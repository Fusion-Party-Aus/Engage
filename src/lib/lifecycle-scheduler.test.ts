import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { createMemoryDb, getDatabase } from "./db.ts";
import {
  advanceDueDeliberations,
  closeDueBallots,
  runGovernanceScheduler,
} from "./governance-scheduler.ts";
import { buildLifecycleMigrationReport } from "./lifecycle-migration-report.ts";
import { POST as secondProposalRoute } from "../pages/api/proposals/[proposalId]/second.ts";
import { GOVERNANCE_EVENTS_COLLECTION } from "./governance-relationships.ts";
import {
  BALLOT_PERIOD_DAYS,
  DELIBERATION_PERIOD_DAYS,
  LIFECYCLE_SYSTEM_ACTOR,
  MAXIMUM_SCHEDULE_DAYS,
  amendmentBlocksScheduledAdvancement,
  advancementEventId,
  ballotClosedEventId,
  defaultBallotClosesAtFrom,
  deliberationEndsAtFrom,
  scheduledBallotClosesAtFrom,
} from "./lifecycle-schedule.ts";
import { resolveLegacyPermissions } from "./rbac.ts";
import {
  ProposalSecondingError,
  castVote,
  saveProposal,
  secondProposal,
} from "./store.ts";
import type { SessionUser } from "./types.ts";
import { PROPOSAL_VOTES, proposalBallotId } from "./vote-storage.ts";

const DAY = 86_400_000;
const NOW = new Date("2026-11-14T00:00:00.000Z");

const author: SessionUser = {
  memberId: "author-1",
  name: "Proposal Author",
  email: "author@example.test",
  role: "member",
  roles: ["member"],
  status: "verified",
  canParticipate: true,
  isStaff: false,
  isAdmin: false,
};

const memberA: SessionUser = {
  memberId: "member-a",
  name: "Member A",
  email: "a@example.test",
  role: "member",
  roles: ["member"],
  status: "verified",
  canParticipate: true,
  isStaff: false,
  isAdmin: false,
};

const memberB: SessionUser = {
  memberId: "member-b",
  name: "Member B",
  email: "b@example.test",
  role: "member",
  roles: ["member"],
  status: "verified",
  canParticipate: true,
  isStaff: false,
  isAdmin: false,
};

const admin: SessionUser = {
  memberId: "admin-1",
  name: "National Admin",
  email: "admin@example.test",
  role: "administrator",
  roles: ["administrator"],
  permissions: resolveLegacyPermissions(["administrator"], []),
  status: "verified",
  canParticipate: true,
  isStaff: true,
  isAdmin: true,
};

