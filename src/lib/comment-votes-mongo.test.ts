import assert from "node:assert/strict";
import { test } from "node:test";
import { MongoClient, type Collection, type Db } from "mongodb";
import { voteOnComment } from "./store.ts";
import type { SessionUser } from "./types.ts";

/**
 * Proves the comment-vote compare-and-swap on a real MongoDB server.
 *
 * The in-memory database serialises updates in one process; it cannot show
 * that concurrent writers do not overwrite each other. These cases run only
 * when VOTING_TEST_MONGODB_URI is available (CI starts a replica set).
 */
const uri = process.env.VOTING_TEST_MONGODB_URI;

function voter(index: number): SessionUser {
  return {
    memberId: `comment-voter-${index}`,
    name: `Voter ${index}`,
    email: `voter-${index}@example.test`,
    status: "verified",
    role: "member",
    roles: ["member"],
    permissions: { national: [], branches: {}, grants: [] },
    canParticipate: true,
    isStaff: false,
    isAdmin: false,
    isBranchAdmin: false,
    branchAdminIds: [],
    activeBranchIds: [],
  };
}

async function seedComment(
  db: Db,
  proposalId: string,
  commentId: string,
): Promise<void> {
  await db.collection("proposals").insertOne({
    proposalId,
    slug: proposalId,
    title: "Comment vote concurrency",
    space: "Governance",
    summary: "Concurrency test.",
    stage: "deliberate",
    authorId: "author-1",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  // Deliberately omit voteVersion: legacy rows must take the first CAS.
  await db.collection("comments").insertOne({
    commentId,
    proposalId,
    memberId: "author-1",
    authorName: "Author",
    stance: "comment",
    body: "Concurrent voting fixture.",
    upvotes: [],
    downvotes: [],
    createdAt: new Date(),
  });
}

/**
 * Models a cold replica set: every comment write pays extra latency, so a
 * fixed attempt count would be exhausted while the write is still settling.
 * Only `collection` is needed by the vote path, so a small facade keeps the
 * injection readable.
 */
function slowCommentWrites(db: Db, delayMs: number): Db {
  return {
    collection(name: string) {
      const collection = db.collection(name);
      if (name !== "comments") return collection;
      return new Proxy(collection, {
        get(target: Collection, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (property !== "updateOne" || typeof value !== "function") {
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async (...args: unknown[]) => {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            return value.apply(target, args);
          };
        },
      });
    },
  } as unknown as Db;
}

/** Fails every compare-and-swap so the retry budget can be observed. */
function neverMatchingWrites(db: Db): Db {
  return {
    collection(name: string) {
      const collection = db.collection(name);
      if (name !== "comments") return collection;
      return new Proxy(collection, {
        get(target: Collection, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (property === "updateOne") {
            return async () => ({
              acknowledged: true,
              matchedCount: 0,
              modifiedCount: 0,
              upsertedCount: 0,
              upsertedId: null,
            });
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  } as unknown as Db;
}

test(
  "concurrent comment votes are not lost on MongoDB",
  { skip: !uri },
  async () => {
    const client = new MongoClient(uri!);
    await client.connect();
    const db = client.db(`engage_comment_votes_${Date.now()}`);
    try {
      const proposalId = "comment-vote-concurrency";
      const commentId = `cmt-${crypto.randomUUID()}`;
      await seedComment(db, proposalId, commentId);

      const voters = Array.from({ length: 25 }, (_, index) => voter(index));
      // Production uses the 5 s default. A loaded runner can stall well past
      // that without any vote being lost, so the test passes a larger budget
      // explicitly rather than turning a machine stall into a false failure.
      const results = await Promise.all(
        voters.map((member) =>
          voteOnComment(db, member, commentId, "upvote", 15_000),
        ),
      );
      assert.equal(results.length, 25);

      const stored = await db.collection("comments").findOne({ commentId });
      assert.ok(stored);
      assert.equal(
        stored.upvotes.length,
        25,
        "every concurrent upvote is persisted",
      );
      assert.equal(new Set(stored.upvotes).size, 25);
      assert.equal(stored.downvotes.length, 0);
      assert.equal(stored.voteVersion, 25);

      // Two simultaneous toggles from a new member cancel out, and the member
      // never appears twice in either array.
      await Promise.all([
        voteOnComment(db, voter(99), commentId, "upvote", 15_000),
        voteOnComment(db, voter(99), commentId, "upvote", 15_000),
      ]);
      const afterToggle = await db.collection("comments").findOne({ commentId });
      assert.ok(afterToggle);
      assert.equal(
        afterToggle.upvotes.filter(
          (memberId: string) => memberId === "comment-voter-99",
        ).length,
        0,
      );
      assert.equal(
        afterToggle.downvotes.filter(
          (memberId: string) => memberId === "comment-voter-99",
        ).length,
        0,
      );
      assert.equal(afterToggle.voteVersion, 27);
    } finally {
      await db.dropDatabase();
      await client.close();
    }
  },
);

test(
  "concurrent comment votes converge when the first writes are slow",
  { skip: !uri },
  async () => {
    const client = new MongoClient(uri!);
    await client.connect();
    const db = client.db(`engage_comment_votes_cold_${Date.now()}`);
    try {
      const proposalId = "comment-vote-cold-start";
      const commentId = `cmt-${crypto.randomUUID()}`;
      await seedComment(db, proposalId, commentId);

      const slowDb = slowCommentWrites(db, 40);
      const voters = Array.from({ length: 25 }, (_, index) => voter(index));
      // A loaded machine can spend more than the production 5 s default on the
      // same burst, so this case passes a larger budget explicitly to prove
      // convergence while the production default stays bounded.
      await Promise.all(
        voters.map((member) =>
          voteOnComment(slowDb, member, commentId, "upvote", 15_000),
        ),
      );

      const stored = await db.collection("comments").findOne({ commentId });
      assert.ok(stored);
      assert.equal(stored.upvotes.length, 25);
      assert.equal(new Set(stored.upvotes).size, 25);
      assert.equal(stored.downvotes.length, 0);
      assert.equal(stored.voteVersion, 25);
    } finally {
      await db.dropDatabase();
      await client.close();
    }
  },
);

test(
  "a stuck comment vote fails within its retry budget and logs the comment",
  { skip: !uri },
  async () => {
    const client = new MongoClient(uri!);
    await client.connect();
    const db = client.db(`engage_comment_votes_stuck_${Date.now()}`);
    const warnings: Array<Record<string, unknown>> = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      try {
        warnings.push(JSON.parse(String(args[0])) as Record<string, unknown>);
      } catch {
        // Ignore unrelated warnings.
      }
    };
    try {
      const proposalId = "comment-vote-stuck";
      const commentId = `cmt-${crypto.randomUUID()}`;
      await seedComment(db, proposalId, commentId);
      const member = voter(1);
      const started = Date.now();
      await assert.rejects(
        // 1 ms is clamped to the 250 ms floor, so the failure stays fast.
        voteOnComment(
          neverMatchingWrites(db),
          member,
          commentId,
          "upvote",
          1,
        ),
        /Comment votes changed at the same time/,
      );
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 200, `budget expired after ${elapsed}ms`);
      assert.ok(elapsed < 5_000, `budget was bounded (${elapsed}ms)`);

      const warning = warnings.find(
        (entry) => entry.event === "comment_vote_retry_budget_exhausted",
      );
      assert.ok(warning, "budget expiry is logged");
      assert.equal(warning.commentId, commentId);
      assert.equal(warning.budgetMs, 250);
      const serialised = JSON.stringify(warning);
      assert.ok(!serialised.includes(member.memberId));
      assert.ok(!serialised.includes("upvote"));
    } finally {
      console.warn = originalWarn;
      await db.dropDatabase();
      await client.close();
    }
  },
);
