import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Db } from "mongodb";
import type { BallotCryptoConfig } from "./ballot-crypto.ts";
import { readBallotOutcome } from "./ballot-outcome.ts";
import { BALLOT_QUORUM_COLLECTION } from "./quorum.ts";
import { createMemoryDb } from "./db.ts";
import { proposalBallotId } from "./vote-storage.ts";

const NOW = new Date("2026-12-01T00:00:00Z");
const FUTURE = new Date("2026-12-20T00:00:00Z");
const RECENTLY_CLOSED = new Date("2026-11-20T00:00:00Z");
const BEFORE_RULE = new Date("2026-11-01T00:00:00Z");
const REVISION = "rev-1";

async function seed(
  db: Db,
  proposalId: string,
  overrides: Record<string, unknown> = {},
) {
  await db.collection("proposals").insertOne({
    proposalId,
    slug: proposalId.toLowerCase(),
    title: `Proposal ${proposalId}`,
    space: "Governance",
    kind: "policy",
    stage: "decide",
    summary: "Summary",
    outcomes: [],
    details: "Details",
    ballotRevisionId: REVISION,
    ballotClosesAt: FUTURE,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

async function insertMany(db: Db, collection: string, docs: any[]) {
  await Promise.all(docs.map((doc) => db.collection(collection).insertOne(doc)));
}

function outcome(
  db: Db,
  proposalId: string,
  options: Record<string, unknown> = {},
) {
  return readBallotOutcome(db, {
    proposalId,
    now: NOW,
    cryptoConfig: null,
    ...options,
  });
}

function castVoteDoc(proposalId: string, revisionId = REVISION) {
  return {
    ballotId: proposalBallotId(proposalId),
    proposalId,
    revisionId,
    memberId: "m1",
    choice: "approve",
    reason: "",
    updatedAt: NOW,
    encrypted: false,
  };
}

describe("ballot outcome read model", () => {
  it("reports an unbound ballot without inventing a tally or quorum", async () => {
    const db = createMemoryDb();
    await seed(db, "P-UNBOUND", { ballotRevisionId: undefined });
    const result = await outcome(db, "P-UNBOUND");
    assert.equal(result?.state, "unbound");
    assert.equal(result?.tally, null);
    assert.equal(result?.quorum, null);
    assert.equal(result?.recorded, null);
    assert.equal(result?.closure.certified, false);
  });

  it("reads an open ballot with a bound tally and a quorum preview", async () => {
    const db = createMemoryDb();
    await seed(db, "P-OPEN");
    await insertMany(db, "proposal_votes", [castVoteDoc("P-OPEN")]);
    const result = await outcome(db, "P-OPEN");
    assert.equal(result?.state, "open");
    assert.equal(result?.tally?.state, "computed");
    assert.deepEqual(result?.tally?.tally, {
      approve: 1,
      abstain: 0,
      reject: 0,
      total: 1,
    });
    assert.equal(result?.quorum?.status, "preview");
    assert.equal(result?.recorded, null);
  });

  it("treats an explicitly closed ballot as closed before its deadline", async () => {
    const db = createMemoryDb();
    await seed(db, "P-CLOSED");
    await db.collection("ballots").insertOne({
      ballotId: proposalBallotId("P-CLOSED"),
      matterId: "P-CLOSED",
      status: "closed",
      closesAt: FUTURE,
    });
    const result = await outcome(db, "P-CLOSED");
    assert.equal(result?.state, "closed");
    assert.equal(result?.closure.closed, true);
    assert.equal(result?.closure.basis, "ballot");
    assert.equal(result?.quorum?.status, "missing");
  });

  it("falls back to the matter closure for a legacy ballot with no row", async () => {
    const db = createMemoryDb();
    await seed(db, "P-LEGACY", {
      ballotClosesAt: undefined,
      ballotClosedAt: RECENTLY_CLOSED,
    });
    const result = await outcome(db, "P-LEGACY");
    assert.equal(result?.state, "closed");
    assert.equal(result?.closure.basis, "matter");
  });

  it("reports a cancelled ballot as cancelled, not open or closed", async () => {
    const db = createMemoryDb();
    await seed(db, "P-CANCELLED");
    await db.collection("ballots").insertOne({
      ballotId: proposalBallotId("P-CANCELLED"),
      matterId: "P-CANCELLED",
      status: "cancelled",
      closesAt: FUTURE,
    });
    const result = await outcome(db, "P-CANCELLED");
    assert.equal(result?.state, "cancelled");
    assert.equal(result?.closure.status, "cancelled");
  });

  it("reads a certified ballot with its recorded result and quorum", async () => {
    const db = createMemoryDb();
    await seed(db, "P-CERTIFIED", { ballotClosesAt: RECENTLY_CLOSED });
    await insertMany(db, "proposal_votes", [castVoteDoc("P-CERTIFIED")]);
    await db.collection("ballots").insertOne({
      ballotId: proposalBallotId("P-CERTIFIED"),
      matterId: "P-CERTIFIED",
      status: "certified",
      closesAt: RECENTLY_CLOSED,
    });
    await db.collection(BALLOT_QUORUM_COLLECTION).insertOne({
      ballotId: proposalBallotId("P-CERTIFIED"),
      matterId: "P-CERTIFIED",
      revisionId: REVISION,
      ruleVersion: "two-tier-quorum-v1",
      status: "evaluated",
      closedAt: RECENTLY_CLOSED,
      recordedAt: NOW,
      verdict: "adopted",
      quorumMet: true,
      participatingMembers: 1,
      activeWindowDays: 90,
    });
    await db.collection("ballot_results").insertOne({
      decisionEventId: "DEC-1",
      ballotId: proposalBallotId("P-CERTIFIED"),
      proposalId: "P-CERTIFIED",
      matterId: "P-CERTIFIED",
      revisionId: REVISION,
      result: "successful",
      computedResult: "successful",
      ruleBasis: "two-tier-quorum-simple-majority-v1",
      recordedBy: "officer-1",
      recordedAt: NOW,
    });

    const result = await outcome(db, "P-CERTIFIED");
    assert.equal(result?.state, "closed");
    assert.equal(result?.closure.certified, true);
    assert.equal(result?.recorded?.record.result, "successful");
    assert.equal(result?.recorded?.resultLabel, "Successful");
    assert.equal(result?.recorded?.computedLabel, "Successful");
    assert.equal(result?.quorum?.status, "recorded");
    assert.equal(
      result?.quorum?.status === "recorded" && result.quorum.ruleLabel,
      "Two-tier quorum, version 1",
    );
    assert.equal(
      result?.quorum?.status === "recorded" && result.quorum.verdictLabel,
      "Adopted",
    );
  });

  it("withholds a numeric tally when votes are bound to another revision", async () => {
    const db = createMemoryDb();
    await seed(db, "P-UNBOUND-VOTES");
    await insertMany(db, "proposal_votes", [
      castVoteDoc("P-UNBOUND-VOTES", "other-revision"),
    ]);
    const result = await outcome(db, "P-UNBOUND-VOTES");
    assert.equal(result?.tally?.state, "unbound");
    assert.equal(result?.tally?.tally, undefined);
    assert.equal(result?.tally?.computedResult, undefined);
    assert.equal(result?.tally?.unboundVoteCount, 1);
  });

  it("distinguishes missing keys from unreadable votes and never shows zero", async () => {
    const db = createMemoryDb();
    await seed(db, "P-ENCRYPTED");
    await db.collection("proposal_votes").insertOne({
      ballotId: proposalBallotId("P-ENCRYPTED"),
      proposalId: "P-ENCRYPTED",
      revisionId: REVISION,
      voterBlindIndex: "blind-1",
      voteEnvelope: { keyId: "k1", iv: "iv", ciphertext: "cipher", tag: "tag" },
      updatedAt: NOW,
    });

    const noKeys = await outcome(db, "P-ENCRYPTED");
    assert.equal(noKeys?.tally?.state, "decryption-unavailable");
    assert.equal(noKeys?.tally?.tally, undefined);

    const cryptoConfig: BallotCryptoConfig = {
      mode: "encrypt",
      activeEncryptionKeyId: "k1",
      encryptionKeys: new Map([["k1", Buffer.alloc(32, 1)]]),
      activeBlindIndexKeyId: "b1",
      blindIndexKeys: new Map([["b1", Buffer.alloc(32, 2)]]),
    };
    const unreadable = await outcome(db, "P-ENCRYPTED", { cryptoConfig });
    assert.equal(unreadable?.tally?.state, "unreadable");
    assert.equal(unreadable?.tally?.tally, undefined);
    assert.equal(unreadable?.tally?.unreadableVoteCount, 1);
  });

  it("keeps a failed quorum distinct from an unsuccessful majority", async () => {
    const db = createMemoryDb();
    await seed(db, "P-QUORUM", { ballotClosesAt: RECENTLY_CLOSED });
    await db.collection(BALLOT_QUORUM_COLLECTION).insertOne({
      ballotId: proposalBallotId("P-QUORUM"),
      matterId: "P-QUORUM",
      revisionId: REVISION,
      ruleVersion: "two-tier-quorum-v1",
      status: "evaluated",
      closedAt: RECENTLY_CLOSED,
      recordedAt: NOW,
      verdict: "inconclusive",
      quorumMet: false,
      participatingMembers: 5,
      activeWindowDays: 90,
    });
    await db.collection("ballot_results").insertOne({
      decisionEventId: "DEC-2",
      ballotId: proposalBallotId("P-QUORUM"),
      proposalId: "P-QUORUM",
      matterId: "P-QUORUM",
      revisionId: REVISION,
      result: "inconclusive",
      computedResult: "unsuccessful",
      ruleBasis: "two-tier-quorum-simple-majority-v1",
      recordedBy: "officer-1",
      recordedAt: NOW,
    });

    const result = await outcome(db, "P-QUORUM");
    assert.equal(result?.recorded?.record.result, "inconclusive");
    assert.equal(result?.recorded?.resultLabel, "Inconclusive");
    assert.equal(result?.recorded?.computedLabel, "Unsuccessful");
    assert.equal(
      result?.quorum?.status === "recorded" && result.quorum.record.quorumMet,
      false,
    );
  });

  it("names the missing quorum snapshot instead of inventing thresholds", async () => {
    const db = createMemoryDb();
    await seed(db, "P-NO-QUORUM", { ballotClosesAt: RECENTLY_CLOSED });
    const result = await outcome(db, "P-NO-QUORUM");
    assert.equal(result?.state, "closed");
    assert.equal(result?.quorum?.status, "missing");
    if (result?.quorum?.status === "missing") {
      assert.match(result.quorum.reason, /quorum closure record/i);
      assert.equal(result.quorum.ruleLabel, "Two-tier quorum, version 1");
      assert.equal("platformQuorumRequired" in result.quorum, false);
    }
  });

  it("keeps an override reason on the recorded result", async () => {
    const db = createMemoryDb();
    await seed(db, "P-OVERRIDE", { ballotClosesAt: RECENTLY_CLOSED });
    await db.collection("ballot_results").insertOne({
      decisionEventId: "DEC-3",
      ballotId: proposalBallotId("P-OVERRIDE"),
      proposalId: "P-OVERRIDE",
      matterId: "P-OVERRIDE",
      revisionId: REVISION,
      result: "successful",
      computedResult: "unsuccessful",
      ruleBasis: "two-tier-quorum-simple-majority-v1",
      override: { reason: "The returning officer reviewed the tally." },
      recordedBy: "officer-1",
      recordedAt: NOW,
    });
    const result = await outcome(db, "P-OVERRIDE");
    assert.equal(result?.recorded?.resultLabel, "Successful");
    assert.equal(result?.recorded?.computedLabel, "Unsuccessful");
    assert.equal(
      result?.recorded?.record.override?.reason,
      "The returning officer reviewed the tally.",
    );
  });

  it("leaves a pre-quorum closed ballot without a quorum view", async () => {
    const db = createMemoryDb();
    await seed(db, "P-PRE-QUORUM", { ballotClosesAt: BEFORE_RULE });
    const result = await outcome(db, "P-PRE-QUORUM");
    assert.equal(result?.state, "closed");
    assert.equal(result?.quorum, null);
  });

  it("does not preview zero participation for an uncountable open ballot", async () => {
    const db = createMemoryDb();
    await seed(db, "P-UNREADABLE-OPEN");
    await db.collection("proposal_votes").insertOne({
      ballotId: proposalBallotId("P-UNREADABLE-OPEN"),
      proposalId: "P-UNREADABLE-OPEN",
      revisionId: REVISION,
      voterBlindIndex: "blind-1",
      voteEnvelope: { keyId: "k1", iv: "iv", ciphertext: "cipher", tag: "tag" },
      updatedAt: NOW,
    });

    const result = await outcome(db, "P-UNREADABLE-OPEN");
    assert.equal(result?.state, "open");
    assert.equal(result?.tally?.state, "decryption-unavailable");
    assert.equal(result?.tally?.tally, undefined);
    assert.equal(
      result?.tally?.unreadableVoteCount,
      0,
      "votes were not read, so they must not be counted as unreadable either",
    );
    assert.equal(result?.quorum?.status, "preview-unavailable");
    if (result?.quorum?.status === "preview-unavailable") {
      assert.match(result.quorum.reason, /cannot be counted/i);
      assert.equal(typeof result.quorum.requirements.ballotQuorumRequired, "number");
    }

    // The invariant covers the whole outcome, not just the tally field.
    const serialised = JSON.stringify(result);
    assert.equal(serialised.includes("participationCount"), false);
    assert.equal(serialised.includes('"quorumMet"'), false);
  });

  it("does not preview zero participation when open-ballot votes are unbound", async () => {
    const db = createMemoryDb();
    await seed(db, "P-UNBOUND-OPEN");
    await insertMany(db, "proposal_votes", [
      castVoteDoc("P-UNBOUND-OPEN", "other-revision"),
    ]);
    const result = await outcome(db, "P-UNBOUND-OPEN");
    assert.equal(result?.state, "open");
    assert.equal(result?.tally?.state, "unbound");
    assert.equal(result?.quorum?.status, "preview-unavailable");
    if (result?.quorum?.status === "preview-unavailable") {
      assert.match(result.quorum.reason, /not bound/i);
    }
  });

  it("rejects a ballot id it cannot resolve independently of the proposal", async () => {
    const db = createMemoryDb();
    await seed(db, "P-OTHER-BALLOT");
    await assert.rejects(
      () => outcome(db, "P-OTHER-BALLOT", { ballotId: "some-other-ballot" }),
      /only the matter's primary ballot/i,
    );
    const primary = await outcome(db, "P-OTHER-BALLOT", {
      ballotId: proposalBallotId("P-OTHER-BALLOT"),
    });
    assert.equal(primary?.state, "open");
  });

  it("returns null only when the proposal does not exist", async () => {
    const db = createMemoryDb();
    assert.equal(await outcome(db, "MISSING"), null);
  });
});
