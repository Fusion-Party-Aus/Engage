import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoClient } from "mongodb";
import { initializeDatabase } from "./db.ts";
import {
  applyBulkBinding,
  buildBallotInventory,
  buildBulkBindingPlan,
  verifyBallotInventory,
} from "./ballot-migration.ts";
import { legacyRevisionId } from "./proposal-revision.ts";
import { PROPOSAL_VOTES, proposalBallotId } from "./vote-storage.ts";
import { castVote } from "./store.ts";
import type { SessionUser } from "./types.ts";

const uri = process.env.VOTING_TEST_MONGODB_URI;
const member: SessionUser = {
  memberId: "migration-member",
  name: "Migration Member",
  email: "member@example.test",
  role: "member",
  status: "verified",
  canParticipate: true,
  isStaff: false,
  isAdmin: false,
};
const options = {
  batchId: "test-retrospective-batch",
  decisionEventId: "test-retrospective-decision",
  actorId: "test-operator",
  reason:
    "Test rehearsal: wording and content hash confirmed unchanged since voting began.",
};
const createdAt = new Date("2026-10-27T08:35:23.933Z");
const voteAt = new Date("2026-11-01T00:00:00.000Z");

async function freshDb(name: string) {
  const client = await new MongoClient(uri!).connect();
  const db = client.db(
    `engage_${name}_${crypto.randomUUID().replaceAll("-", "")}`,
  );
  await initializeDatabase(db);
  return { client, db };
}

async function prepareBallots(db: any, proposalIds: string[]) {
  await db.collection("proposals").updateMany(
    { stage: "decide", proposalId: { $nin: proposalIds } },
    { $set: { stage: "deliberate" } },
  );
  await db.collection("proposals").updateMany(
    { proposalId: { $in: proposalIds } },
    { $set: { stage: "decide", createdAt } },
  );
  await db.collection("proposal_revisions").updateMany(
    { proposalId: { $in: proposalIds } },
    { $set: { createdAt } },
  );
  for (const [index, proposalId] of proposalIds.entries()) {
    await db.collection(PROPOSAL_VOTES).insertOne({
      ballotId: proposalBallotId(proposalId),
      proposalId,
      memberId: `existing-${index}`,
      authorName: `Existing ${index}`,
      choice: index % 2 === 0 ? "approve" : "reject",
      reason: "Existing production vote shape.",
      updatedAt: voteAt,
    });
  }
}

test(
  "startup is insert-only and never rewrites unchanged proposals or silently binds ballots",
  { skip: !uri },
  async () => {
    const { client, db } = await freshDb("startup_idempotency");
    try {
      const before = await db
        .collection("proposals")
        .find({})
        .sort({ proposalId: 1 })
        .toArray();
      assert.equal(before.length, 78);
      const revisionCount = await db
        .collection("proposal_revisions")
        .countDocuments();
      assert.equal(revisionCount, 78);
      const timestamps = new Map(
        before.map((proposal) => [
          proposal.proposalId,
          new Date(proposal.updatedAt).toISOString(),
        ]),
      );

      await db.collection(PROPOSAL_VOTES).insertOne({
        ballotId: proposalBallotId("GOV-001"),
        proposalId: "GOV-001",
        memberId: "startup-existing-voter",
        choice: "approve",
        updatedAt: voteAt,
      });

      await initializeDatabase(db);

      const after = await db
        .collection("proposals")
        .find({})
        .sort({ proposalId: 1 })
        .toArray();
      assert.equal(after.length, 78);
      for (const proposal of after)
        assert.equal(
          new Date(proposal.updatedAt).toISOString(),
          timestamps.get(proposal.proposalId),
          `${proposal.proposalId} updatedAt changed on restart`,
        );
      assert.equal(
        await db.collection("proposal_revisions").countDocuments(),
        revisionCount,
      );
      assert.equal(
        (await db.collection("proposals").findOne({ proposalId: "GOV-001" }))
          ?.ballotRevisionId,
        undefined,
      );
      assert.equal(
        await db.collection("ballot_binding_events").countDocuments(),
        0,
      );
    } finally {
      await db.dropDatabase();
      await client.close();
    }
  },
);

