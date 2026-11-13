import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoClient } from "mongodb";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  castVote,
  deleteProposal,
  getProposalDetail,
  listUserActivity,
  saveProposal,
} from "./store.ts";
import type { SessionUser } from "./types.ts";
import {
  ensureVoteStorage,
  migrateProposalVotes,
  PROPOSAL_VOTES,
  proposalBallotId,
} from "./vote-storage.ts";
import { POST as bindBallot } from "../pages/api/admin/ballots/bind.ts";
import { getDatabase, closeDatabase } from "./db.ts";

const uri = process.env.VOTING_TEST_MONGODB_URI;
const member: SessionUser = {
  memberId: "member-1",
  name: "Member",
  email: "member@example.test",
  role: "member",
  status: "verified",
  canParticipate: true,
  isStaff: false,
  isAdmin: false,
};

test(
  "real MongoDB startup seeds baseline policies without conflicting update paths",
  { skip: !uri },
  async () => {
    const client = await new MongoClient(uri!).connect();
    const db = client.db(
      `engage_vote_test_${crypto.randomUUID().replaceAll("-", "")}`,
    );
    try {
      const seeded = await getDatabase({
        MONGODB_URI: uri!,
        MONGODB_DB_NAME: db.databaseName,
        APP_MODE: "production",
      });
      assert.equal(await seeded.collection("proposals").countDocuments(), 78);
      assert.equal(
        (await seeded.collection(PROPOSAL_VOTES).indexes()).find(
          (i) => i.name === "one_current_proposal_vote_per_member_ballot",
        )?.unique,
        true,
      );
    } finally {
      await closeDatabase();
      await db.dropDatabase();
      await client.close();
    }
  },
);

test(
  "proposal content and its immutable revisions commit together on MongoDB",
  { skip: !uri },
  async () => {
    const client = await new MongoClient(uri!).connect();
    const db = client.db(
      `engage_revision_test_${crypto.randomUUID().replaceAll("-", "")}`,
    );
    try {
      const appDb = await getDatabase({
        MONGODB_URI: uri!,
        MONGODB_DB_NAME: db.databaseName,
        APP_MODE: "production",
      });
      const admin: SessionUser = {
        memberId: "revision-admin",
        name: "Revision Admin",
        email: "admin@example.test",
        role: "administrator",
        status: "verified",
        canParticipate: true,
        isStaff: true,
        isAdmin: true,
      };
      const created = await saveProposal(appDb, admin, {
        title: "Atomic revision test",
        space: "Governance",
        summary: "Initial wording for a MongoDB revision transaction.",
      });
      const first = await appDb
        .collection("proposal_revisions")
        .findOne({ proposalId: created.proposalId });
      assert.ok(first?.revisionId);
      await saveProposal(appDb, admin, {
        proposalId: created.proposalId,
        summary: "Updated wording for a MongoDB revision transaction.",
      });
      const revisions = await appDb
        .collection("proposal_revisions")
        .find({ proposalId: created.proposalId })
        .sort({ createdAt: 1 })
        .toArray();
      assert.equal(revisions.length, 2);
      assert.equal(revisions[1]?.parentRevisionId, revisions[0]?.revisionId);
      assert.equal(
        revisions[1]?.snapshot.summary,
        "Updated wording for a MongoDB revision transaction.",
      );
      assert.equal(
        (
          await appDb
            .collection("proposals")
            .findOne({ proposalId: created.proposalId })
        )?.summary,
        revisions[1]?.snapshot.summary,
      );
    } finally {
      await closeDatabase();
      await db.dropDatabase();
      await client.close();
    }
  },
);

