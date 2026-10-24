import { validateTaxonomy } from "../../../../../lib/platform/taxonomy.ts";
import { ensureIndexes, getDatabase } from "../../../../../lib/platform/database.ts";
import { platformRoles, resolveIdentity } from "../../../../../lib/platform/auth.ts";
import { renderDetailsToHtml } from "../../../../../lib/platform/catalogue.ts";
import { validPolicyId, validatePolicyRevisionInput } from "../../../../../lib/platform/policy-revisions.mjs";
import { json, platformEnv, readJson, requireSameOrigin } from "../../../../../lib/platform/http.ts";
import { consumeRateLimit } from "../../../../../lib/platform/rate-limit.ts";
import type { RuntimeLocals } from "../../../../../lib/platform/types.ts";

export const prerender = false;

export async function POST({ request, params, locals }: { request: Request; params: { policyId: string }; locals: RuntimeLocals }): Promise<Response> {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const env = platformEnv(locals);
  const { identity } = await resolveIdentity(request, env);
  if (!identity) return json({ error: "Sign in with an authorised administrator account." }, 401);
  if (!validPolicyId(params.policyId)) return json({ error: "Invalid policy id." }, 400);
  const body = await readJson(request);
  if (!body) return json({ error: "Provide a valid JSON policy revision." }, 400);
  const parsed = validatePolicyRevisionInput(body);
  if ("error" in parsed) return json({ error: parsed.error }, 400);
  try {
    const db = await getDatabase(env);
    await ensureIndexes(db);
    if (!(await platformRoles(identity, env)).some((role) => role === "administrator" || role === "moderator")) return json({ error: "You are not authorised to create policy revisions." }, 403);
    if (!(await consumeRateLimit(db, "policy-revision-create", identity.memberId, 20, 60 * 60_000))) return json({ error: "Too many revisions created. Please try again later." }, 429, { "retry-after": "3600" });
    const revisions = db.collection("policy_revisions");
    const existing = await revisions.findOne({ policyId: params.policyId }, { projection: { _id: 0, domain: 1, division: 1, domainSlug: 1, anchor: 1, url: 1, provenance: 1, syntheticFixture: 1, taxonomyVersion: 1, programme: 1, pillar: 1, editorialHeading: 1 }, sort: { createdAt: -1, importedAt: -1, version: -1 } });
    if (!existing) return json({ error: "The policy does not exist in the platform policy catalogue." }, 404);
    const taxonomy = validateTaxonomy(body, { ...existing, policyId: params.policyId });
    if ("error" in taxonomy) return json({ error: taxonomy.error }, 400);
    const revisionId = `${params.policyId}:${parsed.value.version}`;
    const now = new Date();
    const isSynthetic = Boolean(existing.syntheticFixture) || env.APP_MODE === "preview" || identity.source === "synthetic";
    const detailHtml = renderDetailsToHtml(parsed.value.details, parsed.value.changeSummary);
    const document = {
      policyId: params.policyId,
      revisionId,
      version: parsed.value.version,
      title: parsed.value.title,
      statement: parsed.value.statement,
      details: parsed.value.details,
      body: parsed.value.details,
      detailHtml,
      outcomes: parsed.value.outcomes,
      ...taxonomy.value,
      syntheticFixture: isSynthetic,
      ...(isSynthetic
        ? {
            fixtureNotice: "SYNTHETIC PREVIEW FIXTURE — Settled revision created in preview mode; not an actual Fusion party revision or decision.",
          }
        : {}),
      ...(parsed.value.changeSummary ? { changeSummary: parsed.value.changeSummary } : {}),
      ...(existing.division ? { division: existing.division } : {}),
      ...(existing.domainSlug ? { domainSlug: existing.domainSlug } : {}),
      ...(existing.anchor ? { anchor: existing.anchor } : {}),
      ...(existing.url ? { url: existing.url } : {}),
      ...(existing.provenance ? { provenance: existing.provenance } : {}),
      createdAt: now,
      createdBy: identity.memberId,
    };
    try {
      await revisions.insertOne(document);
    } catch (error) {
      if (error && typeof error === "object" && (error as { code?: number }).code === 11000) return json({ error: "That policy version already exists and cannot be overwritten." }, 409);
      throw error;
    }
    await db.collection("operational_audit").insertOne({
      actorId: identity.memberId, actorSource: identity.source, action: "immutable_policy_revision_created",
      targetType: "policy", targetId: params.policyId, revisionId, syntheticFixture: isSynthetic, createdAt: now,
    });
    return json({ revision: document, immutable: true }, 201);
  } catch {
    return json({ error: "The policy revision could not be created." }, 503);
  }
}
