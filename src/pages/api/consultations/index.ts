import { ensureIndexes, getDatabase } from "../../../lib/platform/database.ts";
import { resolveIdentity } from "../../../lib/platform/auth.ts";
import { createSubmission, listOwnSubmissions, listMemberSubmissions, validateSubmission } from "../../../lib/platform/consultations.ts";
import { validPolicyId } from "../../../lib/platform/policy-revisions.mjs";
import { json, platformEnv, readJson, requireSameOrigin } from "../../../lib/platform/http.ts";
import type { RuntimeLocals } from "../../../lib/platform/types.ts";
import { canReadDiscussion } from "../../../lib/platform/discussion-access.ts";
import { consumeRateLimit } from "../../../lib/platform/rate-limit.ts";

export const prerender = false;

export async function GET({ request, locals }: { request: Request; locals: RuntimeLocals }): Promise<Response> {
  const env = platformEnv(locals);
  const url = new URL(request.url);
  const policyIdParam = url.searchParams.get("policyId");
  const roundIdParam = url.searchParams.get("roundId") ?? undefined;
  if (policyIdParam !== null && !validPolicyId(policyIdParam)) {
    return json({ error: "Provide a valid policyId." }, 400);
  }
  const { identity } = await resolveIdentity(request, env);
  if (!identity) {
    return json({ error: "Sign in to view your submissions." }, 401);
  }
  try {
    const db = await getDatabase(env);
    await ensureIndexes(db);
    if (!await canReadDiscussion(db, identity, env)) return json({ error: "Verified membership is required for member discussion." }, 403);
    if (policyIdParam || roundIdParam) {
      const publicSubmissions = await listMemberSubmissions(db, identity, env, {
        ...(policyIdParam ? { policyId: policyIdParam } : {}),
        ...(roundIdParam ? { roundId: roundIdParam } : {}),
      });
      const ownSubmissions = identity ? await listOwnSubmissions(db, identity, env) : [];
      return json({
        submissions: publicSubmissions,
        ownSubmissions: ownSubmissions.filter(item => (!policyIdParam || item.policyId === policyIdParam) && (!roundIdParam || item.roundId === roundIdParam)),
      });
    }
    return json({ submissions: await listOwnSubmissions(db, identity, env) });
  } catch {
    return json({ error: "Consultation submissions are temporarily unavailable." }, 503);
  }
}

export async function POST({ request, locals }: { request: Request; locals: RuntimeLocals }): Promise<Response> {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const env = platformEnv(locals);
  const { identity, unavailableReason } = await resolveIdentity(request, env);
  if (!identity) return json({ error: "Sign in to submit consultation feedback." }, unavailableReason ? 503 : 401);
  const body = await readJson(request);
  const input = body && validateSubmission(body);
  if (!input) return json({ error: "Check the policy, submission type, and text. Submissions must be between 10 and 10,000 characters." }, 400);
  try {
    const db = await getDatabase(env);
    await ensureIndexes(db);
    if (!await canReadDiscussion(db, identity, env)) return json({ error: "Verified membership is required for member discussion." }, 403);
    if (!(await consumeRateLimit(db, "consultation-submission", identity.memberId, 5, 60 * 60_000))) return json({ error: "You have reached the submission limit for this hour. Please try again later." }, 429, { "retry-after": "3600" });
    const submissionId = await createSubmission(db, identity, input, new Date(), env);
    return json({ submissionId, status: "pending" }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Your submission could not be saved.";
    const status = message.includes("verification") ? 403 : message.includes("not open") ? 409 : message.includes("not included") || message.includes("could not be found") ? 422 : 503;
    return json({ error: message }, status);
  }
}
