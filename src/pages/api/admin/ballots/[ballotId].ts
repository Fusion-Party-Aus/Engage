import { ensureIndexes, getDatabase } from "../../../../lib/platform/database.ts";
import { platformRoles, resolveIdentity } from "../../../../lib/platform/auth.ts";
import { getBallotResults, type BallotRecord } from "../../../../lib/platform/ballots.ts";
import { validateDraftBallotPatch } from "../../../../lib/platform/draft-admin.mjs";
import { json, platformEnv, readJson, requireSameOrigin } from "../../../../lib/platform/http.ts";
import { consumeRateLimit } from "../../../../lib/platform/rate-limit.ts";
import type { RuntimeLocals } from "../../../../lib/platform/types.ts";

export const prerender = false;

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
    if (body.status !== undefined && Object.keys(body).length === 1) {
      if (env.APP_MODE !== "preview" || ballot.bindingBallotsEnabled === true) {
        return json({ error: "Ballot status transitions require preview mode and non-binding configuration." }, 423);
      }
      if (body.status !== "draft" && body.status !== "open" && body.status !== "closed") {
        return json({ error: "Choose draft, open, or closed." }, 400);
      }
      const statusPatch: Record<string, unknown> = { status: body.status, updatedAt: now, updatedBy: identity.memberId };
      if (body.status === "open" && ballot.opensAt > now) {
        statusPatch.opensAt = new Date(now.getTime() - 60_000);
      }
      if (body.status === "open" && ballot.closesAt <= now) {
        statusPatch.closesAt = new Date(now.getTime() + 7 * 24 * 60 * 60_000);
      }
      if (body.status === "closed") {
        statusPatch.closedAt = now;
      }
      await ballots.updateOne({ ballotId: params.ballotId }, { $set: statusPatch });
      let results = null;
      let publishedRevisionId: string | null = null;
      const isSynthetic = Boolean(ballot.syntheticFixture) || env.APP_MODE === "preview" || identity.source === "synthetic";
      if (body.status === "closed") {
        const closedBallot = await ballots.findOne({ ballotId: params.ballotId });
        if (closedBallot) {
          results = await getBallotResults(db, closedBallot);
          if (results?.outcome === "approved") {
            publishedRevisionId = closedBallot.policyRevisionId;
            await db.collection("policy_revisions").updateOne(
              { policyId: closedBallot.proposalId, revisionId: closedBallot.policyRevisionId },
              {
                $set: {
                  approvedAt: now,
                  publishedAt: now,
                  approvedByBallotId: params.ballotId,
                  syntheticOutcome: isSynthetic,
                },
              },
            );
            await db.collection("operational_audit").insertOne({
              actorId: identity.memberId,
              actorSource: identity.source,
              action: "approved_revision_published",
              targetType: "policy",
              targetId: closedBallot.proposalId,
              revisionId: closedBallot.policyRevisionId,
              ballotId: params.ballotId,
              syntheticOutcome: isSynthetic,
              createdAt: now,
            });
          }
        }
      }
      await db.collection("operational_audit").insertOne({
        actorId: identity.memberId, actorSource: identity.source, action: "ballot_status_updated",
        targetType: "ballot", targetId: params.ballotId, status: body.status,
        ...(results ? { outcome: results.outcome, votesCast: results.votesCast } : {}),
        syntheticOutcome: isSynthetic,
        createdAt: now,
      });
      return json({
        ballotId: params.ballotId,
        status: body.status,
        results,
        outcome: results?.outcome ?? null,
        publishedRevisionId,
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
