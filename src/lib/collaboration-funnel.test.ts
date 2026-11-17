import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryDb } from "./db.ts";
import { seedPilotInitiative, submitContribution } from "./collaboration.ts";
import { PILOT_SLUG } from "./collaboration-options.ts";
import {
  FUNNEL_COLLECTION,
  funnelDay,
  parseFunnelEvent,
  readFunnelSummary,
  recordFunnelEvent,
} from "./collaboration-funnel.ts";

const NOW = new Date("2026-11-17T10:00:00.000Z");

test("a funnel row holds only the invitation, day, stage, count and expiry", async () => {
  const db = createMemoryDb();
  await recordFunnelEvent(db, PILOT_SLUG, "view", NOW);
  await recordFunnelEvent(db, PILOT_SLUG, "view", NOW);
  const rows = await db.collection(FUNNEL_COLLECTION).find({}).toArray();
  assert.equal(rows.length, 1);
  assert.deepEqual(
    Object.keys(rows[0]!).filter((key) => key !== "_id").sort(),
    ["count", "day", "expiresAt", "initiativeSlug", "stage"],
  );
  assert.equal(rows[0]?.count, 2);
  assert.equal(rows[0]?.day, "2026-11-17");
  assert.equal(rows[0]?.stage, "view");
  assert.equal(JSON.stringify(rows[0]).includes("127.0.0.1"), false);
});

test("the summary sums the window, separates invitations and ignores older days", async () => {
  const db = createMemoryDb();
  const old = new Date(NOW.getTime() - 90 * 86_400_000);
  await recordFunnelEvent(db, PILOT_SLUG, "view", NOW);
  await recordFunnelEvent(db, PILOT_SLUG, "view", NOW);
  await recordFunnelEvent(db, PILOT_SLUG, "start", NOW);
  await recordFunnelEvent(db, PILOT_SLUG, "submitted", NOW);
  await recordFunnelEvent(db, PILOT_SLUG, "account_intent", NOW);
  await recordFunnelEvent(db, PILOT_SLUG, "view", old);
  await recordFunnelEvent(db, "another-invitation", "view", NOW);

  const summary = await readFunnelSummary(db, PILOT_SLUG, { now: NOW });
  assert.equal(summary.windowDays, 30);
  assert.deepEqual(summary.stages, { view: 2, start: 1, submitted: 1, account_intent: 1 });
  assert.deepEqual(summary.rates, {
    startedOfViewed: 50,
    submittedOfStarted: 100,
    accountIntentOfSubmitted: 100,
  });
});

test("rates are zero rather than undefined when nothing has happened", async () => {
  const db = createMemoryDb();
  const summary = await readFunnelSummary(db, PILOT_SLUG, { now: NOW });
  assert.deepEqual(summary.stages, { view: 0, start: 0, submitted: 0, account_intent: 0 });
  assert.deepEqual(summary.rates, {
    startedOfViewed: 0,
    submittedOfStarted: 0,
    accountIntentOfSubmitted: 0,
  });
});

test("only client-side stages with a safe slug are accepted, and nothing else is read", () => {
  assert.deepEqual(parseFunnelEvent({ initiativeSlug: "our-stories", stage: "view" }), {
    initiativeSlug: "our-stories",
    stage: "view",
  });
  assert.deepEqual(parseFunnelEvent({ initiativeSlug: "our-stories", stage: "start" }), {
    initiativeSlug: "our-stories",
    stage: "start",
  });
  assert.deepEqual(
    parseFunnelEvent({ initiativeSlug: "our-stories", stage: "account_intent", email: "x@y.z" }),
    { initiativeSlug: "our-stories", stage: "account_intent" },
  );
  for (const body of [
    null,
    [],
    "view",
    { initiativeSlug: "our-stories", stage: "submitted" },
    { initiativeSlug: "our-stories", stage: "purchase" },
    { initiativeSlug: "Our Stories", stage: "view" },
    { initiativeSlug: "", stage: "view" },
    { initiativeSlug: "../secret", stage: "view" },
  ]) {
    assert.ok("error" in parseFunnelEvent(body), JSON.stringify(body));
  }
});

test("a sent contribution counts once, and an idempotent retry does not count again", async () => {
  const db = createMemoryDb();
  await seedPilotInitiative(db);
  const submission = {
    initiativeSlug: PILOT_SLUG,
    requestId: "12345678-1234-4234-8234-123456789abc",
    answers: { meaning: "A real answer long enough to be accepted by the form." },
    attribution: "anonymous" as const,
    channels: ["website" as const],
    consent: true,
    adultAttested: true,
  };
  await submitContribution(db, submission);
  await submitContribution(db, submission);
  const summary = await readFunnelSummary(db, PILOT_SLUG);
  assert.equal(summary.stages.submitted, 1);
  assert.equal(funnelDay(new Date("2026-11-17T23:30:00.000Z")), "2026-11-17");
});
