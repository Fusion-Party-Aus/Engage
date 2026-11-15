import assert from "node:assert/strict";
import { test } from "node:test";
import { MongoClient } from "mongodb";
import { voteOnComment } from "./store.ts";
import type { SessionUser } from "./types.ts";

/**
 * Proves the comment-vote compare-and-swap on a real MongoDB server.
 *
 * The in-memory database serialises updates in one process; it cannot show
 * that concurrent writers do not overwrite each other. This case runs only
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

      const voters = Array.from({ length: 25 }, (_, index) => voter(index));
      const results = await Promise.all(
        voters.map((member) =>
          voteOnComment(db, member, commentId, "upvote"),
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
        voteOnComment(db, voter(99), commentId, "upvote"),
        voteOnComment(db, voter(99), commentId, "upvote"),
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
