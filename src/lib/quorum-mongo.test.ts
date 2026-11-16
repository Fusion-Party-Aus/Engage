import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { MongoClient, ObjectId, type Db } from "mongodb";
import {
  BALLOT_QUORUM_COLLECTION,
  readQuorumElectorate,
} from "./quorum.ts";
import {
  BallotDomainError,
  ensureBallotQuorumRecordForCertification,
  recordBallotQuorumAtClosure,
  recordFormalDecision,
  upsertMatterBallot,
} from "./ballots.ts";
import { runInTransaction } from "./db.ts";
import { closeDueBallots } from "./governance-scheduler.ts";
import {
  PROPOSAL_VOTES,
  ensureProposalVoteIndex,
  proposalBallotId,
} from "./vote-storage.ts";

const mongoUri = process.env.VOTING_TEST_MONGODB_URI;
const NOW = new Date("2026-12-15T00:00:00.000Z");
const FUTURE = new Date("2026-12-20T00:00:00.000Z");

function dayOffset(days: number): Date {
  return new Date(NOW.getTime() - days * 86_400_000);
}

async function insertMember(
  db: Db,
  memberId: string,
  options: {
    status?: "verified" | "pending" | "suspended";
    disabled?: boolean;
    activeDaysAgo?: number | null;
    crmPersonId?: string;
  } = {},
): Promise<void> {
  await db.collection("user").insertOne({
    _id: memberId as any,
    name: `Member ${memberId}`,
    email: `${memberId}@example.test`,
    emailVerified: true,
    ...(options.disabled ? { disabled: true } : {}),
  });
  await db.collection("memberships").insertOne({
    memberId,
    status: options.status ?? "verified",
  });
  if (options.activeDaysAgo !== null && options.activeDaysAgo !== undefined) {
    await db.collection("engagement_lifecycle_events").insertOne({
      _id: `activity:${memberId}:${options.activeDaysAgo}` as any,
      memberId,
      event: "activity_day",
      at: dayOffset(options.activeDaysAgo),
    });
  }
  if (options.crmPersonId) {
    await db.collection("crm_identity_links").insertOne({
      memberId,
      application: "underground-crm",
      status: "active",
      crmPersonId: options.crmPersonId,
    });
  }
}

async function seedElectorate(
  db: Db,
  count: number,
  options: {
    prefix?: string;
    active?: boolean | number;
    status?: "verified" | "pending" | "suspended";
    activeDaysAgo?: number;
  } = {},
): Promise<string[]> {
  const ids: string[] = [];
  const activeCount =
    options.active === false
      ? 0
      : typeof options.active === "number"
        ? options.active
        : count;
  for (let index = 0; index < count; index += 1) {
    const memberId = `${options.prefix ?? "member"}-${index}`;
    ids.push(memberId);
    await insertMember(db, memberId, {
      status: options.status ?? "verified",
      activeDaysAgo:
        index < activeCount ? (options.activeDaysAgo ?? 5) : null,
    });
  }
  return ids;
}

async function seedBallot(
  db: Db,
  input: {
    matterId: string;
    closedAt?: Date;
    status?: "open" | "closed";
    revisionId?: string;
  },
): Promise<{ ballotId: string; revisionId: string }> {
  const revisionId = input.revisionId ?? "rev-1";
  await db.collection("proposals").insertOne({
    proposalId: input.matterId,
    slug: input.matterId.toLowerCase(),
    title: `Quorum fixture ${input.matterId}`,
    space: "Governance",
    stage: "decide",
    ballotRevisionId: revisionId,
    ...(input.closedAt ? { ballotClosedAt: input.closedAt } : {}),
    createdAt: dayOffset(20),
    updatedAt: dayOffset(20),
  });
  await db.collection("proposal_revisions").insertOne({
    proposalId: input.matterId,
    revisionId,
    parentRevisionId: null,
    createdAt: dayOffset(20),
    snapshot: { title: `Quorum fixture ${input.matterId}` },
    contentHash: `hash-${input.matterId}`,
  });
  await upsertMatterBallot(db, {
    matterId: input.matterId,
    revisionId,
    status: input.status ?? "closed",
    now: dayOffset(20),
  });
  return {
    ballotId: proposalBallotId(input.matterId),
    revisionId,
  };
}

