import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { MongoClient, type Db } from "mongodb";
import { loadAdminParticipation } from "./admin-participation.ts";

// The panel reads `proposal_votes` directly, so the mapping and deduplication
// are verified against real documents on a MongoDB replica set.
const mongoUri = process.env.VOTING_TEST_MONGODB_URI;

const now = new Date("2026-11-16T09:00:00Z");
const windowStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
const hoursAgo = (hours: number) =>
  new Date(now.getTime() - hours * 60 * 60 * 1000);
const daysAgo = (days: number) =>
  new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

const proposals = [
  {
    proposalId: "p1",
    slug: "housing",
    title: "Housing",
    authorId: "author-1",
    authorName: "Author One",
    createdAt: daysAgo(30).toISOString(),
  },
  {
    proposalId: "p2",
    slug: "transport",
    title: "Transport",
    authorId: "m3",
    authorName: "Sam Member",
    createdAt: daysAgo(2).toISOString(),
  },
];

async function seed(db: Db) {
  await db.collection("proposals").insertMany([
    {
      proposalId: "p1",
      slug: "housing",
      title: "Housing",
      authorId: "author-1",
      authorName: "Author One",
      createdAt: daysAgo(30),
    },
    {
      proposalId: "p2",
      slug: "transport",
      title: "Transport",
      authorId: "m3",
      authorName: "Sam Member",
      createdAt: daysAgo(2),
    },
  ]);
  await db.collection("proposal_votes").insertMany([
    {
      // Encrypted ballot: no memberId and no authorName are stored.
      _id: "encrypted-1" as any,
      ballotId: "proposal:p1",
      proposalId: "p1",
      revisionId: "rev-1",
      voterBlindIndex: "blind-1",
      voteEnvelope: { ciphertext: "not-for-the-panel" },
      updatedAt: hoursAgo(1),
    },
    {
      // Replayed copy of the same encrypted act.
      _id: "encrypted-replay" as any,
      ballotId: "proposal:p1",
      proposalId: "p1",
      revisionId: "rev-1",
      voterBlindIndex: "blind-1",
      voteEnvelope: { ciphertext: "not-for-the-panel" },
      updatedAt: hoursAgo(1),
    },
    {
      // Legacy plaintext ballot: identity is present, choice must stay hidden.
      _id: "plaintext-1" as any,
      ballotId: "proposal:p2",
      proposalId: "p2",
      memberId: "m1",
      authorName: "Ada Member",
      choice: "reject",
      reason: "a private reason",
      updatedAt: hoursAgo(2),
    },
    {
      _id: "plaintext-2" as any,
      ballotId: "proposal:p2",
      proposalId: "p2",
      memberId: "m2",
      authorName: "Alex Member",
      choice: "approve",
      reason: "another private reason",
      updatedAt: hoursAgo(3),
    },
    {
      // Amendment ballots are out of scope for this feed.
      _id: "amendment-1" as any,
      ballotId: "amendment:a1",
      proposalId: "p1",
      memberId: "m4",
      authorName: "Amendment Member",
      updatedAt: hoursAgo(0.5),
    },
    {
      // Prior activity, so this member is not a first-time participant.
      _id: "old-1" as any,
      ballotId: "proposal:p1",
      proposalId: "p1",
      memberId: "m3",
      authorName: "Sam Member",
      updatedAt: daysAgo(8),
    },
  ]);
  await db.collection("comments").insertOne({
    commentId: "c1",
    proposalId: "p1",
    memberId: "m2",
    authorName: "Alex Member",
    body: "A comment",
    createdAt: daysAgo(1),
  });
}

describe("admin participation feed", { skip: !mongoUri }, () => {
  let client: MongoClient;
  let db: Db;

  before(async () => {
    client = await new MongoClient(mongoUri!).connect();
    db = client.db(`engage_admin_participation_${crypto.randomUUID().replaceAll("-", "")}`);
    await seed(db);
  });

  after(async () => {
    await db.dropDatabase();
    await client.close();
  });

  it("classifies votes as votes and keeps their genuine timestamps", async () => {
    const result = await loadAdminParticipation(db, proposals, {
      showIdentifiableBallots: true,
      windowStart,
    });
    const votes = result.events.filter((event) => event.kind === "vote");
    assert.equal(votes.length, 3);
    assert.ok(votes.every((event) => event.action === "voted on"));

    const encrypted = votes.find((event) => event.target === "Housing");
    assert.ok(encrypted, "the encrypted vote appears on its proposal");
    assert.equal(encrypted!.actor, "A member");
    assert.equal(encrypted!.date.toISOString(), hoursAgo(1).toISOString());

    const named = votes.filter((event) => event.target === "Transport");
    assert.deepEqual(
      named.map((event) => event.actor).sort(),
      ["Ada Member", "Alex Member"],
    );
  });

  it("keeps the summary strip and the filter counts on one classification", async () => {
    const result = await loadAdminParticipation(db, proposals, {
      showIdentifiableBallots: true,
      windowStart,
    });
    assert.equal(result.summary.votes, result.events.filter((event) => event.kind === "vote").length);
    assert.equal(
      result.summary.contributions,
      result.events.filter((event) => event.kind === "contribution").length,
    );
    assert.equal(
      result.summary.proposals,
      result.events.filter((event) => event.kind === "proposal").length,
    );
    assert.deepEqual(result.summary, {
      votes: 3,
      contributions: 1,
      proposals: 1,
      firstTimeParticipants: 2,
    });

    const submission = result.events.find((event) => event.kind === "proposal");
    assert.equal(submission?.actor, "Sam Member");
    assert.equal(submission?.action, "submitted");
    const contribution = result.events.find((event) => event.kind === "contribution");
    assert.equal(contribution?.action, "contributed to");
  });

  it("drops a replayed encrypted vote but keeps separate ballots and voters", async () => {
    const result = await loadAdminParticipation(db, proposals, {
      showIdentifiableBallots: true,
      windowStart,
    });
    assert.equal(
      result.events.filter((event) => event.target === "Housing" && event.kind === "vote").length,
      1,
    );
    assert.equal(
      result.events.filter((event) => event.target === "Transport" && event.kind === "vote").length,
      2,
    );
    assert.equal(
      result.events.some((event) => event.actor === "Amendment Member"),
      false,
    );
  });

  it("never exposes a vote choice, reason or envelope", async () => {
    const result = await loadAdminParticipation(db, proposals, {
      showIdentifiableBallots: true,
      windowStart,
    });
    const serialized = JSON.stringify(result);
    for (const secret of [
      "reject",
      "approve",
      "a private reason",
      "another private reason",
      "not-for-the-panel",
      "blind-1",
      "voterBlindIndex",
      "voteEnvelope",
    ]) {
      assert.equal(serialized.includes(secret), false, `${secret} leaked`);
    }
  });

  it("omits votes entirely without identifiable-ballot permission", async () => {
    const result = await loadAdminParticipation(db, proposals, {
      showIdentifiableBallots: false,
      windowStart,
    });
    assert.equal(result.summary.votes, 0);
    assert.equal(result.events.some((event) => event.kind === "vote"), false);
    assert.equal(result.summary.contributions, 1);
    assert.equal(result.summary.proposals, 1);
  });
});
