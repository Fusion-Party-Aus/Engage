import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { MongoClient, type Db } from "mongodb";
import { loadBallotCryptoConfig, generateBallotKeyHex } from "./ballot-crypto.ts";
import {
  BALLOT_OUTCOME_RULE_BASIS,
  BallotDomainError,
  FORMAL_DECISIONS_COLLECTION,
  readBoundBallotTallies,
  recordFormalDecision,
  upsertMatterBallot,
} from "./ballots.ts";
import { GOVERNANCE_EVENTS_COLLECTION } from "./governance-relationships.ts";
import { closeDatabase } from "./db.ts";
import { castVote } from "./store.ts";
import type { PlatformEnv, SessionUser, VoteChoice } from "./types.ts";
import { PROPOSAL_VOTES, proposalBallotId } from "./vote-storage.ts";
import { POST as recordResultRoute } from "../pages/api/admin/ballots/result.ts";

// These cases prove persistence, certification atomicity and the stored evidence
// shape, so they run against a real MongoDB replica set. Start one and set
// VOTING_TEST_MONGODB_URI (the full suite expects it) to run them.
const mongoUri = process.env.VOTING_TEST_MONGODB_URI;

const memberUser = (memberId: string): SessionUser => ({
  memberId,
  name: `Member ${memberId}`,
  email: `${memberId}@example.test`,
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
});

const futureDate = () => new Date(Date.now() + 7 * 86400_000);

async function seedBallot(db: Db, proposalId: string): Promise<string> {
  const now = new Date();
  await db.collection("proposals").insertOne({
    proposalId,
    slug: proposalId.toLowerCase(),
    title: `Outcome validation ${proposalId}`,
    space: "Governance",
    summary: "Bound ballot for computed outcome validation.",
    details: "",
    stage: "decide",
    ballotRevisionId: "rev-1",
    ballotClosesAt: futureDate(),
    createdAt: now,
    updatedAt: now,
  });
  await db.collection("proposal_revisions").insertOne({
    proposalId,
    revisionId: "rev-1",
    parentRevisionId: null,
    createdAt: now,
    snapshot: {
      title: `Outcome validation ${proposalId}`,
      summary: "Bound ballot for computed outcome validation.",
      details: "",
    },
    contentHash: `hash-${proposalId}`,
  });
  await upsertMatterBallot(db, {
    matterId: proposalId,
    revisionId: "rev-1",
    status: "open",
  });
  return proposalBallotId(proposalId);
}

async function castChoices(
  db: Db,
  proposalId: string,
  choices: VoteChoice[],
  env?: Partial<PlatformEnv>,
): Promise<void> {
  for (const [index, choice] of choices.entries()) {
    await castVote(
      db,
      memberUser(`member-${proposalId}-${index}`),
      { proposalId, choice },
      env,
    );
  }
}

/** Close the ballot exactly as the scheduler does, so certification is allowed. */
async function closeBallot(db: Db, proposalId: string): Promise<void> {
  const now = new Date();
  await db
    .collection("proposals")
    .updateOne({ proposalId }, { $set: { ballotClosedAt: now } });
  await db
    .collection("ballots")
    .updateOne(
      { ballotId: proposalBallotId(proposalId) },
      { $set: { status: "closed", updatedAt: now } },
    );
}

