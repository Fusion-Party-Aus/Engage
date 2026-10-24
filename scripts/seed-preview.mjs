#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const initialRound = JSON.parse(await readFile(resolve(root, "src/data/initial-round.json"), "utf8"));
const policies = JSON.parse(await readFile(resolve(root, "src/data/policies.json"), "utf8"));
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
const byId = new Map(initialRound.policies.map((policy) => [policy.id, policy]));
const simulationFixtureSpecs = [
  ["simulation-housing-01", "Solve the Housing Crisis", "POL-010"],
  ["simulation-democracy-01", "Renew Our Democracy", "POL-039"],
  ["simulation-small-business-01", "Build up Small Businesses", "POL-025"],
  ["simulation-communities-01", "Rebuild Our Communities", "POL-047"],
];

const revisions = initialRound.policies.map((policy) => ({
  policyId: policy.id,
  revisionId: policy.policyVersion,
  version: policy.policyVersion,
  title: policy.title,
  domain: policy.domain,
  statement: policy.statement,
  outcomes: policy.outcomes,
  body: policy.details,
  source: initialRound.source,
  importedAt: now,
}));

const formalBallots = initialRound.policies.map((policy) => ({
  ballotId: policy.ballot.id,
  proposalId: policy.id,
  policyRevisionId: policy.policyVersion,
  title: policy.title,
  domain: policy.domain,
  mode: "formal",
  status: "draft",
  opensAt: new Date(policy.ballot.opensAt),
  closesAt: new Date(policy.ballot.closesAt),
  choices: ["approve", "do-not-approve"],
  mandatoryDoNotApproveReason: false,
  bindingBallotsEnabled: false,
  createdAt: now,
}));

const initialRoundRecord = {
  roundId: initialRound.id,
  version: initialRound.version,
  program: initialRound.program,
  timezone: initialRound.timezone,
  status: "draft",
  opensAt: new Date(initialRound.openingInclusiveUtc),
  closesAt: new Date(initialRound.closingExclusiveUtc),
  meeting: initialRound.meeting,
  rules: initialRound.rules,
  policyIds: initialRound.policies.map(({ id }) => id),
  activationGates: initialRound.activationGates,
  bindingBallotsEnabled: false,
  createdAt: now,
};

const previewRound = {
  roundId: "preview-demo-consultation",
  label: "Synthetic preview consultation",
  status: "open",
  synthetic: true,
  opensAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
  closesAt: new Date("2099-01-01T00:00:00.000Z"),
  policyIds: initialRound.policies.map(({ id }) => id),
  createdAt: now,
};

const simulationBallots = simulationFixtureSpecs.map(([ballotId, domain, policyId]) => {
  const policy = byId.get(policyId);
  if (!policy) throw new Error(`Missing policy fixture: ${policyId}`);
  return {
    ballotId,
    proposalId: policy.id,
    policyRevisionId: policy.policyVersion,
    title: `Synthetic preview: ${policy.title}`,
    domain,
    mode: "simulation",
    status: "open",
    opensAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
    closesAt: new Date("2099-01-01T00:00:00.000Z"),
    choices: ["approve", "do-not-approve"],
    synthetic: true,
    createdAt: now,
  };
});

console.log(JSON.stringify({
  database: process.env.MONGODB_DB_NAME ?? "<not connected>",
  migratedPolicies: policies.length,
  policyRevisions: revisions.length,
  initialRound: { roundId: initialRoundRecord.roundId, status: initialRoundRecord.status, ballots: formalBallots.length },
  previewConsultation: previewRound.roundId,
  simulationBallots: simulationBallots.map(({ ballotId }) => ballotId),
  writes: !dryRun,
}, null, 2));

if (!dryRun) {
  const { MongoClient } = await import("mongodb");
  const client = await new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5_000 }).connect();
  try {
    const db = client.db(process.env.MONGODB_DB_NAME);
    await Promise.all([
      db.collection("policy_revisions").createIndex({ policyId: 1, version: 1 }, { unique: true, name: "policy_version_unique" }),
      db.collection("consultation_rounds").createIndex({ status: 1, opensAt: 1, closesAt: 1 }),
      db.collection("consultation_submissions").createIndex({ memberId: 1, createdAt: -1 }),
      db.collection("consultation_submissions").createIndex({ status: 1, createdAt: 1 }),
      db.collection("ballots").createIndex({ ballotId: 1 }, { unique: true, name: "ballot_id_unique" }),
      db.collection("ballots").createIndex({ mode: 1, status: 1, opensAt: 1, closesAt: 1 }),
      db.collection("votes").createIndex({ ballotId: 1, memberId: 1 }, { unique: true, name: "one_current_vote_per_member_ballot" }),
      db.collection("preview_votes").createIndex({ ballotId: 1, memberId: 1 }, { unique: true, name: "one_current_preview_vote_per_member_ballot" }),
      db.collection("application_roles").createIndex({ memberId: 1, role: 1 }, { unique: true, name: "member_role_unique" }),
      db.collection("operational_audit").createIndex({ createdAt: -1 }),
      db.collection("mutation_rate_limits").createIndex({ scope: 1, subjectId: 1, window: 1 }, { unique: true, name: "rate_limit_window_unique" }),
      db.collection("mutation_rate_limits").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "rate_limit_expiry" }),
    ]);
    for (const revision of revisions) {
      await db.collection("policy_revisions").updateOne(
        { policyId: revision.policyId, version: revision.version },
        { $setOnInsert: revision },
        { upsert: true },
      );
    }
    await db.collection("consultation_rounds").updateOne({ roundId: initialRoundRecord.roundId }, { $set: initialRoundRecord }, { upsert: true });
    await db.collection("consultation_rounds").updateOne({ roundId: previewRound.roundId }, { $set: previewRound }, { upsert: true });
    for (const ballot of [...formalBallots, ...simulationBallots]) {
      await db.collection("ballots").updateOne({ ballotId: ballot.ballotId }, { $set: ballot }, { upsert: true });
    }
    console.log("Preview data and indexes are ready. No sample votes or member records were created.");
  } finally {
    await client.close();
  }
}
