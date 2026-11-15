import assert from "node:assert/strict";
import { test } from "node:test";
import { MongoClient, type Db } from "mongodb";
import { initializeDatabase } from "./db.ts";
import { runGovernanceScheduler } from "./governance-scheduler.ts";
import {
  NOTIFICATION_OUTBOX_COLLECTION,
  drainNotificationOutbox,
  enqueueBallotOpenedNotifications,
  type NotificationOutboxRecord,
} from "./notification-outbox.ts";
import { NOTIFICATION_DELIVERIES_COLLECTION } from "./notifications.ts";
import { scheduledBallotClosesAtFrom } from "./lifecycle-schedule.ts";
import type { PlatformEnv } from "./types.ts";

/**
 * Real-MongoDB coverage for the durable notification outbox. The in-memory
 * database cannot prove unique dedupe keys, claim atomicity or conditional
 * retry writes, so these cases run only when a replica set is available.
 */
const uri = process.env.VOTING_TEST_MONGODB_URI;

const DAY = 86_400_000;
const NOW = new Date("2026-11-14T00:00:00.000Z");
const TEST_ENV: PlatformEnv = {
  VAPID_PUBLIC_KEY: "test-vapid-public",
  VAPID_PRIVATE_KEY: "test-vapid-private",
  VAPID_SUBJECT: "mailto:notifications@fusionparty.org.au",
  PUBLIC_ORIGIN: "https://engage.fusionparty.org.au",
};

async function withDatabase(run: (db: Db) => Promise<void>): Promise<void> {
  const client = await new MongoClient(uri!).connect();
  const db = client.db(`engage_outbox_test_${crypto.randomUUID().replaceAll("-", "")}`);
  try {
    await initializeDatabase(db);
    await run(db);
  } finally {
    await db.dropDatabase();
    await client.close();
  }
}

async function seedMember(db: Db, memberId: string, branchId = "branch-nat"): Promise<void> {
  await db.collection("user").insertOne({
    _id: memberId as any,
    name: memberId,
    email: `${memberId}@example.test`,
    emailVerified: true,
    disabled: false,
  } as any);
  await db.collection("memberships").insertOne({ memberId, status: "verified" });
  await db.collection("branch_memberships").insertOne({
    memberId,
    branchId,
    status: "active",
    branchRole: "member",
  });
}

async function seedBranch(db: Db, branchId = "branch-nat"): Promise<void> {
  await db.collection("branches").updateOne(
    { branchId },
    {
      $setOnInsert: {
        branchId,
        name: branchId === "branch-nat" ? "Fusion National" : "Fusion Victoria",
        kind: branchId === "branch-nat" ? "national" : "state",
        recognised: true,
        parentBranchId: branchId === "branch-nat" ? null : "branch-nat",
      },
    },
    { upsert: true },
  );
}

function openedDraft(
  proposalId: string,
  overrides: Record<string, any> = {},
): Record<string, any> {
  const secondedAt = new Date(NOW.getTime() - 30 * DAY);
  return {
    proposalId,
    slug: proposalId.toLowerCase(),
    title: `Motion ${proposalId}`,
    space: "Governance",
    summary: "INTERNAL SUMMARY WORDING",
    outcomes: [],
    details: "INTERNAL DETAIL WORDING",
    kind: "policy",
    stage: "deliberate",
    secondedBy: "member-seconder",
    secondedAt,
    deliberationEndsAt: NOW,
    jurisdictionBranchId: "branch-nat",
    governanceAuthorityBranchId: "branch-nat",
    publicationScope: "national",
    createdAt: secondedAt,
    updatedAt: secondedAt,
    ...overrides,
  };
}

async function outboxRows(db: Db, matterId: string): Promise<NotificationOutboxRecord[]> {
  return (await db
    .collection(NOTIFICATION_OUTBOX_COLLECTION)
    .find({ matterId })
    .toArray()) as unknown as NotificationOutboxRecord[];
}

