import test from "node:test";
import assert from "node:assert/strict";
import { calculateStrictMajority, formalVotingIsEnabled, isBallotOpen, upsertCurrentVote, validateVoteChoice } from "./voting.mjs";

test("a ballot is open at its opening instant and closed at its closing instant", () => {
  const opensAt = new Date("2026-10-26T00:00:00+11:00");
  const closesAt = new Date("2026-11-27T00:00:00+11:00");
  const ballot = { status: "open", opensAt, closesAt };
  assert.equal(isBallotOpen(ballot, opensAt), true);
  assert.equal(isBallotOpen(ballot, new Date(closesAt.getTime() - 1)), true);
  assert.equal(isBallotOpen(ballot, closesAt), false);
  assert.equal(isBallotOpen({ ...ballot, status: "draft" }, opensAt), false);
});

test("a strict majority of votes cast determines the outcome, with ties failing", () => {
  assert.deepEqual(calculateStrictMajority(6, 4), { votesCast: 10, outcome: "approved" });
  assert.deepEqual(calculateStrictMajority(5, 5), { votesCast: 10, outcome: "not-approved" });
  assert.deepEqual(calculateStrictMajority(0, 0), { votesCast: 0, outcome: "no-valid-votes" });
  assert.deepEqual(calculateStrictMajority(4, 6), { votesCast: 10, outcome: "not-approved" });
});

test("only the two defined ballot choices are accepted", () => {
  assert.equal(validateVoteChoice("approve"), true);
  assert.equal(validateVoteChoice("do-not-approve"), true);
  assert.equal(validateVoteChoice("abstain"), false);
  assert.equal(validateVoteChoice(""), false);
});

test("concurrent synthetic revotes leave exactly one current choice", async () => {
  const votes = new Map<string, Record<string, unknown>>();
  let seenMissing = 0;
  const votesCollection = {
    async updateOne(filter: Record<string, string>, update: Record<string, Record<string, unknown>>, options?: { upsert?: boolean }) {
      const key = `${filter.ballotId}:${filter.memberId}`;
      const current = votes.get(key);
      if (!current && options?.upsert) {
        seenMissing += 1;
        if (seenMissing === 1) await Promise.resolve();
        if (seenMissing === 2) {
          const collision = new Error("duplicate key") as Error & { code: number };
          collision.code = 11000;
          throw collision;
        }
      }
      votes.set(key, { ...current, ...update.$set, ...(!current ? update.$setOnInsert : {}) });
      return { upsertedCount: current ? 0 : 1 };
    },
  };
  await Promise.all([
    upsertCurrentVote(votesCollection, { ballotId: "housing-01", memberId: "preview-member-01" }, "approve", new Date("2026-10-26T00:00:00Z")),
    upsertCurrentVote(votesCollection, { ballotId: "housing-01", memberId: "preview-member-01" }, "do-not-approve", new Date("2026-10-26T00:00:01Z")),
  ]);
  assert.equal(votes.size, 1);
  const stored = votes.get("housing-01:preview-member-01");
  assert.ok(["approve", "do-not-approve"].includes(String(stored?.choice)));
  assert.equal("synthetic" in (stored ?? {}), false);
});

test("formal ballot activation stays disabled in preview", () => {
  assert.equal(formalVotingIsEnabled({ APP_MODE: "preview", FORMAL_BALLOTS_ENABLED: "true" }), false);
  assert.equal(formalVotingIsEnabled({ APP_MODE: "production", FORMAL_BALLOTS_ENABLED: "false" }), false);
});
