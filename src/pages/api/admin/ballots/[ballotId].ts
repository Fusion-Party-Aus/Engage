import { ensureIndexes, getDatabase } from "../../../../lib/platform/database.ts";
import { platformRoles, resolveIdentity } from "../../../../lib/platform/auth.ts";
import { validBallotEvidence, bindingBallotAuthorised } from "../../../../lib/platform/ballot-authorization.ts";
import { formalVotingIsEnabled } from "../../../../lib/platform/voting.mjs";
import { finalizeBallot, type BallotRecord } from "../../../../lib/platform/ballots.ts";
import { validateDraftBallotPatch, validateOpenBallotSchedule } from "../../../../lib/platform/draft-admin.mjs";
import { json, platformEnv, readJson, requireSameOrigin } from "../../../../lib/platform/http.ts";
import { consumeRateLimit } from "../../../../lib/platform/rate-limit.ts";
import type { RuntimeLocals } from "../../../../lib/platform/types.ts";

export const prerender = false;

const statusTransitionKeys = new Set(["status", "opensAt", "closesAt", "authorizationEvidence"]);

export async function PATCH({ request, params, locals }: { request: Request; params: { ballotId: string }; locals: RuntimeLocals }): Promise<Response> {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const env = platformEnv(locals);
  const { identity } = await resolveIdentity(request, env);
  if (!identity) return json({ error: "Sign in with an authorised administrator account." }, 401);
  const body = await readJson(request);
  if (!body) return json({ error: "Provide valid JSON." }, 400);
  try {
    const db = await getDatabase(env);
    await ensureIndexes(db);
    if (!(await platformRoles(identity, env)).some((role) => role === "administrator" || role === "moderator")) return json({ error: "You are not authorised to edit ballots." }, 403);
    if (!(await consumeRateLimit(db, "draft-ballot-edit", identity.memberId, 60, 60 * 60_000))) return json({ error: "Too many ballot changes. Please try again later." }, 429, { "retry-after": "3600" });
    const ballots = db.collection<BallotRecord>("ballots");
    const ballot = await ballots.findOne({ ballotId: params.ballotId });
    if (!ballot) return json({ error: "Ballot not found." }, 404);
    const now = new Date();
    if (body.status !== undefined && Object.keys(body).every((key) => statusTransitionKeys.has(key))) {
      if (body.status !== "closed" && (ballot.status === "closed" || ballot.results || ballot.finalizedAt)) {
        return json({ error: "A closed ballot cannot be reopened. Create a new ballot for a new decision." }, 409);
      }
      let authorization = ballot.authorization;
      if (env.APP_MODE !== "preview") {
        if (identity.source !== "engage" || !(await platformRoles(identity, env)).includes("administrator")) return json({ error: "Administrator role required." }, 403);
        if (body.status === "open") {
          if (ballot.status !== "draft" || !formalVotingIsEnabled(env)) return json({ error: "Only a draft ballot can open after binding voting is enabled." }, 423);
          if (await db.collection("votes").countDocuments({ ballotId: params.ballotId })) return json({ error: "A binding ballot must start without prior preview or voting activity. Create a new ballot." }, 409);
          if (validBallotEvidence(body.authorizationEvidence)) authorization = { approvedBy: identity.memberId, approvedAt: now, evidence: body.authorizationEvidence };
          const revision = await db.collection("policy_revisions").findOne({ policyId: ballot.proposalId, revisionId: ballot.policyRevisionId });
          if (!revision || revision.syntheticFixture || !bindingBallotAuthorised({ ...ballot, bindingBallotsEnabled: true, authorization })) return json({ error: "Record governance approval and evidence for all ballot safeguards before opening an authentic ballot." }, 423);
        } else if (body.status !== "closed") return json({ error: "Production ballots cannot return to draft." }, 409);
      } else if (ballot.bindingBallotsEnabled === true) return json({ error: "Preview cannot manage binding ballots." }, 423);
      if (body.status !== "draft" && body.status !== "open" && body.status !== "closed") {
        return json({ error: "Choose draft, open, or closed." }, 400);
      }
      const isSynthetic = Boolean(ballot.syntheticFixture) || env.APP_MODE === "preview" || identity.source === "synthetic";
      if (body.status === "closed") {
        const finalized = await finalizeBallot(db, params.ballotId, {
          actorId: identity.memberId,
          actorSource: identity.source,
          closeReason: "administrative",
          isSyntheticOverride: isSynthetic,
        });
        if (!finalized) return json({ error: "Ballot not found." }, 404);
        return json({
          ballotId: params.ballotId,
          status: "closed",
          results: finalized.results,
          outcome: finalized.outcome,
          publishedRevisionId: finalized.publishedRevisionId,
          syntheticOutcome: finalized.syntheticOutcome,
        });
      }
      const statusPatch: Record<string, unknown> = { status: body.status, updatedAt: now, updatedBy: identity.memberId };
      if (env.APP_MODE === "production" && body.status === "open") Object.assign(statusPatch, { authorization, bindingBallotsEnabled: true });
      if (body.status === "open") {
        const windowCheck = validateOpenBallotSchedule(
          { opensAt: body.opensAt, closesAt: body.closesAt },
          { opensAt: ballot.opensAt, closesAt: ballot.closesAt },
          now,
        );
        if ("error" in windowCheck) {
          return json({ error: windowCheck.error }, 400);
        }
        statusPatch.opensAt = windowCheck.opensAt;
        statusPatch.closesAt = windowCheck.closesAt;
      }
      const changed = await ballots.updateOne({ ballotId: params.ballotId, status: ballot.status }, { $set: statusPatch });
      if (!changed.matchedCount) return json({ error: "The ballot changed while you were editing it." }, 409);
      await db.collection("operational_audit").insertOne({
        actorId: identity.memberId, actorSource: identity.source, action: "ballot_status_updated",
        targetType: "ballot", targetId: params.ballotId, status: body.status,
        ...(statusPatch.opensAt ? { opensAt: statusPatch.opensAt, closesAt: statusPatch.closesAt } : {}),
        syntheticOutcome: isSynthetic,
        ...(env.APP_MODE === "production" && body.status === "open" ? { authorization } : {}),
        createdAt: now,
      });
      return json({
        ballotId: params.ballotId,
        status: body.status,
        opensAt: statusPatch.opensAt ?? ballot.opensAt,
        closesAt: statusPatch.closesAt ?? ballot.closesAt,
        results: null,
        outcome: null,
        publishedRevisionId: null,
        syntheticOutcome: isSynthetic,
      });
    }
    if (ballot.status !== "draft" || ballot.bindingBallotsEnabled === true) return json({ error: "Only inactive draft ballots can be edited." }, 409);
    const patch = validateDraftBallotPatch(body, { opensAt: ballot.opensAt, closesAt: ballot.closesAt, priority: ballot.priority });
    if ("error" in patch) return json({ error: patch.error }, 400);
    let title = ballot.title;
    if (patch.policyRevisionId !== undefined) {
      const revision = await db.collection("policy_revisions").findOne({ policyId: ballot.proposalId, revisionId: patch.policyRevisionId }, { projection: { title: 1, _id: 0 } });
      if (!revision) return json({ error: "That immutable policy revision does not belong to this proposal." }, 400);
      title = revision.title;
    }
    const changes = { ...patch, title, updatedAt: now, updatedBy: identity.memberId };
    const updated = await ballots.updateOne(
      { ballotId: params.ballotId, status: "draft", bindingBallotsEnabled: { $ne: true } },
      { $set: changes },
    );
    if (!updated.modifiedCount) return json({ error: "The ballot changed while you were editing it." }, 409);
    await db.collection("operational_audit").insertOne({
      actorId: identity.memberId, actorSource: identity.source, action: "draft_ballot_configuration_updated",
      targetType: "ballot", targetId: params.ballotId,
      changedFields: Object.keys(body), policyRevisionId: patch.policyRevisionId, priority: patch.priority,
      opensAt: patch.opensAt, closesAt: patch.closesAt, createdAt: now,
    });
    return json({ ballotId: params.ballotId, title, status: "draft", ...patch, bindingBallotsEnabled: false });
  } catch {
    return json({ error: "The draft ballot could not be updated." }, 503);
  }
}
