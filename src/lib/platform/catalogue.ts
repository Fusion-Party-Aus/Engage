import type { Db } from "mongodb";
import catalogueData from "../../data/policy-catalogue.json" with { type: "json" };
import initialRoundData from "../../data/initial-round.json" with { type: "json" };
import { ensureIndexes, getDatabase } from "./database.ts";
import { closeExpiredBallots, getBallotResults, type BallotRecord, type BallotResults } from "./ballots.ts";
import type { PlatformEnv } from "./types.ts";

export interface ProvenanceLink {
  label: string;
  url: string | null;
  description: string;
}

export interface PolicyProvenance {
  category: "existing-repackaged" | "materially-revised" | "new-proposal" | "draft-derived" | "unverified";
  classification: "existing-repackaged" | "materially-revised" | "new-proposal" | "draft-derived" | "unverified";
  priorHeuristicCategory?: string;
  label: string;
  summary: string;
  evidenceBasis?: string;
  sourceTypes?: string[];
  flaggedNewInStaticExport: boolean;
  lineageVerified: boolean;
  materialEquivalenceVerified?: boolean;
  uncertaintyNote?: string;
  lineage: ProvenanceLink[];
  valuesAlignment: string[];
}

export interface PolicyCatalogueEntry {
  policyId: string;
  version: string;
  title: string;
  division: string;
  domain: string;
  domainSummary: string;
  domainSlug: string;
  anchor: string;
  url: string;
  statement: string;
  outcomes: string[];
  details: string;
  detailHtml: string;
  provenance: PolicyProvenance;
  syntheticFixture?: boolean;
  fixtureNotice?: string;
  initialAgmRound: {
    included: boolean;
    roundId: string | null;
    ballotId: string | null;
  };
}

export interface PolicyRevisionRecord {
  policyId: string;
  revisionId: string;
  version: string;
  title: string;
  division?: string;
  domain?: string;
  domainSlug?: string;
  anchor?: string;
  url?: string;
  statement: string;
  outcomes: string[];
  details?: string;
  body?: string;
  detailHtml?: string;
  changeSummary?: string;
  provenance?: PolicyProvenance;
  syntheticFixture?: boolean;
  fixtureNotice?: string;
  approvedAt?: Date;
  publishedAt?: Date;
  approvedByBallotId?: string;
  createdAt?: Date;
  importedAt?: Date;
}

