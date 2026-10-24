import test from "node:test";
import assert from "node:assert/strict";
import { calculateStrictMajority, formalVotingIsEnabled, validateVoteChoice } from "./voting.mjs";

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

test("formal ballot activation stays disabled in preview", () => {
  assert.equal(formalVotingIsEnabled({ APP_MODE: "preview", FORMAL_BALLOTS_ENABLED: "true" }), false);
  assert.equal(formalVotingIsEnabled({ APP_MODE: "production", FORMAL_BALLOTS_ENABLED: "false" }), false);
});
