import assert from "node:assert/strict";
import { test } from "node:test";
import { MongoClient, type Db } from "mongodb";
import { ensureDatabaseIndexes } from "./db-indexes.ts";
import {
  BallotDomainError,
  recordFormalDecision,
  upsertMatterBallot,
} from "./ballots.ts";
import { BALLOT_RESULTS_BALLOT_INDEX } from "./ballot-results-index-migration.ts";
import { GOVERNANCE_EVENTS_COLLECTION } from "./governance-relationships.ts";
import { resolveLegacyPermissions } from "./rbac.ts";
import {
  ProposalDeletionConflictError,
  castVote,
  deleteProposal,
  saveProposal,
} from "./store.ts";
import type { SessionUser } from "./types.ts";
import { PROPOSAL_VOTES, proposalBallotId } from "./vote-storage.ts";

/**
 * Real-MongoDB coverage for the governance writes that the Sprint 1 integrity
 * suite exercises against the in-memory database.
 *
 * The in-memory database cannot prove transaction atomicity, unique indexes or
 * conditional-write concurrency. These cases run only when a replica set is
 * available, and each case uses its own database that is dropped afterwards.
 *
 * @see docs/status/sprint1-integration-report.md — "Limitations of this verification"
 * @see docs/status/rfc0001-programme-tracker.md — cross-slice risk 4
 */
const uri = process.env.VOTING_TEST_MONGODB_URI;

const adminUser: SessionUser = {
  memberId: "admin-1",
  name: "National Admin",
  email: "admin@fusionparty.org.au",
  status: "verified",
  role: "administrator",
  roles: ["administrator"],
  // Mirror a real session: the national administrator resolves the catalogue,
  // including the ballots.bind gate that governs entering Decide.
  permissions: resolveLegacyPermissions(["administrator"], []),
  canParticipate: true,
  isStaff: true,
  isAdmin: true,
  isBranchAdmin: false,
  branchAdminIds: [],
  activeBranchIds: ["branch-nat"],
};

const memberUser: SessionUser = {
  memberId: "member-1",
  name: "Verified Member",
  email: "member@fusionparty.org.au",
  status: "verified",
  role: "member",
  roles: ["member"],
  permissions: { national: [], branches: {}, grants: [] },
  canParticipate: true,
  isStaff: false,
  isAdmin: false,
  isBranchAdmin: false,
  branchAdminIds: [],
  activeBranchIds: ["branch-nat"],
};

const futureClose = () => new Date(Date.now() + 7 * 86400_000).toISOString();

