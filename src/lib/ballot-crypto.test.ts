import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import {
  BallotCryptoError,
  computeVoterBlindIndex,
  decryptVotePayload,
  encryptVotePayload,
  generateBallotKeyHex,
  loadBallotCryptoConfig,
} from "./ballot-crypto.ts";
import { migrateEncryptedVotes } from "./ballot-encryption-migration.ts";
import { castVote, getProposalDetail } from "./store.ts";
import { PROPOSAL_VOTES, ensureProposalVoteIndex, proposalBallotId } from "./vote-storage.ts";
import type { SessionUser } from "./types.ts";

const uri = process.env.VOTING_TEST_MONGODB_URI;

function makeTestKeys() {
  return {
    encV1: generateBallotKeyHex(),
    encV2: generateBallotKeyHex(),
    biV1: generateBallotKeyHex(),
  };
}

test("ballot crypto rejects key reuse, short keys, and missing keys when enabled", () => {
  const same = generateBallotKeyHex();
  assert.throws(
    () =>
      loadBallotCryptoConfig({
        BALLOT_ENCRYPTION_MODE: "encrypt",
        BALLOT_ENCRYPTION_KEYS: `v1:${same}`,
        BALLOT_BLIND_INDEX_KEY: `bi-v1:${same}`,
      }),
    (err: unknown) =>
      err instanceof BallotCryptoError && err.code === "KEY_REUSE_FORBIDDEN",
  );

  assert.throws(
    () =>
      loadBallotCryptoConfig({
        BALLOT_ENCRYPTION_MODE: "encrypt",
        BALLOT_ENCRYPTION_KEYS: "v1:deadbeef",
        BALLOT_BLIND_INDEX_KEY: `bi-v1:${same}`,
      }),
    (err: unknown) =>
      err instanceof BallotCryptoError && err.code === "INVALID_KEY_LENGTH",
  );

  assert.throws(
    () =>
      loadBallotCryptoConfig({
        BALLOT_ENCRYPTION_MODE: "encrypt",
      }),
    (err: unknown) =>
      err instanceof BallotCryptoError && err.code === "MISSING_KEYS",
  );

  assert.equal(loadBallotCryptoConfig({ BALLOT_ENCRYPTION_MODE: "off" }), null);
});

test("blind index is deterministic per ballot+member and unlinkable across ballots", () => {
  const { encV1, biV1 } = makeTestKeys();
  const config = loadBallotCryptoConfig({
    BALLOT_ENCRYPTION_MODE: "encrypt",
    BALLOT_ENCRYPTION_KEYS: `v1:${encV1}`,
    BALLOT_BLIND_INDEX_KEY: `bi-v1:${biV1}`,
  })!;
  const biKey = config.blindIndexKeys.get(config.activeBlindIndexKeyId)!;

  const idx1 = computeVoterBlindIndex(biKey, "proposal:P1", "member-123");
  const idx1Repeat = computeVoterBlindIndex(biKey, "proposal:P1", "member-123");
  const idx2 = computeVoterBlindIndex(biKey, "proposal:P2", "member-123");
  const idxOther = computeVoterBlindIndex(biKey, "proposal:P1", "member-456");

  assert.equal(idx1, idx1Repeat);
  assert.equal(idx1.length, 64);
  assert.notEqual(idx1, idx2);
  assert.notEqual(idx1, idxOther);
});

