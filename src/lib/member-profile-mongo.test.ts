import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { getMemberProfilePage } from "./member-profile.ts";

/**
 * Real-MongoDB coverage for the profile read model.
 *
 * The in-memory database does not implement `$group`, so the comment-karma
 * aggregation path is only meaningful against MongoDB. This suite is skipped
 * unless the same test URI used by the voting suite is configured.
 */

const uri = process.env.VOTING_TEST_MONGODB_URI;
const client = uri ? new MongoClient(uri, { serverSelectionTimeoutMS: 2000 }) : null;
const databaseName = `engage-profile-${randomUUID().slice(0, 8)}`;
let db: Db | null = null;

async function database(): Promise<Db> {
  if (!client) throw new Error("MongoDB test client is not configured");
  if (!db) {
    await client.connect();
    db = client.db(databaseName);
  }
  return db;
}

after(async () => {
  if (db) await db.dropDatabase().catch(() => {});
  await client?.close();
});

describe("public profile on MongoDB", { skip: !uri }, () => {
  it("aggregates karma only across visible, non-deleted comments", async () => {
    const testDb = await database();
    const memberId = new ObjectId();
    const otherId = new ObjectId();
    const memberKey = memberId.toHexString();

    await testDb.collection("user").insertOne({
      _id: memberId,
      name: "Ada Lovelace",
      bio: "Real MongoDB biography.",
      createdAt: new Date(Date.UTC(2025, 5, 1)),
      disabled: false,
    } as any);
    await testDb.collection("user").insertOne({
      _id: otherId,
      name: "Bob Member",
      createdAt: new Date(Date.UTC(2025, 6, 1)),
      disabled: false,
    } as any);

    await testDb.collection("proposals").insertMany([
      {
        proposalId: "PROP-PUBLIC",
        slug: "public-proposal",
        title: "Public proposal",
        summary: "Public",
        stage: "deliberate",
        authorId: memberKey,
        authorName: "Ada Lovelace",
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 1)),
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 1)),
      },
      {
        proposalId: "PROP-PRIVATE",
        slug: "private-proposal",
        title: "Private proposal",
        summary: "Private",
        stage: "deliberate",
        publicationScope: "private",
        authorId: otherId.toHexString(),
        authorName: "Bob Member",
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 2)),
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 2)),
      },
    ]);

    await testDb.collection("comments").insertMany([
      {
        commentId: "cmt-public-1",
        proposalId: "PROP-PUBLIC",
        memberId: memberKey,
        authorName: "Ada Lovelace",
        stance: "support",
        body: "Visible support.",
        upvotes: ["v1", "v2"],
        downvotes: [],
        depth: 0,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 1, 0)),
      },
      {
        commentId: "cmt-public-2",
        proposalId: "PROP-PUBLIC",
        memberId: memberKey,
        authorName: "Ada Lovelace",
        stance: "concern",
        body: "Visible concern.",
        upvotes: ["v1"],
        downvotes: ["v2"],
        depth: 0,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 2, 0)),
      },
      {
        commentId: "cmt-private",
        proposalId: "PROP-PRIVATE",
        memberId: memberKey,
        authorName: "Ada Lovelace",
        stance: "comment",
        body: "Private text.",
        upvotes: Array.from({ length: 50 }, (_, index) => `p-${index}`),
        downvotes: [],
        depth: 0,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 3, 0)),
      },
      {
        commentId: "cmt-deleted",
        proposalId: "PROP-PUBLIC",
        memberId: memberKey,
        authorName: "Ada Lovelace",
        stance: "comment",
        body: "",
        deletedAt: new Date(Date.UTC(2026, 0, 1, 0, 4, 0)),
        upvotes: Array.from({ length: 30 }, (_, index) => `d-${index}`),
        downvotes: [],
        depth: 0,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 4, 0)),
      },
    ]);

    const page = await getMemberProfilePage(testDb, memberKey, {
      pageSize: 10,
    });
    assert.ok(page);
    assert.equal(page.profile.stats.comments, 2);
    assert.equal(page.profile.stats.karma, 2);
    assert.deepEqual(
      page.items.map((item) => item.id),
      ["cmt-public-2", "cmt-public-1"],
    );
    assert.equal(JSON.stringify(page).includes("Private text."), false);
    assert.equal(JSON.stringify(page).includes("v1"), false);
  });
});