/**
 * Keep a follow-up write's `updatedAt` distinct from the snapshot that racing
 * calls read, so the conditional update is the only thing deciding the race.
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function withDatabase(run: (db: Db) => Promise<void>): Promise<void> {
  const client = await new MongoClient(uri!).connect();
  // MongoDB caps database names at 63 characters.
  const db = client.db(
    `engage_gov_mongo_test_${crypto.randomUUID().replaceAll("-", "")}`,
  );
  try {
    await ensureDatabaseIndexes(db);
    await run(db);
  } finally {
    try {
      await db.dropDatabase();
    } finally {
      await client.close();
    }
  }
}

async function ensureNationalBranch(db: Db): Promise<void> {
  await db.collection("branches").updateOne(
    { branchId: "branch-nat" },
    {
      $setOnInsert: {
        branchId: "branch-nat",
        name: "National",
        kind: "national",
        recognised: true,
        createdAt: new Date(),
      },
    },
    { upsert: true },
  );
}

function duplicateKey(error: unknown): boolean {
  return (error as { code?: number } | null)?.code === 11000;
}

test(
  "real MongoDB: hard deletion succeeds for a bare draft and is refused once history exists",
  { skip: !uri },
  async () => {
    await withDatabase(async (db) => {
      await ensureNationalBranch(db);

      // A draft with one revision and no governance history is deletable, and
      // the deletion audit event commits with the removal.
      const draft = await saveProposal(db, adminUser, {
        title: "Disposable initial draft",
        space: "Governance",
        summary: "Draft created in error before any deliberation.",
        stage: "propose",
      });
      assert.equal(
        await db
          .collection("proposal_revisions")
          .countDocuments({ proposalId: draft.proposalId }),
        1,
      );
      await deleteProposal(db, adminUser, draft.proposalId, "Duplicate draft");

      assert.equal(
        await db
          .collection("proposals")
          .countDocuments({ proposalId: draft.proposalId }),
        0,
      );
      assert.equal(
        await db
          .collection("proposal_revisions")
          .countDocuments({ proposalId: draft.proposalId }),
        0,
      );
      const deletedEvent = await db
        .collection(GOVERNANCE_EVENTS_COLLECTION)
        .findOne({
          matterId: draft.proposalId,
          eventType: "proposal.deleted",
        });
      assert.equal(deletedEvent?.reason, "Duplicate draft");
      assert.equal(deletedEvent?.actorId, adminUser.memberId);
      assert.equal(deletedEvent?.metadata?.stage, "propose");

      // Revisions beyond the initial draft are governance history.
      const revised = await saveProposal(db, adminUser, {
        title: "Revised draft",
        space: "Governance",
        summary: "First revision of the draft.",
        stage: "deliberate",
      });
      await tick();
      await saveProposal(db, adminUser, {
        proposalId: revised.proposalId,
        title: "Revised draft",
        space: "Governance",
        summary: "Second revision of the draft.",
        stage: "deliberate",
      });
      assert.equal(
        await db
          .collection("proposal_revisions")
          .countDocuments({ proposalId: revised.proposalId }),
        2,
      );
      await assert.rejects(
        deleteProposal(db, adminUser, revised.proposalId),
        ProposalDeletionConflictError,
      );
      assert.equal(
        await db
          .collection("proposals")
          .countDocuments({ proposalId: revised.proposalId }),
        1,
        "a refused deletion must leave the proposal intact",
      );
      assert.equal(
        await db
          .collection("proposal_revisions")
          .countDocuments({ proposalId: revised.proposalId }),
        2,
        "a refused deletion must leave every revision intact",
      );
      assert.equal(
        await db.collection(GOVERNANCE_EVENTS_COLLECTION).countDocuments({
          matterId: revised.proposalId,
          eventType: "proposal.deleted",
        }),
        0,
        "a refused deletion must not write a deletion event",
      );

      // Any recorded vote is governance history, and the vote survives refusal.
      const voted = await saveProposal(db, adminUser, {
        title: "Voted matter",
        space: "Governance",
        summary: "Matter with a formal member vote.",
        stage: "decide",
        ballotClosesAt: futureClose(),
      });
      await castVote(db, memberUser, {
        proposalId: voted.proposalId,
        choice: "approve",
      });
      assert.equal(
        await db
          .collection(PROPOSAL_VOTES)
          .countDocuments({ proposalId: voted.proposalId }),
        1,
      );

      await assert.rejects(
        deleteProposal(db, adminUser, voted.proposalId),
        ProposalDeletionConflictError,
      );
      assert.equal(
        await db
          .collection(PROPOSAL_VOTES)
          .countDocuments({ proposalId: voted.proposalId }),
        1,
        "a refused deletion must keep the member's vote",
      );
      assert.ok(
        await db
          .collection("proposals")
          .findOne({ proposalId: voted.proposalId }),
        "a refused deletion must keep the proposal",
      );
      assert.equal(
        await db.collection(GOVERNANCE_EVENTS_COLLECTION).countDocuments({
          matterId: voted.proposalId,
          eventType: "proposal.deleted",
        }),
        0,
      );
    });
  },
);

test(
  "real MongoDB: a stage transition writes one event, and a racing attempt writes none",
  { skip: !uri },
  async () => {
    await withDatabase(async (db) => {
      await ensureNationalBranch(db);

      const created = await saveProposal(db, adminUser, {
        title: "Single transition event",
        space: "Governance",
        summary: "Opening Decide must audit exactly one transition.",
        stage: "deliberate",
        governanceAuthorityBranchId: "branch-nat",
        jurisdictionBranchId: "branch-nat",
      });
      assert.equal(
        await db
          .collection(GOVERNANCE_EVENTS_COLLECTION)
          .countDocuments({ matterId: created.proposalId }),
        0,
        "creating a draft in Deliberate writes no transition event",
      );

      await tick();
      const opened = await saveProposal(db, adminUser, {
        proposalId: created.proposalId,
        stage: "decide",
        ballotClosesAt: futureClose(),
      });
      assert.equal(opened.stage, "decide");

      const transitions = await db
        .collection(GOVERNANCE_EVENTS_COLLECTION)
        .find({
          matterId: created.proposalId,
          eventType: "proposal.stage_transition",
        })
        .toArray();
      assert.equal(transitions.length, 1, "exactly one transition event");
      const event = transitions[0]!;
      assert.equal(event.actorId, adminUser.memberId);
      assert.equal(event.metadata?.fromStage, "deliberate");
      assert.equal(event.metadata?.toStage, "decide");
      assert.equal(event.revisionId, opened.ballotRevisionId);
      assert.equal(event.authorityBranchId, "branch-nat");
      assert.equal(opened.governanceAuthorityBranchId, "branch-nat");

      // Two officers acting on the same snapshot: one transition commits, the
      // stale attempt is refused by the conditional update and writes no event.
      const racing = await saveProposal(db, adminUser, {
        title: "Racing transition",
        space: "Governance",
        summary: "Only one of two simultaneous openings may take effect.",
        stage: "deliberate",
      });
      await tick();
      const body = {
        proposalId: racing.proposalId,
        stage: "decide" as const,
        ballotClosesAt: futureClose(),
      };
      const results = await Promise.allSettled([
        saveProposal(db, adminUser, body),
        saveProposal(db, adminUser, body),
      ]);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      assert.equal(fulfilled.length, 1, "exactly one racing transition commits");
      assert.equal(rejected.length, 1);
      assert.match(
        String((rejected[0] as PromiseRejectedResult).reason?.message),
        /changed while you were editing/,
      );

      const raced = await db
        .collection(GOVERNANCE_EVENTS_COLLECTION)
        .find({
          matterId: racing.proposalId,
          eventType: "proposal.stage_transition",
        })
        .toArray();
      assert.equal(raced.length, 1, "the refused attempt writes no second event");
      assert.equal(raced[0]?.metadata?.fromStage, "deliberate");
      assert.equal(raced[0]?.metadata?.toStage, "decide");
      assert.equal(
        (await db
          .collection("proposals")
          .findOne({ proposalId: racing.proposalId }))?.stage,
        "decide",
      );
      assert.equal(
        await db
          .collection("ballots")
          .countDocuments({ matterId: racing.proposalId }),
        0,
        "a stage transition alone does not invent a ballot record",
      );

      // The append-only audit identity is protected by a real unique index:
      // a duplicate eventId cannot be inserted even outside the writers.
      const eventIdIndex = (
        await db.collection(GOVERNANCE_EVENTS_COLLECTION).indexes()
      ).find((index) => index.name === "eventId_1");
      assert.equal(eventIdIndex?.unique, true);
      await assert.rejects(
        db.collection(GOVERNANCE_EVENTS_COLLECTION).insertOne({
          eventId: event.eventId,
          eventType: "proposal.stage_transition",
          matterId: created.proposalId,
          actorId: adminUser.memberId,
          createdAt: new Date(),
        }),
        duplicateKey,
        "the unique eventId index must reject a duplicate audit identity",
      );
      assert.equal(
        await db.collection(GOVERNANCE_EVENTS_COLLECTION).countDocuments({
          matterId: created.proposalId,
          eventType: "proposal.stage_transition",
        }),
        1,
      );
    });
  },
);

test(
  "real MongoDB: a formal decision writes result, certification and event together, idempotently",
  { skip: !uri },
  async () => {
    await withDatabase(async (db) => {
      const opened = await saveProposal(db, adminUser, {
        title: "Decision atomicity check",
        space: "Governance",
        summary:
          "Formal decision must write result, certification, and event together.",
        stage: "decide",
        ballotClosesAt: futureClose(),
      });
      const ballotId = proposalBallotId(opened.proposalId);
      const revisionId = opened.ballotRevisionId!;
      await upsertMatterBallot(db, {
        matterId: opened.proposalId,
        revisionId,
        status: "open",
      });

      const recordedAt = new Date("2026-11-15T00:00:00.000Z");
      // Certification requires a closed ballot (#28). Close it exactly as the
      // scheduler does rather than certifying a ballot that could still change.
      await db
        .collection("proposals")
        .updateOne(
          { proposalId: opened.proposalId },
          { $set: { ballotClosedAt: new Date(recordedAt.getTime() - 1) } },
        );
      const payload = {
        matterId: opened.proposalId,
        revisionId,
        result: "successful" as const,
        decisionEventId: "dec-evt-1",
        authorityBranchId: "branch-nat",
        recordedBy: adminUser.memberId,
        now: recordedAt,
        // No votes were cast, so the votes compute "unsuccessful" (D9). This
        // case proves certification mechanics, so the recording is an explicit
        // override rather than a change to the outcome rule.
        overrideReason:
          "Coverage fixture: certification mechanics with no cast votes.",
      };
      const first = await recordFormalDecision(db, payload);
      assert.equal(first.result, "successful");
      assert.equal(first.ballotId, ballotId);
      assert.equal(first.recordedAt.getTime(), recordedAt.getTime());

      const stored = await db
        .collection("ballot_results")
        .findOne({ ballotId });
      assert.equal(stored?.result, "successful");
      assert.equal(stored?.decisionEventId, "dec-evt-1");
      assert.equal(stored?.matterId, opened.proposalId);
      assert.equal(stored?.revisionId, revisionId);
      assert.equal(stored?.recordedBy, adminUser.memberId);
      assert.equal(
        (await db.collection("ballots").findOne({ ballotId }))?.status,
        "certified",
        "the ballot is certified in the same operation as the result",
      );

      const decisionEvents = await db
        .collection(GOVERNANCE_EVENTS_COLLECTION)
        .find({
          matterId: opened.proposalId,
          eventType: "decision.recorded",
        })
        .toArray();
      assert.equal(decisionEvents.length, 1);
      assert.equal(decisionEvents[0]?.decisionEventId, "dec-evt-1");
      assert.equal(decisionEvents[0]?.ballotId, ballotId);
      assert.equal(decisionEvents[0]?.revisionId, revisionId);
      assert.equal(decisionEvents[0]?.actorId, adminUser.memberId);
      assert.equal(decisionEvents[0]?.metadata?.result, "successful");
      assert.equal(
        decisionEvents[0]?.createdAt?.getTime(),
        recordedAt.getTime(),
      );

      // An identical retry returns the stored record without rewriting it.
      const retry = await recordFormalDecision(db, payload);
      assert.equal(retry.decisionEventId, "dec-evt-1");
      assert.equal(
        retry.recordedAt.getTime(),
        recordedAt.getTime(),
        "the retry returns the stored record, not a new one",
      );
      assert.equal(
        await db
          .collection("ballot_results")
          .countDocuments({ matterId: opened.proposalId }),
        1,
      );
      assert.equal(
        await db.collection(GOVERNANCE_EVENTS_COLLECTION).countDocuments({
          matterId: opened.proposalId,
          eventType: "decision.recorded",
        }),
        1,
      );
      assert.equal(
        (await db.collection("ballots").findOne({ ballotId }))?.status,
        "certified",
      );

      // A conflicting replacement is refused and leaves the original untouched.
      await assert.rejects(
        recordFormalDecision(db, {
          ...payload,
          result: "unsuccessful",
          decisionEventId: "dec-evt-2",
        }),
        (error) =>
          error instanceof BallotDomainError &&
          error.code === "DECISION_ALREADY_RECORDED",
      );
      const afterConflict = await db
        .collection("ballot_results")
        .findOne({ ballotId });
      assert.equal(afterConflict?.result, "successful");
      assert.equal(afterConflict?.decisionEventId, "dec-evt-1");
      assert.equal(
        afterConflict?.recordedAt.getTime(),
        recordedAt.getTime(),
      );
      assert.equal(
        await db.collection(GOVERNANCE_EVENTS_COLLECTION).countDocuments({
          matterId: opened.proposalId,
          eventType: "decision.recorded",
        }),
        1,
        "a refused replacement writes no second event",
      );

      // One result per ballot is enforced by the real unique ballotId index,
      // not only by the writer's pre-read.
      const resultIndex = (await db.collection("ballot_results").indexes()).find(
        (index) => index.name === BALLOT_RESULTS_BALLOT_INDEX,
      );
      assert.equal(resultIndex?.unique, true);
      await assert.rejects(
        db.collection("ballot_results").insertOne({
          ballotId,
          matterId: opened.proposalId,
          revisionId,
          result: "unsuccessful",
          decisionEventId: "dec-evt-raw",
          recordedBy: "raw-insert",
          recordedAt: new Date(),
        }),
        duplicateKey,
        "the unique ballotId index must reject a second result for one ballot",
      );
      assert.equal(
        await db
          .collection("ballot_results")
          .countDocuments({ matterId: opened.proposalId }),
        1,
      );
    });
  },
);

test(
  "real MongoDB: concurrent identical decisions and deletions each collapse to one outcome",
  { skip: !uri },
  async () => {
    await withDatabase(async (db) => {
      await ensureNationalBranch(db);

      // Two identical result calls: both succeed as an idempotent retry, but
      // only one result, one event and one certification exist.
      const opened = await saveProposal(db, adminUser, {
        title: "Concurrent decision",
        space: "Governance",
        summary: "Two simultaneous identical decisions must agree.",
        stage: "decide",
        ballotClosesAt: futureClose(),
      });
      const ballotId = proposalBallotId(opened.proposalId);
      const revisionId = opened.ballotRevisionId!;
      await upsertMatterBallot(db, {
        matterId: opened.proposalId,
        revisionId,
        status: "open",
      });
      await db.collection("proposals").updateOne(
        { proposalId: opened.proposalId },
        // Pre-rule closure keeps this fixture about result idempotency. Quorum
        // certification has separate coverage.
        { $set: { ballotClosedAt: new Date("2026-11-10T00:00:00.000Z") } },
      );
      const sameDecision = {
        matterId: opened.proposalId,
        revisionId,
        result: "successful" as const,
        decisionEventId: "dec-evt-concurrent",
        authorityBranchId: "branch-nat",
        recordedBy: adminUser.memberId,
        overrideReason:
          "Coverage fixture: certification mechanics with no cast votes.",
      };
      const decisions = await Promise.allSettled([
        recordFormalDecision(db, sameDecision),
        recordFormalDecision(db, sameDecision),
      ]);
      assert.equal(
        decisions.filter((result) => result.status === "fulfilled").length,
        2,
        "an identical concurrent retry is idempotent, never a conflicting write",
      );
      assert.equal(
        await db
          .collection("ballot_results")
          .countDocuments({ matterId: opened.proposalId }),
        1,
        "exactly one result row",
      );
      assert.equal(
        await db.collection(GOVERNANCE_EVENTS_COLLECTION).countDocuments({
          matterId: opened.proposalId,
          eventType: "decision.recorded",
        }),
        1,
        "exactly one decision event",
      );
      assert.equal(
        (await db.collection("ballots").findOne({ ballotId }))?.status,
        "certified",
      );

      // Two simultaneous deletions of the same bare draft: one removes it, the
      // other is refused, and exactly one deletion event survives.
      const draft = await saveProposal(db, adminUser, {
        title: "Concurrent deletion",
        space: "Governance",
        summary: "Only one deletion of a bare draft may succeed.",
        stage: "propose",
      });
      const deletions = await Promise.allSettled([
        deleteProposal(db, adminUser, draft.proposalId, "Concurrent attempt A"),
        deleteProposal(db, adminUser, draft.proposalId, "Concurrent attempt B"),
      ]);
      const deleted = deletions.filter(
        (result) => result.status === "fulfilled",
      );
      const refused = deletions.filter((result) => result.status === "rejected");
      assert.equal(deleted.length, 1, "exactly one deletion commits");
      assert.equal(refused.length, 1);
      assert.ok(
        (refused[0] as PromiseRejectedResult).reason instanceof
          ProposalDeletionConflictError,
        "the stale deletion is a conflict, not a silent success",
      );
      assert.equal(
        await db
          .collection("proposals")
          .countDocuments({ proposalId: draft.proposalId }),
        0,
      );
      assert.equal(
        await db
          .collection("proposal_revisions")
          .countDocuments({ proposalId: draft.proposalId }),
        0,
      );
      assert.equal(
        await db.collection(GOVERNANCE_EVENTS_COLLECTION).countDocuments({
          matterId: draft.proposalId,
          eventType: "proposal.deleted",
        }),
        1,
        "exactly one deletion event",
      );
    });
  },
);

test(
  "real MongoDB: certification is refused while the ballot is open and succeeds after closure",
  { skip: !uri },
  async () => {
    await withDatabase(async (db) => {
      const opened = await saveProposal(db, adminUser, {
        title: "Closure before certification",
        space: "Governance",
        summary: "An open ballot must not be certified.",
        stage: "decide",
        ballotClosesAt: futureClose(),
      });
      const revisionId = opened.ballotRevisionId!;
      const ballotId = proposalBallotId(opened.proposalId);
      await upsertMatterBallot(db, {
        matterId: opened.proposalId,
        revisionId,
        status: "open",
      });

      await assert.rejects(
        recordFormalDecision(db, {
          matterId: opened.proposalId,
          revisionId,
          result: "unsuccessful",
          decisionEventId: "dec-not-closed",
          recordedBy: adminUser.memberId,
        }),
        (error) =>
          error instanceof BallotDomainError &&
          error.code === "BALLOT_NOT_CLOSED",
        "a ballot that can still accept votes must not be certified",
      );
      assert.equal(
        await db.collection("ballot_results").countDocuments({ ballotId }),
        0,
        "the refused certification writes no result",
      );

      // Close it as the scheduler does, then certify. Zero votes compute
      // "unsuccessful", so this needs no override.
      await db
        .collection("proposals")
        .updateOne(
          { proposalId: opened.proposalId },
          // Pre-rule closure; this case tests the certification boundary.
          { $set: { ballotClosedAt: new Date("2026-11-10T00:00:00.000Z") } },
        );
      const recorded = await recordFormalDecision(db, {
        matterId: opened.proposalId,
        revisionId,
        result: "unsuccessful",
        decisionEventId: "dec-after-close",
        recordedBy: adminUser.memberId,
      });
      assert.equal(recorded.result, "unsuccessful");
      assert.equal(recorded.computedResult, "unsuccessful");
      assert.equal(recorded.tally?.total, 0);
      assert.equal(
        (await db.collection("ballots").findOne({ ballotId }))?.status,
        "certified",
      );
    });
  },
);