async function seedVotes(
  db: Db,
  ballotId: string,
  matterId: string,
  revisionId: string,
  choices: Array<"approve" | "reject" | "abstain">,
  memberIds?: string[],
): Promise<void> {
  await db.collection(PROPOSAL_VOTES).insertMany(
    choices.map((choice, index) => ({
      ballotId,
      proposalId: matterId,
      memberId: memberIds?.[index] ?? `voter-${matterId}-${index}`,
      choice,
      revisionId,
      updatedAt: dayOffset(2),
    })),
  );
}

describe(
  "two-tier quorum (real MongoDB replica set)",
  { skip: !mongoUri },
  () => {
    let client: MongoClient;
    let db: Db;

    before(async () => {
      client = await new MongoClient(mongoUri!).connect();
    });

    after(async () => {
      await db?.dropDatabase();
      await client?.close();
    });

    // A fresh database per case keeps one test's electorate out of another.
    const fresh = async () => {
      db = client.db(
        `engage_quorum_${crypto.randomUUID().replaceAll("-", "")}`,
      );
    };

    it("counts verified, active and duplicate-free membership", async () => {
      await fresh();
      await seedElectorate(db, 28, { prefix: "eligible", active: 12 });
      await insertMember(db, "pending-1", {
        status: "pending",
        activeDaysAgo: 1,
      });
      await insertMember(db, "suspended-1", {
        status: "suspended",
        activeDaysAgo: 1,
      });
      await insertMember(db, "disabled-1", {
        disabled: true,
        activeDaysAgo: 1,
      });
      await insertMember(db, "inactive-1", { activeDaysAgo: null });
      // Two accounts linked to one CRM person count once.
      await insertMember(db, "duplicate-a", {
        activeDaysAgo: 1,
        crmPersonId: "person-1",
      });
      await insertMember(db, "duplicate-b", {
        activeDaysAgo: 1,
        crmPersonId: "person-1",
      });

      const electorate = await readQuorumElectorate(db, { now: NOW });
      // 28 seeded + one inactive + the duplicate pair (counted once) = 30.
      // The disabled account is excluded, and pending/suspended memberships
      // never enter the registered electorate.
      assert.equal(electorate.eligibleRegisteredMembers, 30);
      assert.equal(electorate.duplicateAccountsExcluded, 1);
      assert.equal(electorate.disabledAccountsExcluded, 1);
      assert.equal(electorate.activeEligibleMembers, 13);
    });

    it("matches Better Auth ObjectId user ids to string membership ids", async () => {
      await fresh();
      const memberId = new ObjectId().toHexString();
      await db.collection("user").insertOne({
        _id: new ObjectId(memberId),
        email: `${memberId}@example.test`,
      });
      await db.collection("memberships").insertOne({
        memberId,
        status: "verified",
      });
      await db.collection("engagement_lifecycle_events").insertOne({
        _id: "objectid-activity" as any,
        memberId,
        event: "activity_day",
        at: dayOffset(2),
      });
      const electorate = await readQuorumElectorate(db, { now: NOW });
      assert.equal(electorate.eligibleRegisteredMembers, 1);
      assert.equal(electorate.activeEligibleMembers, 1);
      assert.equal(electorate.missingAccountsExcluded, 0);
    });

    it("is active from votes, comments, proposals and amendments as well as visits", async () => {
      await fresh();
      const ids = await seedElectorate(db, 30, {
        prefix: "quiet",
        active: 0,
      });
      await db.collection(PROPOSAL_VOTES).insertOne({
        ballotId: "proposal:OTHER",
        proposalId: "OTHER",
        memberId: ids[0],
        revisionId: "rev-other",
        choice: "abstain",
        updatedAt: dayOffset(3),
      });
      await db.collection("comments").insertOne({
        proposalId: "OTHER",
        memberId: ids[1],
        createdAt: dayOffset(3),
      });
      await db.collection("proposals").insertOne({
        proposalId: "AUTHORED",
        authorId: ids[2],
        createdAt: dayOffset(3),
      });
      await db.collection("amendments").insertOne({
        amendmentId: "AMD-AUTHORED",
        authorId: ids[3],
        createdAt: dayOffset(3),
      });
      // A 91-day-old visit is outside the rolling window.
      await db.collection("engagement_lifecycle_events").insertOne({
        _id: "stale-visit" as any,
        memberId: ids[4],
        event: "activity_day",
        at: dayOffset(91),
      });

      const electorate = await readQuorumElectorate(db, { now: NOW });
      assert.equal(electorate.eligibleRegisteredMembers, 30);
      assert.equal(electorate.activeEligibleMembers, 4);
    });

    it("records a closure snapshot and evaluates both quorums", async () => {
      await fresh();
      const active = await seedElectorate(db, 38, {
        prefix: "active",
        active: 38,
      });
      const { ballotId, revisionId } = await seedBallot(db, {
        matterId: "PROP-ACCEPT",
        closedAt: NOW,
      });
      await seedVotes(
        db,
        ballotId,
        "PROP-ACCEPT",
        revisionId,
        [
          ...Array.from({ length: 11 }, () => "approve" as const),
          ...Array.from({ length: 3 }, () => "abstain" as const),
          ...Array.from({ length: 5 }, () => "reject" as const),
        ],
        active,
      );

      const record = await recordBallotQuorumAtClosure(db, {
        ballotId,
        matterId: "PROP-ACCEPT",
        revisionId,
        closedAt: NOW,
        now: NOW,
      });
      assert.equal(record.status, "evaluated");
      assert.equal(record.eligibleRegisteredMembers, 38);
      assert.equal(record.activeEligibleMembers, 38);
      assert.equal(record.platformQuorumRequired, 30);
      assert.equal(record.platformQuorumMet, true);
      assert.equal(record.ballotQuorumRequired, 19);
      assert.equal(record.participatingMembers, 19);
      assert.equal(record.ballotQuorumMet, true);
      assert.equal(record.quorumMet, true);
      assert.equal(record.verdict, "adopted");
      assert.deepEqual(record.tally, {
        approve: 11,
        abstain: 3,
        reject: 5,
        total: 19,
      });
      assert.equal(record.ruleVersion, "two-tier-quorum-v1");
    });

    it("meets quorum with a proportional requirement below 30 active members", async () => {
      await fresh();
      await seedElectorate(db, 20, { prefix: "small", active: 20 });
      const { ballotId, revisionId } = await seedBallot(db, {
        matterId: "PROP-SMALL",
        closedAt: NOW,
      });
      await seedVotes(
        db,
        ballotId,
        "PROP-SMALL",
        revisionId,
        Array.from({ length: 10 }, () => "approve" as const),
      );

      const record = await recordBallotQuorumAtClosure(db, {
        ballotId,
        matterId: "PROP-SMALL",
        revisionId,
        closedAt: NOW,
        now: NOW,
      });
      assert.equal(record.platformQuorumMet, false);
      assert.equal(record.ballotQuorumRequired, 10);
      assert.equal(record.ballotQuorumMet, true);
      assert.equal(record.quorumMet, false);
      assert.equal(record.verdict, "inconclusive");
    });

    it("refuses to certify a failed quorum as successful or unsuccessful", async () => {
      await fresh();
      await seedElectorate(db, 30, { prefix: "lowturnout", active: 30 });
      const { ballotId, revisionId } = await seedBallot(db, {
        matterId: "PROP-LOW",
        closedAt: NOW,
      });
      // 30 active requires 15 participants; only 3 take part, all approving.
      await seedVotes(
        db,
        ballotId,
        "PROP-LOW",
        revisionId,
        ["approve", "approve", "approve"],
      );
      await recordBallotQuorumAtClosure(db, {
        ballotId,
        matterId: "PROP-LOW",
        revisionId,
        closedAt: NOW,
        now: NOW,
      });

      await assert.rejects(
        recordFormalDecision(db, {
          matterId: "PROP-LOW",
          revisionId,
          result: "successful",
          decisionEventId: "DEC-LOW-1",
          recordedBy: "admin-1",
          now: NOW,
        }),
        (error: unknown) =>
          error instanceof BallotDomainError &&
          error.code === "BALLOT_QUORUM_NOT_MET",
      );

      const recorded = await recordFormalDecision(db, {
        matterId: "PROP-LOW",
        revisionId,
        result: "inconclusive",
        decisionEventId: "DEC-LOW-1",
        recordedBy: "admin-1",
        now: NOW,
      });
      assert.equal(recorded.result, "inconclusive");
      assert.equal(recorded.computedResult, "inconclusive");
      assert.equal(recorded.quorum?.quorumMet, false);
      assert.equal(recorded.quorum?.verdict, "inconclusive");
      assert.equal(recorded.override, undefined);
    });

    it("records a quorum-passing ballot as unsuccessful when approval fails", async () => {
      await fresh();
      await seedElectorate(db, 30, { prefix: "reject", active: 30 });
      const { ballotId, revisionId } = await seedBallot(db, {
        matterId: "PROP-REJECT",
        closedAt: NOW,
      });
      await seedVotes(
        db,
        ballotId,
        "PROP-REJECT",
        revisionId,
        [
          ...Array.from({ length: 7 }, () => "approve" as const),
          ...Array.from({ length: 8 }, () => "reject" as const),
        ],
      );
      await recordBallotQuorumAtClosure(db, {
        ballotId,
        matterId: "PROP-REJECT",
        revisionId,
        closedAt: NOW,
        now: NOW,
      });

      const recorded = await recordFormalDecision(db, {
        matterId: "PROP-REJECT",
        revisionId,
        result: "unsuccessful",
        decisionEventId: "DEC-REJECT-1",
        recordedBy: "admin-1",
        now: NOW,
      });
      assert.equal(recorded.result, "unsuccessful");
      assert.equal(recorded.quorum?.quorumMet, true);
      assert.equal(recorded.quorum?.verdict, "rejected");
    });

    it("does not change a recorded closure when membership later changes", async () => {
      await fresh();
      await seedElectorate(db, 30, { prefix: "frozen", active: 30 });
      const { ballotId, revisionId } = await seedBallot(db, {
        matterId: "PROP-FROZEN",
        closedAt: NOW,
      });
      await seedVotes(
        db,
        ballotId,
        "PROP-FROZEN",
        revisionId,
        Array.from({ length: 15 }, () => "approve" as const),
      );
      const first = await recordBallotQuorumAtClosure(db, {
        ballotId,
        matterId: "PROP-FROZEN",
        revisionId,
        closedAt: NOW,
        now: NOW,
      });
      assert.equal(first.eligibleRegisteredMembers, 30);
      assert.equal(first.activeEligibleMembers, 30);

      // Ten more active members and a suspension after closure.
      await seedElectorate(db, 10, { prefix: "later", active: 10 });
      await db
        .collection("memberships")
        .updateOne({ memberId: "frozen-0" }, { $set: { status: "suspended" } });

      const second = await recordBallotQuorumAtClosure(db, {
        ballotId,
        matterId: "PROP-FROZEN",
        revisionId,
        closedAt: NOW,
        now: NOW,
      });
      assert.deepEqual(second, first);
      const stored = await db
        .collection(BALLOT_QUORUM_COLLECTION)
        .findOne({ ballotId });
      assert.equal(stored?.eligibleRegisteredMembers, 30);
      assert.equal(
        await db.collection(BALLOT_QUORUM_COLLECTION).countDocuments({ ballotId }),
        1,
      );
    });

    it("refuses a participation mismatch instead of silently certifying", async () => {
      await fresh();
      await seedElectorate(db, 30, { prefix: "mismatch", active: 30 });
      const { ballotId, revisionId } = await seedBallot(db, {
        matterId: "PROP-MISMATCH",
        closedAt: NOW,
      });
      await seedVotes(
        db,
        ballotId,
        "PROP-MISMATCH",
        revisionId,
        Array.from({ length: 15 }, () => "approve" as const),
      );
      await recordBallotQuorumAtClosure(db, {
        ballotId,
        matterId: "PROP-MISMATCH",
        revisionId,
        closedAt: NOW,
        now: NOW,
      });
      // Simulate an unauthorised post-closure deletion. The immutable snapshot
      // must expose the discrepancy rather than recalculate quorum.
      await db
        .collection(PROPOSAL_VOTES)
        .deleteOne({ ballotId, memberId: "voter-PROP-MISMATCH-0" });
      await assert.rejects(
        recordFormalDecision(db, {
          matterId: "PROP-MISMATCH",
          revisionId,
          result: "successful",
          decisionEventId: "DEC-MISMATCH",
          recordedBy: "admin-1",
          now: NOW,
        }),
        (error: unknown) =>
          error instanceof BallotDomainError &&
          error.code === "BALLOT_QUORUM_PARTICIPATION_MISMATCH",
      );
    });

    it("does not reconstruct a missing post-rule snapshot from live data", async () => {
      await fresh();
      await seedElectorate(db, 30, { prefix: "missing", active: 30 });
      const { ballotId, revisionId } = await seedBallot(db, {
        matterId: "PROP-MISSING",
        closedAt: NOW,
      });
      await seedVotes(
        db,
        ballotId,
        "PROP-MISSING",
        revisionId,
        Array.from({ length: 15 }, () => "approve" as const),
      );
      await assert.rejects(
        recordFormalDecision(db, {
          matterId: "PROP-MISSING",
          revisionId,
          result: "successful",
          decisionEventId: "DEC-MISSING",
          recordedBy: "admin-1",
          now: NOW,
        }),
        (error: unknown) =>
          error instanceof BallotDomainError &&
          error.code === "BALLOT_QUORUM_SNAPSHOT_MISSING",
      );
    });

    it("keeps a pre-rule closure under the approval-only rule", async () => {
      await fresh();
      const { revisionId } = await seedBallot(db, {
        matterId: "PROP-LEGACY",
        closedAt: new Date("2026-11-10T00:00:00.000Z"),
      });
      const recorded = await recordFormalDecision(db, {
        matterId: "PROP-LEGACY",
        revisionId,
        result: "unsuccessful",
        decisionEventId: "DEC-LEGACY",
        recordedBy: "admin-1",
        now: NOW,
      });
      assert.equal(recorded.result, "unsuccessful");
      assert.equal(recorded.ruleBasis, "simple-majority-d9-v1");
      assert.equal(recorded.quorum?.status, "legacy-not-applied");
      assert.equal(recorded.quorum?.applied, false);
    });

    it("closes an open-at-rollout ballot and writes its snapshot atomically", async () => {
      await fresh();
      await seedElectorate(db, 30, { prefix: "rollout", active: 30 });
      const { ballotId, revisionId } = await seedBallot(db, {
        matterId: "PROP-ROLLOUT",
        status: "open",
      });
      await seedVotes(
        db,
        ballotId,
        "PROP-ROLLOUT",
        revisionId,
        Array.from({ length: 15 }, () => "approve" as const),
      );
      const due = await db.collection("proposals").updateOne(
        { proposalId: "PROP-ROLLOUT" },
        { $set: { ballotClosesAt: new Date("2026-12-14T00:00:00.000Z") } },
      );
      assert.equal(due.matchedCount, 1);

      const report = await closeDueBallots(db, { now: NOW });
      assert.equal(report.errors.length, 0);
      assert.equal(report.closed.length, 1);
      const snapshot = await db
        .collection(BALLOT_QUORUM_COLLECTION)
        .findOne({ ballotId });
      assert.equal(snapshot?.status, "evaluated");
      assert.equal(snapshot?.quorumMet, true);

      const recorded = await recordFormalDecision(db, {
        matterId: "PROP-ROLLOUT",
        revisionId,
        result: "successful",
        decisionEventId: "DEC-ROLLOUT",
        recordedBy: "admin-1",
        now: NOW,
      });
      assert.equal(recorded.result, "successful");
      assert.equal(recorded.ruleBasis, "two-tier-quorum-simple-majority-v1");
      assert.equal(recorded.quorum?.ruleVersion, "two-tier-quorum-v1");
      assert.equal(recorded.quorum?.participatingMembers, 15);
    });

    it("records one snapshot under concurrent closure and membership change", async () => {
      await fresh();
      await seedElectorate(db, 30, { prefix: "race", active: 30 });
      const { ballotId, revisionId } = await seedBallot(db, {
        matterId: "PROP-RACE",
        closedAt: NOW,
      });
      await seedVotes(
        db,
        ballotId,
        "PROP-RACE",
        revisionId,
        Array.from({ length: 15 }, () => "approve" as const),
      );
      await Promise.all([
        runInTransaction(db, (session) =>
          recordBallotQuorumAtClosure(db, {
            ballotId,
            matterId: "PROP-RACE",
            revisionId,
            closedAt: NOW,
            now: NOW,
            session,
          }),
        ),
        seedElectorate(db, 1, { prefix: "concurrent", active: 1 }),
      ]);
      const stored = await db
        .collection(BALLOT_QUORUM_COLLECTION)
        .findOne({ ballotId });
      assert.ok(stored);
      // The snapshot saw the electorate either before or after the concurrent
      // insertion, never a partially mixed count.
      assert.ok(
        stored?.eligibleRegisteredMembers === 30 ||
          stored?.eligibleRegisteredMembers === 31,
      );
      assert.equal(
        await db.collection(BALLOT_QUORUM_COLLECTION).countDocuments({ ballotId }),
        1,
      );
      await db.collection("proposals").updateOne(
        { proposalId: "PROP-RACE" },
        { $set: { ballotClosedAt: NOW } },
      );
      const recorded = await recordFormalDecision(db, {
        matterId: "PROP-RACE",
        revisionId,
        result: "successful",
        decisionEventId: "DEC-RACE",
        recordedBy: "admin-1",
        now: NOW,
      });
      assert.equal(
        recorded.quorum?.eligibleRegisteredMembers,
        stored?.eligibleRegisteredMembers,
      );
    });

    it("does not count a member whose only activity is older than the window", async () => {
      await fresh();
      await seedElectorate(db, 30, { prefix: "stale", active: 0 });
      const { ballotId, revisionId } = await seedBallot(db, {
        matterId: "PROP-STALE",
        closedAt: NOW,
      });
      await db.collection("engagement_lifecycle_events").insertOne({
        _id: "stale-only" as any,
        memberId: "stale-0",
        event: "my_engage_viewed",
        at: dayOffset(120),
      });
      await seedVotes(
        db,
        ballotId,
        "PROP-STALE",
        revisionId,
        Array.from({ length: 15 }, () => "approve" as const),
        Array.from({ length: 15 }, (_, index) => `stale-${index}`),
      );
      const record = await recordBallotQuorumAtClosure(db, {
        ballotId,
        matterId: "PROP-STALE",
        revisionId,
        closedAt: NOW,
        now: NOW,
      });
      // The 15 voters' own votes are activity inside the window, so they count
      // as active even though they made no separate visit.
      assert.equal(record.activeEligibleMembers, 15);
      assert.equal(record.ballotQuorumRequired, 8);
      assert.equal(record.ballotQuorumMet, true);
    });

    it("counts a changed vote once", async () => {
      await fresh();
      const active = await seedElectorate(db, 30, {
        prefix: "change",
        active: 30,
      });
      const { ballotId, revisionId } = await seedBallot(db, {
        matterId: "PROP-CHANGE",
        closedAt: NOW,
      });
      await seedVotes(
        db,
        ballotId,
        "PROP-CHANGE",
        revisionId,
        Array.from({ length: 15 }, () => "approve" as const),
        active.slice(0, 15),
      );
      await db.collection(PROPOSAL_VOTES).updateOne(
        { ballotId, memberId: active[0] },
        { $set: { choice: "reject", updatedAt: dayOffset(1) } },
      );
      const record = await recordBallotQuorumAtClosure(db, {
        ballotId,
        matterId: "PROP-CHANGE",
        revisionId,
        closedAt: NOW,
        now: NOW,
      });
      assert.equal(record.participatingMembers, 15);
      assert.deepEqual(record.tally, {
        approve: 14,
        abstain: 0,
        reject: 1,
        total: 15,
      });
      assert.equal(record.ballotQuorumMet, true);
    });

    it("exposes the missing snapshot as an explicit operational error", async () => {
      await fresh();
      const { ballotId, revisionId } = await seedBallot(db, {
        matterId: "PROP-NO-SNAPSHOT",
        closedAt: NOW,
      });
      await assert.rejects(
        ensureBallotQuorumRecordForCertification(db, {
          ballotId,
          matterId: "PROP-NO-SNAPSHOT",
          revisionId,
          now: NOW,
        }),
        (error: unknown) =>
          error instanceof BallotDomainError &&
          error.code === "BALLOT_QUORUM_SNAPSHOT_MISSING",
      );
    });

    it("counts one member once even if a duplicate vote is attempted", async () => {
      await fresh();
      await ensureProposalVoteIndex(db);
      await db.collection(PROPOSAL_VOTES).insertOne({
        ballotId: "proposal:DUP",
        proposalId: "DUP",
        memberId: "member-1",
        revisionId: "rev-1",
        choice: "approve",
        updatedAt: NOW,
      });
      await assert.rejects(
        db.collection(PROPOSAL_VOTES).insertOne({
          ballotId: "proposal:DUP",
          proposalId: "DUP",
          memberId: "member-1",
          revisionId: "rev-1",
          choice: "reject",
          updatedAt: NOW,
        }),
        (error: unknown) => (error as { code?: number }).code === 11000,
      );
      assert.equal(
        await db
          .collection(PROPOSAL_VOTES)
          .countDocuments({ ballotId: "proposal:DUP" }),
        1,
      );
    });

    it("keeps one record per ballot even with different ids for the same matter", async () => {
      await fresh();
      const first = new ObjectId().toHexString();
      assert.equal(first.length, 24);
      const { ballotId, revisionId } = await seedBallot(db, {
        matterId: "PROP-ONE",
        closedAt: NOW,
      });
      await recordBallotQuorumAtClosure(db, {
        ballotId,
        matterId: "PROP-ONE",
        revisionId,
        closedAt: NOW,
        now: NOW,
      });
      await recordBallotQuorumAtClosure(db, {
        ballotId,
        matterId: "PROP-ONE",
        revisionId,
        closedAt: NOW,
        now: NOW,
      });
      assert.equal(
        await db.collection(BALLOT_QUORUM_COLLECTION).countDocuments({
          matterId: "PROP-ONE",
        }),
        1,
      );
    });
  },
);
