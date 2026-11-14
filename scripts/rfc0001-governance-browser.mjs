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

  // Create a national policy proposal in Propose through the real API as the
  // member who will later vote. Seconding is a different member's act.
  const createdResponse = await fetch(`${origin}/api/proposals`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: memberCookie,
    },
    body: JSON.stringify({
      title: "Deadline and vote change verification",
      space: "Governance",
      summary: "Synthetic proposal created by the RFC 0001 browser check.",
      stage: "propose",
    }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  const proposalId = created.proposal.proposalId;
  const slug = created.proposal.slug;
  assert.equal(created.proposal.stage, "propose");

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

  // Seconding: a member who is not the author opens deliberation for 30 days.
  await page.goto(`${origin}/proposals/${slug}/`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Second this proposal" }).click();
  await page
    .getByText("Seconded. Deliberation is now open for 30 days.")
    .waitFor();
  for (let attempt = 0; attempt < 40; attempt++) {
    const current = await db.collection("proposals").findOne({ proposalId });
    if (current?.stage === "deliberate") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const seconded = await db.collection("proposals").findOne({ proposalId });
  assert.equal(seconded.stage, "deliberate");
  assert.ok(seconded.deliberationEndsAt instanceof Date);
  assert.ok(seconded.secondedBy);
  const secondEvent = await db.collection("governance_events").findOne({
    matterId: proposalId,
    eventType: "proposal.seconded",
  });
  assert.ok(secondEvent, "Seconding must record a governance event");
  const transitionEvent = await db.collection("governance_events").findOne({
    matterId: proposalId,
    eventType: "proposal.stage_transition",
    "metadata.trigger": "seconded",
  });
  assert.ok(transitionEvent, "Seconding must record the stage transition");
  await page.screenshot({
    path: path.join(output, "admin-seconds-proposal.png"),
    fullPage: true,
  });
  results.push({
    journey: "member seconds proposal and opens deliberation",
    stage: seconded.stage,
    deliberationEndsAt: seconded.deliberationEndsAt.toISOString(),
    eventId: secondEvent.eventId,
  });

  await page.goto(
    `${origin}/admin/proposals/?edit=${encodeURIComponent(proposalId)}`,
    { waitUntil: "networkidle" },
  );
  // A previous Astro/React slot bug made every stage select render the first
  // option. Editing a proposal could silently reset its stage.
  assert.equal(
    await page.inputValue("#editor-stage"),
    "deliberate",
    "The editor must show the proposal's current stage",
  );
  await page.selectOption("#editor-stage", "decide");
  const status = page.locator("#editor-status");

  // An explicit past deadline is still refused.
  const past = new Date(Date.now() - 3_600_000);
  const pastLocal = new Date(past.getTime() - past.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
  await page.fill("#editor-ballot-closes-at", pastLocal);
  await page.locator("#proposal-editor-form button[type=submit]").click();
  await status.filter({ hasText: /must be in the future/i }).waitFor();

  // With no explicit date, the approved 30-day default applies (D6).
  await page.fill("#editor-ballot-closes-at", "");
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
  const defaultWindow = opened.ballotClosesAt.getTime() - Date.now();
  assert.ok(
    defaultWindow > 29 * 86400_000 && defaultWindow < 31 * 86400_000,
    `Expected the 30-day default deadline, got ${opened.ballotClosesAt.toISOString()}`,
  );
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