async function insertMatter(
  db: ReturnType<typeof createMemoryDb>,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const proposalId = String(overrides.proposalId ?? `PROP-${randomUUID()}`);
  await db.collection("proposals").insertOne({
    proposalId,
    slug: proposalId.toLowerCase(),
    title: "Scheduled lifecycle test matter",
    space: "Governance",
    summary: "A matter used to verify the scheduled lifecycle.",
    outcomes: [],
    details: "",
    kind: "policy",
    stage: "deliberate",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
  return proposalId;
}

async function insertRevision(
  db: ReturnType<typeof createMemoryDb>,
  proposalId: string,
  revisionId = `rev-${randomUUID()}`,
  createdAt: Date = NOW,
): Promise<string> {
  await db.collection("proposal_revisions").insertOne({
    revisionId,
    proposalId,
    parentRevisionId: null,
    authorId: author.memberId,
    createdAt,
    snapshot: { title: "title", summary: "summary", outcomes: [], details: "" },
    contentHash: revisionId,
  });
  return revisionId;
}

async function insertSecondedDeliberation(
  db: ReturnType<typeof createMemoryDb>,
  options: { deliberationEndsAt?: Date; secondedAt?: Date } = {},
): Promise<{ proposalId: string; revisionId: string; secondedAt: Date }> {
  const secondedAt = options.secondedAt ?? new Date(NOW.getTime() - 30 * DAY);
  const proposalId = await insertMatter(db, {
    stage: "deliberate",
    authorId: author.memberId,
    secondedBy: memberA.memberId,
    secondedAt,
    deliberationEndsAt: options.deliberationEndsAt ?? NOW,
  });
  const revisionId = await insertRevision(
    db,
    proposalId,
    undefined,
    secondedAt,
  );
  return { proposalId, revisionId, secondedAt };
}

describe("approved lifecycle schedule constants", () => {
  it("derives the 30-day deliberation, 30-day ballot and 60-day ceiling", () => {
    assert.equal(DELIBERATION_PERIOD_DAYS, 30);
    assert.equal(BALLOT_PERIOD_DAYS, 30);
    assert.equal(MAXIMUM_SCHEDULE_DAYS, 60);
    const secondedAt = new Date("2026-01-01T00:00:00.000Z");
    assert.equal(
      deliberationEndsAtFrom(secondedAt).toISOString(),
      "2026-01-31T00:00:00.000Z",
    );
    assert.equal(
      scheduledBallotClosesAtFrom(secondedAt).toISOString(),
      "2026-03-02T00:00:00.000Z",
    );
    assert.equal(
      defaultBallotClosesAtFrom(secondedAt).toISOString(),
      "2026-01-31T00:00:00.000Z",
    );
    assert.equal(
      advancementEventId("PROP-1", "2026-01-31T00:00:00.000Z"),
      "sched:advance:PROP-1:2026-01-31T00:00:00.000Z",
    );
    assert.equal(
      ballotClosedEventId("PROP-1", "2026-03-02T00:00:00.000Z"),
      "sched:close:PROP-1:2026-03-02T00:00:00.000Z",
    );
  });

  it("fails closed on every amendment status that can still change wording", () => {
    for (const status of [
      "proposed",
      "stale",
      "conflict",
      "ready",
      "voting",
      "endorsed",
      "accepted",
      "unrecognised-future-status",
      undefined,
    ]) {
      assert.equal(
        amendmentBlocksScheduledAdvancement(status),
        true,
        `${String(status)} must block the schedule`,
      );
    }
    for (const status of [
      "rejected",
      "withdrawn",
      "applied",
      "not-endorsed",
      "inconclusive",
      "REJECTED",
    ]) {
      assert.equal(
        amendmentBlocksScheduledAdvancement(status),
        false,
        `${String(status)} must not block the schedule`,
      );
    }
  });
});

describe("seconding a proposal (D3)", () => {
  it("records the seconder and starts the 30-day deliberation clock", async () => {
    const db = createMemoryDb();
    const proposalId = await insertMatter(db, {
      stage: "propose",
      authorId: author.memberId,
    });

    const seconded = await secondProposal(db, memberA, proposalId);
    assert.equal(seconded.secondedBy, memberA.memberId);
    assert.equal(seconded.stage, "deliberate");
    assert.ok(seconded.secondedAt instanceof Date);
    assert.ok(seconded.deliberationEndsAt instanceof Date);
    assert.equal(
      seconded.deliberationEndsAt!.getTime() - seconded.secondedAt!.getTime(),
      DELIBERATION_PERIOD_DAYS * DAY,
    );

    const stored = await db.collection("proposals").findOne({ proposalId });
    assert.equal(stored?.secondedBy, memberA.memberId);
    assert.equal(
      new Date(stored?.deliberationEndsAt).getTime(),
      seconded.deliberationEndsAt!.getTime(),
    );

    const events = await db
      .collection(GOVERNANCE_EVENTS_COLLECTION)
      .find({ matterId: proposalId, eventType: "proposal.seconded" })
      .toArray();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.actorId, memberA.memberId);
    assert.equal(
      events[0]?.metadata?.deliberationEndsAt,
      seconded.deliberationEndsAt!.toISOString(),
    );
    const transitions = await db
      .collection(GOVERNANCE_EVENTS_COLLECTION)
      .find({ matterId: proposalId, eventType: "proposal.stage_transition" })
      .toArray();
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0]?.metadata?.fromStage, "propose");
    assert.equal(transitions[0]?.metadata?.toStage, "deliberate");
    assert.equal(transitions[0]?.metadata?.trigger, "seconded");
  });

  it("refuses an officer transition into Deliberate without a seconder", async () => {
    const db = createMemoryDb();
    const proposalId = await insertMatter(db, {
      stage: "propose",
      authorId: author.memberId,
    });

    await assert.rejects(
      saveProposal(db, admin, { proposalId, stage: "deliberate" }),
      /needs a seconder/i,
    );
    const unchanged = await db.collection("proposals").findOne({ proposalId });
    assert.equal(unchanged?.stage, "propose");

    await secondProposal(db, memberA, proposalId);
    const advanced = await db.collection("proposals").findOne({ proposalId });
    assert.equal(advanced?.stage, "deliberate");
  });

  it("refuses self-seconding, a second seconder, an ineligible member and a non-propose stage", async () => {
    const db = createMemoryDb();
    const proposalId = await insertMatter(db, {
      stage: "propose",
      authorId: author.memberId,
    });

    await assert.rejects(
      secondProposal(db, author, proposalId),
      (error: unknown) =>
        error instanceof ProposalSecondingError &&
        error.status === 409 &&
        /own proposal/i.test(error.message),
    );
    await assert.rejects(
      secondProposal(db, { ...memberA, canParticipate: false }, proposalId),
      /must be verified/i,
    );

    await secondProposal(db, memberA, proposalId);
    await assert.rejects(
      secondProposal(db, memberB, proposalId),
      /already has a seconder/i,
    );

    const deliberateId = await insertMatter(db, {
      stage: "deliberate",
      authorId: author.memberId,
    });
    await assert.rejects(
      secondProposal(db, memberA, deliberateId),
      /Only a proposal in Propose/i,
    );

    await assert.rejects(
      secondProposal(db, memberA, "PROP-DOES-NOT-EXIST"),
      /not found/i,
    );
  });

  it("records exactly one seconder under concurrent requests", async () => {
    const db = createMemoryDb();
    const proposalId = await insertMatter(db, {
      stage: "propose",
      authorId: author.memberId,
    });

    const results = await Promise.allSettled([
      secondProposal(db, memberA, proposalId),
      secondProposal(db, memberB, proposalId),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);

    const events = await db
      .collection(GOVERNANCE_EVENTS_COLLECTION)
      .find({ matterId: proposalId, eventType: "proposal.seconded" })
      .toArray();
    assert.equal(events.length, 1);
    const stored = await db.collection("proposals").findOne({ proposalId });
    assert.equal(stored?.secondedBy, events[0]?.actorId);
  });
});