test("AES-256-GCM envelope prevents tampering, cross-ballot, cross-revision, and cross-voter substitution", () => {
  const { encV1, encV2, biV1 } = makeTestKeys();
  const config = loadBallotCryptoConfig({
    BALLOT_ENCRYPTION_MODE: "encrypt",
    BALLOT_ENCRYPTION_KEYS: `v1:${encV1}`,
    BALLOT_BLIND_INDEX_KEY: `bi-v1:${biV1}`,
  })!;
  const biKey = config.blindIndexKeys.get(config.activeBlindIndexKeyId)!;
  const voterBlindIndex = computeVoterBlindIndex(biKey, "proposal:P1", "member-1");
  const ctx = {
    ballotId: "proposal:P1",
    proposalId: "P1",
    revisionId: "rev-1",
    voterBlindIndex,
  };

  const envelope = encryptVotePayload(
    config,
    { choice: "approve", reason: "Supports renewable grid transition." },
    ctx,
  );
  const decoded = decryptVotePayload(config, envelope, ctx);
  assert.deepEqual(decoded, {
    choice: "approve",
    reason: "Supports renewable grid transition.",
  });

  // Tampered ciphertext
  const ctBuf = Buffer.from(envelope.ct, "base64");
  ctBuf[0] = ctBuf[0]! ^ 0xff;
  assert.throws(
    () =>
      decryptVotePayload(
        config,
        { ...envelope, ct: ctBuf.toString("base64") },
        ctx,
      ),
    (err: unknown) =>
      err instanceof BallotCryptoError && err.code === "DECRYPTION_FAILED",
  );

  // Cross-ballot substitution
  assert.throws(
    () =>
      decryptVotePayload(config, envelope, {
        ...ctx,
        ballotId: "proposal:P2",
        proposalId: "P2",
      }),
    /failed authentication/,
  );

  // Cross-revision substitution
  assert.throws(
    () =>
      decryptVotePayload(config, envelope, {
        ...ctx,
        revisionId: "rev-2",
      }),
    /failed authentication/,
  );

  // Cross-voter substitution
  assert.throws(
    () =>
      decryptVotePayload(config, envelope, {
        ...ctx,
        voterBlindIndex: computeVoterBlindIndex(biKey, "proposal:P1", "member-2"),
      }),
    /failed authentication/,
  );

  // Key mismatch
  const wrongKeyConfig = loadBallotCryptoConfig({
    BALLOT_ENCRYPTION_MODE: "encrypt",
    BALLOT_ENCRYPTION_KEYS: `v1:${encV2}`,
    BALLOT_BLIND_INDEX_KEY: `bi-v1:${biV1}`,
  })!;
  assert.throws(
    () => decryptVotePayload(wrongKeyConfig, envelope, ctx),
    /failed authentication/,
  );
});

