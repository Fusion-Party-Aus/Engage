import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createMemoryDb } from "./db.ts";
import { approveReengagementCampaign, runApprovedReengagementBatch } from "./member-reengagement.ts";
import {
  dispatchMemberNotification,
  getMemberNotificationPreferences,
  listMemberNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  updateMemberNotificationPreferences,
} from "./notifications.ts";
import {
  listMemberPushSubscriptions,
  registerPushSubscription,
  revokePushSubscription,
  sendWebPushToMember,
} from "./web-push.ts";

const TEST_ENV = {
  VAPID_PUBLIC_KEY: "test-vapid-public",
  VAPID_PRIVATE_KEY: "test-vapid-private",
  VAPID_SUBJECT: "mailto:notifications@fusionparty.org.au",
  RESEND_API_KEY: "re_test_key",
  AUTH_EMAIL_FROM: "Engage <noreply@engage.fusionparty.org.au>",
  ENGAGE_EMAIL_SECRET: "test-email-secret-32-chars-minimum",
  PUBLIC_ORIGIN: "https://engage.fusionparty.org.au",
};

test("Web Push subscription lifecycle: multi-device registration, revocation, and 404/410 cleanup", async () => {
  const db = createMemoryDb();
  const sub1 = await registerPushSubscription(db, "m-1", {
    endpoint: "https://push.example.com/sub-1",
    keys: { p256dh: "p256-1", auth: "auth-1" },
    deviceLabel: "Desktop Firefox",
  });
  await registerPushSubscription(db, "m-1", {
    endpoint: "https://push.example.com/sub-2",
    keys: { p256dh: "p256-2", auth: "auth-2" },
    deviceLabel: "Mobile Safari",
  });

  let active = await listMemberPushSubscriptions(db, "m-1");
  assert.equal(active.length, 2);

  const delivered: string[] = [];
  const result = await sendWebPushToMember(
    db,
    TEST_ENV,
    "m-1",
    {
      title: "Ballot closing soon",
      body: "Voting closes tomorrow.",
      url: "/proposals/sample/",
      tag: "engage-closing_deadlines",
    },
    {
      sender: async (sub) => {
        if (sub.endpoint.endsWith("/sub-2")) {
          const err = new Error("Gone") as Error & { statusCode: number };
          err.statusCode = 410;
          throw err;
        }
        delivered.push(sub.endpoint);
        return { statusCode: 201 };
      },
    },
  );

  assert.equal(result.sent, 1);
  assert.equal(result.cleanedUp, 1);
  assert.deepEqual(delivered, ["https://push.example.com/sub-1"]);

  active = await listMemberPushSubscriptions(db, "m-1");
  assert.equal(active.length, 1);
  assert.equal(active[0]?.subscriptionId, sub1.subscriptionId);

  const revoked = await revokePushSubscription(db, "m-1", sub1.subscriptionId);
  assert.equal(revoked, true);
  assert.equal((await listMemberPushSubscriptions(db, "m-1")).length, 0);
});

test("Notification consent isolation: push stays disabled even when email is enabled", async () => {
  const db = createMemoryDb();
  const prefs = await getMemberNotificationPreferences(db, "m-consent", true);
  assert.equal(prefs.email.new_ballots, true);
  assert.equal(prefs.push.new_ballots, false);
  assert.equal(prefs.push.closing_deadlines, false);
  assert.equal(prefs.push.contribution_responses, false);
  assert.equal(prefs.push.governance_outcomes, false);
  assert.equal(prefs.push.account_membership, false);
});

test("Dispatch coordinates in-app inbox, deduplication, and lock-screen confidentiality", async () => {
  const db = createMemoryDb();
  await registerPushSubscription(db, "m-dispatch", {
    endpoint: "https://push.example.com/sub-dispatch",
    keys: { p256dh: "p256", auth: "auth" },
  });
  await updateMemberNotificationPreferences(db, "m-dispatch", {
    push: { new_ballots: true },
  });

  const payloads: Array<{ title: string; body: string; url: string }> = [];
  const pushSender = async (_sub: unknown, rawPayload: string) => {
    payloads.push(JSON.parse(rawPayload));
    return { statusCode: 201 };
  };

  const first = await dispatchMemberNotification(db, TEST_ENV, {
    memberId: "m-dispatch",
    topic: "new_ballots",
    title: "Secret Branch Motion",
    body: "Confidential branch wording is open for vote.",
    href: "/proposals/secret-motion/",
    dedupeKey: "ballot-open:secret-motion",
    isConfidential: true,
    pushSender,
  });

  assert.equal(first.inAppCreated, true);
  assert.equal(first.push.sent, 1);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0]?.title, "Fusion Engage update");
  assert.equal(payloads[0]?.body.includes("Secret Branch Motion"), false);

  // Duplicate dispatch with same dedupeKey must not create a second notification or push
  const duplicate = await dispatchMemberNotification(db, TEST_ENV, {
    memberId: "m-dispatch",
    topic: "new_ballots",
    title: "Secret Branch Motion",
    body: "Confidential branch wording is open for vote.",
    href: "/proposals/secret-motion/",
    dedupeKey: "ballot-open:secret-motion",
    isConfidential: true,
    pushSender,
  });

  assert.equal(duplicate.inAppCreated, false);
  assert.equal(duplicate.push.sent, 0);
  assert.equal(payloads.length, 1);

  const inbox = await listMemberNotifications(db, "m-dispatch", 10);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0]?.title, "Secret Branch Motion");
  assert.equal(inbox[0]?.readAt, null);

  await markNotificationRead(db, "m-dispatch", inbox[0]!.notificationId);
  const afterRead = await listMemberNotifications(db, "m-dispatch", 10);
  assert.ok(afterRead[0]?.readAt);

  // Create one more unread and test markAllNotificationsRead
  await dispatchMemberNotification(db, TEST_ENV, {
    memberId: "m-dispatch",
    topic: "governance_outcomes",
    title: "Outcome recorded",
    body: "A proposal you voted on has concluded.",
    href: "/proposals/outcome/",
    dedupeKey: "outcome:1",
    pushSender,
  });
  const markedAll = await markAllNotificationsRead(db, "m-dispatch");
  assert.equal(markedAll, 1);
});

