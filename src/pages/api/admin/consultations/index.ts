import { ensureIndexes, getDatabase } from "../../../../lib/platform/database";
import { platformRoles, resolveIdentity } from "../../../../lib/platform/auth";
import { json, platformEnv } from "../../../../lib/platform/http";
import type { RuntimeLocals } from "../../../../lib/platform/types";
import { consumeRateLimit } from "../../../../lib/platform/rate-limit";

export const prerender = false;

export async function GET({ request, locals }: { request: Request; locals: RuntimeLocals }): Promise<Response> {
  const env = platformEnv(locals);
  const { identity } = await resolveIdentity(request, env);
  if (!identity) return json({ error: "Sign in with an authorised administrator account." }, 401);
  try {
    const db = await getDatabase(env);
    await ensureIndexes(db);
    if (!(await platformRoles(identity, env)).some((role) => role === "administrator" || role === "moderator")) return json({ error: "You are not authorised to review submissions." }, 403);
    if (!(await consumeRateLimit(db, "consultation-queue", identity.memberId, 60, 60_000))) return json({ error: "Too many moderation queue requests. Please try again shortly." }, 429, { "retry-after": "60" });
    const url = new URL(request.url);
    const requestedStatus = url.searchParams.get("status") ?? "pending";
    if (!new Set(["pending", "accepted", "declined", "needs-changes"]).has(requestedStatus)) return json({ error: "Unknown submission status." }, 400);
    const submissions = await db.collection("consultation_submissions").find({ status: requestedStatus }, {
      projection: { _id: 0, submissionId: 1, roundId: 1, policyId: 1, policyRevisionId: 1, kind: 1, title: 1, body: 1, status: 1, createdAt: 1, moderatorResponse: 1, identitySource: 1, synthetic: 1 },
    }).sort({ createdAt: 1 }).limit(100).toArray();
    return json({ submissions });
  } catch {
    return json({ error: "The moderation queue is temporarily unavailable." }, 503);
  }
}