test(
  "real MongoDB: scheduler advancement enqueues exactly one opened row per eligible member",
  { skip: !uri },
  async () => {
    await withDatabase(async (db) => {
      await seedBranch(db);
      await seedMember(db, "member-a");
      await seedMember(db, "member-b");
      // Unverified members are not in the electorate.
      await db.collection("user").insertOne({
        _id: "member-unverified" as any,
        name: "Unverified",
        email: "unverified@example.test",
        disabled: false,
      } as any);
      await db.collection("memberships").insertOne({
        memberId: "member-unverified",
        status: "pending",
      });

      const proposalId = "PROP-OPEN-OUTBOX";
      await db.collection("proposals").insertOne(openedDraft(proposalId));
      await db.collection("proposal_revisions").insertOne({
        revisionId: `rev-${proposalId}`,
        proposalId,
        parentRevisionId: null,
        authorId: "author-1",
        createdAt: new Date(NOW.getTime() - 30 * DAY),
        snapshot: { title: "t", summary: "s", outcomes: [], details: "" },
        contentHash: `hash-${proposalId}`,
      });

      // A separate open ballot inside the seven-day window must also be queued.
      const closingId = "PROP-CLOSING-OUTBOX";
      await db.collection("proposals").insertOne({
        proposalId: closingId,
        slug: closingId.toLowerCase(),
        title: `Motion ${closingId}`,
        space: "Governance",
        summary: "IRRELEVANT",
        outcomes: [],
        details: "",
        kind: "policy",
        stage: "decide",
        ballotRevisionId: `rev-${closingId}`,
        ballotClosesAt: new Date(NOW.getTime() + 3 * DAY),
        jurisdictionBranchId: "branch-nat",
        governanceAuthorityBranchId: "branch-nat",
        publicationScope: "national",
        createdAt: new Date(NOW.getTime() - 30 * DAY),
        updatedAt: new Date(NOW.getTime() - 30 * DAY),
      });

      const first = await runGovernanceScheduler(db, { now: NOW });
      assert.equal(first.counts.advanced, 1);
      assert.equal(first.counts.errors, 0);

      const opened = await outboxRows(db, proposalId);
      assert.equal(opened.length, 2);
      assert.deepEqual(
        opened.map((row) => row.memberId).sort(),
        ["member-a", "member-b"],
      );
      for (const row of opened) {
        assert.equal(row.event, "ballot_opened");
        assert.equal(row.status, "pending");
        assert.equal(row.revisionId, `rev-${proposalId}`);
        assert.equal(
          new Date((await db.collection("proposals").findOne({ proposalId }))!.ballotClosesAt).toISOString(),
          scheduledBallotClosesAtFrom(new Date(NOW.getTime() - 30 * DAY)).toISOString(),
        );
      }

      const closing = await outboxRows(db, closingId);
      assert.equal(closing.length, 2);
      assert.ok(closing.every((row) => row.event === "ballot_closing_soon"));

      // Re-running the scheduler creates no second notification.
      const second = await runGovernanceScheduler(db, { now: new Date(NOW.getTime() + 60_000) });
      assert.equal(second.counts.advanced, 0);
      assert.equal((await outboxRows(db, proposalId)).length, 2);
      assert.equal((await outboxRows(db, closingId)).length, 2);

      // Drain once: each member receives both events exactly once. This also
      // proves the `notification_deliveries` unique index accepts more than one
      // delivery, which the previous index shape silently rejected.
      const drained = await drainNotificationOutbox(db, TEST_ENV, {
        now: new Date(NOW.getTime() + 60_000),
      });
      assert.equal(drained.sent, 4);
      assert.equal(drained.failed, 0);
      const perMember = await db
        .collection("member_notifications")
        .aggregate([{ $group: { _id: "$memberId", count: { $sum: 1 } } }])
        .toArray();
      assert.deepEqual(
        perMember
          .map((row: any) => [row._id, row.count])
          .sort((left: any, right: any) => String(left[0]).localeCompare(String(right[0]))),
        [
          ["member-a", 2],
          ["member-b", 2],
        ],
      );

      // The unique dedupe key is the database guarantee behind that count.
      const rows = await outboxRows(db, proposalId);
      await assert.rejects(
        db.collection(NOTIFICATION_OUTBOX_COLLECTION).insertOne({
          ...rows[0],
          _id: `copy-${rows[0]!._id}`,
        } as any),
        (error: { code?: number }) => error.code === 11000,
      );
    });
  },
);

