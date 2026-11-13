// RFC 0001 integration browser verification.
//
// Runs the production build against a disposable MongoDB database and verifies
// the governance journeys that changed in Sprint 1:
//
//   1. Opening Decide without a closing date is refused in the interface.
//   2. A future closing date opens the ballot, binds the wording revision and
//      records a stage-transition governance event.
//   3. The member sees the ballot deadline and can vote, then change the vote
//      while the ballot remains open.
//
// This script never contacts production and never uses real member accounts.
// Playwright is supplied through ENGAGE_PLAYWRIGHT_MODULE, as in CI.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { MongoClient } from "mongodb";

const modulePath = process.env.ENGAGE_PLAYWRIGHT_MODULE;
if (!modulePath) {
  throw new Error(
    "Set ENGAGE_PLAYWRIGHT_MODULE to an isolated Playwright index.mjs.",
  );
}
const mongoUri = process.env.VOTING_TEST_MONGODB_URI;
if (!mongoUri) {
  throw new Error(
    "Set VOTING_TEST_MONGODB_URI to a disposable MongoDB replica set.",
  );
}

const { chromium } = await import(pathToFileURL(modulePath).href);
const output = path.resolve("docs/screenshots/rfc0001");
await mkdir(output, { recursive: true });

const origin = "http://127.0.0.1:4398";
const dbName = `engage_rfc_e2e_${crypto.randomUUID().replaceAll("-", "")}`;
const server = spawn(process.execPath, ["dist/server/entry.mjs"], {
  stdio: "inherit",
  env: {
    ...process.env,
    APP_MODE: "preview",
    MONGODB_URI: mongoUri,
    MONGODB_DB_NAME: dbName,
    HOST: "127.0.0.1",
    PORT: "4398",
    ASTRO_NODE_LOGGING: "disabled",
    PUBLIC_ORIGIN: origin,
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: "rfc0001-e2e-secret-not-used-in-production",
    RESEND_API_KEY: "",
    AUTH_EMAIL_FROM: "",
    ENGAGE_DIGEST_ENABLED: "false",
    LEGAL_ACCEPTANCE_ENABLED: "false",
  },
});

const client = new MongoClient(mongoUri);
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
  const adminCookie = "engage_dev_user=administrator";
  const memberCookie = "engage_dev_user=member";
  const results = [];

  // Create a national policy proposal in Deliberate through the real API.
  const createdResponse = await fetch(`${origin}/api/proposals`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: adminCookie,
    },
    body: JSON.stringify({
      title: "Deadline and vote change verification",
      space: "Governance",
      summary: "Synthetic proposal created by the RFC 0001 browser check.",
      stage: "deliberate",
    }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  const proposalId = created.proposal.proposalId;
  const slug = created.proposal.slug;

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([
    { name: "engage_dev_user", value: "administrator", url: origin },
  ]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(`admin: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("400 (Bad Request)")) {
      errors.push(`admin console: ${message.text()}`);
    }
  });

  await page.goto(
    `${origin}/admin/proposals/?edit=${encodeURIComponent(proposalId)}`,
    { waitUntil: "networkidle" },
  );
  await page.selectOption("#editor-stage", "decide");
  await page.locator("#proposal-editor-form button[type=submit]").click();
  const status = page.locator("#editor-status");
  await status.filter({ hasText: /closing date is required/i }).waitFor();

  const closeAt = new Date(Date.now() + 30 * 86400_000);
  const local = new Date(closeAt.getTime() - closeAt.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
  await page.fill("#editor-ballot-closes-at", local);
  page.on("response", async (response) => {
    if (response.url().includes(`/api/proposals/${proposalId}`) && !response.ok()) {
      console.error("PATCH failed", response.status(), await response.text());
    }
  });
  await page.locator("#proposal-editor-form button[type=submit]").click();
  try {
    await page.waitForURL(/\/proposals\/.+\//, { timeout: 20000 });
  } catch (error) {
    console.error("Editor status:", await status.textContent());
    throw error;
  }

  const opened = await db.collection("proposals").findOne({ proposalId });
  assert.equal(opened.stage, "decide");
  assert.ok(opened.ballotRevisionId, "Opening Decide must bind a wording revision");
  assert.ok(opened.ballotClosesAt instanceof Date, "Ballot must have a closing date");
  const transition = await db.collection("governance_events").findOne({
    matterId: proposalId,
    eventType: "proposal.stage_transition",
    "metadata.toStage": "decide",
  });
  assert.ok(transition, "Entering Decide must record a governance event");
  results.push({
    journey: "admin opens ballot with deadline",
    proposalId,
    ballotRevisionId: opened.ballotRevisionId,
    ballotClosesAt: opened.ballotClosesAt.toISOString(),
    governanceEventId: transition.eventId,
  });

  // Member journey: deadline visibility, vote, and vote change.
  const memberContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  await memberContext.addCookies([
    { name: "engage_dev_user", value: "member", url: origin },
  ]);
  const memberPage = await memberContext.newPage();
  memberPage.on("pageerror", (error) => errors.push(`member: ${error.message}`));
  memberPage.on("console", (message) => {
    if (message.type() === "error") errors.push(`member console: ${message.text()}`);
  });
  await memberPage.goto(`${origin}/proposals/${slug}/`, {
    waitUntil: "networkidle",
  });
  await memberPage.getByTestId("ballot-deadline-banner").waitFor();
  await memberPage.screenshot({
    path: path.join(output, "member-ballot-deadline-mobile.png"),
    fullPage: true,
  });

  await memberPage.locator('[data-choice="approve"]').click();
  await memberPage.getByRole("button", { name: "Record vote" }).click();
  await memberPage.getByText("Recorded: Approve").waitFor();
  let vote = await db.collection("proposal_votes").findOne({
    proposalId,
    memberId: "dev-member-01",
  });
  assert.equal(vote.choice, "approve");

  await memberPage.locator('[data-choice="reject"]').click();
  await memberPage.getByRole("button", { name: "Update vote" }).click();
  await memberPage.getByText("Recorded: Reject").waitFor();
  // Wait for the mutation to persist before reading the database.
  for (let attempt = 0; attempt < 40; attempt++) {
    vote = await db.collection("proposal_votes").findOne({
      proposalId,
      memberId: "dev-member-01",
    });
    if (vote?.choice === "reject") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(vote.choice, "reject", "A member must be able to change their vote");
  const voteCount = await db
    .collection("proposal_votes")
    .countDocuments({ proposalId, memberId: "dev-member-01" });
  assert.equal(voteCount, 1, "Changing a vote must update, not duplicate it");
  await memberPage.screenshot({
    path: path.join(output, "member-vote-changed-mobile.png"),
    fullPage: true,
  });
  results.push({
    journey: "member votes and changes vote",
    finalChoice: vote.choice,
    storedVotesForMember: voteCount,
  });

  assert.deepEqual(errors, [], "Uncaught browser errors");

  await writeFile(
    path.join(output, "verification.json"),
    JSON.stringify(
      {
        syntheticAccountsOnly: true,
        productionAccess: false,
        database: dbName,
        results,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ output, results }, null, 2));
} finally {
  await browser?.close();
  try {
    await client.db(dbName).dropDatabase();
  } catch {}
  await client.close();
  server.kill("SIGTERM");
}
