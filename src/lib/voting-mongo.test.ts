import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoClient } from "mongodb";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { castVote, deleteProposal, listUserActivity } from "./store.ts";
import type { SessionUser } from "./types.ts";
import { ensureVoteStorage, migrateProposalVotes, PROPOSAL_VOTES, proposalBallotId } from "./vote-storage.ts";

const uri = process.env.VOTING_TEST_MONGODB_URI;
const member: SessionUser = { memberId: "member-1", name: "Member", email: "member@example.test", role: "member", status: "verified", canParticipate: true, isStaff: false, isAdmin: false };

test("one member can vote on two independent policies despite the legacy ballot index", { skip: !uri }, async () => {
  const client = await new MongoClient(uri!).connect();
  const db = client.db(`engage_vote_test_${crypto.randomUUID().replaceAll("-", "")}`);
  try {
    await db.collection("votes").createIndex({ ballotId: 1, memberId: 1 }, { unique: true, name: "one_current_vote_per_member_ballot" });
    await db.collection("proposals").insertMany(["POL-001", "POL-002"].map(proposalId => ({ proposalId, stage: "decide" })));
    await migrateProposalVotes(db, true);
    await castVote(db, member, { policyId: "POL-001", choice: "approve" });
    await castVote(db, member, { policyId: "POL-002", choice: "reject" });
    const revote = await castVote(db, member, { proposalId: "POL-001", choice: "abstain" });
    assert.deepEqual(revote.votes, { approve: 0, abstain: 1, reject: 0, total: 1 });
    assert.equal(await db.collection(PROPOSAL_VOTES).countDocuments(), 2);
    assert.equal((await db.collection(PROPOSAL_VOTES).findOne({ proposalId: "POL-002" }))?.ballotId, proposalBallotId("POL-002"));
    await assert.rejects(db.collection(PROPOSAL_VOTES).insertOne({ ballotId: proposalBallotId("POL-001"), memberId: member.memberId }), { code: 11000 });
    await assert.rejects(castVote(db, { ...member, canParticipate: false }, { policyId: "POL-002", choice: "approve" }), /verified/);
    await assert.rejects(castVote(db, member, { policyId: "POL-002", choice: "invalid" }), /Choose/);
    await db.collection("proposals").updateOne({ proposalId: "POL-002" }, { $set: { stage: "implement" } });
    await assert.rejects(castVote(db, member, { policyId: "POL-002", choice: "approve" }), /Decide stage/);
    await deleteProposal(db, { ...member, isAdmin: true }, "POL-001");
    assert.equal(await db.collection(PROPOSAL_VOTES).countDocuments(), 2);
  } finally { await db.dropDatabase(); await client.close(); }
});

test("migration preserves mixed legacy ballots and current votes, and is read-only by default and restartable", { skip: !uri }, async () => {
  const client = await new MongoClient(uri!).connect();
  const db = client.db(`engage_vote_test_${crypto.randomUUID().replaceAll("-", "")}`);
  try {
    const source = db.collection("votes");
    await source.createIndex({ ballotId: 1, memberId: 1 }, { unique: true, name: "one_current_vote_per_member_ballot" });
    await db.collection("proposals").insertOne({ proposalId: "POL-001", stage: "decide" });
    await source.insertMany([
      { ballotId: "consultation-a", proposalId: "POL-001", memberId: member.memberId, choice: "approve", eligibilitySnapshot: { valid: true } },
      { ballotId: "consultation-b", proposalId: "POL-001", memberId: member.memberId, choice: "do-not-approve" },
      { ballotId: null, proposalId: "POL-001", memberId: member.memberId, choice: "approve", updatedAt: new Date(), reason: "Original reason" },
    ]);
    const before = await source.find({}).toArray();
    const indexes = await source.listIndexes().toArray();
    await assert.rejects(ensureVoteStorage(db), /migration required/);
    const plan = await migrateProposalVotes(db);
    assert.equal(plan.legacyBallots, 2);
    assert.equal(plan.currentVotes, 1);
    assert.equal(await db.collection(PROPOSAL_VOTES).countDocuments(), 0);
    assert.equal(await db.collection("schema_migrations").countDocuments(), 0);
    const cli = await promisify(execFile)(process.execPath, ["scripts/migrate-proposal-votes.mjs", "--dry-run"], {
      env: { ...process.env, MONGODB_URI: uri!, MONGODB_DB_NAME: db.databaseName }, timeout: 10000,
    });
    assert.equal(JSON.parse(cli.stdout).currentVotes, 1);
    assert.ok(!cli.stdout.includes("Original reason"));
    assert.equal(await db.collection(PROPOSAL_VOTES).countDocuments(), 0);
    await assert.rejects(promisify(execFile)(process.execPath, ["scripts/migrate-proposal-votes.mjs", "--apply"], {
      env: { ...process.env, MONGODB_URI: uri!, MONGODB_DB_NAME: db.databaseName }, timeout: 10000,
    }), /Stop all writers/);
    await migrateProposalVotes(db, true);
    await ensureVoteStorage(db);
    assert.equal((await listUserActivity(db, member.memberId)).votes.length, 1);
    const migrated = await db.collection(PROPOSAL_VOTES).findOne({ memberId: member.memberId });
    assert.equal(migrated?.reason, "Original reason");
    await castVote(db, member, { proposalId: "POL-001", choice: "reject" });
    await migrateProposalVotes(db, true); // Must not reset a later selection.
    assert.equal((await db.collection(PROPOSAL_VOTES).findOne({ memberId: member.memberId }))?.choice, "reject");
    assert.deepEqual(await source.find({}).toArray(), before);
    assert.deepEqual(await source.listIndexes().toArray(), indexes);
    await assert.rejects(source.insertOne({ ballotId: "consultation-a", memberId: member.memberId }), { code: 11000 });
  } finally { await db.dropDatabase(); await client.close(); }
});