describe("scheduled advancement (D4/D5/D7)", () => {
  it("advances only matters at or past their deliberation deadline and binds the latest revision", async () => {
    const db = createMemoryDb();
    const due = await insertSecondedDeliberation(db, { deliberationEndsAt: NOW });
    const overdue = await insertSecondedDeliberation(db, {
      deliberationEndsAt: new Date(NOW.getTime() - DAY),
    });
    const future = await insertSecondedDeliberation(db, {
      deliberationEndsAt: new Date(NOW.getTime() + 1),
    });
    // A newer immutable revision must be the one bound.
    const newerRevision = await insertRevision(
      db,
      due.proposalId,
      "rev-newer",
      new Date(NOW.getTime() - 3600_000),
    );

    const report = await advanceDueDeliberations(db, { now: NOW });
    assert.equal(report.advanced.length, 2);
    assert.equal(report.errors.length, 0);
    assert.deepEqual(
      report.advanced.map((item) => item.proposalId).sort(),
      [due.proposalId, overdue.proposalId].sort(),
    );

    const advanced = await db
      .collection("proposals")
      .findOne({ proposalId: due.proposalId });
    assert.equal(advanced?.stage, "decide");
    assert.equal(advanced?.ballotRevisionId, newerRevision);
    assert.equal(
      new Date(advanced?.ballotClosesAt).getTime(),
      scheduledBallotClosesAtFrom(due.secondedAt).getTime(),
    );

    const stillDeliberate = await db
      .collection("proposals")
      .findOne({ proposalId: future.proposalId });
    assert.equal(stillDeliberate?.stage, "deliberate");

    const events = await db
      .collection(GOVERNANCE_EVENTS_COLLECTION)
      .find({
        matterId: due.proposalId,
        eventType: "proposal.stage_transition",
      })
      .toArray();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.actorId, LIFECYCLE_SYSTEM_ACTOR);
    assert.equal(events[0]?.eventId, advancementEventId(due.proposalId, NOW));
    assert.equal(events[0]?.metadata?.fromStage, "deliberate");
    assert.equal(events[0]?.metadata?.toStage, "decide");
    assert.equal(
      events[0]?.metadata?.trigger,
      "scheduled_deliberation_deadline",
    );
    assert.equal(
      events[0]?.metadata?.ballotClosesAt,
      scheduledBallotClosesAtFrom(due.secondedAt).toISOString(),
    );
  });

  it("does not require or grant ballots.bind for the system transition", async () => {
    const db = createMemoryDb();
    // No governance authority, no officer, no permission snapshot anywhere.
    const { proposalId } = await insertSecondedDeliberation(db);
    const report = await advanceDueDeliberations(db, { now: NOW });
    assert.equal(report.advanced.length, 1);
    const stored = await db.collection("proposals").findOne({ proposalId });
    assert.equal(stored?.stage, "decide");
    assert.equal(stored?.ballotRevisionBoundBy, LIFECYCLE_SYSTEM_ACTOR);
  });

  it("is idempotent: a replayed run records no second transition", async () => {
    const db = createMemoryDb();
    await insertSecondedDeliberation(db);

    const first = await advanceDueDeliberations(db, { now: NOW });
    const second = await advanceDueDeliberations(db, { now: NOW });
    assert.equal(first.advanced.length, 1);
    assert.equal(second.advanced.length, 0);
    assert.equal(second.blockers.length, 0);
    assert.equal(second.errors.length, 0);
    assert.equal(
      await db
        .collection(GOVERNANCE_EVENTS_COLLECTION)
        .countDocuments({ eventType: "proposal.stage_transition" }),
      1,
    );
  });

  it("produces exactly one transition under two concurrent runs", async () => {
    const db = createMemoryDb();
    const { proposalId } = await insertSecondedDeliberation(db);

    const [first, second] = await Promise.all([
      advanceDueDeliberations(db, { now: NOW }),
      advanceDueDeliberations(db, { now: NOW }),
    ]);
    assert.equal(first.advanced.length + second.advanced.length, 1);
    assert.equal(
      await db
        .collection(GOVERNANCE_EVENTS_COLLECTION)
        .countDocuments({
          matterId: proposalId,
          eventType: "proposal.stage_transition",
        }),
      1,
    );
    assert.equal(
      (await db.collection("proposals").findOne({ proposalId }))?.stage,
      "decide",
    );
  });

  it("refuses and reports matters with unresolved blocking amendments", async () => {
    const db = createMemoryDb();
    const blockingStatuses = [
      "proposed",
      "stale",
      "conflict",
      "ready",
      "voting",
      "endorsed",
      "accepted",
      "unexpected",
    ];
    const proposalIds: string[] = [];
    for (const status of blockingStatuses) {
      const proposalId = await insertMatter(db, {
        stage: "deliberate",
        secondedBy: memberA.memberId,
        secondedAt: new Date(NOW.getTime() - 30 * DAY),
        deliberationEndsAt: NOW,
      });
      await insertRevision(db, proposalId);
      await db.collection("amendments").insertOne({
        amendmentId: `amd-${status}`,
        proposalId,
        status,
        createdAt: NOW,
      });
      proposalIds.push(proposalId);
    }

    const report = await advanceDueDeliberations(db, { now: NOW });
    assert.equal(report.advanced.length, 0);
    assert.equal(report.blockers.length, blockingStatuses.length);
    assert.ok(
      report.blockers.every(
        (blocker) => blocker.reason === "blocking_amendments",
      ),
    );
    assert.deepEqual(
      report.blockers.map((blocker) => blocker.proposalId).sort(),
      proposalIds.sort(),
    );
    const first = report.blockers[0]!;
    assert.equal(first.amendmentIds?.length, 1);
    for (const proposalId of proposalIds) {
      assert.equal(
        (await db.collection("proposals").findOne({ proposalId }))?.stage,
        "deliberate",
      );
    }
    assert.equal(
      await db
        .collection(GOVERNANCE_EVENTS_COLLECTION)
        .countDocuments({ eventType: "proposal.stage_transition" }),
      0,
    );
  });

  it("advances when every amendment is finally resolved", async () => {
    const db = createMemoryDb();
    const { proposalId } = await insertSecondedDeliberation(db);
    for (const status of [
      "rejected",
      "withdrawn",
      "applied",
      "not-endorsed",
      "inconclusive",
    ]) {
      await db.collection("amendments").insertOne({
        amendmentId: `amd-${status}`,
        proposalId,
        status,
      });
    }
    const report = await advanceDueDeliberations(db, { now: NOW });
    assert.equal(report.advanced.length, 1);
    assert.equal(report.blockers.length, 0);
  });

  it("skips a matter without an immutable revision and reports it", async () => {
    const db = createMemoryDb();
    const proposalId = await insertMatter(db, {
      stage: "deliberate",
      secondedBy: memberA.memberId,
      secondedAt: new Date(NOW.getTime() - 30 * DAY),
      deliberationEndsAt: NOW,
    });
    const report = await advanceDueDeliberations(db, { now: NOW });
    assert.equal(report.advanced.length, 0);
    assert.equal(report.skipped.length, 1);
    assert.equal(report.skipped[0]?.proposalId, proposalId);
    assert.equal(report.skipped[0]?.reason, "no_current_revision");
  });

  it("refuses a late run rather than opening a ballot that has already closed", async () => {
    const db = createMemoryDb();
    const secondedAt = new Date(NOW.getTime() - (MAXIMUM_SCHEDULE_DAYS + 1) * DAY);
    const { proposalId } = await insertSecondedDeliberation(db, {
      secondedAt,
      deliberationEndsAt: new Date(NOW.getTime() - DAY),
    });
    const report = await advanceDueDeliberations(db, { now: NOW });
    assert.equal(report.advanced.length, 0);
    assert.equal(report.blockers[0]?.reason, "scheduled_ballot_deadline_passed");
    assert.equal(
      (await db.collection("proposals").findOne({ proposalId }))?.stage,
      "deliberate",
    );
  });

  it("refuses a matter with no seconding anchor instead of guessing a deadline", async () => {
    const db = createMemoryDb();
    const proposalId = await insertMatter(db, {
      stage: "deliberate",
      secondedBy: memberA.memberId,
      deliberationEndsAt: NOW,
    });
    await insertRevision(db, proposalId);
    const report = await advanceDueDeliberations(db, { now: NOW });
    assert.equal(report.advanced.length, 0);
    assert.equal(report.blockers[0]?.reason, "missing_schedule_anchor");
  });

  it("refuses to bind a revision that existing votes do not reference", async () => {
    const db = createMemoryDb();
    const { proposalId } = await insertSecondedDeliberation(db);
    const newerRevision = await insertRevision(
      db,
      proposalId,
      "rev-newer",
      new Date(NOW.getTime() - 3600_000),
    );
    await db.collection(PROPOSAL_VOTES).insertOne({
      ballotId: proposalBallotId(proposalId),
      proposalId,
      revisionId: "rev-old",
      memberId: memberA.memberId,
      choice: "approve",
      updatedAt: NOW,
    });
    const report = await advanceDueDeliberations(db, { now: NOW });
    assert.equal(report.advanced.length, 0);
    assert.equal(report.blockers[0]?.reason, "ballot_revision_conflict");
    assert.equal(
      (await db.collection("proposals").findOne({ proposalId }))
        ?.ballotRevisionId,
      undefined,
    );
    assert.notEqual(newerRevision, "rev-old");
  });

  it("dry-run reports the transition without writing it", async () => {
    const db = createMemoryDb();
    const { proposalId } = await insertSecondedDeliberation(db);
    const report = await runGovernanceScheduler(db, { now: NOW, dryRun: true });
    assert.equal(report.mode, "dry-run");
    assert.equal(report.advanced.length, 1);
    assert.equal(
      (await db.collection("proposals").findOne({ proposalId }))?.stage,
      "deliberate",
    );
    assert.equal(
      await db
        .collection(GOVERNANCE_EVENTS_COLLECTION)
        .countDocuments({ eventType: "proposal.stage_transition" }),
      0,
    );
  });
});

