import { ensureIndexes, getDatabase } from "../../../lib/platform/database";
import { platformRoles, resolveIdentity } from "../../../lib/platform/auth";
import { validPolicyId } from "../../../lib/platform/policy-revisions.mjs";
import { json, platformEnv } from "../../../lib/platform/http";
import { consumeRateLimit } from "../../../lib/platform/rate-limit";
import type { RuntimeLocals } from "../../../lib/platform/types";

export const prerender = false;

export async function GET({ request, locals }: { request: Request; locals: RuntimeLocals }): Promise<Response> {
  const env = platformEnv(locals);
  const { identity } = await resolveIdentity(request, env);
  if (!identity) return json({ error: "Sign in with an authorised administrator account." }, 401);
  const policyId = new URL(request.url).searchParams.get("policyId");
  if (!validPolicyId(policyId)) return json({ error: "Provide a valid policyId." }, 400);
  try {
    const db = await getDatabase(env);
    await ensureIndexes(db);
    if (!(await platformRoles(identity, env)).some((role) => role === "administrator" || role === "moderator")) return json({ error: "You are not authorised to view policy revisions." }, 403);
    if (!(await consumeRateLimit(db, "policy-revision-list", identity.memberId, 60, 60_000))) return json({ error: "Too many revision requests. Please try again shortly." }, 429, { "retry-after": "60" });
    const revisions = await db.collection("policy_revisions").find({ policyId }, {
      projection: {
        _id: 0, policyId: 1, revisionId: 1, version: 1, title: 1, division: 1, domain: 1, programme: 1, pillar: 1, editorialHeading: 1, taxonomyVersion: 1,
        statement: 1, outcomes: 1, body: 1, details: 1, detailHtml: 1, provenance: 1, createdAt: 1, importedAt: 1,
      },
    }).sort({ createdAt: 1, version: 1 }).limit(100).toArray();
    return json({ policyId, revisions, syntheticOnly: identity.source === "synthetic" });
  } catch {
    return json({ error: "Policy revisions are temporarily unavailable." }, 503);
  }
}
