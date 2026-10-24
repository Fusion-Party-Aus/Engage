import { ensureIndexes, getDatabase } from "../../../../lib/platform/database.ts";
import { platformRoles, resolveIdentity } from "../../../../lib/platform/auth.ts";
import { renderDetailsToHtml } from "../../../../lib/platform/catalogue.ts";
import { validPolicyId, validatePolicyRevisionInput } from "../../../../lib/platform/policy-revisions.mjs";
import { json, platformEnv, readJson, requireSameOrigin } from "../../../../lib/platform/http.ts";
import { consumeRateLimit } from "../../../../lib/platform/rate-limit.ts";
import type { BallotRecord } from "../../../../lib/platform/ballots.ts";
import type { RuntimeLocals } from "../../../../lib/platform/types.ts";

export const prerender = false;

const allowedCategories = new Set([
  "new-proposal",
  "materially-revised",
  "existing-repackaged",
  "draft-derived",
  "unverified",
]);

type DraftBallot = BallotRecord & {
  choices: string[];
  mandatoryDoNotApproveReason: boolean;
  createdAt: Date;
  createdBy: string;
};

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "proposal";
}

export async function POST({ request, locals }: { request: Request; locals: RuntimeLocals }): Promise<Response> {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const env = platformEnv(locals);
  const { identity } = await resolveIdentity(request, env);
  if (!identity) return json({ error: "Sign in with an authorised administrator account." }, 401);
  const body = await readJson(request);
  if (!body) return json({ error: "Provide a valid JSON policy proposal." }, 400);
  const policyId = typeof body.policyId === "string" ? body.policyId.trim() : "";
  if (!validPolicyId(policyId)) return json({ error: "Provide a valid policyId (e.g. POL-077)." }, 400);
  const division = body.division === "RECLAIM OUR FUTURE" ? "RECLAIM OUR FUTURE" : "RECLAIM OUR ECONOMY";
  const provenanceCategory = typeof body.provenanceCategory === "string" && allowedCategories.has(body.provenanceCategory)
    ? body.provenanceCategory
    : "new-proposal";
  const provenanceSummary = typeof body.provenanceSummary === "string" && body.provenanceSummary.trim().length <= 500
    ? body.provenanceSummary.trim()
    : "Newly proposed policy drafted for member consultation and ballot review.";
  const roundId = typeof body.roundId === "string" && body.roundId.trim() ? body.roundId.trim() : undefined;

  const { policyId: _pid, division: _div, provenanceCategory: _cat, provenanceSummary: _sum, roundId: _rid, ...revisionFields } = body;
  const parsed = validatePolicyRevisionInput(revisionFields);
  if ("error" in parsed) return json({ error: parsed.error }, 400);
  if (!parsed.value.domain) return json({ error: "Provide the policy domain." }, 400);

  try {
    const db = await getDatabase(env);
    await ensureIndexes(db);
    if (!(await platformRoles(identity, env)).some((role) => role === "administrator" || role === "moderator")) {
      return json({ error: "You are not authorised to propose new policies." }, 403);
    }
    if (!(await consumeRateLimit(db, "policy-create", identity.memberId, 20, 60 * 60_000))) {
      return json({ error: "Too many policies created. Please try again later." }, 429, { "retry-after": "3600" });
    }
    const revisions = db.collection("policy_revisions");
    if (await revisions.findOne({ policyId }, { projection: { _id: 1 } })) {
      return json({ error: "That policyId already exists. Create a new revision on the existing policy instead." }, 409);
    }
    const now = new Date();
    const isSynthetic = env.APP_MODE === "preview" || identity.source === "synthetic";
    const revisionId = `${policyId}:${parsed.value.version}`;
    const domainSlug = `/${division === "RECLAIM OUR FUTURE" ? "reclaim-our-future" : "reclaim-our-economy"}/${slugify(parsed.value.domain)}/`;
    const anchor = slugify(parsed.value.title);
    const detailHtml = renderDetailsToHtml(parsed.value.details, parsed.value.changeSummary);
    const document = {
      policyId,
      revisionId,
      version: parsed.value.version,
      title: parsed.value.title,
      division,
      domain: parsed.value.domain,
      domainSlug,
      anchor,
      url: `${domainSlug}#${anchor}`,
      statement: parsed.value.statement,
      details: parsed.value.details,
      body: parsed.value.details,
      detailHtml,
      outcomes: parsed.value.outcomes,
      syntheticFixture: isSynthetic,
      ...(isSynthetic
        ? {
            fixtureNotice: "SYNTHETIC PREVIEW FIXTURE — Created in preview mode for Engage lifecycle verification; not an actual Fusion party policy.",
          }
        : {}),
      provenance: {
        category: provenanceCategory,
        label: isSynthetic
          ? "Synthetic fixture · New proposal"
          : provenanceCategory === "new-proposal"
            ? "New proposal · Member review"
            : "Proposed revision",
        summary: isSynthetic ? `[SYNTHETIC PREVIEW FIXTURE] ${provenanceSummary}` : provenanceSummary,
        flaggedNewInStaticExport: false,
        lineageVerified: !isSynthetic,
        materialEquivalenceVerified: false,
        uncertaintyNote: isSynthetic
          ? "Synthetic preview fixture only — not an official party proposal."
          : "Requires member consultation and ballot approval before adoption.",
        lineage: [],
        valuesAlignment: [],
      },
      createdAt: now,
      createdBy: identity.memberId,
    };
    await revisions.insertOne(document);
    if (roundId) {
      await db.collection("consultation_rounds").updateOne(
        { roundId },
        { $addToSet: { policyIds: policyId }, $set: { updatedAt: now, updatedBy: identity.memberId } },
      );
    }
    const defaultBallotId = `ballot-${slugify(policyId)}`;
    const ballots = db.collection<DraftBallot>("ballots");
    let draftBallot: DraftBallot | null = await ballots.findOne({ ballotId: defaultBallotId }, { projection: { _id: 0 } });
    if (!draftBallot) {
      draftBallot = {
        ballotId: defaultBallotId,
        proposalId: policyId,
        policyRevisionId: revisionId,
        ...(roundId ? { roundId } : {}),
        title: parsed.value.title,
        summary: parsed.value.statement,
        domain: parsed.value.domain,
        status: "draft",
        opensAt: new Date(now.getTime() + 7 * 24 * 60 * 60_000),
        closesAt: new Date(now.getTime() + 21 * 24 * 60 * 60_000),
        choices: ["approve", "do-not-approve"],
        mandatoryDoNotApproveReason: false,
        bindingBallotsEnabled: false,
        syntheticFixture: isSynthetic,
        createdAt: now,
        createdBy: identity.memberId,
      };
      await ballots.insertOne(draftBallot);
    }
    await db.collection("operational_audit").insertOne({
      actorId: identity.memberId,
      actorSource: identity.source,
      action: "new_policy_proposal_created",
      targetType: "policy",
      targetId: policyId,
      revisionId,
      roundId: roundId ?? null,
      ballotId: defaultBallotId,
      syntheticFixture: isSynthetic,
      createdAt: now,
    });
    return json({ policy: document, ballot: draftBallot, immutable: true }, 201);
  } catch {
    return json({ error: "The policy proposal could not be created." }, 503);
  }
}
