import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { MongoClient, type Db } from "mongodb";
import { generateBallotKeyHex, loadBallotCryptoConfig } from "./ballot-crypto.ts";
import {
  BALLOT_TALLIES,
  BALLOT_TALLY_INDEX,
  inspectBallotTallyProjection,
  readBallotTallyProjections,
} from "./ballot-tallies.ts";
import {
  FORMAL_DECISIONS_COLLECTION,
  recordFormalDecision,
  upsertMatterBallot,
} from "./ballots.ts";
import { castVote, listProposals } from "./store.ts";
import type { PlatformEnv, SessionUser } from "./types.ts";
import {
  PROPOSAL_VOTES,
  ensureVoteStorage,
  proposalBallotId,
} from "./vote-storage.ts";

// The projection is written after a vote transaction commits and is compared
// with the authoritative bound tally, so these cases need a real replica set.
const mongoUri = process.env.VOTING_TEST_MONGODB_URI;

const memberUser = (memberId: string): SessionUser => ({
  memberId,
  name: `Member ${memberId}`,
  email: `${memberId}@example.test`,
  role: "member",
  roles: ["member"],
  status: "verified",
  canParticipate: true,
  isStaff: false,
  isAdmin: false,
  branchAdminIds: [],
  activeBranchIds: ["branch-nat"],
});

const futureDate = () => new Date(Date.now() + 7 * 86400_000);

async function seedBallot(db: Db, proposalId: string): Promise<string> {
  const now = new Date();
  await db.collection("proposals").insertOne({
    proposalId,
    slug: proposalId.toLowerCase(),
    title: `Projection ballot ${proposalId}`,
    space: "Governance",
    summary: "Bound ballot for the tally projection.",
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
    createdAt: now,
    snapshot: { title: proposalId, summary: "", details: "" },
  });
  await upsertMatterBallot(db, {
    matterId: proposalId,
    revisionId: "rev-1",
    status: "open",
  });
  return proposalBallotId(proposalId);
}

