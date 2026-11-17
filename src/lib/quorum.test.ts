import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACTIVE_MEMBER_WINDOW_DAYS,
  BALLOT_QUORUM_RULE_VERSION,
  PLATFORM_QUORUM_MINIMUM,
  QUORUM_RULE_EFFECTIVE_AT,
  activeSince,
  buildBallotQuorumRecord,
  buildLegacyQuorumRecord,
  calculateBallotQuorum,
  evaluateQuorum,
  quorumRuleLabel,
  quorumVerdictLabel,
  type QuorumElectorate,
} from "./quorum.ts";

const electorate = (
  eligibleRegisteredMembers: number,
  activeEligibleMembers: number,
): QuorumElectorate => ({
  eligibleMemberIds: Array.from({ length: eligibleRegisteredMembers }, (_, i) => `m${i}`),
  eligibleRegisteredMembers,
  activeEligibleMembers,
  activeSince: new Date("2026-08-18T00:00:00.000Z"),
  duplicateAccountsExcluded: 0,
  disabledAccountsExcluded: 0,
  missingAccountsExcluded: 0,
});

test("ballot quorum follows the published hybrid formula", () => {
  const cases: Array<[number, number]> = [
    [0, 0],
    [1, 1],
    [4, 2],
    [20, 10],
    [30, 15],
    [38, 19],
    [50, 25],
    [59, 30],
    [60, 30],
    [100, 30],
    [500, 30],
    [900, 30],
    [901, 31],
    [1_000, 32],
    [2_000, 45],
  ];
  for (const [active, required] of cases) {
    assert.equal(
      calculateBallotQuorum(active),
      required,
      `${active} active members should require ${required}`,
    );
  }
});

test("the required number rises and falls with the active electorate", () => {
  assert.equal(calculateBallotQuorum(38), 19);
  assert.equal(calculateBallotQuorum(60), 30);
  assert.equal(calculateBallotQuorum(59), 30);
  assert.equal(calculateBallotQuorum(900), 30);
  assert.equal(calculateBallotQuorum(901), 31);
  // A falling electorate lowers the requirement again; the rule is not a
  // ratchet once a ballot has seen a larger active membership.
  assert.equal(calculateBallotQuorum(901), 31);
  assert.equal(calculateBallotQuorum(500), 30);
});

test("negative or malformed membership counts never produce a negative quorum", () => {
  assert.equal(calculateBallotQuorum(-1), 0);
  assert.equal(calculateBallotQuorum(Number.NaN), 0);
  assert.equal(calculateBallotQuorum(Number.POSITIVE_INFINITY), 0);
});

test("fewer than 30 eligible registered members fails platform quorum", () => {
  const result = evaluateQuorum({
    eligibleRegisteredMembers: 29,
    activeEligibleMembers: 29,
    participationCount: 29,
    approve: 29,
    reject: 0,
  });
  assert.equal(result.platformQuorumRequired, PLATFORM_QUORUM_MINIMUM);
  assert.equal(result.platformQuorumMet, false);
  assert.equal(result.quorumMet, false);
  assert.equal(result.verdict, "inconclusive");
});

test("exactly 30 eligible registered members meets platform quorum", () => {
  const result = evaluateQuorum({
    eligibleRegisteredMembers: 30,
    activeEligibleMembers: 30,
    participationCount: 15,
    approve: 10,
    reject: 5,
  });
  assert.equal(result.platformQuorumMet, true);
  assert.equal(result.ballotQuorumRequired, 15);
  assert.equal(result.ballotQuorumMet, true);
  assert.equal(result.quorumMet, true);
  assert.equal(result.verdict, "adopted");
});

test("the acceptance example holds: 38 registered, 38 active, 19 participants", () => {
  const result = evaluateQuorum({
    eligibleRegisteredMembers: 38,
    activeEligibleMembers: 38,
    participationCount: 19,
    approve: 11,
    reject: 8,
  });
  assert.deepEqual(
    {
      platform: result.platformQuorumMet,
      required: result.ballotQuorumRequired,
      participation: result.participationCount,
      ballot: result.ballotQuorumMet,
      verdict: result.verdict,
    },
    {
      platform: true,
      required: 19,
      participation: 19,
      ballot: true,
      verdict: "adopted",
    },
  );
});

test("quorum and approval are separate tests", () => {
  const failedApproval = evaluateQuorum({
    eligibleRegisteredMembers: 60,
    activeEligibleMembers: 60,
    participationCount: 30,
    approve: 14,
    reject: 16,
  });
  assert.equal(failedApproval.quorumMet, true);
  assert.equal(failedApproval.approvalSatisfied, false);
  assert.equal(failedApproval.verdict, "rejected");

  const failedQuorum = evaluateQuorum({
    eligibleRegisteredMembers: 60,
    activeEligibleMembers: 60,
    participationCount: 29,
    approve: 29,
    reject: 0,
  });
  assert.equal(failedQuorum.approvalSatisfied, true);
  assert.equal(failedQuorum.quorumMet, false);
  assert.equal(failedQuorum.verdict, "inconclusive");
});