test(
  "bulk migration binds all existing votes to the deterministic revision and is idempotent",
  { skip: !uri },
  async () => {
    const { client, db } = await freshDb("bulk_binding");
    try {
      const ids = ["GOV-001", "POL-010"];
      await prepareBallots(db, ids);
      const inventory = await buildBallotInventory(db);
      assert.equal(inventory.ballotCount, 2);
      assert.equal(inventory.totalVotes, 2);
      assert.equal(inventory.classifications.supported, 2);
      for (const ballot of inventory.ballots) {
        assert.equal(ballot.evidence.baselineMatch, true);
        assert.equal(ballot.candidateRevisionExists, true);
      }

      const dryRun = await applyBulkBinding(db, inventory, options, {
        apply: false,
      });
      assert.equal(dryRun.transaction, "dry-run");
      assert.equal(
        await db.collection("ballot_binding_events").countDocuments(),
        0,
      );

      const first = await applyBulkBinding(db, inventory, options, {
        apply: true,
      });
      assert.equal(first.transaction, "committed");
      assert.equal(first.ballots.length, 2);
      assert.equal(
        await db.collection("ballot_binding_events").countDocuments(),
        2,
      );
      const verification = await verifyBallotInventory(db, inventory);
      assert.deepEqual(verification.failures, []);
      assert.equal(verification.verified, 2);

      for (const ballot of inventory.ballots) {
        const proposal = await db
          .collection("proposals")
          .findOne({ proposalId: ballot.proposalId });
        assert.ok(proposal);
        assert.equal(proposal.ballotRevisionId, ballot.candidateRevisionId);
        const votes = await db
          .collection(PROPOSAL_VOTES)
          .find({ proposalId: ballot.proposalId })
          .sort({ memberId: 1 })
          .toArray();
        assert.equal(votes.length, ballot.voteCount);
        assert.ok(votes.every((vote) => vote.revisionId === ballot.candidateRevisionId));
        assert.deepEqual(
          votes.map((vote) => vote.choice),
          [ballot.proposalId === "GOV-001" ? "approve" : "reject"],
        );
        assert.ok(votes.every((vote) => vote.updatedAt.getTime() === voteAt.getTime()));
      }

      const beforeRetry = await db
        .collection("ballot_binding_events")
        .countDocuments();
      const boundInventory = await buildBallotInventory(db, {
        includeBound: true,
      });
      const retry = await applyBulkBinding(db, boundInventory, options, {
        apply: true,
      });
      assert.equal(retry.transaction, "committed");
      assert.ok(retry.ballots.every((ballot) => ballot.idempotent));
      assert.equal(
        await db.collection("ballot_binding_events").countDocuments(),
        beforeRetry,
      );

      for (const ballot of inventory.ballots) {
        const result = await castVote(db, member, {
          proposalId: ballot.proposalId,
          choice: "abstain",
        });
        assert.equal(result.choice, "abstain");
        assert.equal(result.votes.total, 2);
      }
    } finally {
      await db.dropDatabase();
      await client.close();
    }
  },
);

test(
  "bulk migration also binds archived historical ballots so every existing vote is attached",
  { skip: !uri },
  async () => {
    const { client, db } = await freshDb("bulk_archived");
    try {
      await prepareBallots(db, ["GOV-001", "GOV-002"]);
      await db
        .collection("proposals")
        .updateOne({ proposalId: "GOV-002" }, { $set: { stage: "archived" } });
      const inventory = await buildBallotInventory(db);
      assert.equal(inventory.ballotCount, 2);
      assert.equal(inventory.totalVotes, 2);
      assert.equal(
        inventory.ballots.find((ballot) => ballot.proposalId === "GOV-002")
          ?.ballotScope,
        "archived-history",
      );
      const result = await applyBulkBinding(db, inventory, options, {
        apply: true,
      });
      assert.equal(result.verification.failures.length, 0);
      const archivedVote = await db
        .collection(PROPOSAL_VOTES)
        .findOne({ proposalId: "GOV-002" });
      assert.ok(archivedVote?.revisionId);
      assert.equal(
        (await db.collection("proposals").findOne({ proposalId: "GOV-002" }))
          ?.ballotRevisionId,
        archivedVote.revisionId,
      );
      await assert.rejects(
        () => castVote(db, member, { proposalId: "GOV-002", choice: "approve" }),
        /not currently in the Decide stage/,
      );
    } finally {
      await db.dropDatabase();
      await client.close();
    }
  },
);