async function projectionRow(db: Db, ballotId: string) {
  return db.collection(BALLOT_TALLIES).findOne({
    ballotId,
    revisionId: "rev-1",
  });
}

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
  "ballot tally projection (real MongoDB replica set)",
  { skip: !mongoUri },
  () => {
    let client: MongoClient;
    let db: Db;

    before(async () => {
      client = await new MongoClient(mongoUri!).connect();
      db = client.db(
        `engage_ballot_tally_test_${randomUUID().replaceAll("-", "")}`,
      );
      await ensureVoteStorage(db);
      await db
        .collection(BALLOT_TALLIES)
        .createIndex(
          { ballotId: 1, revisionId: 1 },
          { unique: true, name: BALLOT_TALLY_INDEX },
        );
    });

    after(async () => {
      await db?.dropDatabase();
      await client?.close();
    });

    it("projects a cast vote and matches the authoritative bound tally", async () => {
      const proposalId = "PROP-PROJECT-CAST";
      const ballotId = await seedBallot(db, proposalId);
      await castVote(db, memberUser("cast-1"), {
        proposalId,
        choice: "approve",
      });
      await castVote(db, memberUser("cast-2"), {
        proposalId,
        choice: "reject",
      });
      await castVote(db, memberUser("cast-3"), {
        proposalId,
        choice: "abstain",
      });

      const row = await projectionRow(db, ballotId);
      assert.deepEqual(
        {
          approve: row?.approve,
          abstain: row?.abstain,
          reject: row?.reject,
          total: row?.total,
        },
        { approve: 1, abstain: 1, reject: 1, total: 3 },
      );
      const read = await readBallotTallyProjections(db, [
        { ballotId, revisionId: "rev-1" },
      ]);
      assert.deepEqual(read.get(`${ballotId}\u0000rev-1`)?.tally, {
        approve: 1,
        abstain: 1,
        reject: 1,
        total: 3,
      });
    });

    it("moves a changed vote and never double counts the same choice", async () => {
      const proposalId = "PROP-PROJECT-CHANGE";
      const ballotId = await seedBallot(db, proposalId);
      const voter = memberUser("change-1");
      await castVote(db, voter, { proposalId, choice: "approve" });
      await castVote(db, voter, { proposalId, choice: "approve" });
      let row = await projectionRow(db, ballotId);
      assert.deepEqual(
        { approve: row?.approve, reject: row?.reject, total: row?.total },
        { approve: 1, reject: 0, total: 1 },
      );

      await castVote(db, voter, { proposalId, choice: "reject" });
      row = await projectionRow(db, ballotId);
      assert.deepEqual(
        {
          approve: row?.approve,
          abstain: row?.abstain,
          reject: row?.reject,
          total: row?.total,
        },
        { approve: 0, abstain: 0, reject: 1, total: 1 },
      );
    });

    it("counts concurrent votes without losing one", async () => {
      const proposalId = "PROP-PROJECT-CONCURRENT";
      const ballotId = await seedBallot(db, proposalId);
      await Promise.all([
        castVote(db, memberUser("concurrent-1"), {
          proposalId,
          choice: "approve",
        }),
        castVote(db, memberUser("concurrent-2"), {
          proposalId,
          choice: "approve",
        }),
        castVote(db, memberUser("concurrent-3"), {
          proposalId,
          choice: "reject",
        }),
        castVote(db, memberUser("concurrent-4"), {
          proposalId,
          choice: "abstain",
        }),
      ]);
      const row = await projectionRow(db, ballotId);
      assert.deepEqual(
        {
          approve: row?.approve,
          abstain: row?.abstain,
          reject: row?.reject,
          total: row?.total,
        },
        { approve: 2, abstain: 1, reject: 1, total: 4 },
      );
      const storedVotes = await db
        .collection(PROPOSAL_VOTES)
        .countDocuments({ ballotId });
      assert.equal(storedVotes, 4);
    });

    it("is revision-scoped", async () => {
      const proposalId = "PROP-PROJECT-REVISION";
      const ballotId = await seedBallot(db, proposalId);
      await castVote(db, memberUser("revision-1"), {
        proposalId,
        choice: "approve",
      });
      await castVote(db, memberUser("revision-2"), {
        proposalId,
        choice: "approve",
      });
      await db.collection(PROPOSAL_VOTES).insertOne({
        ballotId,
        proposalId,
        revisionId: "rev-old",
        memberId: "revision-3",
        choice: "reject",
        updatedAt: new Date(),
      });
      const row = await projectionRow(db, ballotId);
      assert.deepEqual(
        { approve: row?.approve, reject: row?.reject, total: row?.total },
        { approve: 2, reject: 0, total: 2 },
      );
    });

    it("certifies from the bound votes even when the projection is corrupted", async () => {
      const proposalId = "PROP-PROJECT-CERTIFY";
      const ballotId = await seedBallot(db, proposalId);
      for (const suffix of ["1", "2", "3"]) {
        await castVote(db, memberUser(`certify-${suffix}`), {
          proposalId,
          choice: "approve",
        });
      }
      await castVote(db, memberUser("certify-4"), {
        proposalId,
        choice: "reject",
      });
      await db.collection(BALLOT_TALLIES).updateOne(
        { ballotId, revisionId: "rev-1" },
        {
          $set: {
            approve: 900,
            abstain: 0,
            reject: 0,
            total: 900,
            updatedAt: new Date(),
          },
        },
      );
      await closeBallot(db, proposalId);
      const record = await recordFormalDecision(db, {
        matterId: proposalId,
        revisionId: "rev-1",
        result: "successful",
        decisionEventId: "DECISION-PROJECTION-1",
        recordedBy: "admin-1",
      });
      assert.deepEqual(record.tally, {
        approve: 3,
        abstain: 0,
        reject: 1,
        total: 4,
      });
      assert.equal(record.computedResult, "successful");
      const stored = await db
        .collection(FORMAL_DECISIONS_COLLECTION)
        .findOne({ ballotId });
      assert.deepEqual(stored?.tally, record.tally);
      // The projection is still the corrupted display value; certification did
      // not read or repair it.
      const row = await projectionRow(db, ballotId);
      assert.equal(row?.total, 900);
    });

    it("keeps the vote successful and logs when the projection write fails", async () => {
      const proposalId = "PROP-PROJECT-FAILURE";
      await seedBallot(db, proposalId);
      const failing = new Proxy(db as any, {
        get(target, property) {
          if (property === "collection") {
            return (name: string) => {
              if (name === BALLOT_TALLIES) {
                return {
                  updateOne: async () => {
                    throw new Error("projection store offline");
                  },
                  find: () => ({ toArray: async () => [] }),
                  createIndex: async () => "ok",
                };
              }
              return target.collection(name);
            };
          }
          return (target as any)[property];
        },
      }) as Db;

      const original = console.error;
      const logged: string[] = [];
      console.error = (value?: unknown) => {
        logged.push(String(value));
      };
      let result: Awaited<ReturnType<typeof castVote>> | undefined;
      try {
        result = await castVote(failing, memberUser("failure-1"), {
          proposalId,
          choice: "approve",
        });
      } finally {
        console.error = original;
      }

      assert.equal(result?.votes.total, 1);
      assert.equal(
        await db.collection(PROPOSAL_VOTES).countDocuments({
          ballotId: proposalBallotId(proposalId),
        }),
        1,
      );
      assert.equal(logged.length, 1);
      const event = JSON.parse(logged[0]!);
      assert.equal(event.event, "ballot_tally_projection_failed");
      assert.equal(event.ballotId, proposalBallotId(proposalId));
      assert.equal("choice" in event, false);
      assert.equal("memberId" in event, false);
    });

    it("projects encrypted ballots as accurately as plaintext ones", async () => {
      const proposalId = "PROP-PROJECT-ENCRYPTED";
      const ballotId = await seedBallot(db, proposalId);
      const env: Partial<PlatformEnv> = {
        BALLOT_ENCRYPTION_MODE: "encrypt",
        BALLOT_ENCRYPTION_KEYS: `v1:${generateBallotKeyHex()}`,
        BALLOT_BLIND_INDEX_KEY: `bi-v1:${generateBallotKeyHex()}`,
      };
      await castVote(
        db,
        memberUser("encrypted-1"),
        { proposalId, choice: "approve" },
        env,
      );
      await castVote(
        db,
        memberUser("encrypted-2"),
        { proposalId, choice: "reject" },
        env,
      );
      const row = await projectionRow(db, ballotId);
      assert.deepEqual(
        {
          approve: row?.approve,
          abstain: row?.abstain,
          reject: row?.reject,
          total: row?.total,
        },
        { approve: 1, abstain: 0, reject: 1, total: 2 },
      );
      const report = await inspectBallotTallyProjection(db, {
        cryptoConfig: loadBallotCryptoConfig(env),
      });
      const group = report.rows.find((item) => item.ballotId === ballotId);
      assert.equal(group?.status, "match");
      assert.equal(group?.unreadableVotes, 0);
    });

    it("stops the public list reading proposal_votes end to end", async () => {
      const proposalId = "PROP-PROJECT-LIST";
      await seedBallot(db, proposalId);
      await castVote(db, memberUser("list-1"), {
        proposalId,
        choice: "approve",
      });
      const reads: string[] = [];
      const spy = new Proxy(db as any, {
        get(target, property) {
          if (property === "collection") {
            return (name: string) => {
              reads.push(name);
              return target.collection(name);
            };
          }
          return (target as any)[property];
        },
      }) as Db;
      const proposals = await listProposals(spy, {
        user: null,
        includeDetails: false,
        includeVoteTallies: false,
      });
      assert.equal(reads.includes(PROPOSAL_VOTES), false);
      assert.equal(proposals.length > 0, true);
      assert.ok(
        proposals.every((proposal) => proposal.votes.total === 0),
        "the list leaves vote totals to the projection overlay",
      );
    });
  },
);