test(
  "MongoDB encrypted voting omits plaintext identity/choice, handles concurrency, migrates legacy votes, and rotates keys",
  { skip: !uri },
  async () => {
    const client = new MongoClient(uri!);
    await client.connect();
    const dbName = `engage_crypto_${randomUUID().slice(0, 8)}`;
    const db = client.db(dbName);
    const { encV1, encV2, biV1 } = makeTestKeys();

    const envV1 = {
      BALLOT_ENCRYPTION_MODE: "encrypt",
      BALLOT_ENCRYPTION_KEYS: `v1:${encV1}`,
      BALLOT_BLIND_INDEX_KEY: `bi-v1:${biV1}`,
    };
    const prevEnv = {
      BALLOT_ENCRYPTION_MODE: process.env.BALLOT_ENCRYPTION_MODE,
      BALLOT_ENCRYPTION_KEYS: process.env.BALLOT_ENCRYPTION_KEYS,
      BALLOT_BLIND_INDEX_KEY: process.env.BALLOT_BLIND_INDEX_KEY,
    };
    Object.assign(process.env, envV1);

    try {
      await ensureProposalVoteIndex(db);
      await db.collection("branches").insertOne({
        branchId: "branch-nat",
        name: "Fusion National",
        kind: "national",
        recognised: true,
      });
      await db.collection("proposals").insertOne({
        proposalId: "PROP-ENC-1",
        slug: "prop-enc-1",
        title: "Encrypted Ballot Test Proposal",
        summary: "Verify encrypted vote storage and blind indexing.",
        details: "Full details for encrypted ballot test.",
        outcomes: ["Encrypted storage"],
        space: "National",
        stage: "decide",
        kind: "policy",
        ballotRevisionId: "rev-enc-1",
        publicationScope: "national",
        jurisdictionBranchId: "branch-nat",
        governanceAuthorityBranchId: "branch-nat",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.collection("proposal_revisions").insertOne({
        revisionId: "rev-enc-1",
        proposalId: "PROP-ENC-1",
        parentRevisionId: null,
        authorId: "admin-1",
        createdAt: new Date(),
        snapshot: {
          title: "Encrypted Ballot Test Proposal",
          summary: "Verify encrypted vote storage and blind indexing.",
          outcomes: ["Encrypted storage"],
          details: "Full details for encrypted ballot test.",
        },
        contentHash: "hash-enc-1",
      });

      const memberA: SessionUser = {
        memberId: "member-enc-a",
        name: "Alice Voter",
        email: "alice@example.test",
        role: "member",
        status: "verified",
        canParticipate: true,
        isStaff: false,
        isAdmin: false,
        verifiedBranchIds: ["branch-nat"],
      };
      const memberB: SessionUser = {
        ...memberA,
        memberId: "member-enc-b",
        name: "Bob Voter",
        email: "bob@example.test",
      };
      await db.collection("branch_memberships").insertMany([
        { branchId: "branch-nat", memberId: memberA.memberId, status: "active" },
        { branchId: "branch-nat", memberId: memberB.memberId, status: "active" },
      ]);

      // Concurrent submissions by same member must converge to 1 vote record
      await Promise.all([
        castVote(db, memberA, { proposalId: "PROP-ENC-1", choice: "approve", reason: "First" }, envV1),
        castVote(db, memberA, { proposalId: "PROP-ENC-1", choice: "reject", reason: "Changed mind" }, envV1),
      ]);
      await castVote(db, memberB, { proposalId: "PROP-ENC-1", choice: "abstain", reason: "Neutral" }, envV1);

      const rawDocs = await db.collection(PROPOSAL_VOTES).find({}).toArray();
      assert.equal(rawDocs.length, 2);
      for (const doc of rawDocs) {
        assert.equal(doc.memberId, undefined, "memberId must not be stored in plaintext");
        assert.equal(doc.authorName, undefined, "authorName must not be stored in plaintext");
        assert.equal(doc.choice, undefined, "choice must not be stored in plaintext");
        assert.equal(doc.reason, undefined, "reason must not be stored in plaintext");
        assert.equal(typeof doc.voterBlindIndex, "string");
        assert.equal(doc.voteEnvelope?.v, 1);
        assert.equal(doc.voteEnvelope?.kid, "v1");
      }

      const detailA = await getProposalDetail(db, "PROP-ENC-1", memberA);
      assert.ok(detailA);
      assert.equal(detailA.proposal.votes.total, 2);
      assert.ok(detailA.myVote === "approve" || detailA.myVote === "reject");

      // Legacy plaintext vote migration + key rotation
      await db.collection(PROPOSAL_VOTES).insertOne({
        ballotId: proposalBallotId("PROP-ENC-1"),
        proposalId: "PROP-ENC-1",
        revisionId: "rev-enc-1",
        memberId: "member-legacy-c",
        authorName: "Carol Legacy",
        choice: "approve",
        reason: "Legacy plaintext vote",
        updatedAt: new Date(),
      });

      const rotatedEnv = {
        BALLOT_ENCRYPTION_MODE: "encrypt",
        BALLOT_ENCRYPTION_KEYS: `v2:${encV2},v1:${encV1}`,
        BALLOT_ENCRYPTION_ACTIVE_KEY_ID: "v2",
        BALLOT_BLIND_INDEX_KEY: `bi-v1:${biV1}`,
      };
      const rotatedConfig = loadBallotCryptoConfig(rotatedEnv)!;

      // Dry-run must not modify anything
      const dryRun = await migrateEncryptedVotes(db, rotatedConfig, { apply: false, rotate: true });
      assert.equal(dryRun.applied, false);
      assert.equal(dryRun.before.plaintextCount, 1);
      assert.equal(dryRun.before.encryptedCount, 2);
      assert.equal(dryRun.before.rotationCandidateCount, 2);

      // Apply migration + rotation
      const applied = await migrateEncryptedVotes(db, rotatedConfig, { apply: true, rotate: true });
      assert.equal(applied.applied, true);
      assert.equal(applied.migratedCount, 1);
      assert.equal(applied.rotatedCount, 2);
      assert.equal(applied.after.plaintextCount, 0);
      assert.equal(applied.after.encryptedCount, 3);
      assert.equal(applied.after.rotationCandidateCount, 0);

      // Idempotent re-run
      const rerun = await migrateEncryptedVotes(db, rotatedConfig, { apply: true, rotate: true });
      assert.equal(rerun.migratedCount, 0);
      assert.equal(rerun.rotatedCount, 0);
      assert.equal(rerun.after.encryptedCount, 3);

      // Verify all envelopes now use v2 and have no plaintext PII/choice
      const afterDocs = await db.collection(PROPOSAL_VOTES).find({}).toArray();
      assert.equal(afterDocs.length, 3);
      for (const doc of afterDocs) {
        assert.equal(doc.voteEnvelope?.kid, "v2");
        assert.equal(doc.memberId, undefined);
        assert.equal(doc.choice, undefined);
      }
    } finally {
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await db.dropDatabase();
      await client.close();
    }
  },
);