test(
  "real MongoDB: two concurrent drains send an outbox row exactly once",
  { skip: !uri },
  async () => {
    await withDatabase(async (db) => {
      await seedBranch(db);
      await seedMember(db, "member-only");
      const proposalId = "PROP-CONCURRENT-DRAIN";
      await db.collection("proposals").insertOne({
        proposalId,
        slug: proposalId.toLowerCase(),
        title: "Concurrent drain",
        space: "Governance",
        summary: "Summary",
        outcomes: [],
        details: "",
        kind: "policy",
        stage: "decide",
        ballotRevisionId: `rev-${proposalId}`,
        ballotClosesAt: new Date(NOW.getTime() + 3 * DAY),
        jurisdictionBranchId: "branch-nat",
        governanceAuthorityBranchId: "branch-nat",
        publicationScope: "national",
        createdAt: new Date(NOW.getTime() - 30 * DAY),
        updatedAt: new Date(NOW.getTime() - 30 * DAY),
      });
      const enqueued = await enqueueBallotOpenedNotifications(db, proposalId, { now: NOW });
      assert.equal(enqueued.enqueued, 1);

      const [left, right] = await Promise.all([
        drainNotificationOutbox(db, TEST_ENV, { now: NOW }),
        drainNotificationOutbox(db, TEST_ENV, { now: NOW }),
      ]);
      assert.equal(left.claimed + right.claimed, 1);
      assert.equal(left.sent + right.sent, 1);
      assert.equal(left.failed + right.failed, 0);
      assert.equal(await db.collection("member_notifications").countDocuments({}), 1);
      assert.equal(
        await db.collection(NOTIFICATION_DELIVERIES_COLLECTION).countDocuments({}),
        1,
      );
      const [row] = await outboxRows(db, proposalId);
      assert.equal(row?.status, "sent");
      assert.equal(row?.attempts, 1);
    });
  },
);

test(
  "real MongoDB: a failed send persists attempts and a later run sends once",
  { skip: !uri },
  async () => {
    await withDatabase(async (db) => {
      await seedBranch(db);
      await seedMember(db, "member-retry");
      const proposalId = "PROP-RETRY";
      await db.collection("proposals").insertOne({
        proposalId,
        slug: proposalId.toLowerCase(),
        title: "Retry",
        space: "Governance",
        summary: "Summary",
        outcomes: [],
        details: "",
        kind: "policy",
        stage: "decide",
        ballotRevisionId: `rev-${proposalId}`,
        ballotClosesAt: new Date(NOW.getTime() + 3 * DAY),
        jurisdictionBranchId: "branch-nat",
        governanceAuthorityBranchId: "branch-nat",
        publicationScope: "national",
        createdAt: new Date(NOW.getTime() - 30 * DAY),
        updatedAt: new Date(NOW.getTime() - 30 * DAY),
      });
      await enqueueBallotOpenedNotifications(db, proposalId, { now: NOW });

      const failed = await drainNotificationOutbox(db, TEST_ENV, {
        now: NOW,
        dispatch: async () => {
          throw new Error("Provider unavailable");
        },
      });
      assert.equal(failed.failed, 1);
      assert.equal(failed.retried, 1);

      let [row] = await outboxRows(db, proposalId);
      assert.equal(row?.status, "failed");
      assert.equal(row?.attempts, 1);
      assert.ok(row!.nextAttemptAt.getTime() > NOW.getTime());
      assert.equal(await db.collection("member_notifications").countDocuments({}), 0);

      const retried = await drainNotificationOutbox(db, TEST_ENV, {
        now: new Date(NOW.getTime() + 2 * 60_000),
      });
      assert.equal(retried.sent, 1);
      [row] = await outboxRows(db, proposalId);
      assert.equal(row?.status, "sent");
      assert.equal(row?.attempts, 2);
      assert.equal(await db.collection("member_notifications").countDocuments({}), 1);

      // A third run has nothing to claim: delivery evidence is not re-sent.
      const settled = await drainNotificationOutbox(db, TEST_ENV, {
        now: new Date(NOW.getTime() + 5 * 60_000),
      });
      assert.equal(settled.claimed, 0);
    });
  },
);

test(
  "real MongoDB: outbox indexes exist with a retention TTL",
  { skip: !uri },
  async () => {
    await withDatabase(async (db) => {
      const indexes = await db.collection(NOTIFICATION_OUTBOX_COLLECTION).indexes();
      const byName = new Map(indexes.map((index) => [index.name, index]));
      assert.ok(byName.has("outbox_dedupe_unique"));
      assert.equal(byName.get("outbox_dedupe_unique")?.unique, true);
      assert.ok(byName.has("outbox_due"));
      assert.ok(byName.has("outbox_matter_event"));
      assert.ok(byName.has("outbox_member_created"));
      const retention = byName.get("outbox_retention");
      assert.ok(retention);
      assert.equal(retention?.expireAfterSeconds, 0);
    });
  },
);
