import { ensureIndexes, getDatabase } from "../../../lib/platform/database";
import { resolveIdentity } from "../../../lib/platform/auth";
import { createSubmission, listOwnSubmissions, validateSubmission } from "../../../lib/platform/consultations";
import { json, platformEnv, readJson, requireSameOrigin } from "../../../lib/platform/http";
import type { RuntimeLocals } from "../../../lib/platform/types";
import { consumeRateLimit } from "../../../lib/platform/rate-limit";

export const prerender = false;

export async function GET({ request, locals }: { request: Request; locals: RuntimeLocals }): Promise<Response> {
  const { identity } = await resolveIdentity(request, platformEnv(locals));
  if (!identity) return json({ error: "Sign in to view your submissions." }, 401);
  try {
    const db = await getDatabase(platformEnv(locals));
    await ensureIndexes(db);
    return json({ submissions: await listOwnSubmissions(db, identity.memberId), synthetic: identity.source === "synthetic" });
  } catch {
    return json({ error: "Your submissions are temporarily unavailable." }, 503);
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
    return json({ submissionId, status: "pending", synthetic: identity.source === "synthetic" }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Your submission could not be saved.";
    return json({ error: message }, message.includes("not open") ? 409 : 503);
  }
}