test(
  "bulk migration fails closed on wording changes and rolls back the whole batch",
  { skip: !uri },
  async () => {
    const { client, db } = await freshDb("bulk_fail_closed");
    try {
      const ids = ["GOV-001", "POL-010"];
      await prepareBallots(db, ids);

      await db
        .collection("proposals")
        .updateOne(
          { proposalId: "POL-010" },
          { $set: { summary: "Unexpected wording change after voting began." } },
        );
      const changed = await buildBallotInventory(db);
      assert.equal(changed.classifications.ambiguous, 1);
      const changedPlan = buildBulkBindingPlan(changed, options);
      assert.ok(changedPlan.blockers.some((blocker) => blocker.includes("POL-010")));
      await assert.rejects(
        () => applyBulkBinding(db, changed, options, { apply: true }),
        /Bulk binding refused/,
      );
      assert.equal(
        await db.collection("ballot_binding_events").countDocuments(),
        0,
      );

      // Restore the baseline wording, then plant a conflicting revision for the
      // second ballot. The batch should bind the first ballot and then roll back
      // when the second cannot be reconciled.
      const baseline = (
        await import("../data/policies.json", { with: { type: "json" } })
      ).default as any[];
      const baselinePolicy = baseline.find(
        (item) => (item.proposalId || item.policyId) === "POL-010",
      );
      await db.collection("proposals").updateOne(
        { proposalId: "POL-010" },
        {
          $set: {
            title: baselinePolicy.title,
            summary: baselinePolicy.statement || baselinePolicy.summary,
            outcomes: baselinePolicy.outcomes,
            details: baselinePolicy.details,
          },
        },
      );
      await db.collection("proposal_revisions").deleteOne({
        proposalId: "POL-010",
        revisionId: legacyRevisionId("POL-010"),
      });
      await db.collection("proposal_revisions").insertOne({
        revisionId: "tampered-revision",
        proposalId: "POL-010",
        parentRevisionId: null,
        createdAt,
        snapshot: {
          title: baselinePolicy.title,
          summary: "Tampered wording not shown to voters.",
          outcomes: baselinePolicy.outcomes,
          details: baselinePolicy.details,
        },
        contentHash: "tampered-hash",
        provenance: "manual",
      });

      const rollbackInventory = await buildBallotInventory(db);
      assert.equal(rollbackInventory.classifications.supported, 2);
      await assert.rejects(
        () =>
          applyBulkBinding(db, rollbackInventory, options, { apply: true }),
        /immutable revision matching the inventoried wording could not be verified/,
      );
      for (const proposalId of ids) {
        assert.equal(
          (await db.collection("proposals").findOne({ proposalId }))
            ?.ballotRevisionId,
          undefined,
        );
        const votes = await db
          .collection(PROPOSAL_VOTES)
          .find({ proposalId })
          .toArray();
        assert.ok(votes.every((vote) => vote.revisionId === undefined));
      }
      assert.equal(
        await db.collection("ballot_binding_events").countDocuments(),
        0,
      );
    } finally {
      await db.dropDatabase();
      await client.close();
    }
  },
);

test(
  "bulk migration refuses ballots whose existing votes name conflicting revisions",
  { skip: !uri },
  async () => {
    const { client, db } = await freshDb("bulk_conflicting_votes");
    try {
      await prepareBallots(db, ["GOV-001"]);
      await db.collection(PROPOSAL_VOTES).updateOne(
        { proposalId: "GOV-001", memberId: "existing-0" },
        { $set: { revisionId: "another-revision" } },
      );
      const inventory = await buildBallotInventory(db);
      assert.equal(inventory.classifications.conflicting, 1);
      const plan = buildBulkBindingPlan(inventory, options);
      assert.ok(plan.blockers.some((blocker) => blocker.includes("GOV-001")));
      await assert.rejects(
        () => applyBulkBinding(db, inventory, options, { apply: true }),
        /Bulk binding refused/,
      );
      assert.equal(
        await db.collection("ballot_binding_events").countDocuments(),
        0,
      );
    } finally {
      await db.dropDatabase();
      await client.close();
    }
  },
);
