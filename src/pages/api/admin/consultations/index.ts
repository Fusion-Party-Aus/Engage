import { canReadDiscussion, discussionAudience } from "../../../../lib/platform/discussion-access.ts";
import { ensureIndexes, getDatabase } from "../../../../lib/platform/database.ts";
import { platformRoles, resolveIdentity } from "../../../../lib/platform/auth.ts";
import { json, platformEnv } from "../../../../lib/platform/http.ts";
import type { RuntimeLocals } from "../../../../lib/platform/types.ts";
import { consumeRateLimit } from "../../../../lib/platform/rate-limit.ts";
import { validPolicyId } from "../../../../lib/platform/policy-revisions.mjs";

export const prerender = false;

export async function GET({ request, locals }: { request: Request; locals: RuntimeLocals }): Promise<Response> {
  const env = platformEnv(locals);
  const { identity } = await resolveIdentity(request, env);
  if (!identity) return json({ error: "Sign in with an authorised administrator account." }, 401);
  try {
    const db = await getDatabase(env);
    await ensureIndexes(db);
    if (!await canReadDiscussion(db, identity, env)) return json({ error: "Verified membership is required for member discussion." }, 403);
    if (!(await platformRoles(identity, env)).some((role) => role === "administrator" || role === "moderator")) return json({ error: "You are not authorised to review submissions." }, 403);
    if (!(await consumeRateLimit(db, "consultation-queue", identity.memberId, 60, 60_000))) return json({ error: "Too many moderation queue requests. Please try again shortly." }, 429, { "retry-after": "60" });
    const url = new URL(request.url);
    const requestedStatus = url.searchParams.get("status") ?? "pending";
    if (!new Set(["pending", "accepted", "declined", "needs-changes"]).has(requestedStatus)) return json({ error: "Unknown submission status." }, 400);
    const policyId = url.searchParams.get('policyId');
    const roundId = url.searchParams.get('roundId');
    const offset = Number(url.searchParams.get('offset') ?? 0);
    if (policyId !== null && !validPolicyId(policyId)) return json({ error: 'Choose a valid policy.' }, 400);
    if (roundId !== null && !/^[a-z0-9][a-z0-9-]{2,79}$/.test(roundId)) return json({ error: 'Choose a valid consultation round.' }, 400);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) return json({ error: 'Invalid queue page.' }, 400);
    const submissions = await db.collection("consultation_submissions").find({ status: requestedStatus, ...discussionAudience(identity), ...(policyId ? { policyId } : {}), ...(roundId ? { roundId } : {}) }, {
      projection: { _id: 0, submissionId: 1, roundId: 1, policyId: 1, policyRevisionId: 1, kind: 1, title: 1, body: 1, status: 1, createdAt: 1, moderatorResponse: 1, identitySource: 1, synthetic: 1 },
    }).sort({ createdAt: 1, submissionId: 1 }).skip(offset).limit(101).toArray();
    return json({ submissions: submissions.slice(0, 100), hasMore: submissions.length > 100 });
  } catch {
    return json({ error: "The moderation queue is temporarily unavailable." }, 503);
  }
}
