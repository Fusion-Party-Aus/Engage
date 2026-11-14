import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import { MongoClient } from "mongodb";
import { createMemoryDb, initializeDatabase } from "./db.ts";
import {
  BallotDomainError,
  recordFormalDecision,
  upsertMatterBallot,
} from "./ballots.ts";
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

const mongoUri = process.env.VOTING_TEST_MONGODB_URI;

const adminUser: SessionUser = {
  memberId: "admin-1",
  name: "National Admin",
  email: "admin@fusionparty.org.au",
  status: "verified",
  role: "administrator",
  roles: ["administrator"],
  // Mirror a real session: a national administrator resolves the full national
  // permission catalogue, including the newly enforced ballots.bind gate.
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

describe("Sprint 1 governance integrity", () => {
  it("defaults a missing ballot closing date to the 30-day period and rejects invalid or past dates", async () => {
    const db = createMemoryDb();
    const draft = await saveProposal(db, adminUser, {
      title: "Require ballot close dates",
      space: "Governance",
      summary: "Every ballot must have an enforceable closing date.",
      stage: "deliberate",
    });

    await assert.rejects(
      saveProposal(db, adminUser, {
        proposalId: draft.proposalId,
        stage: "decide",
        ballotClosesAt: "not-a-date",
      }),
      /invalid/i,
    );

    await assert.rejects(
      saveProposal(db, adminUser, {
        proposalId: draft.proposalId,
        stage: "decide",
        ballotClosesAt: new Date(Date.now() - 60_000).toISOString(),
      }),
      /must be in the future/i,
    );

    // D6: an officer opening a ballot without a date receives the approved
    // 30-day ordinary ballot period instead of an unbounded ballot.
    const expectedDefault = Date.now() + 30 * 86400_000;
    const opened = await saveProposal(db, adminUser, {
      proposalId: draft.proposalId,
      stage: "decide",
    });
    assert.equal(opened.stage, "decide");
    assert.ok(opened.ballotClosesAt instanceof Date);
    assert.ok(
      Math.abs(opened.ballotClosesAt.getTime() - expectedDefault) < 60_000,
      "default ballot deadline should be 30 days from opening",
    );
    assert.ok(opened.ballotRevisionId);

    // An explicit date remains authoritative.
    const returned = await saveProposal(db, adminUser, {
      proposalId: draft.proposalId,
      stage: "deliberate",
    });
    assert.equal(returned.stage, "deliberate");
    const explicit = new Date(Date.now() + 7 * 86400_000);
    const reopened = await saveProposal(db, adminUser, {
      proposalId: draft.proposalId,
      stage: "decide",
      ballotClosesAt: explicit.toISOString(),
    });
    assert.equal(reopened.ballotClosesAt?.getTime(), explicit.getTime());

    const events = await db
      .collection(GOVERNANCE_EVENTS_COLLECTION)
      .find({ matterId: draft.proposalId, eventType: "proposal.stage_transition" })
      .toArray();
    assert.equal(events.length, 3);
    assert.equal(events[0]?.metadata?.fromStage, "deliberate");
    assert.equal(events[0]?.metadata?.toStage, "decide");
  });

  it("clears stale revision binding on zero-vote reopen and rebinds to revised wording", async () => {
    const db = createMemoryDb();
    const draft = await saveProposal(db, adminUser, {
      title: "Reopenable policy motion",
      space: "Governance",
      summary: "Initial wording before first Decide.",
      stage: "deliberate",
    });
    const firstOpen = await saveProposal(db, adminUser, {
      proposalId: draft.proposalId,
      stage: "decide",
      ballotClosesAt: futureClose(),
    });
    const firstRev = firstOpen.ballotRevisionId;
    assert.ok(firstRev);

    // Return to Deliberate with zero votes
    const returned = await saveProposal(db, adminUser, {
      proposalId: draft.proposalId,
      stage: "deliberate",
    });
    assert.equal(returned.ballotRevisionId, undefined);

    // Edit wording -> new revision
    await new Promise((r) => setTimeout(r, 5));
    const revised = await saveProposal(db, adminUser, {
      proposalId: draft.proposalId,
      title: "Reopenable policy motion",
      space: "Governance",
      summary: "Updated wording after deliberation feedback.",
      stage: "deliberate",
    });
    assert.equal(revised.ballotRevisionId, undefined);

    // Re-enter Decide -> must bind to the NEW revision, not firstRev
    const reopened = await saveProposal(db, adminUser, {
      proposalId: draft.proposalId,
      stage: "decide",
      ballotClosesAt: futureClose(),
    });
    assert.ok(reopened.ballotRevisionId);
    assert.notEqual(reopened.ballotRevisionId, firstRev);

    const events = await db
      .collection(GOVERNANCE_EVENTS_COLLECTION)
      .find({ matterId: draft.proposalId })
      .toArray();
    assert.ok(events.some((e) => e.eventType === "ballot.unbound"));
    assert.equal(
      events.filter((e) => e.eventType === "proposal.stage_transition").length,
      3,
    );
  });

  it("never rebinds or allows substantive edits after votes exist", async () => {
    const db = createMemoryDb();
    const opened = await saveProposal(db, adminUser, {
      title: "Voted policy motion",
      space: "Governance",
      summary: "Wording locked once a member votes.",
      stage: "decide",
      ballotClosesAt: futureClose(),
    });
    await castVote(db, memberUser, {
      proposalId: opened.proposalId,
      choice: "approve",
    });

    await assert.rejects(
      saveProposal(db, adminUser, {
        proposalId: opened.proposalId,
        title: "Voted policy motion",
        space: "Governance",
        summary: "Attempted silent wording change.",
        stage: "deliberate",
      }),
      /locked to protect ballot integrity/i,
    );
  });

  it("records formal decisions atomically with ballot certification, event, and idempotency", async () => {
    const db = createMemoryDb();
    const opened = await saveProposal(db, adminUser, {
      title: "Decision atomicity check",
      space: "Governance",
      summary: "Formal decision must write result, certification, and event together.",
      stage: "decide",
      ballotClosesAt: futureClose(),
    });
    await upsertMatterBallot(db, {
      matterId: opened.proposalId,
      revisionId: opened.ballotRevisionId!,
      status: "open",
    });

    const first = await recordFormalDecision(db, {
      matterId: opened.proposalId,
      revisionId: opened.ballotRevisionId!,
      result: "successful",
      decisionEventId: "dec-evt-1",
      authorityBranchId: "branch-nat",
      recordedBy: adminUser.memberId,
    });
    assert.equal(first.result, "successful");

    // Idempotent retry with identical payload returns existing without duplicate event
    const retry = await recordFormalDecision(db, {
      matterId: opened.proposalId,
      revisionId: opened.ballotRevisionId!,
      result: "successful",
      decisionEventId: "dec-evt-1",
      authorityBranchId: "branch-nat",
      recordedBy: adminUser.memberId,
    });
    assert.equal(retry.decisionEventId, "dec-evt-1");

    const events = await db
      .collection(GOVERNANCE_EVENTS_COLLECTION)
      .find({ matterId: opened.proposalId, eventType: "decision.recorded" })
      .toArray();
    assert.equal(events.length, 1);

    const ballot = await db
      .collection("ballots")
      .findOne({ ballotId: proposalBallotId(opened.proposalId) });
    assert.equal(ballot?.status, "certified");

    // Conflicting retry is rejected
    await assert.rejects(
      recordFormalDecision(db, {
        matterId: opened.proposalId,
        revisionId: opened.ballotRevisionId!,
        result: "unsuccessful",
        decisionEventId: "dec-evt-2",
        authorityBranchId: "branch-nat",
        recordedBy: adminUser.memberId,
      }),
      BallotDomainError,
    );
  });

  it("refuses hard deletion when a matter has governance history and audits draft deletion", async () => {
    const db = createMemoryDb();

    // Draft in propose with 1 revision can be deleted and records an event
    const draft = await saveProposal(db, adminUser, {
      title: "Disposable initial draft",
      space: "Governance",
      summary: "Draft created in error before any deliberation.",
      stage: "propose",
    });
    await deleteProposal(db, adminUser, draft.proposalId, "Duplicate draft");
    assert.equal(
      await db.collection("proposals").findOne({ proposalId: draft.proposalId }),
      null,
    );
    const delEvt = await db
      .collection(GOVERNANCE_EVENTS_COLLECTION)
      .findOne({ matterId: draft.proposalId, eventType: "proposal.deleted" });
    assert.equal(delEvt?.reason, "Duplicate draft");

    // Matter with >1 revision cannot be deleted
    const revised = await saveProposal(db, adminUser, {
      title: "Revised draft",
      space: "Governance",
      summary: "First revision of the draft.",
      stage: "deliberate",
    });
    await saveProposal(db, adminUser, {
      proposalId: revised.proposalId,
      title: "Revised draft",
      space: "Governance",
      summary: "Second revision of the draft.",
      stage: "deliberate",
    });
    await assert.rejects(
      deleteProposal(db, adminUser, revised.proposalId),
      ProposalDeletionConflictError,
    );

    // Voted matter cannot be deleted
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
    await assert.rejects(
      deleteProposal(db, adminUser, voted.proposalId),
      ProposalDeletionConflictError,
    );
    assert.equal(
      await db.collection(PROPOSAL_VOTES).countDocuments({ proposalId: voted.proposalId }),
      1,
    );
  });
});

test(
  "real MongoDB supports 1-to-many ballot_results per proposal and transactional castVote",
  { skip: !mongoUri },
  async () => {
    const client = await new MongoClient(mongoUri!).connect();
    const db = client.db(
      `engage_sprint1_test_${crypto.randomUUID().replaceAll("-", "")}`,
    );
    try {
      // Simulate legacy unique proposalId_1 index before initializeDatabase upgrades it
      await db
        .collection("ballot_results")
        .createIndex({ proposalId: 1 }, { unique: true });
      await initializeDatabase(db);

      const indexes = await db.collection("ballot_results").indexes();
      assert.ok(
        indexes.some(
          (i) => i.name === "ballot_results_ballot_unique" && i.unique === true,
        ),
      );
      assert.ok(
        !indexes.some((i) => i.name === "proposalId_1" && i.unique === true),
      );

      // Two distinct ballots for the same matterId can both record formal decisions
      await recordFormalDecision(db, {
        ballotId: "proposal:PROP-MULTI-1",
        matterId: "PROP-MULTI-1",
        revisionId: "rev-1",
        result: "successful",
        decisionEventId: "dec-multi-1",
        recordedBy: adminUser.memberId,
      });
      await recordFormalDecision(db, {
        ballotId: "amendment:AMD-MULTI-1",
        matterId: "PROP-MULTI-1",
        revisionId: "rev-1",
        result: "unsuccessful",
        decisionEventId: "dec-multi-2",
        recordedBy: adminUser.memberId,
      });
      assert.equal(
        await db.collection("ballot_results").countDocuments({ matterId: "PROP-MULTI-1" }),
        2,
      );

      // Transactional castVote commits vote + clears pending preference
      await db.collection("branches").insertOne({
        branchId: "branch-nat",
        name: "National",
        kind: "national",
        recognised: true,
      });
      await db.collection("branch_memberships").insertOne({
        branchId: "branch-nat",
        memberId: memberUser.memberId,
        status: "active",
        branchRole: "member",
      });
      const opened = await saveProposal(db, adminUser, {
        title: "Mongo transactional vote",
        space: "Governance",
        summary: "Verify castVote transaction on replica set.",
        stage: "decide",
        ballotClosesAt: futureClose(),
      });
      await db.collection("pending_vote_preferences").insertOne({
        ballotId: proposalBallotId(opened.proposalId),
        proposalId: opened.proposalId,
        revisionId: opened.ballotRevisionId,
        memberId: memberUser.memberId,
        choice: "reject",
        reason: "",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const res = await castVote(db, memberUser, {
        proposalId: opened.proposalId,
        choice: "approve",
      });
      assert.equal(res.choice, "approve");
      assert.equal(res.votes.approve, 1);
      assert.equal(
        await db.collection("pending_vote_preferences").countDocuments({
          ballotId: proposalBallotId(opened.proposalId),
          memberId: memberUser.memberId,
        }),
        0,
      );
    } finally {
      await db.dropDatabase();
      await client.close();
    }
  },
);
