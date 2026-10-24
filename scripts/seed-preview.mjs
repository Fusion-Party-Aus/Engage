#!/usr/bin/env node
import { policyTaxonomy } from '../src/lib/platform/taxonomy.ts';
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const initialRound = JSON.parse(await readFile(resolve(root, "src/data/initial-round.json"), "utf8"));
const policies = JSON.parse(await readFile(resolve(root, "src/data/policies.json"), "utf8"));
const catalogue = JSON.parse(await readFile(resolve(root, "src/data/policy-catalogue.json"), "utf8"));
const dryRun = process.argv.includes("--dry-run");

if (process.env.APP_MODE !== "preview") {
  throw new Error("Refusing to seed: APP_MODE must be exactly 'preview'.");
}
if (!dryRun && !process.argv.includes("--confirm-preview")) {
  throw new Error("Pass --confirm-preview to write only to the isolated preview database.");
}
if (!dryRun && (!process.env.MONGODB_URI || !process.env.MONGODB_DB_NAME)) {
  throw new Error("Set MONGODB_URI and MONGODB_DB_NAME for the isolated preview database.");
}

const now = new Date();
const roundPolicyMap = new Map(initialRound.policies.map((policy) => [policy.id, policy]));

// Seed all 76 baseline policy revisions with full layered content and provenance
const revisions = catalogue.map((entry) => {
  const roundPolicy = roundPolicyMap.get(entry.policyId);
  const version = roundPolicy ? roundPolicy.policyVersion : entry.version;
  return {
    policyId: entry.policyId,
    revisionId: version,
    version,
    title: entry.title,
    division: entry.division,
    ...policyTaxonomy(entry),
    domainSlug: entry.domainSlug,
    anchor: entry.anchor,
    url: entry.url,
    statement: entry.statement,
    outcomes: entry.outcomes,
    details: entry.details,
    body: entry.details,
    detailHtml: entry.detailHtml,
    provenance: entry.provenance,
    source: initialRound.source,
    importedAt: now,
    createdAt: now,
  };
});

// Add synthetic settled revision fixture v2 for POL-010 to demonstrate Existing -> Proposed -> Member Review -> Settled Revision -> Vote -> Recorded Outcome
const pol010Base = catalogue.find((e) => e.policyId === "POL-010");
const settledPol010Revision = {
  policyId: "POL-010",
  revisionId: "POL-010:v2-settled",
  version: "v2-settled",
  title: pol010Base.title,
  division: pol010Base.division,
  ...policyTaxonomy(pol010Base),
  domainSlug: pol010Base.domainSlug,
  anchor: pol010Base.anchor,
  url: pol010Base.url,
  statement: "Implement a nationally consistent Land Value Tax framework that applies by default, abolishes residential stamp duty with a five-year credit window for prior stamp duty paid, and requires a broad land-only tax base while allowing states to displace the federal tax with a compliant state system.",
  outcomes: pol010Base.outcomes,
  details: `${pol010Base.details}\n\n**[SYNTHETIC PREVIEW FIXTURE] Settled revision note (v2-settled)**\n\nSynthetic test fixture demonstrating how a revision is settled after member consultation (adding a five-year lookback window for crediting prior residential stamp duty). Not an actual party decision.`,
  body: `${pol010Base.details}\n\n**[SYNTHETIC PREVIEW FIXTURE] Settled revision note (v2-settled)**\n\nSynthetic test fixture demonstrating how a revision is settled after member consultation (adding a five-year lookback window for crediting prior residential stamp duty). Not an actual party decision.`,
  changeSummary: "[SYNTHETIC PREVIEW FIXTURE] Simulated post-consultation amendment adding a five-year stamp duty credit window (not an actual party decision).",
  detailHtml: pol010Base.detailHtml,
  provenance: pol010Base.provenance,
  syntheticFixture: true,
  fixtureNotice: "SYNTHETIC PREVIEW FIXTURE — Simulated settled revision for testing ballot workflow; not an actual Fusion party policy revision or decision.",
  createdAt: new Date(now.getTime() + 1000),
  createdBy: "preview-admin-01",
};

