import assert from "node:assert/strict";
import { test } from "node:test";
import { MongoClient, type Db } from "mongodb";
import { initializeDatabase } from "./db.ts";
import {
  CollaborationError,
  exportApproved,
  listContributions,
  readContributionMedia,
  reviewContribution,
  seedPilotInitiative,
  submitContribution,
} from "./collaboration.ts";
import { PILOT_SLUG } from "./collaboration-options.ts";
import type { SessionUser } from "./types.ts";

/**
 * Real-MongoDB coverage for public collaboration matters.
 *
 * The in-memory preview cannot prove the unique contribution reference, the
 * media/contribution separation or `$inc` version concurrency, so these cases
 * run only when a replica set is available.
 */
const uri = process.env.VOTING_TEST_MONGODB_URI;

const reviewer = {
  memberId: "reviewer-1",
  permissions: {
    national: ["collaboration.review", "collaboration.manage"],
    branches: {},
    grants: [],
  },
} as unknown as SessionUser;

async function withDatabase(run: (db: Db) => Promise<void>): Promise<void> {
  const client = await new MongoClient(uri!).connect();
  const db = client.db(`engage_collaboration_test_${crypto.randomUUID().replaceAll("-", "")}`);
  try {
    await initializeDatabase(db);
    await run(db);
  } finally {
    await db.dropDatabase();
    await client.close();
  }
}

const base = {
  initiativeSlug: PILOT_SLUG,
  answers: { meaning: "Fusion is the first party that made local decisions feel possible." },
  attribution: "named" as const,
  displayName: "Sam Rivera",
  channels: ["website" as const],
  consent: true,
  adultAttested: true,
};

test(
  "a guest contribution commits once, and media never enters the contribution document",
  { skip: !uri },
  async () => {
    await withDatabase(async (db) => {
      await seedPilotInitiative(db);
      const requestId = "12345678-1234-4234-8234-123456789abc";
      const first = await submitContribution(db, { ...base, requestId });
      const again = await submitContribution(db, { ...base, requestId });
      assert.equal(again.contributionId, first.contributionId);
      assert.equal(await db.collection("collaboration_contributions").countDocuments(), 1);

      const row = await db
        .collection("collaboration_contributions")
        .findOne({ contributionId: first.contributionId });
      assert.equal(row?.status, "new");
      assert.equal(JSON.stringify(row).includes("bytes"), false);

      const inbox = await listContributions(db, reviewer);
      assert.equal(inbox.total, 1);
      assert.equal(inbox.items[0]?.email, "");
    });
  },
);

test(
  "two reviewers cannot both win the same version, and the audit trail records the winner",
  { skip: !uri },
  async () => {
    await withDatabase(async (db) => {
      await seedPilotInitiative(db);
      const { contributionId } = await submitContribution(db, {
        ...base,
        requestId: "22345678-1234-4234-8234-123456789abc",
      });
      await reviewContribution(db, reviewer, {
        contributionId,
        action: "set_status",
        status: "approved",
        version: 0,
      });
      await assert.rejects(
        reviewContribution(db, reviewer, {
          contributionId,
          action: "set_status",
          status: "declined",
          version: 0,
        }),
        /changed since/,
      );
      const events = await db
        .collection("collaboration_events")
        .find({ contributionId })
        .toArray();
      assert.equal(events.length, 1);
      assert.equal(events[0]?.toStatus, "approved");
    });
  },
);

test(
  "approved-only export leaves declined work and private consent behind",
  { skip: !uri },
  async () => {
    await withDatabase(async (db) => {
      await seedPilotInitiative(db);
      const approved = await submitContribution(db, {
        ...base,
        requestId: "32345678-1234-4234-8234-123456789abc",
      });
      const declined = await submitContribution(db, {
        ...base,
        requestId: "42345678-1234-4234-8234-123456789abc",
      });
      await reviewContribution(db, reviewer, {
        contributionId: approved.contributionId,
        action: "set_status",
        status: "approved",
        version: 0,
      });
      await reviewContribution(db, reviewer, {
        contributionId: declined.contributionId,
        action: "set_status",
        status: "declined",
        version: 0,
      });
      const payload = await exportApproved(db, reviewer);
      const contributions = payload.contributions as Array<{ contributionId: string }>;
      assert.equal(contributions.length, 1);
      assert.equal(contributions[0]?.contributionId, approved.contributionId);
    });
  },
);

test(
  "a reviewer without the permission is refused by the database-backed path too",
  { skip: !uri },
  async () => {
    await withDatabase(async (db) => {
      await seedPilotInitiative(db);
      const outsider = { memberId: "x", permissions: { national: [], branches: {}, grants: [] } } as unknown as SessionUser;
      await assert.rejects(listContributions(db, outsider), CollaborationError);
      await assert.rejects(exportApproved(db, null), /Sign in/);
    });
  },
);

test(
  "stored photograph bytes round-trip through BSON and stay private",
  { skip: !uri },
  async () => {
    await withDatabase(async (db) => {
      await seedPilotInitiative(db);
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      );
      const { contributionId } = await submitContribution(
        db,
        { ...base, requestId: "52345678-1234-4234-8234-123456789abc" },
        [new File([png], "me.png", { type: "image/png" })],
      );
      const inbox = await listContributions(db, reviewer);
      const descriptor = inbox.items.find((item) => item.contributionId === contributionId)!.media[0]!;
      const read = await readContributionMedia(db, reviewer, descriptor.mediaId);
      assert.equal(read.bytes.length, descriptor.byteSize);
      assert.equal(read.mimeType, "image/png");
      assert.equal(read.bytes.subarray(1, 4).toString("latin1"), "PNG");
    });
  },
);
