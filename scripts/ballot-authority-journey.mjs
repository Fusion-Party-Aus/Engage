// Ballot authority journey verification.
//
// Runs the production build against a disposable MongoDB database and checks
// the delegated-officer journey that the authority module exists to fix:
//
//   1. A member with no ballot permission cannot open the workspace or bind.
//   2. A delegated branch officer sees the responsibility and the control,
//      and completes the bind through the real API.
//   3. The same officer is refused for a matter whose authority and
//      jurisdiction differ.
//   4. A national administrator still sees and completes the act.
//
// This script never contacts production. Set VOTING_TEST_MONGODB_URI to a
// disposable database server; it uses a fresh database name and drops it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { MongoClient } from "mongodb";

const mongoUri = process.env.VOTING_TEST_MONGODB_URI;
if (!mongoUri) {
  throw new Error("Set VOTING_TEST_MONGODB_URI to a disposable MongoDB database.");
}

const origin = "http://127.0.0.1:4399";
const dbName = `engage_authority_e2e_${crypto.randomUUID().replaceAll("-", "")}`;
const memberCookie = "engage_dev_user=member";
const adminCookie = "engage_dev_user=administrator";

const server = spawn(process.execPath, ["dist/server/entry.mjs"], {
  stdio: "inherit",
  env: {
    ...process.env,
    APP_MODE: "preview",
    MONGODB_URI: mongoUri,
    MONGODB_DB_NAME: dbName,
    HOST: "127.0.0.1",
    PORT: "4399",
    ASTRO_NODE_LOGGING: "disabled",
    PUBLIC_ORIGIN: origin,
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: "ballot-authority-e2e-secret-not-used-in-production",
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

const MATCHING = "jurney-match";
const MISMATCHED = "jurney-mismatch";
const revisionIdFor = (proposalId) => `rev-${proposalId}`;
const now = new Date();
const closesAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

function get(path, cookie) {
  return fetch(`${origin}${path}`, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });
}

function bind(proposalId, cookie) {
  return fetch(`${origin}/api/admin/ballots/bind`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({
      proposalId,
      revisionId: revisionIdFor(proposalId),
      decisionEventId: `DEC-${proposalId}`,
      reason: "Journey verification reviewed the wording snapshot.",
    }),
  });
}

let browser;
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

  await db.collection("branches").insertMany([
    { branchId: "branch-nat", name: "Fusion National", kind: "national", recognised: true },
    { branchId: "branch-vic", name: "Victoria", kind: "state", recognised: true, parentBranchId: "branch-nat" },
    { branchId: "branch-nsw", name: "New South Wales", kind: "state", recognised: true, parentBranchId: "branch-nat" },
  ]);

  const matter = (proposalId, slug, title, jurisdiction) => ({
    proposalId,
    slug,
    title,
    space: "Governance",
    kind: "policy",
    summary: `${title} summary for the authority journey.`,
    outcomes: ["A recorded outcome"],
    details: "Wording under review.",
    stage: "decide",
    publicationScope: "national",
    originatingBranchId: "branch-vic",
    governanceAuthorityBranchId: "branch-vic",
    jurisdictionBranchId: jurisdiction,
    ballotClosesAt: closesAt,
    createdAt: now,
    updatedAt: now,
  });
  await db.collection("proposals").insertMany([
    matter(MATCHING, "jurney-matching", "Journey matching authority matter", "branch-vic"),
    matter(MISMATCHED, "jurney-mismatched", "Journey mismatched authority matter", "branch-nsw"),
  ]);
  await db.collection("proposal_revisions").insertMany(
    [MATCHING, MISMATCHED].map((proposalId) => ({
      proposalId,
      revisionId: revisionIdFor(proposalId),
      contentHash: `hash-${proposalId}`,
      snapshot: {
        title: `Journey revision ${proposalId}`,
        summary: "Reviewed wording.",
        outcomes: ["A recorded outcome"],
        details: "Exact wording under review.",
      },
      createdAt: now,
    })),
  );

  // 1. A member with no ballot permission cannot enter or act.
  let response = await get(`/admin/proposals/jurney-matching/`, memberCookie);
  assert.equal(response.status, 403, "member is refused the workspace");
  pass("a member without ballot permission is refused the workspace");

  response = await get(`/admin/responsibilities/`, memberCookie);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /No administrator responsibilities/);
  pass("a member without ballot permission has no responsibility queue");

  response = await bind(MATCHING, memberCookie);
  assert.equal(response.status, 403);
  assert.equal(
    (await response.json()).error,
    "Administrator access required.",
  );
  pass("a member without ballot permission cannot bind");

  // 2. Delegate ballots.bind for branch-vic to the development member.
  await db.collection("rbac_roles").insertOne({
    roleId: "role_journey_ballot_officer",
    name: "Journey Ballot Officer",
    description: "Branch ballot administration for the journey check.",
    scope: "branch",
    permissions: ["ballots.bind"],
    createdAt: now,
    updatedAt: now,
  });
  await db.collection("rbac_assignments").insertOne({
    assignmentId: "assignment_journey_ballot_officer",
    memberId: "dev-member-01",
    roleId: "role_journey_ballot_officer",
    scopeType: "branch",
    branchId: "branch-vic",
    status: "active",
    assignedBy: "journey",
    assignedAt: now,
  });

  // 3. The delegated officer discovers the work and completes it.
  response = await get(`/admin/responsibilities/`, memberCookie);
  assert.equal(response.status, 200);
  let html = await response.text();
  assert.match(html, /Bind wording/);
  assert.match(html, /\/admin\/proposals\/jurney-matching\/#bind-ballot/);
  assert.doesNotMatch(html, /\/admin\/proposals\/jurney-mismatched\/#bind-ballot/);
  pass("the delegated officer sees the matching bind responsibility and not the mismatched one");

  response = await get(`/admin/proposals/jurney-matching/`, memberCookie);
  assert.equal(response.status, 200);
  html = await response.text();
  assert.match(html, /id="bind-ballot"/);
  assert.match(html, /Bind reviewed wording/);
  assert.doesNotMatch(html, /Binding and recording a ballot result require/);
  pass("the delegated officer sees the bind control on the matching matter");

  response = await get(`/admin/proposals/jurney-mismatched/`, memberCookie);
  assert.equal(response.status, 403);
  html = await response.text();
  assert.doesNotMatch(html, /id="bind-ballot"/);
  pass("the delegated officer is refused the mismatched-authority workspace");

  response = await bind(MATCHING, memberCookie);
  assert.equal(response.status, 201, `bind failed: ${await response.text()}`);
  const bound = await db.collection("proposals").findOne({ proposalId: MATCHING });
  assert.equal(bound?.ballotRevisionId, revisionIdFor(MATCHING));
  assert.equal(
    await db.collection("governance_events").countDocuments({
      eventType: "ballot.bound",
      matterId: MATCHING,
    }),
    1,
  );
  pass("the delegated officer binds the matching matter and the event is recorded");

  response = await bind(MISMATCHED, memberCookie);
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /not authorised to review this ballot/i);
  pass("the delegated officer cannot bind a matter whose authority and jurisdiction differ");

  // 4. A national administrator still sees and completes the act.
  response = await get(`/admin/proposals/jurney-mismatched/`, adminCookie);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /id="bind-ballot"/);
  response = await bind(MISMATCHED, adminCookie);
  assert.equal(response.status, 201, `admin bind failed: ${await response.text()}`);
  const adminBound = await db.collection("proposals").findOne({ proposalId: MISMATCHED });
  assert.equal(adminBound?.ballotRevisionId, revisionIdFor(MISMATCHED));
  pass("a national administrator still sees and completes the act");

  console.log(`\n${results.length} journey checks passed.`);
} finally {
  if (browser) await browser.close().catch(() => {});
  await client.db(dbName).dropDatabase().catch(() => {});
  await client.close().catch(() => {});
  server.kill("SIGTERM");
}