test(
  "one member can vote on two independent policies despite the legacy ballot index",
  { skip: !uri },
  async () => {
    const client = await new MongoClient(uri!).connect();
    const db = client.db(
      `engage_vote_test_${crypto.randomUUID().replaceAll("-", "")}`,
    );
    try {
      await db
        .collection("votes")
        .createIndex(
          { ballotId: 1, memberId: 1 },
          { unique: true, name: "one_current_vote_per_member_ballot" },
        );
      // Match all three unique indexes observed on the NUC, including policy-era storage.
      await db
        .collection("votes")
        .createIndex({ policyId: 1, memberId: 1 }, { unique: true });
      await db
        .collection("votes")
        .createIndex({ proposalId: 1, memberId: 1 }, { unique: true });
      await db
        .collection("proposals")
        .insertMany(
          ["POL-001", "POL-002"].map((proposalId) => ({
            proposalId,
            stage: "decide",
          })),
        );
      await db
        .collection("proposal_revisions")
        .insertMany(
          ["POL-001", "POL-002"].map((proposalId) => ({
            proposalId,
            revisionId: `revision-${proposalId}`,
            parentRevisionId: null,
            createdAt: new Date(),
            snapshot: { title: proposalId, summary: "Versioned ballot test." },
            contentHash: `hash-${proposalId}`,
          })),
        );
      await migrateProposalVotes(db, true);
      await castVote(db, member, { policyId: "POL-001", choice: "approve" });
      await castVote(db, member, { policyId: "POL-002", choice: "reject" });
      const revote = await castVote(db, member, {
        proposalId: "POL-001",
        choice: "abstain",
      });
      assert.deepEqual(revote.votes, {
        approve: 0,
        abstain: 1,
        reject: 0,
        total: 1,
      });
      assert.equal(await db.collection(PROPOSAL_VOTES).countDocuments(), 2);
      assert.equal(
        (await db.collection(PROPOSAL_VOTES).findOne({ proposalId: "POL-002" }))
          ?.ballotId,
        proposalBallotId("POL-002"),
      );
      await Promise.all(
        Array.from({ length: 8 }, () =>
          castVote(db, member, {
            proposalId: "POL-001",
            ballotId: "consultation-b",
            choice: "abstain",
          }),
        ),
      );
      assert.equal(await db.collection(PROPOSAL_VOTES).countDocuments(), 2);
      assert.equal(
        (await db.collection(PROPOSAL_VOTES).findOne({ proposalId: "POL-001" }))
          ?.ballotId,
        proposalBallotId("POL-001"),
      );
      await assert.rejects(
        db
          .collection(PROPOSAL_VOTES)
          .insertOne({
            ballotId: proposalBallotId("POL-001"),
            memberId: member.memberId,
          }),
        { code: 11000 },
      );
      await assert.rejects(
        castVote(
          db,
          { ...member, canParticipate: false },
          { policyId: "POL-002", choice: "approve" },
        ),
        /verified/,
      );
      await assert.rejects(
        castVote(db, member, { policyId: "POL-002", choice: "invalid" }),
        /Choose/,
      );
      await db
        .collection("proposals")
        .updateOne({ proposalId: "POL-002" }, { $set: { stage: "implement" } });
      await assert.rejects(
        castVote(db, member, { policyId: "POL-002", choice: "approve" }),
        /Decide stage/,
      );
      await assert.rejects(
        deleteProposal(db, { ...member, isAdmin: true }, "POL-001"),
        /cannot be deleted/i,
      );
      assert.equal(await db.collection(PROPOSAL_VOTES).countDocuments(), 2);
    } finally {
      await db.dropDatabase();
      await client.close();
    }
  },
);