export interface PolicyLifecycleView extends PolicyCatalogueEntry {
  id: string;
  slug: string;
  sectionPath: string;
  activeRevisionId: string;
  publishedRevisionId: string;
  consultationRoundId: string | null;
  activeRevision: PolicyRevisionRecord;
  pendingSettledRevision: PolicyRevisionRecord | null;
  revisions: PolicyRevisionRecord[];
  consultationRounds: Array<{
    roundId: string;
    program: string;
    status: string;
    opensAt: Date;
    closesAt: Date;
    syntheticFixture?: boolean;
    fixtureNotice?: string;
  }>;
  submissions: Array<{
    submissionId: string;
    roundId: string;
    policyRevisionId: string;
    kind: string;
    title?: string;
    body: string;
    status: string;
    createdAt: Date;
    moderatorResponse?: string;
    syntheticFixture?: boolean;
  }>;
  ballot: (BallotRecord & { results?: BallotResults | null; outcome?: "approved" | "not-approved" | "no-valid-votes" | null; syntheticFixture?: boolean }) | null;
  adoptedRevisionId: string | null;
  adoptionIsSynthetic: boolean;
  syntheticFixture: boolean;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderDetailsToHtml(details: string, changeSummary?: string): string {
  const blocks = details
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  const htmlParts = blocks.map((block) => {
    const escaped = escapeHtml(block).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    return `<p>${escaped.replace(/\n/g, "<br />")}</p>`;
  });
  if (changeSummary?.trim()) {
    htmlParts.push(`<p><strong>Settled revision summary:</strong> ${escapeHtml(changeSummary.trim())}</p>`);
  }
  return htmlParts.join("");
}

const baselineCatalogue = catalogueData as PolicyCatalogueEntry[];

function defaultRevisionFor(entry: PolicyCatalogueEntry): PolicyRevisionRecord {
  const inRound = initialRoundData.policies.find((p) => p.id === entry.policyId);
  const version = inRound ? inRound.policyVersion : entry.version;
  return {
    policyId: entry.policyId,
    revisionId: version,
    version,
    title: entry.title,
    division: entry.division,
    domain: entry.domain,
    domainSlug: entry.domainSlug,
    anchor: entry.anchor,
    url: entry.url,
    statement: entry.statement,
    outcomes: entry.outcomes,
    details: entry.details,
    body: entry.details,
    detailHtml: entry.detailHtml,
    provenance: entry.provenance,
  };
}

export async function tryGetDb(env: PlatformEnv): Promise<Db | null> {
  if (!env.MONGODB_URI && env.APP_MODE !== "preview") return null;
  try {
    const db = await getDatabase(env);
    await ensureIndexes(db);
    return db;
  } catch {
    return null;
  }
}

export async function loadPolicyCatalogue(env: PlatformEnv): Promise<PolicyLifecycleView[]> {
  const db = await tryGetDb(env);
  if (!db) {
    return baselineCatalogue.map((entry) => {
      const rev = defaultRevisionFor(entry);
      const roundMatch = entry.initialAgmRound.included ? [{
        roundId: initialRoundData.id,
        program: initialRoundData.program,
        status: initialRoundData.status,
        opensAt: new Date(initialRoundData.openingInclusiveUtc),
        closesAt: new Date(initialRoundData.closingExclusiveUtc),
      }] : [];
      const ballotMatch: (BallotRecord & { results?: BallotResults | null }) | null = entry.initialAgmRound.included && entry.initialAgmRound.ballotId ? {
        ballotId: entry.initialAgmRound.ballotId,
        proposalId: entry.policyId,
        policyRevisionId: rev.revisionId,
        roundId: initialRoundData.id,
        title: entry.title,
        domain: entry.domain,
        status: "draft",
        opensAt: new Date(initialRoundData.openingInclusiveUtc),
        closesAt: new Date(initialRoundData.closingExclusiveUtc),
        results: null,
      } : null;
      return {
        ...entry,
        id: entry.policyId,
        slug: entry.anchor,
        sectionPath: entry.domainSlug,
        activeRevisionId: rev.revisionId,
        publishedRevisionId: rev.revisionId,
        consultationRoundId: roundMatch[0]?.roundId ?? null,
        provenance: {
          ...entry.provenance,
          classification: entry.provenance.category,
        },
        activeRevision: rev,
        pendingSettledRevision: null,
        revisions: [rev],
        consultationRounds: roundMatch,
        submissions: [],
        ballot: ballotMatch,
        adoptedRevisionId: null,
        adoptionIsSynthetic: false,
        syntheticFixture: false,
      };
    });
  }

  await closeExpiredBallots(db);
  const [dbRevisions, dbRounds, dbSubmissions, dbBallots] = await Promise.all([
    db.collection<PolicyRevisionRecord>("policy_revisions").find({}, { projection: { _id: 0 } }).sort({ importedAt: 1, createdAt: 1, version: 1 }).toArray(),
    db.collection<{ roundId: string; program?: string; label?: string; status: string; opensAt: Date; closesAt: Date; policyIds?: string[]; syntheticFixture?: boolean; fixtureNotice?: string }>("consultation_rounds").find({}, { projection: { _id: 0 } }).toArray(),
    db.collection<{ submissionId: string; roundId: string; policyId: string; policyRevisionId: string; kind: string; title?: string; body: string; status: string; createdAt: Date; moderatorResponse?: string; syntheticFixture?: boolean }>("consultation_submissions").find(
      { status: { $in: ["accepted", "needs-changes"] } },
      { projection: { _id: 0 } },
    ).sort({ createdAt: -1 }).toArray(),
    db.collection<BallotRecord>("ballots").find({}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray(),
  ]);

  const revisionsByPolicy = new Map<string, PolicyRevisionRecord[]>();
  for (const rev of dbRevisions) {
    const list = revisionsByPolicy.get(rev.policyId) ?? [];
    list.push(rev);
    revisionsByPolicy.set(rev.policyId, list);
  }

  const ballotsByProposal = new Map<string, BallotRecord[]>();
  for (const ballot of dbBallots) {
    const list = ballotsByProposal.get(ballot.proposalId) ?? [];
    list.push(ballot);
    ballotsByProposal.set(ballot.proposalId, list);
  }

  const submissionsByPolicy = new Map<string, typeof dbSubmissions>();
  for (const sub of dbSubmissions) {
    const list = submissionsByPolicy.get(sub.policyId) ?? [];
    list.push(sub);
    submissionsByPolicy.set(sub.policyId, list);
  }

  // Include both baseline 76 policies and any newly created policies in MongoDB
  const seenPolicyIds = new Set(baselineCatalogue.map((e) => e.policyId));
  const extraEntries: PolicyCatalogueEntry[] = [];
  for (const [policyId, revs] of revisionsByPolicy.entries()) {
    if (seenPolicyIds.has(policyId) || !revs.length) continue;
    const initial = revs[0]!;
    const initialDetails = initial.details ?? initial.body ?? "";
    extraEntries.push({
      policyId,
      version: initial.version,
      title: initial.title,
      division: initial.division ?? "RECLAIM OUR ECONOMY",
      domain: initial.domain ?? "Additional Policy Proposals",
      domainSummary: "Newly proposed policy under member review.",
      domainSlug: initial.domainSlug ?? "/reclaim-our-economy/build-up-small-businesses/",
      anchor: initial.anchor ?? policyId.toLowerCase(),
      url: initial.url ?? `/policies/?policy=${encodeURIComponent(policyId)}`,
      statement: initial.statement,
      outcomes: initial.outcomes ?? [],
      details: initialDetails,
      detailHtml: initial.detailHtml || renderDetailsToHtml(initialDetails, initial.changeSummary),
      syntheticFixture: Boolean(initial.syntheticFixture),
      fixtureNotice: initial.fixtureNotice,
      provenance: initial.provenance ?? {
        category: "new-proposal",
        classification: "new-proposal",
        label: initial.syntheticFixture ? "Synthetic fixture · New proposal" : "New proposal · Member review",
        summary: initial.syntheticFixture
          ? "SYNTHETIC PREVIEW FIXTURE: Simulated policy proposal for testing continuous policy development (Engage lifecycle). Not an actual party policy."
          : "Newly proposed policy drafted for member consultation and ballot review.",
        flaggedNewInStaticExport: false,
        lineageVerified: true,
        materialEquivalenceVerified: false,
        lineage: [],
        valuesAlignment: [],
      },
      initialAgmRound: {
        included: false,
        roundId: null,
        ballotId: null,
      },
    });
  }

  const allEntries = [...baselineCatalogue, ...extraEntries];
  const views: PolicyLifecycleView[] = [];

  for (const entry of allEntries) {
    const revs = revisionsByPolicy.get(entry.policyId);
    const allRevs = revs && revs.length ? revs : [defaultRevisionFor(entry)];
    const baselineRev = allRevs[0]!;
    const latestRev = allRevs[allRevs.length - 1]!;

    const rounds = dbRounds
      .filter((r) => Array.isArray(r.policyIds) && r.policyIds.includes(entry.policyId))
      .map((r) => ({
        roundId: r.roundId,
        program: r.program ?? r.label ?? r.roundId,
        status: r.status,
        opensAt: r.opensAt,
        closesAt: r.closesAt,
        syntheticFixture: Boolean(r.syntheticFixture),
        fixtureNotice: r.fixtureNotice,
      }));

    const policyBallots = ballotsByProposal.get(entry.policyId) ?? [];
    // Prefer open or closed ballot, or the primary ballot
    const primaryBallot = policyBallots.find((b) => b.status === "open" || b.status === "closed") ?? policyBallots[0] ?? null;
    let ballotWithResults: (BallotRecord & { results?: BallotResults | null; outcome?: "approved" | "not-approved" | "no-valid-votes" | null; syntheticFixture?: boolean }) | null = null;
    let adoptedRevisionId: string | null = null;
    let adoptionIsSynthetic = false;

    if (primaryBallot) {
      const results = primaryBallot.status === "closed" ? await getBallotResults(db, primaryBallot) : null;
      const ballotSynthetic = Boolean(primaryBallot.syntheticFixture) || env.APP_MODE === "preview" || primaryBallot.bindingBallotsEnabled !== true;
      ballotWithResults = { ...primaryBallot, results, outcome: results?.outcome ?? null, syntheticFixture: ballotSynthetic };
      if (results?.outcome === "approved") {
        adoptedRevisionId = primaryBallot.policyRevisionId;
        adoptionIsSynthetic = ballotSynthetic;
      }
    }

    const adoptedRev = adoptedRevisionId
      ? allRevs.find((r) => r.revisionId === adoptedRevisionId || r.version === adoptedRevisionId) ?? null
      : null;

    const ballotCandidateRev = primaryBallot
      ? allRevs.find((r) => r.revisionId === primaryBallot.policyRevisionId || r.version === primaryBallot.policyRevisionId) ?? latestRev
      : latestRev;

    // Only an administratively settled AND approved revision replaces the displayed public policy version;
    // while unapproved, the initial baseline version remains the displayed text and the candidate revision is shown as pending vote.
    const displayedRev = adoptedRev ?? baselineRev;
    const pendingSettledRevision = !adoptedRev && ballotCandidateRev.revisionId !== displayedRev.revisionId
      ? ballotCandidateRev
      : null;

    const displayedDetails = displayedRev.details ?? displayedRev.body ?? entry.details;
    const displayedDetailHtml = displayedRev.detailHtml
      || (displayedRev.revisionId !== baselineRev.revisionId
        ? renderDetailsToHtml(displayedDetails, displayedRev.changeSummary)
        : (entry.detailHtml || renderDetailsToHtml(displayedDetails, displayedRev.changeSummary)));

    const isSyntheticPolicy = Boolean(entry.syntheticFixture || baselineRev.syntheticFixture);

    views.push({
      ...entry,
      id: entry.policyId,
      slug: entry.anchor,
      sectionPath: entry.domainSlug,
      activeRevisionId: ballotCandidateRev.revisionId,
      publishedRevisionId: displayedRev.revisionId,
      consultationRoundId: rounds[0]?.roundId ?? null,
      provenance: {
        ...entry.provenance,
        classification: entry.provenance.category,
      },
      title: displayedRev.title || entry.title,
      statement: displayedRev.statement || entry.statement,
      outcomes: displayedRev.outcomes?.length ? displayedRev.outcomes : entry.outcomes,
      details: displayedDetails,
      detailHtml: displayedDetailHtml,
      activeRevision: displayedRev,
      pendingSettledRevision,
      revisions: allRevs,
      consultationRounds: rounds,
      submissions: submissionsByPolicy.get(entry.policyId) ?? [],
      ballot: ballotWithResults,
      adoptedRevisionId,
      adoptionIsSynthetic,
      syntheticFixture: isSyntheticPolicy,
    });
  }

  return views;
}
