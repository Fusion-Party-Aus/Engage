import { ensureIndexes, getDatabase } from "../../../lib/platform/database.ts";
import { resolveIdentity } from "../../../lib/platform/auth.ts";
import { createSubmission, listOwnSubmissions, listPublicSubmissions, validateSubmission } from "../../../lib/platform/consultations.ts";
import { validPolicyId } from "../../../lib/platform/policy-revisions.mjs";
import { json, platformEnv, readJson, requireSameOrigin } from "../../../lib/platform/http.ts";
import type { RuntimeLocals } from "../../../lib/platform/types.ts";
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
  if (!policyIdParam && !roundIdParam && !identity) {
    return json({ error: "Sign in to view your submissions." }, 401);
  }
  try {
    const db = await getDatabase(env);
    await ensureIndexes(db);
    if (policyIdParam || roundIdParam) {
      const publicSubmissions = await listPublicSubmissions(db, {
        ...(policyIdParam ? { policyId: policyIdParam } : {}),
        ...(roundIdParam ? { roundId: roundIdParam } : {}),
      });
      const ownSubmissions = identity ? await listOwnSubmissions(db, identity.memberId) : [];
      return json({
        submissions: publicSubmissions,
        ownSubmissions: policyIdParam ? ownSubmissions.filter((item) => item.policyId === policyIdParam) : ownSubmissions,
      });
    }
    return json({ submissions: await listOwnSubmissions(db, identity!.memberId) });
  } catch {
    return json({ error: "Consultation submissions are temporarily unavailable." }, 503);
  }
}

export async function POST({ request, locals }: { request: Request; locals: RuntimeLocals }): Promise<Response> {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const env = platformEnv(locals);
  const { identity, unavailableReason } = await resolveIdentity(request, env);
  if (!identity) return json({ error: unavailableReason ? "Underground sign-in is not available yet." : "Sign in to submit consultation feedback." }, unavailableReason ? 503 : 401);
  const body = await readJson(request);
  const input = body && validateSubmission(body);
  if (!input) return json({ error: "Check the policy, submission type, and text. Submissions must be between 10 and 10,000 characters." }, 400);
  try {
    const db = await getDatabase(env);
    await ensureIndexes(db);
    if (!(await consumeRateLimit(db, "consultation-submission", identity.memberId, 5, 60 * 60_000))) return json({ error: "You have reached the submission limit for this hour. Please try again later." }, 429, { "retry-after": "3600" });
    const submissionId = await createSubmission(db, identity, input);
    return json({ submissionId, status: "pending" }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Your submission could not be saved.";
    const status = message.includes("not open") ? 409 : message.includes("not included") || message.includes("could not be found") ? 422 : 503;
    return json({ error: message }, status);
  }
}