test(
  "migration preserves mixed legacy ballots and current votes, and is read-only by default and restartable",
  { skip: !uri },
  async () => {
    const client = await new MongoClient(uri!).connect();
    const db = client.db(
      `engage_vote_test_${crypto.randomUUID().replaceAll("-", "")}`,
    );
    try {
      const source = db.collection("votes");
      await source.createIndex(
        { ballotId: 1, memberId: 1 },
        { unique: true, name: "one_current_vote_per_member_ballot" },
      );
      const proposalRevisionId = "reviewed-revision-POL-001";
      await db
        .collection("proposals")
        .insertOne({ proposalId: "POL-001", stage: "decide" });
      await db
        .collection("proposal_revisions")
        .insertOne({
          proposalId: "POL-001",
          revisionId: proposalRevisionId,
          parentRevisionId: null,
          createdAt: new Date(),
          snapshot: {
            title: "Reviewed legacy wording",
            summary: "Exact selected wording.",
          },
          contentHash: "reviewed-legacy-hash",
        });
      await source.insertMany([
        {
          ballotId: "consultation-a",
          proposalId: "POL-001",
          memberId: member.memberId,
          choice: "approve",
          eligibilitySnapshot: { valid: true },
        },
        {
          ballotId: "consultation-b",
          proposalId: "POL-001",
          memberId: member.memberId,
          choice: "do-not-approve",
        },
        {
          ballotId: null,
          proposalId: "POL-001",
          memberId: member.memberId,
          choice: "approve",
          updatedAt: new Date(),
          reason: "Original reason",
        },
      ]);
      const before = await source.find({}).toArray();
      const indexes = await source.listIndexes().toArray();
      await assert.rejects(ensureVoteStorage(db), /migration required/);
      const plan = await migrateProposalVotes(db);
      assert.equal(plan.legacyBallots, 2);
      assert.equal(plan.currentVotes, 1);
      assert.equal(await db.collection(PROPOSAL_VOTES).countDocuments(), 0);
      assert.equal(
        await db.collection("schema_migrations").countDocuments(),
        0,
      );
      const cli = await promisify(execFile)(
        process.execPath,
        ["scripts/migrate-proposal-votes.mjs", "--dry-run"],
        {
          env: {
            ...process.env,
            MONGODB_URI: uri!,
            MONGODB_DB_NAME: db.databaseName,
          },
          timeout: 10000,
        },
      );
      assert.equal(JSON.parse(cli.stdout).currentVotes, 1);
      assert.ok(!cli.stdout.includes("Original reason"));
      assert.equal(await db.collection(PROPOSAL_VOTES).countDocuments(), 0);
      await assert.rejects(
        promisify(execFile)(
          process.execPath,
          ["scripts/migrate-proposal-votes.mjs", "--apply"],
          {
            env: {
              ...process.env,
              MONGODB_URI: uri!,
              MONGODB_DB_NAME: db.databaseName,
            },
            timeout: 10000,
          },
        ),
        /Stop all writers/,
      );
      await migrateProposalVotes(db, true);
      await ensureVoteStorage(db);
      assert.equal(
        (await listUserActivity(db, member.memberId)).votes.length,
        1,
      );
      const migrated = await db
        .collection(PROPOSAL_VOTES)
        .findOne({ memberId: member.memberId });
      assert.equal(migrated?.reason, "Original reason");
      await assert.rejects(
        castVote(db, member, { proposalId: "POL-001", choice: "reject" }),
        /administrator must review/,
      );
      const bindResponse = await bindBallot({
        request: new Request("http://localhost/api/admin/ballots/bind", {
          method: "POST",
          headers: {
            Cookie: "engage_dev_user=administrator",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            proposalId: "POL-001",
            revisionId: proposalRevisionId,
            decisionEventId: "manual-review-POL-001",
            reason:
              "Compared the saved revision with the recorded ballot evidence.",
          }),
        }),
        locals: {
          runtime: {
            env: {
              APP_MODE: "development",
              MONGODB_URI: uri!,
              MONGODB_DB_NAME: db.databaseName,
            },
          },
        },
      } as never);
      assert.equal(bindResponse.status, 201);
      assert.equal(
        (
          await db
            .collection(PROPOSAL_VOTES)
            .findOne({ memberId: member.memberId })
        )?.revisionId,
        proposalRevisionId,
      );
      await castVote(db, member, { proposalId: "POL-001", choice: "reject" });
      await migrateProposalVotes(db, true); // Must not reset a later selection.
      assert.equal(
        (
          await db
            .collection(PROPOSAL_VOTES)
            .findOne({ memberId: member.memberId })
        )?.choice,
        "reject",
      );
      assert.deepEqual(await source.find({}).toArray(), before);
      assert.deepEqual(await source.listIndexes().toArray(), indexes);
      await assert.rejects(
        source.insertOne({
          ballotId: "consultation-a",
          memberId: member.memberId,
        }),
        { code: 11000 },
      );
    } finally {
      await closeDatabase();
      await db.dropDatabase();
      await client.close();
    }
  },
);

