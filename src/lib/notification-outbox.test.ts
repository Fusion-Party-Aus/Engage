import assert from "node:assert/strict";
import test from "node:test";
import type { Db } from "mongodb";
import { createMemoryDb } from "./db.ts";
import {
  NOTIFICATION_OUTBOX_COLLECTION,
  ballotOpenedDedupeKey,
  buildBallotOpenedPayload,
  buildClosingSoonPayload,
  closingSoonDedupeKey,
  drainNotificationOutbox,
  enqueueBallotOpenedNotifications,
  enqueueClosingSoonNotifications,
  listEligibleBallotMembers,
  type NotificationOutboxRecord,
} from "./notification-outbox.ts";
import { NOTIFICATION_DELIVERIES_COLLECTION } from "./notifications.ts";
import { updateMemberNotificationPreferences } from "./notifications.ts";
import { registerPushSubscription } from "./web-push.ts";

/**
 * In-memory coverage for the notification outbox. Persistence, unique indexes
 * and concurrency are covered against a real replica set in
 * `notification-outbox-mongo.test.ts`; these cases focus on the electorate
 * predicate, content safety and preference behaviour.
 */

const NOW = new Date("2026-11-14T00:00:00.000Z");
const DAY = 86_400_000;
const TEST_ENV = {
  VAPID_PUBLIC_KEY: "test-vapid-public",
  VAPID_PRIVATE_KEY: "test-vapid-private",
  VAPID_SUBJECT: "mailto:notifications@fusionparty.org.au",
  PUBLIC_ORIGIN: "https://engage.fusionparty.org.au",
};

async function seedBranches(db: Db): Promise<void> {
  const branches = [
    { branchId: "branch-nat", name: "Fusion National", kind: "national", recognised: true },
    {
      branchId: "branch-vic",
      name: "Fusion Victoria",
      kind: "state",
      recognised: true,
      parentBranchId: "branch-nat",
    },
    {
      branchId: "branch-unrecognised",
      name: "Fusion Unrecognised",
      kind: "state",
      recognised: false,
      parentBranchId: "branch-nat",
    },
  ];
  for (const branch of branches) {
    await db.collection("branches").insertOne(branch);
  }
}

async function seedMember(
  db: Db,
  memberId: string,
  options: { verified?: boolean; branchIds?: string[]; followedBranchIds?: string[] } = {},
): Promise<void> {
  const verified = options.verified !== false;
  await db.collection("user").insertOne({
    _id: memberId as any,
    name: memberId,
    email: `${memberId}@example.test`,
    emailVerified: true,
    disabled: false,
  });
  await db.collection("memberships").insertOne({
    memberId,
    status: verified ? "verified" : "pending",
  });
  for (const branchId of options.branchIds ?? []) {
    await db.collection("branch_memberships").insertOne({
      memberId,
      branchId,
      status: "active",
      branchRole: "member",
    });
  }
  for (const branchId of options.followedBranchIds ?? []) {
    await db.collection("branch_subscriptions").insertOne({
      memberId,
      branchId,
      status: "following",
    });
  }
}

async function seedProposal(
  db: Db,
  overrides: Record<string, any> = {},
): Promise<Record<string, any>> {
  const proposal = {
    proposalId: "PROP-1",
    slug: "test-motion",
    title: "Test motion",
    space: "Governance",
    summary: "INTERNAL SUMMARY WORDING",
    outcomes: ["INTERNAL OUTCOME WORDING"],
    details: "INTERNAL DETAIL WORDING",
    stage: "decide",
    ballotRevisionId: "rev-1",
    ballotClosesAt: new Date(NOW.getTime() + 3 * DAY),
    publicationScope: "national",
    jurisdictionBranchId: "branch-nat",
    governanceAuthorityBranchId: "branch-nat",
    createdAt: new Date(NOW.getTime() - 30 * DAY),
    updatedAt: new Date(NOW.getTime() - 30 * DAY),
    ...overrides,
  };
  await db.collection("proposals").insertOne(proposal);
  return proposal;
}

async function rows(db: Db): Promise<NotificationOutboxRecord[]> {
  return (await db
    .collection(NOTIFICATION_OUTBOX_COLLECTION)
    .find({})
    .toArray()) as unknown as NotificationOutboxRecord[];
}