test("Approved re-engagement batch requires approval, respects consent, and deduplicates", async () => {
  const db = createMemoryDb();
  const actor = {
    memberId: "admin-1",
    name: "Admin",
    email: "admin@fusionparty.org.au",
    status: "verified" as const,
    canParticipate: true,
    isAdmin: true,
    isStaff: false,
    isOfficer: true,
    role: "administrator" as const,
  };
  await db.collection("user").insertOne({
    _id: "m-target" as any,
    email: "ethan.c@fusionparty.org.au",
    name: "Ethan",
    emailVerified: true,
    createdAt: new Date("2025-11-01T00:00:00Z"),
  });
  await db.collection("user").insertOne({
    _id: "m-opted-out" as any,
    email: "optedout@example.com",
    name: "Opted Out",
    emailVerified: true,
    createdAt: new Date("2025-11-01T00:00:00Z"),
  });
  await db.collection("engagement_email_preferences").insertOne({
    memberId: "m-opted-out",
    digestEnabled: false,
    suppressed: false,
  });
  await db.collection("memberships").insertOne({
    memberId: "m-target",
    status: "verified",
    verifiedAt: new Date("2025-11-01T00:00:00Z"),
  });
  await db.collection("engagement_email_preferences").insertOne({
    memberId: "m-target",
    digestEnabled: true,
    suppressed: false,
  });
  await db.collection("memberships").insertOne({
    memberId: "m-opted-out",
    status: "verified",
    verifiedAt: new Date("2025-11-01T00:00:00Z"),
  });

  await assert.rejects(
    () =>
      runApprovedReengagementBatch(db, TEST_ENV, actor, {
        campaignId: "missing-campaign",
        batchSize: 10,
      }),
    /explicit administrative approval/i,
  );

  const campaign = await approveReengagementCampaign(
    db,
    actor,
    {
      campaignId: "reengage-test-1",
      cutoff: new Date("2026-01-01T00:00:00Z"),
      note: "Controlled re-engagement check",
    },
    new Date("2026-02-01T00:00:00Z"),
  );

  await db.collection("proposals").insertOne({
    proposalId: "prop-reengage-1",
    slug: "test-open-ballot",
    title: "Test Open Ballot",
    summary: "A test ballot for re-engagement verification.",
    stage: "decide",
    space: "policy",
    visibility: "members",
    ballotClosesAt: new Date("2027-01-14T12:59:00Z"),
    createdAt: new Date("2026-01-10T00:00:00Z"),
    updatedAt: new Date("2026-01-10T00:00:00Z"),
  });

  const sentTo: string[] = [];
  const mockFetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    sentTo.push(...(Array.isArray(body.to) ? body.to : [body.to]));
    return new Response(JSON.stringify({ id: `prov-${sentTo.length}` }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const firstRun = await runApprovedReengagementBatch(db, TEST_ENV, actor, {
    campaignId: campaign.campaignId,
    batchSize: 10,
    send: mockFetch,
    now: new Date("2026-02-01T00:00:00Z"),
  });

  assert.equal(firstRun.sent, 1);
  assert.deepEqual(sentTo, ["ethan.c@fusionparty.org.au"]);

  // Re-running the same campaign must deduplicate via outbox
  const secondRun = await runApprovedReengagementBatch(db, TEST_ENV, actor, {
    campaignId: campaign.campaignId,
    batchSize: 10,
    send: mockFetch,
    now: new Date("2026-02-01T00:00:00Z"),
  });
  assert.equal(secondRun.sent, 0);
});

test("PWA manifest and service worker enforce static-only caching and push handlers", () => {
  const manifest = JSON.parse(readFileSync("public/manifest.webmanifest", "utf8"));
  assert.equal(manifest.name, "Fusion Engage");
  assert.equal(manifest.display, "standalone");
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2);

  const sw = readFileSync("public/sw.js", "utf8");
  assert.ok(sw.includes('url.pathname.startsWith("/api/")'), "SW must bypass /api/");
  assert.ok(sw.includes('request.mode === "navigate"'), "SW must bypass navigation");
  assert.ok(sw.includes('addEventListener("push"'), "SW must handle push events");
  assert.ok(sw.includes('addEventListener("notificationclick"'), "SW must handle notificationclick");
});
