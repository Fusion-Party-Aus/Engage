import { ensureIndexes, getDatabase } from "../../../../lib/platform/database";
import { platformRoles, resolveIdentity } from "../../../../lib/platform/auth";
import { validateDraftRoundPatch } from "../../../../lib/platform/draft-admin.mjs";
import { json, platformEnv, readJson, requireSameOrigin } from "../../../../lib/platform/http";
import { consumeRateLimit } from "../../../../lib/platform/rate-limit";
import type { RuntimeLocals } from "../../../../lib/platform/types";

export const prerender = false;

export async function PATCH({ request, params, locals }: { request: Request; params: { roundId: string }; locals: RuntimeLocals }): Promise<Response> {
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
    if (!(await platformRoles(identity, env)).some((role) => role === "administrator" || role === "moderator")) return json({ error: "You are not authorised to edit consultation schedules." }, 403);
    if (!(await consumeRateLimit(db, "consultation-round-edit", identity.memberId, 30, 60 * 60_000))) return json({ error: "Too many schedule changes. Please try again later." }, 429, { "retry-after": "3600" });
    const rounds = db.collection("consultation_rounds");
    const round = await rounds.findOne({ roundId: params.roundId });
    if (!round) return json({ error: "Consultation round not found." }, 404);
    const now = new Date();
    if (body.status !== undefined && Object.keys(body).length === 1) {
      if (env.APP_MODE !== "preview" && (identity.source !== "engage" || !(await platformRoles(identity, env)).includes("administrator") || round.syntheticFixture)) return json({ error: "An administrator must open an authentic consultation round." }, 403);
      if (body.status !== "draft" && body.status !== "open" && body.status !== "closed") return json({ error: "Choose draft, open, or closed." }, 400);
      await rounds.updateOne(
        { roundId: params.roundId },
        { $set: { status: body.status, updatedAt: now, updatedBy: identity.memberId } },
      );
      await db.collection("operational_audit").insertOne({
        actorId: identity.memberId, actorSource: identity.source, action: "consultation_round_status_updated",
        targetType: "consultation_round", targetId: params.roundId, status: body.status, createdAt: now,
      });
      return json({ roundId: params.roundId, status: body.status, opensAt: round.opensAt, closesAt: round.closesAt });
    }
    if (round.status !== "draft") return json({ error: "Only draft consultation rounds can be rescheduled." }, 409);
    const patch = validateDraftRoundPatch(body, { opensAt: round.opensAt, closesAt: round.closesAt });
    if ("error" in patch) return json({ error: patch.error }, 400);
    const updated = await rounds.updateOne(
      { roundId: params.roundId, status: "draft" },
      { $set: { opensAt: patch.opensAt, closesAt: patch.closesAt, updatedAt: now, updatedBy: identity.memberId } },
    );
    if (!updated.modifiedCount) return json({ error: "The consultation round changed while you were editing it." }, 409);
    await db.collection("operational_audit").insertOne({
      actorId: identity.memberId, actorSource: identity.source, action: "draft_consultation_schedule_updated",
      targetType: "consultation_round", targetId: params.roundId, opensAt: patch.opensAt, closesAt: patch.closesAt, createdAt: now,
    });
    return json({ roundId: params.roundId, status: "draft", opensAt: patch.opensAt, closesAt: patch.closesAt });
  } catch {
    return json({ error: "The consultation schedule could not be updated." }, 503);
  }
}