// All 36 initial AGM review round ballots use the unified ballots collection (no separate simulation vs formal mode split)
// Four representative proposals across the four review domains are open in preview so members can exercise voting immediately
const openPreviewPolicyIds = new Set(["POL-010", "POL-025", "POL-039", "POL-047"]);
const agmBallots = initialRound.policies.map((policy) => {
  const isOpenInPreview = openPreviewPolicyIds.has(policy.id);
  const pinnedRevision = policy.id === "POL-010" ? settledPol010Revision.revisionId : policy.policyVersion;
  return {
    ballotId: policy.ballot.id,
    proposalId: policy.id,
    policyRevisionId: pinnedRevision,
    roundId: initialRound.id,
    title: policy.title,
    summary: policy.statement,
    domain: policy.domain,
    status: isOpenInPreview ? "open" : "draft",
    opensAt: isOpenInPreview ? new Date(now.getTime() - 24 * 60 * 60 * 1000) : new Date(policy.ballot.opensAt),
    closesAt: isOpenInPreview ? new Date("2099-01-01T00:00:00.000Z") : new Date(policy.ballot.closesAt),
    choices: ["approve", "do-not-approve"],
    mandatoryDoNotApproveReason: false,
    bindingBallotsEnabled: false,
    createdAt: now,
  };
});

// Two separate adoption review questions requested by Stewart (Reclaim platform adoption + Horizon visual identity/logo adoption)
const adoptionBallots = [
  {
    ballotId: "adoption-reclaim-platform",
    proposalId: "GOV-RECLAIM-PLATFORM",
    policyRevisionId: "gov-v1:reclaim-platform",
    roundId: initialRound.id,
    title: "Adopt the Reclaim policy platform structure",
    summary: "Adopt the Reclaim policy library structure and progressive-disclosure format as Fusion's member policy platform.",
    domain: "Platform & Branding Review",
    status: "draft",
    opensAt: new Date(initialRound.openingInclusiveUtc),
    closesAt: new Date(initialRound.closingExclusiveUtc),
    choices: ["approve", "do-not-approve"],
    mandatoryDoNotApproveReason: false,
    bindingBallotsEnabled: false,
    createdAt: now,
  },
  {
    ballotId: "adoption-horizon-identity",
    proposalId: "GOV-HORIZON-IDENTITY",
    policyRevisionId: "gov-v1:horizon-identity",
    roundId: initialRound.id,
    title: "Adopt the Horizon visual identity and logo",
    summary: "Adopt the Horizon visual identity, colour palette, and logo across Fusion's public and member platforms.",
    domain: "Platform & Branding Review",
    status: "draft",
    opensAt: new Date(initialRound.openingInclusiveUtc),
    closesAt: new Date(initialRound.closingExclusiveUtc),
    choices: ["approve", "do-not-approve"],
    mandatoryDoNotApproveReason: false,
    bindingBallotsEnabled: false,
    createdAt: now,
  },
];

// Initial AGM review round (open in preview so members can submit comments, amendments, and alternatives on its 36 policies)
const initialRoundRecord = {
  roundId: initialRound.id,
  version: initialRound.version,
  program: initialRound.program,
  label: initialRound.program,
  timezone: initialRound.timezone,
  status: "open",
  opensAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
  closesAt: new Date("2099-01-01T00:00:00.000Z"),
  scheduledOpensAt: new Date(initialRound.openingInclusiveUtc),
  scheduledClosesAt: new Date(initialRound.closingExclusiveUtc),
  meeting: initialRound.meeting,
  rules: initialRound.rules,
  policyIds: initialRound.policies.map(({ id }) => id),
  activationGates: initialRound.activationGates,
  bindingBallotsEnabled: false,
  createdAt: now,
};

