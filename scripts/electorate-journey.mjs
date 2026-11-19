// Electorate journey verification.
//
// Runs the production build against a disposable MongoDB database and checks
// the member-facing consequences of the electorate module:
//
//   1. The "I haven't voted yet" list shows eligible, open, unvoted ballots.
//   2. A closed, voted, unrecognised or ineligible ballot is absent.
//   3. My Engage shows the open matter and the amendment endorsement ballot.
//   4. Casting a vote removes the ballot from the outstanding list.
//
// Set VOTING_TEST_MONGODB_URI to a disposable MongoDB database server.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { MongoClient } from "mongodb";

const mongoUri = process.env.VOTING_TEST_MONGODB_URI;
if (!mongoUri) {
  throw new Error("Set VOTING_TEST_MONGODB_URI to a disposable MongoDB database.");
}

const origin = "http://127.0.0.1:4400";
const dbName = `engage_electorate_e2e_${crypto.randomUUID().replaceAll("-", "")}`;
const cookie = "engage_dev_user=member";
const now = new Date();
const inThreeDays = new Date(now.getTime() + 3 * 86400_000);
const inThirtyDays = new Date(now.getTime() + 30 * 86400_000);
const yesterday = new Date(now.getTime() - 86400_000);

const server = spawn(process.execPath, ["dist/server/entry.mjs"], {
  stdio: "inherit",
  env: {
    ...process.env,
    APP_MODE: "preview",
    MONGODB_URI: mongoUri,
    MONGODB_DB_NAME: dbName,
    HOST: "127.0.0.1",
    PORT: "4400",
    ASTRO_NODE_LOGGING: "disabled",
    PUBLIC_ORIGIN: origin,
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: "electorate-e2e-secret-not-used-in-production",
    RESEND_API_KEY: "",
    AUTH_EMAIL_FROM: "",
    LEGAL_ACCEPTANCE_ENABLED: "false",
  },
});

const client = new MongoClient(mongoUri);
const results = [];
function pass(message) {
  results.push(message);
  console.log(`  ok  ${message}`);
}

const matter = (proposalId, title, overrides = {}) => ({
  proposalId,
  slug: proposalId.toLowerCase(),
  title,
  space: "Governance",
  kind: "policy",
  summary: `${title} summary.`,
  outcomes: [],
  details: "Journey wording.",
  stage: "decide",
  publicationScope: "national",
  ballotRevisionId: `rev-${proposalId}`,
  ballotClosesAt: inThirtyDays,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

function listNeedingVote() {
  return fetch(
    `${origin}/proposals/?stage=decide&focus=needs-vote&q=Journey`,
    { headers: { cookie } },
  );
}

let html = "";
try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(`${origin}/member/`)).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(ready, "Isolated preview server did not start");

  await client.connect();
  const db = client.db(dbName);

  await Promise.all([
    db.collection("branches").insertOne({
      branchId: "branch-nat",
      name: "Fusion National",
      kind: "national",
      recognised: true,
    }),
    db.collection("branches").insertOne({
      branchId: "branch-vic",
      name: "Victoria",
      kind: "state",
      recognised: true,
      parentBranchId: "branch-nat",
    }),
    db.collection("branches").insertOne({
      branchId: "branch-unrecognised",
      name: "Unrecognised",
      kind: "state",
      recognised: false,
    }),
    db.collection("branch_memberships").insertOne({
      memberId: "dev-member-01",
      branchId: "branch-vic",
      status: "active",
    }),
  ]);

  const matters = [
    matter("JOURNEY-NAT", "Journey national open ballot", {
      jurisdictionBranchId: "branch-nat",
      ballotClosesAt: inThreeDays,
    }),
    matter("JOURNEY-VIC", "Journey branch open ballot", {
      jurisdictionBranchId: "branch-vic",
    }),
    matter("JOURNEY-VOTED", "Journey voted ballot", {
      jurisdictionBranchId: "branch-vic",
    }),
    matter("JOURNEY-CLOSED", "Journey closed ballot", {
      jurisdictionBranchId: "branch-vic",
      ballotClosesAt: yesterday,
    }),
    matter("JOURNEY-OTHER", "Journey other branch ballot", {
      jurisdictionBranchId: "branch-nsw",
    }),
    matter("JOURNEY-UNRECOGNISED", "Journey unrecognised ballot", {
      jurisdictionBranchId: "branch-unrecognised",
    }),
  ];
  await Promise.all(matters.map((row) => db.collection("proposals").insertOne(row)));
  await Promise.all(
    matters.map((row) =>
      db.collection("proposal_revisions").insertOne({
        proposalId: row.proposalId,
        revisionId: row.ballotRevisionId,
        contentHash: `hash-${row.proposalId}`,
        snapshot: {
          title: row.title,
          summary: row.summary,
          outcomes: [],
          details: row.details,
        },
        createdAt: now,
      }),
    ),
  );
  await db.collection("proposal_votes").insertOne({
    memberId: "dev-member-01",
    proposalId: "JOURNEY-VOTED",
    ballotId: "proposal:JOURNEY-VOTED",
    revisionId: "rev-JOURNEY-VOTED",
    choice: "approve",
    reason: "",
    updatedAt: now,
    encrypted: false,
  });
  await db.collection("amendments").insertOne({
    amendmentId: "JOURNEY-AMD",
    proposalId: "JOURNEY-NAT",
    title: "Journey amendment",
    status: "voting",
    ballotRevisionId: "rev-JOURNEY-NAT",
    baseRevisionId: "rev-JOURNEY-NAT",
    currentRevisionId: "amd-rev-1",
    ballotAmendmentRevisionId: "amd-rev-1",
    ballotClosesAt: inThreeDays,
    createdAt: now,
    updatedAt: now,
  });

  let response = await listNeedingVote();
  assert.equal(response.status, 200);
  html = await response.text();
  assert.match(html, /Journey national open ballot/);
  assert.match(html, /Journey branch open ballot/);
  assert.doesNotMatch(html, /Journey voted ballot/);
  assert.doesNotMatch(html, /Journey closed ballot/);
  assert.doesNotMatch(html, /Journey other branch ballot/);
  assert.doesNotMatch(html, /Journey unrecognised ballot/);
  pass("the needs-vote list shows only eligible, open, unvoted ballots");

  response = await fetch(`${origin}/member/`, { headers: { cookie } });
  assert.equal(response.status, 200);
  html = await response.text();
  assert.match(html, /Journey national open ballot/);
  assert.match(html, /Amendment: Journey amendment/);
  pass("My Engage shows the open matter and its amendment endorsement ballot");

  response = await fetch(`${origin}/api/votes`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, cookie },
    body: JSON.stringify({
      proposalId: "JOURNEY-NAT",
      choice: "approve",
      reason: "Journey vote.",
    }),
  });
  assert.equal(response.status, 200, `vote failed: ${await response.text()}`);

  response = await listNeedingVote();
  assert.equal(response.status, 200);
  html = await response.text();
  assert.doesNotMatch(html, /Journey national open ballot/);
  assert.match(html, /Journey branch open ballot/);
  pass("casting a vote removes only that ballot from the outstanding list");

  const vote = await db
    .collection("proposal_votes")
    .findOne({ memberId: "dev-member-01", proposalId: "JOURNEY-NAT" });
  assert.equal(vote?.revisionId, "rev-JOURNEY-NAT");
  pass("the vote is bound to the ballot revision and persisted");

  console.log(`\n${results.length} electorate checks passed.`);
} finally {
  await client.db(dbName).dropDatabase().catch(() => {});
  await client.close().catch(() => {});
  server.kill("SIGTERM");
}