describe("automatic ballot closure (D6)", () => {
  async function openDueBallot(
    db: ReturnType<typeof createMemoryDb>,
    closesAt: Date = NOW,
  ): Promise<{ proposalId: string; revisionId: string }> {
    const proposalId = await insertMatter(db, {
      stage: "decide",
      ballotClosesAt: closesAt,
      ballotRevisionId: "rev-ballot",
      governanceAuthorityBranchId: "branch-nat",
    });
    const revisionId = await insertRevision(db, proposalId, "rev-ballot");
    await db.collection("ballots").insertOne({
      ballotId: proposalBallotId(proposalId),
      matterId: proposalId,
      revisionId,
      status: "open",
      closesAt,
      openedAt: new Date(closesAt.getTime() - 30 * DAY),
      createdAt: new Date(closesAt.getTime() - 30 * DAY),
      updatedAt: new Date(closesAt.getTime() - 30 * DAY),
    });
    return { proposalId, revisionId };
  }

  it("records ballot.closed once without changing the stage or recording a result", async () => {
    const db = createMemoryDb();
    const { proposalId } = await openDueBallot(db);

    const report = await closeDueBallots(db, { now: NOW });
    assert.equal(report.closed.length, 1);
    assert.equal(report.closed[0]?.ballotId, proposalBallotId(proposalId));
    assert.equal(
      report.closed[0]?.eventId,
      ballotClosedEventId(proposalId, NOW),
    );

    const stored = await db.collection("proposals").findOne({ proposalId });
    assert.equal(stored?.stage, "decide");
    assert.equal(new Date(stored?.ballotClosedAt).getTime(), NOW.getTime());

    const event = await db
      .collection(GOVERNANCE_EVENTS_COLLECTION)
      .findOne({ matterId: proposalId, eventType: "ballot.closed" });
    assert.equal(event?.actorId, LIFECYCLE_SYSTEM_ACTOR);
    assert.equal(event?.metadata?.ballotClosesAt, NOW.toISOString());
    assert.equal(
      await db.collection("ballot_results").countDocuments({ proposalId }),
      0,
    );
    assert.equal(
      (await db.collection("ballots").findOne({ ballotId: proposalBallotId(proposalId) }))
        ?.status,
      "closed",
    );

    const replay = await closeDueBallots(db, { now: NOW });
    assert.equal(replay.closed.length, 0);
    assert.equal(
      await db
        .collection(GOVERNANCE_EVENTS_COLLECTION)
        .countDocuments({ matterId: proposalId, eventType: "ballot.closed" }),
      1,
    );

    // Returning the matter to Deliberate starts a new ballot instance, so the
    // closure marker clears while the historical event remains.
    const returned = await saveProposal(db, admin, {
      proposalId,
      stage: "deliberate",
    });
    assert.equal(returned.stage, "deliberate");
    const afterReturn = await db
      .collection("proposals")
      .findOne({ proposalId });
    assert.equal(afterReturn?.ballotClosedAt, undefined);
    assert.equal(
      await db
        .collection(GOVERNANCE_EVENTS_COLLECTION)
        .countDocuments({ matterId: proposalId, eventType: "ballot.closed" }),
      1,
    );
  });

  it("does not close a ballot before its deadline", async () => {
    const db = createMemoryDb();
    const { proposalId } = await openDueBallot(
      db,
      new Date(NOW.getTime() + 1),
    );
    const report = await closeDueBallots(db, { now: NOW });
    assert.equal(report.closed.length, 0);
    assert.equal(
      (await db.collection("proposals").findOne({ proposalId }))?.ballotClosedAt,
      undefined,
    );
  });

  it("records exactly one closure under two concurrent runs", async () => {
    const db = createMemoryDb();
    const { proposalId } = await openDueBallot(db);
    await Promise.all([
      closeDueBallots(db, { now: NOW }),
      closeDueBallots(db, { now: NOW }),
    ]);
    assert.equal(
      await db
        .collection(GOVERNANCE_EVENTS_COLLECTION)
        .countDocuments({ matterId: proposalId, eventType: "ballot.closed" }),
      1,
    );
  });

  it("rejects votes after the deadline and after the closure is recorded", async () => {
    const db = createMemoryDb();
    const opened = await saveProposal(db, admin, {
      title: "Voting after the deadline",
      space: "Governance",
      summary: "A ballot must stop accepting votes at its deadline.",
      stage: "decide",
    });
    assert.ok(opened.ballotClosesAt);
    // A vote before the deadline is accepted.
    await castVote(db, memberA, {
      proposalId: opened.proposalId,
      choice: "approve",
    });

    const deadline = new Date(Date.now() - 60_000);
    await db
      .collection("proposals")
      .updateOne(
        { proposalId: opened.proposalId },
        { $set: { ballotClosesAt: deadline } },
      );

    await assert.rejects(
      castVote(db, memberB, {
        proposalId: opened.proposalId,
        choice: "reject",
      }),
      /closed/i,
    );

    const report = await closeDueBallots(db);
    assert.equal(report.closed.length, 1);
    await assert.rejects(
      castVote(db, memberB, {
        proposalId: opened.proposalId,
        choice: "reject",
      }),
      /closed/i,
    );
    // An existing voter may not change a vote after the deadline either (D11
    // only protects changes while the ballot is open).
    await assert.rejects(
      castVote(db, memberA, {
        proposalId: opened.proposalId,
        choice: "reject",
      }),
      /closed/i,
    );
    assert.equal(
      await db
        .collection(PROPOSAL_VOTES)
        .countDocuments({ ballotId: proposalBallotId(opened.proposalId) }),
      1,
    );
  });
});

