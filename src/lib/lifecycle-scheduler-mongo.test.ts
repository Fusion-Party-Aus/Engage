import assert from "node:assert/strict";
import { test } from "node:test";
import { MongoClient, type Db } from "mongodb";
import { initializeDatabase } from "./db.ts";
import { advanceDueDeliberations, closeDueBallots } from "./governance-scheduler.ts";
import { GOVERNANCE_EVENTS_COLLECTION } from "./governance-relationships.ts";
import {
  LIFECYCLE_SYSTEM_ACTOR,
  scheduledBallotClosesAtFrom,
} from "./lifecycle-schedule.ts";
import { secondProposal } from "./store.ts";
import type { SessionUser } from "./types.ts";
import { proposalBallotId } from "./vote-storage.ts";

/**
 * Real-MongoDB coverage for the scheduled lifecycle. The in-memory database
 * cannot prove conditional-write atomicity, unique event IDs or transaction
 * behaviour, so these cases run only when a replica set is available.
 */
const uri = process.env.VOTING_TEST_MONGODB_URI;

const DAY = 86_400_000;
const NOW = new Date("2026-11-14T00:00:00.000Z");

function member(memberId: string): SessionUser {
  return {
    memberId,
    name: memberId,
    email: `${memberId}@example.test`,
    role: "member",
    roles: ["member"],
    status: "verified",
    canParticipate: true,
    isStaff: false,
    isAdmin: false,
  };
}

async function withDatabase(run: (db: Db) => Promise<void>): Promise<void> {
  const client = await new MongoClient(uri!).connect();
  const db = client.db(
    `engage_lifecycle_test_${crypto.randomUUID().replaceAll("-", "")}`,
  );
  try {
    await initializeDatabase(db);
    await run(db);
  } finally {
    await db.dropDatabase();
    await client.close();
  }
}

test(
  "real MongoDB: concurrent scheduler runs advance a due matter exactly once",
  { skip: !uri },
  async () => {
    await withDatabase(async (db) => {
      const indexNames = (await db.collection(GOVERNANCE_EVENTS_COLLECTION).indexes()).map(
        (index) => index.name,
      );
      assert.ok(indexNames.includes("eventId_1"));

      const secondedAt = new Date(NOW.getTime() - 30 * DAY);
      const proposalId = `PROP-SCHED-${crypto.randomUUID()}`;
      await db.collection("proposals").insertOne({
        proposalId,
        slug: proposalId.toLowerCase(),
        title: "Concurrent scheduled advancement",
        space: "Governance",
        summary: "Concurrent scheduler runs must advance this matter once.",
        outcomes: [],
        details: "",
        kind: "policy",
        stage: "deliberate",
        secondedBy: "member-seconder",
        secondedAt,
        deliberationEndsAt: NOW,
        createdAt: secondedAt,
        updatedAt: secondedAt,
      });
      await db.collection("proposal_revisions").insertOne({
        revisionId: `rev-${proposalId}`,
        proposalId,
        parentRevisionId: null,
        authorId: "author-1",
        createdAt: secondedAt,
        snapshot: { title: "t", summary: "s", outcomes: [], details: "" },
        contentHash: `hash-${proposalId}`,
      });

      const [first, second] = await Promise.all([
        advanceDueDeliberations(db, { now: NOW }),
        advanceDueDeliberations(db, { now: NOW }),
      ]);
      const advanced = [...first.advanced, ...second.advanced].filter(
        (item) => item.proposalId === proposalId,
      );
      assert.equal(advanced.length, 1);
      assert.equal(first.errors.length + second.errors.length, 0);

      const stored = await db.collection("proposals").findOne({ proposalId });
      assert.equal(stored?.stage, "decide");
      assert.equal(stored?.ballotRevisionId, `rev-${proposalId}`);
      assert.equal(
        new Date(stored!.ballotClosesAt).toISOString(),
        scheduledBallotClosesAtFrom(secondedAt).toISOString(),
      );

      const events = await db
        .collection(GOVERNANCE_EVENTS_COLLECTION)
        .find({ matterId: proposalId, eventType: "proposal.stage_transition" })
        .toArray();
      assert.equal(events.length, 1);
      assert.equal(events[0]?.actorId, LIFECYCLE_SYSTEM_ACTOR);
      assert.equal(
        events[0]?.eventId,
        `sched:advance:${proposalId}:${NOW.toISOString()}`,
      );
    });
  },
);

test(
  "real MongoDB: concurrent closure runs record one ballot.closed event",
  { skip: !uri },
  async () => {
    await withDatabase(async (db) => {
      const proposalId = `PROP-CLOSE-${crypto.randomUUID()}`;
      await db.collection("proposals").insertOne({
        proposalId,
        slug: proposalId.toLowerCase(),
        title: "Concurrent scheduled closure",
        space: "Governance",
        summary: "Concurrent closure runs must record one closure.",
        outcomes: [],
        details: "",
        kind: "policy",
        stage: "decide",
        ballotRevisionId: `rev-${proposalId}`,
        ballotClosesAt: NOW,
        createdAt: new Date(NOW.getTime() - 30 * DAY),
        updatedAt: new Date(NOW.getTime() - 30 * DAY),
      });

      await Promise.all([
        closeDueBallots(db, { now: NOW }),
        closeDueBallots(db, { now: NOW }),
      ]);

      const stored = await db.collection("proposals").findOne({ proposalId });
      assert.equal(stored?.stage, "decide");
      assert.ok(stored?.ballotClosedAt instanceof Date);
      const events = await db
        .collection(GOVERNANCE_EVENTS_COLLECTION)
        .find({ matterId: proposalId, eventType: "ballot.closed" })
        .toArray();
      assert.equal(events.length, 1);
      assert.equal(events[0]?.ballotId, proposalBallotId(proposalId));
      assert.equal(
        await db.collection("ballot_results").countDocuments({ proposalId }),
        0,
      );
    });
  },
);

test(
  "real MongoDB: only one of two concurrent seconders is recorded",
  { skip: !uri },
  async () => {
    await withDatabase(async (db) => {
      const proposalId = `PROP-SECOND-${crypto.randomUUID()}`;
      await db.collection("proposals").insertOne({
        proposalId,
        slug: proposalId.toLowerCase(),
        title: "Concurrent seconding",
        space: "Governance",
        summary: "Only one independent seconder may be recorded.",
        outcomes: [],
        details: "",
        kind: "policy",
        stage: "propose",
        authorId: "author-1",
        createdAt: NOW,
        updatedAt: NOW,
      });

      const results = await Promise.allSettled([
        secondProposal(db, member("member-a"), proposalId),
        secondProposal(db, member("member-b"), proposalId),
      ]);
      assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        1,
      );
      assert.equal(
        results.filter((result) => result.status === "rejected").length,
        1,
      );

      const stored = await db.collection("proposals").findOne({ proposalId });
      const events = await db
        .collection(GOVERNANCE_EVENTS_COLLECTION)
        .find({ matterId: proposalId, eventType: "proposal.seconded" })
        .toArray();
      assert.equal(events.length, 1);
      assert.equal(stored?.secondedBy, events[0]?.actorId);
      assert.equal(stored?.stage, "deliberate");
      assert.ok(stored?.deliberationEndsAt instanceof Date);
    });
  },
);