test("branch ballot audience reuses the voting eligibility predicate", async () => {
  const db = createMemoryDb();
  await seedBranches(db);
  // Eligible: verified platform membership and an active Victoria membership.
  await seedMember(db, "m-eligible", { branchIds: ["branch-vic"] });
  // Ineligible: verified, but only follows the branch. Following never votes.
  await seedMember(db, "m-follower", { followedBranchIds: ["branch-vic"] });
  // Ineligible: verified, but no Victorian membership fact.
  await seedMember(db, "m-other-branch", { branchIds: ["branch-nat"] });
  // Ineligible: has a branch membership row but is not a verified member.
  await seedMember(db, "m-unverified", { verified: false, branchIds: ["branch-vic"] });

  const proposal = await seedProposal(db, {
    jurisdictionBranchId: "branch-vic",
    publicationScope: "branch",
  });
  const eligible = await listEligibleBallotMembers(db, proposal as any);
  assert.deepEqual(
    eligible.map((member) => member.memberId),
    ["m-eligible"],
  );

  // The reverse direction: a national ballot is open to every verified member,
  // including a member with no separate branch membership record.
  const national = await seedProposal(db, {
    proposalId: "PROP-NAT",
    slug: "national-motion",
    jurisdictionBranchId: "branch-nat",
  });
  const nationalEligible = await listEligibleBallotMembers(db, national as any);
  assert.deepEqual(
    nationalEligible.map((member) => member.memberId).sort(),
    ["m-eligible", "m-follower", "m-other-branch"],
  );

  // An unrecognised branch cannot run a ballot, so nobody is eligible.
  const unavailable = await seedProposal(db, {
    proposalId: "PROP-UNAVAILABLE",
    slug: "unavailable-motion",
    jurisdictionBranchId: "branch-unrecognised",
  });
  assert.deepEqual(await listEligibleBallotMembers(db, unavailable as any), []);
});

test("opened enqueue writes one safe row per eligible member and is idempotent", async () => {
  const db = createMemoryDb();
  await seedBranches(db);
  await seedMember(db, "m-1");
  await seedMember(db, "m-2");
  await seedProposal(db);

  const first = await enqueueBallotOpenedNotifications(db, "PROP-1", { now: NOW });
  assert.equal(first.matters, 1);
  assert.equal(first.eligible, 2);
  assert.equal(first.enqueued, 2);
  assert.equal(first.duplicates, 0);

  const stored = await rows(db);
  assert.equal(stored.length, 2);
  for (const row of stored) {
    assert.equal(row.status, "pending");
    assert.equal(row.topic, "new_ballots");
    assert.equal(row.event, "ballot_opened");
    assert.equal(row.attempts, 0);
    assert.equal(row.matterId, "PROP-1");
    assert.equal(row.ballotId, "proposal:PROP-1");
    assert.deepEqual(Object.keys(row.payload).sort(), [
      "body",
      "href",
      "isConfidential",
      "title",
    ]);
    assert.equal(row.payload.href, "/proposals/test-motion/#proposal-vote");
    assert.equal(row.dedupeKey, ballotOpenedDedupeKey(row.memberId, "PROP-1"));
    // Never restate wording, never carry a choice, tally or identifiable data.
    const serialised = JSON.stringify(row);
    assert.equal(serialised.includes("INTERNAL SUMMARY WORDING"), false);
    assert.equal(serialised.includes("INTERNAL OUTCOME WORDING"), false);
    assert.equal(serialised.includes("INTERNAL DETAIL WORDING"), false);
    assert.equal(/approve|abstain|reject|tally|voteChoice|reason/i.test(serialised), false);
  }

  const second = await enqueueBallotOpenedNotifications(db, "PROP-1", { now: NOW });
  assert.equal(second.enqueued, 0);
  assert.equal(second.duplicates, 2);
  assert.equal((await rows(db)).length, 2);
});

test("closing soon respects the seven-day window and skips closed or expired ballots", async () => {
  const db = createMemoryDb();
  await seedBranches(db);
  await seedMember(db, "m-1");

  await seedProposal(db, {
    proposalId: "PROP-INSIDE",
    slug: "inside",
    ballotClosesAt: new Date(NOW.getTime() + 7 * DAY - 1),
  });
  await seedProposal(db, {
    proposalId: "PROP-OUTSIDE",
    slug: "outside",
    ballotClosesAt: new Date(NOW.getTime() + 7 * DAY + 60_000),
  });
  await seedProposal(db, {
    proposalId: "PROP-EXPIRED",
    slug: "expired",
    ballotClosesAt: new Date(NOW.getTime() - 1),
  });
  await seedProposal(db, {
    proposalId: "PROP-CLOSED",
    slug: "closed",
    ballotClosesAt: new Date(NOW.getTime() + 2 * DAY),
    ballotClosedAt: new Date(NOW.getTime() - DAY),
  });

  const report = await enqueueClosingSoonNotifications(db, { now: NOW });
  assert.equal(report.matters, 1);
  assert.equal(report.enqueued, 1);
  const stored = await rows(db);
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.matterId, "PROP-INSIDE");
  assert.equal(stored[0]?.topic, "closing_deadlines");
  assert.equal(
    stored[0]?.dedupeKey,
    closingSoonDedupeKey("m-1", "PROP-INSIDE", new Date(NOW.getTime() + 7 * DAY - 1)),
  );
  assert.match(stored[0]!.payload.body, /14 November 2026|21 November 2026/);
});