test("migration resumes a partial copy and startup fails if uniqueness cannot be installed", { skip: !uri }, async () => {
  const client = await new MongoClient(uri!).connect();
  const db = client.db(`engage_vote_test_${crypto.randomUUID().replaceAll("-", "")}`);
  try {
    await db.collection("proposals").insertOne({ proposalId: "POL-001" });
    await db.collection("votes").insertMany([member.memberId, "member-2"].map(memberId => ({ proposalId: "POL-001", memberId, choice: "approve", updatedAt: new Date() })));
    const plan = await migrateProposalVotes(db);
    await db.collection(PROPOSAL_VOTES).insertOne(plan.copies[0]!);
    await migrateProposalVotes(db, true);
    assert.equal(await db.collection(PROPOSAL_VOTES).countDocuments(), 2);
    await db.collection(PROPOSAL_VOTES).dropIndex("one_current_proposal_vote_per_member_ballot");
    await db.collection(PROPOSAL_VOTES).createIndex({ ballotId: 1, memberId: 1 }, { name: "one_current_proposal_vote_per_member_ballot" });
    await assert.rejects(ensureVoteStorage(db), { code: 86 });
  } finally { await db.dropDatabase(); await client.close(); }
});

test("ambiguous, duplicate and conflicting records block migration without choosing or overwriting votes", { skip: !uri }, async () => {
  const client = await new MongoClient(uri!).connect();
  const db = client.db(`engage_vote_test_${crypto.randomUUID().replaceAll("-", "")}`);
  try {
    await db.collection("proposals").insertOne({ proposalId: "POL-001" });
    const record = { proposalId: "POL-001", memberId: member.memberId, choice: "approve", updatedAt: new Date() };
    await db.collection("votes").insertMany([{ ...record }, { ...record }]);
    await assert.rejects(migrateProposalVotes(db, true), /Duplicate source/);
    assert.equal(await db.collection(PROPOSAL_VOTES).countDocuments(), 0);
    await db.collection("votes").deleteMany({});
    await db.collection("votes").insertOne({ policyId: "POL-001", memberId: member.memberId });
    await assert.rejects(migrateProposalVotes(db, true), /Unrecognised/);
    await db.collection("votes").deleteMany({});
    const inserted = await db.collection("votes").insertOne(record);
    await db.collection(PROPOSAL_VOTES).insertOne({ ...record, _id: inserted.insertedId, ballotId: proposalBallotId("POL-001"), choice: "reject" });
    await assert.rejects(migrateProposalVotes(db, true), /differs/);
    assert.equal(await db.collection("schema_migrations").countDocuments(), 0);
    assert.equal((await db.collection(PROPOSAL_VOTES).findOne({}))?.choice, "reject");
  } finally { await db.dropDatabase(); await client.close(); }
});
