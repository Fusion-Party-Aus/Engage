import { canReadDiscussion } from "../../../../../lib/platform/discussion-access.ts";
import { ensureIndexes, getDatabase } from "../../../../../lib/platform/database.ts";
import { platformRoles, resolveIdentity } from "../../../../../lib/platform/auth.ts";
import { reviewSubmission } from "../../../../../lib/platform/consultations.ts";
import { json, platformEnv, readJson, requireSameOrigin } from "../../../../../lib/platform/http.ts";
import type { RuntimeLocals } from "../../../../../lib/platform/types.ts";
import { consumeRateLimit } from "../../../../../lib/platform/rate-limit.ts";

export const prerender = false;

export async function POST({ request, params, locals }: { request: Request; params: { submissionId: string }; locals: RuntimeLocals }): Promise<Response> {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const env = platformEnv(locals);
  const { identity } = await resolveIdentity(request, env);
  if (!identity) return json({ error: "Sign in with an authorised administrator account." }, 401);
  try {
    const db = await getDatabase(env);
    await ensureIndexes(db);
    if (!await canReadDiscussion(db, identity, env)) return json({ error: "Verified membership is required for member discussion." }, 403);
    if (!(await platformRoles(identity, env)).some((role) => role === "administrator" || role === "moderator")) return json({ error: "You are not authorised to moderate submissions." }, 403);
    if (!(await consumeRateLimit(db, "consultation-moderation", identity.memberId, 120, 60 * 60_000))) return json({ error: "Too many moderation updates. Please try again later." }, 429, { "retry-after": "3600" });
    const body = await readJson(request);
    if (!body || !["accepted", "declined", "needs-changes"].includes(String(body.status))) return json({ error: "Choose a valid review status." }, 400);
    const changed = await reviewSubmission(db, identity, params.submissionId, body.status as "accepted" | "declined" | "needs-changes", typeof body.moderatorResponse === "string" ? body.moderatorResponse : undefined, env);
    return changed ? json({ reviewed: true }) : json({ error: "This submission is not awaiting review." }, 409);
  } catch {
    return json({ error: "The submission could not be reviewed." }, 503);
  }
}