describe("officer-opened ballot deadline default (D6)", () => {
  it("supplies a 30-day default only when no explicit date is given", async () => {
    const db = createMemoryDb();
    const draft = await saveProposal(db, admin, {
      title: "Default ballot deadline",
      space: "Governance",
      summary: "A ballot opened without a date receives the ordinary period.",
      stage: "deliberate",
    });
    const before = Date.now();
    const opened = await saveProposal(db, admin, {
      proposalId: draft.proposalId,
      stage: "decide",
    });
    assert.ok(opened.ballotClosesAt);
    assert.ok(
      Math.abs(
        opened.ballotClosesAt.getTime() - (before + BALLOT_PERIOD_DAYS * DAY),
      ) < 60_000,
    );

    const explicit = new Date(Date.now() + 5 * DAY);
    const rescheduled = await saveProposal(db, admin, {
      proposalId: draft.proposalId,
      stage: "decide",
      ballotClosesAt: explicit.toISOString(),
    });
    assert.equal(rescheduled.ballotClosesAt?.getTime(), explicit.getTime());
  });
});

describe("seconding API and migration reporting", () => {
  it("seconds a proposal through the member route without exposing the seconder ID", async () => {
    const env = { APP_MODE: "development" };
    const db = await getDatabase(env);
    const proposalId = `PROP-API-${randomUUID()}`;
    await db.collection("proposals").insertOne({
      proposalId,
      slug: proposalId.toLowerCase(),
      title: "Member-facing seconding",
      space: "Governance",
      summary: "A member seconds this proposal through the API.",
      outcomes: [],
      details: "",
      kind: "policy",
      stage: "propose",
      authorId: "some-other-author",
      createdAt: NOW,
      updatedAt: NOW,
    });

    const call = () =>
      secondProposalRoute({
        params: { proposalId },
        request: new Request(
          `http://localhost/api/proposals/${proposalId}/second`,
          {
            method: "POST",
            headers: { Cookie: "engage_dev_user=member" },
          },
        ),
        locals: { runtime: { env } },
      } as never);

    const response = await call();
    assert.equal(response.status, 201);
    const payload = (await response.json()) as {
      proposal: Record<string, unknown>;
    };
    assert.equal(payload.proposal.seconded, true);
    assert.ok(payload.proposal.deliberationEndsAt);
    assert.equal("secondedBy" in payload.proposal, false);

    const duplicate = await call();
    assert.equal(duplicate.status, 409);
    assert.match(
      ((await duplicate.json()) as { error: string }).error,
      /already has a seconder/i,
    );

    const signedOut = await secondProposalRoute({
      params: { proposalId },
      request: new Request(
        `http://localhost/api/proposals/${proposalId}/second`,
        { method: "POST" },
      ),
      locals: { runtime: { env } },
    } as never);
    assert.equal(signedOut.status, 401);
  });

  it("reports legacy deadline gaps without rewriting them", async () => {
    const db = createMemoryDb();
    const openBallotId = await insertMatter(db, {
      stage: "decide",
      ballotRevisionId: "rev-legacy",
    });
    const deliberateWithoutClock = await insertMatter(db, { stage: "deliberate" });
    const healthy = await insertSecondedDeliberation(db);
    const healthyBallot = await insertMatter(db, {
      stage: "decide",
      ballotClosesAt: new Date(NOW.getTime() + DAY),
      ballotRevisionId: "rev-healthy",
    });
    await db.collection("amendments").insertOne({
      amendmentId: "amd-legacy",
      proposalId: openBallotId,
      status: "voting",
      createdAt: NOW,
    });
    await db.collection("ballots").insertOne({
      ballotId: proposalBallotId(openBallotId),
      matterId: openBallotId,
      status: "open",
      openedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const before = {
      proposals: await db.collection("proposals").find({}).toArray(),
      amendments: await db.collection("amendments").find({}).toArray(),
      ballots: await db.collection("ballots").find({}).toArray(),
    };
    const report = await buildLifecycleMigrationReport(db, { now: NOW });
    assert.equal(report.readOnly, true);
    assert.ok(report.counts.openBallotsWithoutDeadline >= 3);
    assert.deepEqual(
      report.openBallotsWithoutDeadline
        .filter((gap) => gap.collection === "proposals")
        .map((gap) => gap.id),
      [openBallotId],
    );
    assert.deepEqual(
      report.deliberateWithoutDeliberationDeadline.map((gap) => gap.proposalId),
      [deliberateWithoutClock],
    );
    assert.ok(
      !report.deliberateWithoutDeliberationDeadline.some(
        (gap) => gap.proposalId === healthy.proposalId,
      ),
    );
    assert.ok(
      !report.openBallotsWithoutDeadline.some(
        (gap) => gap.id === healthyBallot,
      ),
    );
    assert.ok(report.recoveryOptions.length >= 3);
    assert.deepEqual(
      await db.collection("proposals").find({}).toArray(),
      before.proposals,
    );
    assert.deepEqual(
      await db.collection("amendments").find({}).toArray(),
      before.amendments,
    );
    assert.deepEqual(
      await db.collection("ballots").find({}).toArray(),
      before.ballots,
    );
  });
});
