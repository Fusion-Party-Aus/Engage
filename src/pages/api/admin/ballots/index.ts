import { ensureIndexes, getDatabase } from "../../../../lib/platform/database.ts";
import { platformRoles, resolveIdentity } from "../../../../lib/platform/auth.ts";
import { validPolicyId } from "../../../../lib/platform/policy-revisions.mjs";
import { json, platformEnv, readJson, requireSameOrigin } from "../../../../lib/platform/http.ts";
import { consumeRateLimit } from "../../../../lib/platform/rate-limit.ts";
import type { RuntimeLocals } from "../../../../lib/platform/types.ts";

export const prerender = false;

export async function POST({ request, locals }: { request: Request; locals: RuntimeLocals }): Promise<Response> {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const env = platformEnv(locals);
  const { identity } = await resolveIdentity(request, env);
  if (!identity) return json({ error: "Sign in with an authorised administrator account." }, 401);
  const body = await readJson(request);
  if (!body) return json({ error: "Provide a valid JSON ballot configuration." }, 400);
  const ballotId = typeof body.ballotId === "string" ? body.ballotId.trim() : "";
  const proposalId = typeof body.proposalId === "string" ? body.proposalId.trim() : "";
  const policyRevisionId = typeof body.policyRevisionId === "string" ? body.policyRevisionId.trim() : "";
  const roundId = typeof body.roundId === "string" && body.roundId.trim() ? body.roundId.trim() : undefined;
  const status = body.status === "open" && env.APP_MODE === "preview" ? "open" : "draft";
  const opensAt = typeof body.opensAt === "string" ? new Date(body.opensAt) : null;
  const closesAt = typeof body.closesAt === "string" ? new Date(body.closesAt) : null;

  if (!/^[a-z0-9][a-z0-9-]{2,79}$/.test(ballotId) || !validPolicyId(proposalId) || !policyRevisionId) {
    return json({ error: "Provide a valid ballotId, proposalId, and policyRevisionId." }, 400);
  }
  if (!opensAt || !closesAt || Number.isNaN(opensAt.getTime()) || Number.isNaN(closesAt.getTime()) || closesAt <= opensAt) {
    return json({ error: "Provide valid ordered opening and closing dates." }, 400);
  }

  try {
    const db = await getDatabase(env);
    await ensureIndexes(db);
    if (!(await platformRoles(identity, env)).some((role) => role === "administrator" || role === "moderator")) {
      return json({ error: "You are not authorised to create ballots." }, 403);
    }
    if (!(await consumeRateLimit(db, "ballot-create", identity.memberId, 20, 60 * 60_000))) {
      return json({ error: "Too many ballots created. Please try again later." }, 429, { "retry-after": "3600" });
    }
    const revision = await db.collection("policy_revisions").findOne(
      { policyId: proposalId, revisionId: policyRevisionId },
      { projection: { _id: 0, title: 1, statement: 1, domain: 1, syntheticFixture: 1 } },
    );
    if (!revision) {
      return json({ error: "The specified immutable policy revision does not exist for this proposal." }, 400);
    }
    const ballots = db.collection("ballots");
    const existingBallot = await ballots.findOne({ ballotId });
    if (existingBallot && existingBallot.status !== "draft") {
      return json({ error: "A ballot with that ballotId already exists and is not in draft state." }, 409);
    }
    const now = new Date();
    const isSynthetic = Boolean(revision.syntheticFixture) || env.APP_MODE === "preview" || identity.source === "synthetic";
    const document = {
      ballotId,
      proposalId,
      policyRevisionId,
      ...(roundId ? { roundId } : {}),
      title: typeof body.title === "string" && body.title.trim() ? body.title.trim() : revision.title,
      summary: typeof body.summary === "string" && body.summary.trim() ? body.summary.trim() : revision.statement,
      domain: revision.domain,
      status,
      opensAt,
      closesAt,
      choices: ["approve", "do-not-approve"],
      mandatoryDoNotApproveReason: false,
      bindingBallotsEnabled: false,
      syntheticFixture: isSynthetic,
      createdAt: existingBallot?.createdAt ?? now,
      updatedAt: now,
      createdBy: identity.memberId,
    };
    if (existingBallot) {
      await ballots.updateOne({ ballotId }, { $set: document });
    } else {
      await ballots.insertOne(document);
    }
    await db.collection("operational_audit").insertOne({
      actorId: identity.memberId,
      actorSource: identity.source,
      action: "ballot_created",
      targetType: "ballot",
      targetId: ballotId,
      proposalId,
      policyRevisionId,
      status,
      createdAt: now,
    });
    return json({ ballot: document }, 201);
  } catch {
    return json({ error: "The ballot could not be created." }, 503);
  }
}