test("drain honours push opt-in, general communications and lock-screen confidentiality", async () => {
  const db = createMemoryDb();
  await seedBranches(db);
  await seedMember(db, "m-push", { branchIds: ["branch-vic"] });
  await seedMember(db, "m-push-forced", { branchIds: ["branch-vic"] });
  await seedMember(db, "m-inapp-only", { branchIds: ["branch-vic"] });
  await seedProposal(db, {
    title: "Secret Branch Motion",
    summary: "INTERNAL SUMMARY WORDING",
    jurisdictionBranchId: "branch-vic",
    publicationScope: "branch",
  });

  await registerPushSubscription(db, "m-push-forced", {
    endpoint: "https://push.example.com/forced",
    keys: { p256dh: "p256dh", auth: "auth" },
  });
  await updateMemberNotificationPreferences(db, "m-push-forced", {
    push: { new_ballots: true },
    generalCommunicationsEnabled: false,
  });
  // Email suppressed after a bounce, general communications off, push off.
  await db.collection("engagement_email_preferences").insertOne({
    memberId: "m-inapp-only",
    suppressed: true,
    generalCommunicationsEnabled: false,
  });
  // Push on for a member whose general communications are off.
  await registerPushSubscription(db, "m-push", {
    endpoint: "https://push.example.com/default",
    keys: { p256dh: "p256dh", auth: "auth" },
  });
  await updateMemberNotificationPreferences(db, "m-push", {
    push: { new_ballots: true },
  });

  await enqueueBallotOpenedNotifications(db, "PROP-1", { now: NOW });

  const pushed: Array<{ endpoint: string; payload: any }> = [];
  const pushSender = async (subscription: { endpoint: string }, raw: string) => {
    pushed.push({ endpoint: subscription.endpoint, payload: JSON.parse(raw) });
    return { statusCode: 201 };
  };
  const report = await drainNotificationOutbox(db, TEST_ENV, {
    now: NOW,
    pushSender,
  });
  assert.equal(report.sent, 3);
  assert.equal(report.failed, 0);
  assert.equal(report.errors.length, 0);

  // Push is strictly opt-in: only the two opted-in members received one.
  assert.deepEqual(
    pushed.map((entry) => entry.endpoint).sort(),
    ["https://push.example.com/default", "https://push.example.com/forced"],
  );
  for (const entry of pushed) {
    // A branch-scoped matter never leaks its title on a lock screen.
    assert.equal(entry.payload.title, "Fusion Engage update");
    assert.equal(entry.payload.body.includes("Secret Branch Motion"), false);
    assert.equal(entry.payload.body.includes("INTERNAL SUMMARY WORDING"), false);
    assert.equal(entry.payload.url, "/proposals/test-motion/#proposal-vote");
  }

  // In-app is the governance inbox baseline: general communications and email
  // suppression do not hide a formal ballot notice from a verified member.
  const inbox = await db.collection("member_notifications").find({}).toArray();
  assert.equal(inbox.length, 3);
  assert.deepEqual(
    inbox.map((item: any) => item.memberId).sort(),
    ["m-inapp-only", "m-push", "m-push-forced"],
  );
  assert.ok(inbox.every((item: any) => item.title === "Ballot open: Secret Branch Motion"));

  const stored = await rows(db);
  const inAppOnly = stored.find((row) => row.memberId === "m-inapp-only");
  assert.equal(inAppOnly?.status, "sent");
  assert.equal(inAppOnly?.channels?.inApp, "created");
  assert.equal(inAppOnly?.channels?.push, "suppressed");
  const pushRow = stored.find((row) => row.memberId === "m-push");
  assert.equal(pushRow?.channels?.push, "sent");
});