test(
  "NUC record shape migrates without changing originals, totals or content locks",
  { skip: !uri },
  async () => {
    const client = await new MongoClient(uri!).connect();
    const db = client.db(
      `engage_vote_test_${crypto.randomUUID().replaceAll("-", "")}`,
    );
    try {
      const source = db.collection("votes");
      await source.createIndex(
        { ballotId: 1, memberId: 1 },
        { unique: true, name: "one_current_vote_per_member_ballot" },
      );
      await source.createIndex({ policyId: 1, memberId: 1 }, { unique: true });
      await source.createIndex(
        { proposalId: 1, memberId: 1 },
        { unique: true },
      );
      await db
        .collection("proposals")
        .insertOne({
          proposalId: "POL-001",
          slug: "policy-one",
          title: "Original",
          stage: "deliberate",
        });
      // Same field shape/count as production; synthetic member IDs and choices.
      await source.insertMany(
        Array.from({ length: 4 }, (_, i) => ({
          proposalId: "POL-001",
          memberId: `synthetic-${i}`,
          authorName: "Synthetic Member",
          choice: "approve",
          reason: "",
          updatedAt: new Date(),
        })),
      );
      const before = await source.find({}).toArray();
      const indexes = await source.listIndexes().toArray();
      const result = await migrateProposalVotes(db, true);
      assert.equal(result.currentVotes, 4);
      assert.equal(result.destinationCount, 4);
      assert.deepEqual(await source.find({}).toArray(), before);
      assert.deepEqual(await source.listIndexes().toArray(), indexes);
      assert.deepEqual(
        await db.collection(PROPOSAL_VOTES).find({}).toArray(),
        before.map((v) => ({ ...v, ballotId: proposalBallotId(v.proposalId) })),
      );
      const detail = await getProposalDetail(db, "policy-one", null);
      assert.equal(detail?.proposal.votes.total, 4);
      await assert.rejects(
        saveProposal(
          db,
          { ...member, isAdmin: true, isStaff: true },
          {
            proposalId: "POL-001",
            title: "Changed",
            stage: "deliberate",
          },
        ),
        /locked/,
      );
    } finally {
      await db.dropDatabase();
      await client.close();
    }
  },
);

test(
  "migration resumes a partial copy and startup fails if uniqueness cannot be installed",
  { skip: !uri },
  async () => {
    const client = await new MongoClient(uri!).connect();
    const db = client.db(
      `engage_vote_test_${crypto.randomUUID().replaceAll("-", "")}`,
    );
    try {
      await db.collection("proposals").insertOne({ proposalId: "POL-001" });
      await db
        .collection("votes")
        .insertMany(
          [member.memberId, "member-2"].map((memberId) => ({
            proposalId: "POL-001",
            memberId,
            choice: "approve",
            updatedAt: new Date(),
          })),
        );
      const plan = await migrateProposalVotes(db);
      await db.collection(PROPOSAL_VOTES).insertOne(plan.copies[0]!);
      await migrateProposalVotes(db, true);
      assert.equal(await db.collection(PROPOSAL_VOTES).countDocuments(), 2);
      await db
        .collection(PROPOSAL_VOTES)
        .dropIndex("one_current_proposal_vote_per_member_ballot");
      await db
        .collection(PROPOSAL_VOTES)
        .createIndex(
          { ballotId: 1, memberId: 1 },
          { name: "one_current_proposal_vote_per_member_ballot" },
        );
      await assert.rejects(ensureVoteStorage(db), { code: 86 });
    } finally {
      await db.dropDatabase();
      await client.close();
    }
  },
);

test(
  "ambiguous, duplicate and conflicting records block migration without choosing or overwriting votes",
  { skip: !uri },
  async () => {
    const client = await new MongoClient(uri!).connect();
    const db = client.db(
      `engage_vote_test_${crypto.randomUUID().replaceAll("-", "")}`,
    );
    try {
      await db.collection("proposals").insertOne({ proposalId: "POL-001" });
      const record = {
        proposalId: "POL-001",
        memberId: member.memberId,
        choice: "approve",
        updatedAt: new Date(),
      };
      await db.collection("votes").insertMany([{ ...record }, { ...record }]);
      await assert.rejects(migrateProposalVotes(db, true), /Duplicate source/);
      assert.equal(await db.collection(PROPOSAL_VOTES).countDocuments(), 0);
      await db.collection("votes").deleteMany({});
      await db
        .collection("votes")
        .insertOne({ policyId: "POL-001", memberId: member.memberId });
      await assert.rejects(migrateProposalVotes(db, true), /Unrecognised/);
      await db.collection("votes").deleteMany({});
      const inserted = await db.collection("votes").insertOne(record);
      await db
        .collection(PROPOSAL_VOTES)
        .insertOne({
          ...record,
          _id: inserted.insertedId,
          ballotId: proposalBallotId("POL-001"),
          choice: "reject",
        });
      await assert.rejects(migrateProposalVotes(db, true), /differs/);
      assert.equal(
        await db.collection("schema_migrations").countDocuments(),
        0,
      );
      assert.equal(
        (await db.collection(PROPOSAL_VOTES).findOne({}))?.choice,
        "reject",
      );
    } finally {
      await db.dropDatabase();
      await client.close();
    }
  },
);