test("a tie is not adopted even when quorum is met", () => {
  const result = evaluateQuorum({
    eligibleRegisteredMembers: 100,
    activeEligibleMembers: 100,
    participationCount: 30,
    approve: 15,
    reject: 15,
  });
  assert.equal(result.quorumMet, true);
  assert.equal(result.approvalSatisfied, false);
  assert.equal(result.verdict, "rejected");
});

test("zero active members produces a zero ballot requirement but not a fake platform pass", () => {
  const result = evaluateQuorum({
    eligibleRegisteredMembers: 30,
    activeEligibleMembers: 0,
    participationCount: 0,
    approve: 0,
    reject: 0,
  });
  assert.equal(result.ballotQuorumRequired, 0);
  assert.equal(result.platformQuorumMet, true);
  assert.equal(result.quorumMet, true);
  assert.equal(result.verdict, "rejected");
});

test("abstentions count towards participation but not approval", () => {
  const record = buildBallotQuorumRecord({
    ballotId: "proposal:P-1",
    matterId: "P-1",
    revisionId: "rev-1",
    closedAt: new Date("2026-11-20T00:00:00.000Z"),
    electorate: electorate(38, 38),
    tally: { approve: 5, abstain: 14, reject: 0, total: 19 },
  });
  assert.equal(record.participatingMembers, 19);
  assert.equal(record.ballotQuorumRequired, 19);
  assert.equal(record.ballotQuorumMet, true);
  assert.equal(record.approvalSatisfied, true);
  assert.equal(record.verdict, "adopted");
});

test("the closure record is versioned and keeps the final evidence", () => {
  const closedAt = new Date("2026-12-01T00:00:00.000Z");
  const record = buildBallotQuorumRecord({
    ballotId: "proposal:P-2",
    matterId: "P-2",
    revisionId: "rev-2",
    closedAt,
    recordedAt: closedAt,
    electorate: electorate(38, 38),
    tally: { approve: 3, abstain: 0, reject: 4, total: 7 },
  });
  assert.equal(record.ruleVersion, BALLOT_QUORUM_RULE_VERSION);
  assert.equal(record.status, "evaluated");
  assert.equal(record.ballotQuorumRequired, 19);
  assert.equal(record.ballotQuorumMet, false);
  assert.equal(record.quorumMet, false);
  assert.equal(record.verdict, "inconclusive");
  assert.equal(record.closedAt.getTime(), closedAt.getTime());
  assert.equal(record.approvalRule, "simple-majority-d9-v1");
});

test("a ballot closed before the rule is recorded as legacy and not assessed", () => {
  const closedAt = new Date("2026-11-01T00:00:00.000Z");
  const record = buildLegacyQuorumRecord({
    ballotId: "proposal:OLD",
    matterId: "OLD",
    revisionId: "rev-old",
    closedAt,
    tally: { approve: 3, abstain: 0, reject: 1, total: 4 },
  });
  assert.equal(record.status, "legacy-not-applied");
  assert.equal(record.ruleVersion, "pre-quorum-legacy");
  assert.equal(record.quorumMet, undefined);
  assert.equal(record.verdict, "adopted");
  assert.ok(record.closedAt.getTime() < QUORUM_RULE_EFFECTIVE_AT.getTime());
  assert.match(record.anomalies?.join(" ") ?? "", /not applied retrospectively/i);
});

test("activity window is exactly 90 rolling days", () => {
  const now = new Date("2026-11-16T12:00:00.000Z");
  assert.equal(ACTIVE_MEMBER_WINDOW_DAYS, 90);
  assert.equal(
    activeSince(now).toISOString(),
    "2026-08-18T12:00:00.000Z",
  );
});

test("labels are plain language, not rule identifiers", () => {
  assert.equal(quorumVerdictLabel("adopted"), "Adopted");
  assert.equal(quorumVerdictLabel("rejected"), "Rejected");
  assert.equal(quorumVerdictLabel("inconclusive"), "Inconclusive");
  assert.equal(
    quorumRuleLabel({ ruleVersion: BALLOT_QUORUM_RULE_VERSION }),
    "Two-tier quorum, version 1",
  );
  assert.equal(
    quorumRuleLabel({ status: "legacy-not-applied" }),
    "Pre-quorum ballot",
  );
  assert.equal(
    quorumRuleLabel({ status: "unavailable" }),
    "Quorum not recorded",
  );
});