test("a failed send records failed, increments attempts, backs off and then sends once", async () => {
  const db = createMemoryDb();
  await seedBranches(db);
  await seedMember(db, "m-1");
  await seedProposal(db);
  await enqueueBallotOpenedNotifications(db, "PROP-1", { now: NOW });

  const first = await drainNotificationOutbox(db, TEST_ENV, {
    now: NOW,
    dispatch: async () => {
      throw new Error("Provider unavailable");
    },
  });
  assert.equal(first.claimed, 1);
  assert.equal(first.failed, 1);
  assert.equal(first.retried, 1);
  assert.equal(first.exhausted, 0);
  assert.equal(first.errors.length, 1);
  assert.equal(first.errors[0]?.event, "ballot_opened");
  assert.equal(first.errors[0]?.matterId, "PROP-1");
  assert.equal(JSON.stringify(first.errors).includes("m-1"), false);

  const [failedRow] = await rows(db);
  assert.equal(failedRow?.status, "failed");
  assert.equal(failedRow?.attempts, 1);
  assert.ok(failedRow!.nextAttemptAt.getTime() > NOW.getTime());

  // Not due yet: an immediate second run claims nothing and sends nothing.
  const early = await drainNotificationOutbox(db, TEST_ENV, { now: NOW });
  assert.equal(early.claimed, 0);
  assert.equal((await db.collection("member_notifications").countDocuments({})), 0);

  // After the backoff the row is retried and sent.
  const retried = await drainNotificationOutbox(db, TEST_ENV, {
    now: new Date(NOW.getTime() + 2 * 60_000),
  });
  assert.equal(retried.claimed, 1);
  assert.equal(retried.sent, 1);
  assert.equal(retried.failed, 0);

  const [sentRow] = await rows(db);
  assert.equal(sentRow?.status, "sent");
  assert.equal(sentRow?.attempts, 2);
  assert.ok(sentRow?.sentAt instanceof Date);
  assert.ok(sentRow?.retainUntil instanceof Date);
  assert.equal(await db.collection("member_notifications").countDocuments({}), 1);
  assert.equal(await db.collection(NOTIFICATION_DELIVERIES_COLLECTION).countDocuments({}), 1);
});

test("drain suppresses a member who lost eligibility and never retries the row", async () => {
  const db = createMemoryDb();
  await seedBranches(db);
  await seedMember(db, "m-revoked", { branchIds: ["branch-vic"] });
  await seedProposal(db, { jurisdictionBranchId: "branch-vic" });
  await enqueueBallotOpenedNotifications(db, "PROP-1", { now: NOW });

  await db
    .collection("branch_memberships")
    .updateOne(
      { memberId: "m-revoked", branchId: "branch-vic" },
      { $set: { status: "revoked" } },
    );

  const report = await drainNotificationOutbox(db, TEST_ENV, { now: NOW });
  assert.equal(report.claimed, 1);
  assert.equal(report.suppressed, 1);
  assert.equal(report.sent, 0);
  assert.equal(report.errors.length, 0);

  const [row] = await rows(db);
  assert.equal(row?.status, "suppressed");
  assert.equal(row?.suppressionReason, "recipient_ineligible");
  assert.equal(row?.attempts, 0);
  assert.equal(await db.collection("member_notifications").countDocuments({}), 0);

  const again = await drainNotificationOutbox(db, TEST_ENV, {
    now: new Date(NOW.getTime() + DAY),
  });
  assert.equal(again.claimed, 0);
  assert.equal(again.suppressed, 0);
});

test("dry run reports the backlog without claiming, sending or writing", async () => {
  const db = createMemoryDb();
  await seedBranches(db);
  await seedMember(db, "m-1");
  await seedProposal(db);
  await enqueueBallotOpenedNotifications(db, "PROP-1", { now: NOW });

  const report = await drainNotificationOutbox(db, TEST_ENV, {
    now: NOW,
    dryRun: true,
  });
  assert.equal(report.mode, "dry-run");
  assert.equal(report.due, 1);
  assert.equal(report.claimed, 0);
  assert.equal(report.sent, 0);
  assert.equal((await db.collection("member_notifications").countDocuments({})), 0);
  const [row] = await rows(db);
  assert.equal(row?.status, "pending");
  assert.equal(row?.claimToken, undefined);
});

test("payload builders never embed wording and keep the ballot link", () => {
  const opening = buildBallotOpenedPayload({
    slug: "a motion",
    title: "A motion",
    ballotClosesAt: NOW,
    publicationScope: "national",
  });
  assert.deepEqual(Object.keys(opening).sort(), ["body", "href", "isConfidential", "title"]);
  assert.equal(opening.href, "/proposals/a%20motion/#proposal-vote");
  assert.equal(opening.isConfidential, false);
  assert.equal(/approve|abstain|reject|tally/i.test(opening.body), false);

  const closing = buildClosingSoonPayload({
    slug: "a motion",
    title: "A motion",
    ballotClosesAt: NOW,
    publicationScope: "branch",
  });
  assert.equal(closing.isConfidential, true);
  assert.match(closing.body, /Read the ballot before voting closes/);
});