// Second ordinary policy proposal & review round (synthetic preview fixture) to validate Engage-readiness (continuous policy development beyond the AGM round)
const followOnPolicyRevision = {
  policyId: "POL-077",
  revisionId: "POL-077:v1-proposed",
  version: "v1-proposed",
  title: "Guarantee Right to Repair for Farm and Consumer Equipment",
  division: "RECLAIM OUR ECONOMY",
  domain: "Build up Small Businesses",
  domainSlug: "/reclaim-our-economy/build-up-small-businesses/",
  anchor: "guarantee-right-to-repair-for-farm-and-consumer-equipment",
  url: "/reclaim-our-economy/build-up-small-businesses/#guarantee-right-to-repair-for-farm-and-consumer-equipment",
  statement: "Require equipment and device manufacturers selling in Australia to provide independent repairers and owners with fair access to diagnostic tools, spare parts, repair manuals, and software resets on non-discriminatory terms.",
  outcomes: [
    "Small businesses, farmers, and households will face lower repair costs and less equipment downtime.",
    "Independent repair workshops will be able to compete fairly with authorised manufacturer service networks.",
    "Premature equipment replacement and electronic waste will decline as repair becomes practical.",
  ],
  details: "**[SYNTHETIC PREVIEW FIXTURE] Design rationale**\n\nSynthetic preview fixture for testing continuous post-AGM policy development. Manufacturers increasingly use software locks, proprietary diagnostics, and parts restrictions to monopolise post-sale repair.",
  body: "**[SYNTHETIC PREVIEW FIXTURE] Design rationale**\n\nSynthetic preview fixture for testing continuous post-AGM policy development. Manufacturers increasingly use software locks, proprietary diagnostics, and parts restrictions to monopolise post-sale repair.",
  detailHtml: "<p><strong>[SYNTHETIC PREVIEW FIXTURE] Design rationale</strong></p><p>Synthetic preview fixture for testing continuous post-AGM policy development. Manufacturers increasingly use software locks, proprietary diagnostics, and parts restrictions to monopolise post-sale repair.</p>",
  syntheticFixture: true,
  fixtureNotice: "SYNTHETIC PREVIEW FIXTURE — Simulated post-AGM policy proposal for testing the Engage lifecycle. Not an actual Fusion party proposal or decision.",
  provenance: {
    category: "new-proposal",
    label: "Synthetic fixture · New proposal",
    summary: "SYNTHETIC PREVIEW FIXTURE: Simulated post-AGM policy proposal for Engage-readiness verification. Not an actual party policy proposal.",
    flaggedNewInStaticExport: false,
    lineageVerified: false,
    materialEquivalenceVerified: false,
    uncertaintyNote: "Synthetic test fixture only — not part of the imported Reclaim baseline or official party platform.",
    lineage: [],
    valuesAlignment: ["Principle: *Inclusive Economic Advancement* — Independent repair rights reduce monopolistic lock-in for small businesses and households."],
  },
  createdAt: now,
  createdBy: "preview-admin-01",
};

const followOnRoundRecord = {
  roundId: "continuous-policy-round-2027-q1",
  version: "2027-01-15",
  program: "[Synthetic Preview Fixture] Continuous policy development round (Q1 2027 simulation)",
  label: "[Synthetic Preview Fixture] Continuous policy development round (Q1 2027 simulation)",
  description: "SYNTHETIC PREVIEW FIXTURE: Simulated post-AGM consultation round used to verify continuous policy creation, amendment, settlement, voting, and publication. Not an actual party consultation schedule.",
  timezone: "Australia/Sydney",
  status: "open",
  opensAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
  closesAt: new Date("2099-01-01T00:00:00.000Z"),
  policyIds: ["POL-077", "POL-001", "POL-033"],
  bindingBallotsEnabled: false,
  syntheticFixture: true,
  fixtureNotice: "SYNTHETIC PREVIEW FIXTURE — Simulated post-AGM consultation round, not an actual party governance event.",
  createdAt: now,
};

const followOnBallot = {
  ballotId: "ballot-pol-077",
  proposalId: "POL-077",
  policyRevisionId: followOnPolicyRevision.revisionId,
  roundId: followOnRoundRecord.roundId,
  title: followOnPolicyRevision.title,
  summary: followOnPolicyRevision.statement,
  domain: followOnPolicyRevision.domain,
  status: "draft",
  opensAt: new Date("2027-02-01T00:00:00.000Z"),
  closesAt: new Date("2027-03-01T00:00:00.000Z"),
  choices: ["approve", "do-not-approve"],
  mandatoryDoNotApproveReason: false,
  bindingBallotsEnabled: false,
  syntheticFixture: true,
  fixtureNotice: "SYNTHETIC PREVIEW FIXTURE — Simulated ballot for Engage lifecycle verification.",
  createdAt: now,
};