describe(
  "computed ballot outcome validation (real MongoDB replica set)",
  { skip: !mongoUri },
  () => {
    let client: MongoClient;
    let db: Db;

    before(async () => {
      client = await new MongoClient(mongoUri!).connect();
      db = client.db(
        `engage_ballot_outcome_test_${crypto.randomUUID().replaceAll("-", "")}`,
      );
    });

    after(async () => {
      // The API route resolves its own application database client.
      await closeDatabase();
      await db?.dropDatabase();
      await client?.close();
    });

    it("computes approval from bound votes and records the tally and rule basis", async () => {
      const proposalId = "PROP-APPROVED";
      await seedBallot(db, proposalId);
      await castChoices(db, proposalId, [
        "approve",
        "approve",
        "approve",
        "reject",
        "abstain",
        "abstain",
      ]);
      await closeBallot(db, proposalId);

      const record = await recordFormalDecision(db, {
        matterId: proposalId,
        revisionId: "rev-1",
        result: "successful",
        decisionEventId: "BALLOT-APPROVED",
        recordedBy: "admin-1",
      });

      assert.equal(record.result, "successful");
      assert.equal(record.computedResult, "successful");
      assert.equal(record.ruleBasis, BALLOT_OUTCOME_RULE_BASIS);
      assert.deepEqual(record.tally, {
        approve: 3,
        abstain: 2,
        reject: 1,
        total: 6,
      });
      assert.equal(record.override, undefined);

      const stored = await db
        .collection(FORMAL_DECISIONS_COLLECTION)
        .findOne({ ballotId: proposalBallotId(proposalId) });
      assert.equal(stored?.computedResult, "successful");
      assert.equal(stored?.ruleBasis, BALLOT_OUTCOME_RULE_BASIS);
      assert.equal((stored?.tally as { approve: number }).approve, 3);

      const ballot = await db
        .collection("ballots")
        .findOne({ ballotId: proposalBallotId(proposalId) });
      assert.equal(ballot?.status, "certified");

      const event = await db
        .collection(GOVERNANCE_EVENTS_COLLECTION)
        .findOne({ matterId: proposalId, eventType: "decision.recorded" });
      assert.equal(event?.actorId, "admin-1");
      assert.deepEqual(event?.metadata, {
        result: "successful",
        computedResult: "successful",
        tally: { approve: 3, abstain: 2, reject: 1, total: 6 },
        ruleBasis: BALLOT_OUTCOME_RULE_BASIS,
      });
      assert.equal(event?.reason, undefined);
    });

    it("computes rejection, a tie and zero votes as unsuccessful", async () => {
      const majorityNo = "PROP-REJECTED";
      await seedBallot(db, majorityNo);
      await castChoices(db, majorityNo, ["approve", "reject", "reject", "abstain"]);
      await closeBallot(db, majorityNo);
      const rejected = await recordFormalDecision(db, {
        matterId: majorityNo,
        revisionId: "rev-1",
        result: "unsuccessful",
        decisionEventId: "BALLOT-REJECTED",
        recordedBy: "admin-1",
      });
      assert.equal(rejected.computedResult, "unsuccessful");

      const tied = "PROP-TIED";
      await seedBallot(db, tied);
      await castChoices(db, tied, ["approve", "approve", "reject", "reject"]);
      await closeBallot(db, tied);
      const tie = await recordFormalDecision(db, {
        matterId: tied,
        revisionId: "rev-1",
        result: "unsuccessful",
        decisionEventId: "BALLOT-TIED",
        recordedBy: "admin-1",
      });
      assert.equal(tie.computedResult, "unsuccessful");
      assert.equal(tie.tally?.approve, 2);
      assert.equal(tie.tally?.reject, 2);

      const noVotes = "PROP-NO-VOTES";
      await seedBallot(db, noVotes);
      await closeBallot(db, noVotes);
      const empty = await recordFormalDecision(db, {
        matterId: noVotes,
        revisionId: "rev-1",
        result: "unsuccessful",
        decisionEventId: "BALLOT-NO-VOTES",
        recordedBy: "admin-1",
      });
      assert.equal(empty.computedResult, "unsuccessful");
      assert.deepEqual(empty.tally, {
        approve: 0,
        abstain: 0,
        reject: 0,
        total: 0,
      });
    });

    it("refuses a contradicting result without a written reason", async () => {
      const proposalId = "PROP-CONTRADICTION";
      await seedBallot(db, proposalId);
      await castChoices(db, proposalId, ["approve", "approve", "reject"]);
      await closeBallot(db, proposalId);

      await assert.rejects(
        recordFormalDecision(db, {
          matterId: proposalId,
          revisionId: "rev-1",
          result: "unsuccessful",
          decisionEventId: "BALLOT-CONTRADICTION",
          recordedBy: "admin-1",
        }),
        (error: unknown) =>
          error instanceof BallotDomainError &&
          error.code === "RESULT_OVERRIDE_REASON_REQUIRED" &&
          /compute[sd]?.*successful/i.test(error.message),
      );
      // A blank reason is not a reason.
      await assert.rejects(
        recordFormalDecision(db, {
          matterId: proposalId,
          revisionId: "rev-1",
          result: "unsuccessful",
          decisionEventId: "BALLOT-CONTRADICTION",
          overrideReason: "   ",
          recordedBy: "admin-1",
        }),
        (error: unknown) =>
          error instanceof BallotDomainError &&
          error.code === "RESULT_OVERRIDE_REASON_REQUIRED",
      );
      // Nothing was written, so the ballot stays closed but uncertified.
      assert.equal(
        await db
          .collection(FORMAL_DECISIONS_COLLECTION)
          .countDocuments({ ballotId: proposalBallotId(proposalId) }),
        0,
      );
      assert.equal(
        (await db.collection("ballots").findOne({
          ballotId: proposalBallotId(proposalId),
        }))?.status,
        "closed",
      );
    });

    it("records a contradicting result only as an audited override with a reason", async () => {
      const proposalId = "PROP-OVERRIDE";
      await seedBallot(db, proposalId);
      await castChoices(db, proposalId, ["approve", "reject", "reject"]);
      await closeBallot(db, proposalId);

      const record = await recordFormalDecision(db, {
        matterId: proposalId,
        revisionId: "rev-1",
        result: "successful",
        decisionEventId: "BALLOT-OVERRIDE",
        recordedBy: "admin-1",
        overrideReason: "The Returning Officer upheld three disputed ballots.",
      });

      assert.equal(record.result, "successful");
      assert.equal(record.computedResult, "unsuccessful");
      assert.equal(record.override?.by, "admin-1");
      assert.equal(
        record.override?.reason,
        "The Returning Officer upheld three disputed ballots.",
      );
      assert.ok(record.override?.at instanceof Date);

      const event = await db
        .collection(GOVERNANCE_EVENTS_COLLECTION)
        .findOne({ matterId: proposalId, eventType: "decision.recorded" });
      assert.equal(event?.actorId, "admin-1");
      assert.equal(
        event?.reason,
        "The Returning Officer upheld three disputed ballots.",
      );
      assert.equal(
        (event?.metadata as Record<string, unknown>)?.computedResult,
        "unsuccessful",
      );
      assert.equal((event?.metadata as Record<string, unknown>)?.result, "successful");
      assert.deepEqual(
        (event?.metadata as { override?: unknown }).override,
        {
          by: "admin-1",
          reason: "The Returning Officer upheld three disputed ballots.",
        },
      );
    });

    it("keeps identical retries idempotent and refuses a conflicting replacement", async () => {
      const proposalId = "PROP-IDEMPOTENT";
      await seedBallot(db, proposalId);
      await castChoices(db, proposalId, ["approve", "approve", "reject"]);
      await closeBallot(db, proposalId);

      const payload = {
        matterId: proposalId,
        revisionId: "rev-1",
        result: "successful" as const,
        decisionEventId: "BALLOT-IDEMPOTENT",
        recordedBy: "admin-1",
      };
      const first = await recordFormalDecision(db, payload);
      const retry = await recordFormalDecision(db, payload);

      assert.deepEqual(retry, first);
      assert.equal(
        await db
          .collection(FORMAL_DECISIONS_COLLECTION)
          .countDocuments({ proposalId }),
        1,
      );
      assert.equal(
        await db
          .collection(GOVERNANCE_EVENTS_COLLECTION)
          .countDocuments({ matterId: proposalId, eventType: "decision.recorded" }),
        1,
      );

      await assert.rejects(
        recordFormalDecision(db, {
          ...payload,
          result: "unsuccessful",
          decisionEventId: "BALLOT-IDEMPOTENT-2",
        }),
        (error: unknown) =>
          error instanceof BallotDomainError &&
          error.code === "DECISION_ALREADY_RECORDED",
      );
      const stored = await db
        .collection(FORMAL_DECISIONS_COLLECTION)
        .findOne({ proposalId });
      assert.equal(stored?.result, "successful");
      assert.equal(stored?.decisionEventId, "BALLOT-IDEMPOTENT");
    });

    it("certifies encrypted ballots from their decrypted votes", async () => {
      const env: Partial<PlatformEnv> = {
        BALLOT_ENCRYPTION_MODE: "encrypt",
        BALLOT_ENCRYPTION_KEYS: `v1:${generateBallotKeyHex()}`,
        BALLOT_BLIND_INDEX_KEY: `bi-v1:${generateBallotKeyHex()}`,
      };
      const proposalId = "PROP-ENCRYPTED";
      await seedBallot(db, proposalId);
      await castChoices(db, proposalId, ["approve", "approve", "reject"], env);
      await closeBallot(db, proposalId);

      const storedVotes = await db
        .collection(PROPOSAL_VOTES)
        .find({ ballotId: proposalBallotId(proposalId) })
        .toArray();
      assert.equal(storedVotes.length, 3);
      for (const vote of storedVotes) {
        assert.ok(vote.voteEnvelope, "vote must be stored encrypted");
        assert.equal(vote.choice, undefined, "no plaintext choice is stored");
      }

      const record = await recordFormalDecision(db, {
        matterId: proposalId,
        revisionId: "rev-1",
        result: "successful",
        decisionEventId: "BALLOT-ENCRYPTED",
        recordedBy: "admin-1",
        cryptoConfig: loadBallotCryptoConfig(env),
      });
      assert.equal(record.computedResult, "successful");
      assert.deepEqual(record.tally, {
        approve: 2,
        abstain: 0,
        reject: 1,
        total: 3,
      });
    });

    it("leaves an officer-recorded historical result readable and unrewritten", async () => {
      const proposalId = "PROP-HISTORICAL";
      await seedBallot(db, proposalId);
      await castChoices(db, proposalId, ["approve"]);

      const recordedAt = new Date("2026-11-01T00:00:00Z");
      await db.collection(FORMAL_DECISIONS_COLLECTION).insertOne({
        decisionEventId: "BALLOT-HISTORICAL",
        ballotId: proposalBallotId(proposalId),
        proposalId,
        matterId: proposalId,
        revisionId: "rev-1",
        result: "unsuccessful",
        recordedBy: "former-officer",
        recordedAt,
      });

      const retried = await recordFormalDecision(db, {
        matterId: proposalId,
        revisionId: "rev-1",
        result: "unsuccessful",
        decisionEventId: "BALLOT-HISTORICAL",
        recordedBy: "former-officer",
      });
      assert.equal(retried.result, "unsuccessful");
      assert.equal(retried.recordedBy, "former-officer");
      assert.equal(retried.computedResult, undefined);
      assert.equal(retried.tally, undefined);

      const stored = await db
        .collection(FORMAL_DECISIONS_COLLECTION)
        .findOne({ proposalId });
      assert.equal(stored?.result, "unsuccessful");
      assert.equal(stored?.computedResult, undefined);
      assert.equal(stored?.override, undefined);
      assert.equal(
        await db
          .collection(FORMAL_DECISIONS_COLLECTION)
          .countDocuments({ proposalId }),
        1,
      );
    });

    it("serves the computed check through the result API and requires the override reason", async () => {
      const proposalId = "PROP-ROUTE";
      await seedBallot(db, proposalId);
      await castChoices(db, proposalId, ["approve", "approve", "reject"]);
      await closeBallot(db, proposalId);

      const env: PlatformEnv = {
        APP_MODE: "test",
        MONGODB_URI: mongoUri,
        MONGODB_DB_NAME: db.databaseName,
      };
      const call = (body: Record<string, unknown>, cookie: string) =>
        recordResultRoute({
          request: new Request("http://localhost/api/admin/ballots/result", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
          locals: { runtime: { env } },
        } as never);

      let response = await call(
        {
          proposalId,
          result: "unsuccessful",
          decisionEventId: "BALLOT-ROUTE",
        },
        "engage_dev_user=member",
      );
      assert.equal(response.status, 403);

      response = await call(
        {
          proposalId,
          result: "unsuccessful",
          decisionEventId: "BALLOT-ROUTE",
        },
        "engage_dev_user=administrator",
      );
      assert.equal(response.status, 409);
      assert.match(
        String(((await response.json()) as { error?: string }).error),
        /compute[sd]?.*successful/i,
      );

      response = await call(
        {
          proposalId,
          result: "unsuccessful",
          decisionEventId: "BALLOT-ROUTE",
          overrideReason: "Returning Officer direction after a recount.",
        },
        "engage_dev_user=administrator",
      );
      assert.equal(response.status, 201);
      const payload = (await response.json()) as {
        result: Record<string, unknown>;
      };
      assert.equal(payload.result.computedResult, "successful");
      assert.equal(payload.result.result, "unsuccessful");
      assert.equal(payload.result.ruleBasis, BALLOT_OUTCOME_RULE_BASIS);
      const override = payload.result.override as {
        reason: string;
        by: string;
        at: string;
      };
      assert.equal(override.reason, "Returning Officer direction after a recount.");
      assert.equal(override.by, "dev-admin-01");
      assert.match(override.at, /^\d{4}-\d{2}-\d{2}T/);
    });

    it("refuses to certify an open ballot and certifies the closed tally instead", async () => {
      const proposalId = "PROP-STILL-OPEN";
      await seedBallot(db, proposalId);
      await castChoices(db, proposalId, ["approve", "approve", "reject"]);

      await assert.rejects(
        recordFormalDecision(db, {
          matterId: proposalId,
          revisionId: "rev-1",
          result: "successful",
          decisionEventId: "BALLOT-STILL-OPEN",
          recordedBy: "admin-1",
        }),
        (error: unknown) =>
          error instanceof BallotDomainError &&
          error.code === "BALLOT_NOT_CLOSED" &&
          /still accept votes/i.test(error.message),
      );
      assert.equal(
        await db
          .collection(FORMAL_DECISIONS_COLLECTION)
          .countDocuments({ proposalId }),
        0,
      );

      // A vote cast after the attempted certification changes the outcome, which
      // is exactly why an open ballot cannot be certified.
      await castVote(db, memberUser("late-voter"), {
        proposalId,
        choice: "reject",
      });
      await closeBallot(db, proposalId);

      await assert.rejects(
        recordFormalDecision(db, {
          matterId: proposalId,
          revisionId: "rev-1",
          result: "successful",
          decisionEventId: "BALLOT-STILL-OPEN",
          recordedBy: "admin-1",
        }),
        (error: unknown) =>
          error instanceof BallotDomainError &&
          error.code === "RESULT_OVERRIDE_REASON_REQUIRED",
      );
      const recorded = await recordFormalDecision(db, {
        matterId: proposalId,
        revisionId: "rev-1",
        result: "unsuccessful",
        decisionEventId: "BALLOT-STILL-OPEN",
        recordedBy: "admin-1",
      });
      assert.equal(recorded.computedResult, "unsuccessful");
      assert.deepEqual(recorded.tally, {
        approve: 2,
        abstain: 0,
        reject: 2,
        total: 4,
      });
    });

    it("refuses a tally containing a vote bound to another revision", async () => {
      const proposalId = "PROP-DRIFTED";
      await seedBallot(db, proposalId);
      await castChoices(db, proposalId, ["approve", "approve", "reject"]);
      await closeBallot(db, proposalId);
      const ballotId = proposalBallotId(proposalId);
      await db.collection(PROPOSAL_VOTES).insertMany([
        {
          ballotId,
          proposalId,
          revisionId: "rev-0",
          memberId: "drifted-revision",
          choice: "reject",
          updatedAt: new Date(),
        },
        {
          ballotId,
          proposalId,
          memberId: "missing-revision",
          choice: "reject",
          updatedAt: new Date(),
        },
      ]);

      const summary = await readBoundBallotTallies(db, {
        ballots: [{ matterId: proposalId, revisionId: "rev-1" }],
        cryptoConfig: null,
      });
      assert.equal(summary.get(proposalId)?.state, "unbound");
      assert.equal(summary.get(proposalId)?.unboundVoteCount, 2);
      assert.equal(summary.get(proposalId)?.computedResult, undefined);

      await assert.rejects(
        recordFormalDecision(db, {
          matterId: proposalId,
          revisionId: "rev-1",
          result: "successful",
          decisionEventId: "BALLOT-DRIFTED",
          recordedBy: "admin-1",
        }),
        (error: unknown) =>
          error instanceof BallotDomainError &&
          error.code === "BALLOT_TALLY_UNBOUND_VOTES",
      );
      assert.equal(
        await db
          .collection(FORMAL_DECISIONS_COLLECTION)
          .countDocuments({ proposalId }),
        0,
      );
    });

    it("counts only the matter ballot, not amendment-ballot votes", async () => {
      const proposalId = "PROP-AMENDMENT-BALLOT";
      await seedBallot(db, proposalId);
      await castChoices(db, proposalId, ["approve", "reject"]);
      await closeBallot(db, proposalId);
      await db.collection(PROPOSAL_VOTES).insertMany(
        Array.from({ length: 4 }, (_, index) => ({
          ballotId: "amendment:AMD-1",
          proposalId,
          amendmentId: "AMD-1",
          revisionId: "rev-1",
          memberId: `amend-member-${index}`,
          choice: "approve",
          updatedAt: new Date(),
        })),
      );

      const record = await recordFormalDecision(db, {
        matterId: proposalId,
        revisionId: "rev-1",
        result: "unsuccessful",
        decisionEventId: "BALLOT-AMENDMENT",
        recordedBy: "admin-1",
      });
      assert.deepEqual(record.tally, {
        approve: 1,
        abstain: 0,
        reject: 1,
        total: 2,
      });
      assert.equal(record.computedResult, "unsuccessful");
    });

    it("refuses a tally containing an unreadable encrypted vote", async () => {
      const env: Partial<PlatformEnv> = {
        BALLOT_ENCRYPTION_MODE: "encrypt",
        BALLOT_ENCRYPTION_KEYS: `v1:${generateBallotKeyHex()}`,
        BALLOT_BLIND_INDEX_KEY: `bi-v1:${generateBallotKeyHex()}`,
      };
      const proposalId = "PROP-UNREADABLE";
      await seedBallot(db, proposalId);
      await castChoices(db, proposalId, ["approve", "approve", "reject"], env);
      await closeBallot(db, proposalId);

      const [vote] = await db
        .collection(PROPOSAL_VOTES)
        .find({ ballotId: proposalBallotId(proposalId) })
        .toArray();

      // Missing keys are a server fault, not a ballot fault.
      await assert.rejects(
        recordFormalDecision(db, {
          matterId: proposalId,
          revisionId: "rev-1",
          result: "successful",
          decisionEventId: "BALLOT-UNREADABLE",
          recordedBy: "admin-1",
          cryptoConfig: null,
        }),
        (error: unknown) =>
          error instanceof BallotDomainError &&
          error.code === "BALLOT_DECRYPTION_UNAVAILABLE" &&
          error.status === 503,
      );

      const raw = Buffer.from(String(vote.voteEnvelope.ct), "base64");
      raw[0] = raw[0]! ^ 0xff;
      await db.collection(PROPOSAL_VOTES).insertOne({
        ballotId: proposalBallotId(proposalId),
        proposalId,
        revisionId: "rev-1",
        voterBlindIndex: "tampered-blind-index",
        voteEnvelope: {
          ...vote.voteEnvelope,
          ct: raw.toString("base64"),
        },
        updatedAt: new Date(),
      });

      await assert.rejects(
        recordFormalDecision(db, {
          matterId: proposalId,
          revisionId: "rev-1",
          result: "successful",
          decisionEventId: "BALLOT-UNREADABLE",
          recordedBy: "admin-1",
          cryptoConfig: loadBallotCryptoConfig(env),
        }),
        (error: unknown) =>
          error instanceof BallotDomainError &&
          error.code === "BALLOT_TALLY_UNREADABLE",
      );
      const summary = await readBoundBallotTallies(db, {
        ballots: [{ matterId: proposalId, revisionId: "rev-1" }],
        cryptoConfig: loadBallotCryptoConfig(env),
      });
      assert.equal(summary.get(proposalId)?.state, "unreadable");
    });

    it("refuses an over-length override reason instead of truncating the audit record", async () => {
      const proposalId = "PROP-LONG-REASON";
      await seedBallot(db, proposalId);
      await castChoices(db, proposalId, ["approve", "reject", "reject"]);
      await closeBallot(db, proposalId);

      await assert.rejects(
        recordFormalDecision(db, {
          matterId: proposalId,
          revisionId: "rev-1",
          result: "successful",
          decisionEventId: "BALLOT-LONG-REASON",
          recordedBy: "admin-1",
          overrideReason: "x".repeat(1001),
        }),
        (error: unknown) =>
          error instanceof BallotDomainError &&
          error.code === "RESULT_OVERRIDE_REASON_TOO_LONG" &&
          error.status === 400,
      );
      assert.equal(
        await db
          .collection(FORMAL_DECISIONS_COLLECTION)
          .countDocuments({ proposalId }),
        0,
      );
    });

    it("refuses a retry that changes the recorded override reason", async () => {
      const proposalId = "PROP-REASON-RETRY";
      await seedBallot(db, proposalId);
      await castChoices(db, proposalId, ["approve", "reject", "reject"]);
      await closeBallot(db, proposalId);

      const payload = {
        matterId: proposalId,
        revisionId: "rev-1",
        result: "successful" as const,
        decisionEventId: "BALLOT-REASON-RETRY",
        recordedBy: "admin-1",
        overrideReason: "Returning Officer upheld the disputed ballots.",
      };
      const first = await recordFormalDecision(db, payload);
      assert.deepEqual(await recordFormalDecision(db, payload), first);

      await assert.rejects(
        recordFormalDecision(db, {
          ...payload,
          overrideReason: "A different reason after the fact.",
        }),
        (error: unknown) =>
          error instanceof BallotDomainError &&
          error.code === "DECISION_ALREADY_RECORDED",
      );
      const stored = await db
        .collection(FORMAL_DECISIONS_COLLECTION)
        .findOne({ proposalId });
      assert.equal(
        (stored?.override as { reason?: string } | undefined)?.reason,
        "Returning Officer upheld the disputed ballots.",
      );
      assert.equal(
        await db
          .collection(GOVERNANCE_EVENTS_COLLECTION)
          .countDocuments({ matterId: proposalId, eventType: "decision.recorded" }),
        1,
      );
    });
  },
);