console.log(JSON.stringify({
  database: process.env.MONGODB_DB_NAME ?? "<not connected>",
  migratedPolicies: policies.length,
  cataloguePolicies: catalogue.length,
  policyRevisions: revisions.length + 2,
  consultationRounds: [initialRoundRecord.roundId, followOnRoundRecord.roundId],
  ballots: { total: agmBallots.length + adoptionBallots.length + 1, openInPreview: openPreviewPolicyIds.size },
  writes: !dryRun,
}, null, 2));

if (!dryRun) {
  const { MongoClient } = await import("mongodb");
  const client = await new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5_000 }).connect();
  try {
    const db = client.db(process.env.MONGODB_DB_NAME);
    await Promise.all([
      db.collection("policy_revisions").createIndex({ policyId: 1, version: 1 }, { unique: true, name: "policy_version_unique" }),
      db.collection("policy_revisions").createIndex({ policyId: 1, revisionId: 1 }, { unique: true, name: "policy_revision_id_unique" }),
      db.collection("consultation_rounds").createIndex({ roundId: 1 }, { unique: true, name: "round_id_unique" }),
      db.collection("consultation_rounds").createIndex({ status: 1, opensAt: 1, closesAt: 1 }),
      db.collection("consultation_submissions").createIndex({ submissionId: 1 }, { unique: true, name: "submission_id_unique" }),
      db.collection("consultation_submissions").createIndex({ policyId: 1, status: 1, createdAt: 1 }),
      db.collection("consultation_submissions").createIndex({ memberId: 1, createdAt: -1 }),
      db.collection("consultation_submissions").createIndex({ status: 1, createdAt: 1 }),
      db.collection("ballots").createIndex({ ballotId: 1 }, { unique: true, name: "ballot_id_unique" }),
      db.collection("ballots").createIndex({ proposalId: 1, status: 1 }),
      db.collection("ballots").createIndex({ status: 1, opensAt: 1, closesAt: 1 }),
      db.collection("votes").createIndex({ ballotId: 1, memberId: 1 }, { unique: true, name: "one_current_vote_per_member_ballot" }),
      db.collection("application_roles").createIndex({ memberId: 1, role: 1 }, { unique: true, name: "member_role_unique" }),
      db.collection("operational_audit").createIndex({ createdAt: -1 }),
      db.collection("mutation_rate_limits").createIndex({ scope: 1, subjectId: 1, window: 1 }, { unique: true, name: "rate_limit_window_unique" }),
      db.collection("mutation_rate_limits").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "rate_limit_expiry" }),
    ]);
    for (const revision of [...revisions, settledPol010Revision, followOnPolicyRevision]) {
      await db.collection("policy_revisions").updateOne(
        { policyId: revision.policyId, version: revision.version },
        { $set: { ...revision, ...policyTaxonomy(revision) } },
        { upsert: true },
      );
    }
    await db.collection("consultation_rounds").updateOne({ roundId: initialRoundRecord.roundId }, { $set: initialRoundRecord }, { upsert: true });
    await db.collection("consultation_rounds").updateOne({ roundId: followOnRoundRecord.roundId }, { $set: followOnRoundRecord }, { upsert: true });
    // Remove legacy demo-only round and simulation ballots if present
    await db.collection("consultation_rounds").deleteMany({ roundId: "preview-demo-consultation" });
    await db.collection("ballots").deleteMany({ mode: "simulation" });
    for (const ballot of [...agmBallots, ...adoptionBallots, followOnBallot]) {
      await db.collection("ballots").updateOne({ ballotId: ballot.ballotId }, { $set: ballot }, { upsert: true });
    }
    console.log("Policy catalogue, revisions, consultation rounds, and ballots are ready.");
  } finally {
    await client.close();
  }
}
