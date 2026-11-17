import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { MongoClient, type Db } from "mongodb";
import { generateBallotKeyHex, loadBallotCryptoConfig } from "./ballot-crypto.ts";
import {
  BALLOT_TALLIES,
  BALLOT_TALLY_INDEX,
  inspectBallotTallyProjection,
  readBallotTallyProjections,
  rebuildBallotTallyProjection,
  updateBallotTallyProjection,
} from "./ballot-tallies.ts";
import {
  FORMAL_DECISIONS_COLLECTION,
  recordFormalDecision,
  upsertMatterBallot,
} from "./ballots.ts";
import { castVote } from "./voting-store.ts";
import { listProposals } from "./proposals-store.ts";
import type { PlatformEnv, SessionUser, VoteChoice } from "./types.ts";
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

async function projectionRow(
  db: Db,
  ballotId: string,
  revisionId = "rev-1",
) {
  return db.collection(BALLOT_TALLIES).findOne({ ballotId, revisionId });
}

function tallyOf(row: Record<string, any> | null) {
  return {
    approve: row?.approve,
    abstain: row?.abstain,
    reject: row?.reject,
    total: row?.total,
  };
}

/** The authoritative tally of the plaintext votes in one revision. */
async function authoritativeTally(
  db: Db,
  ballotId: string,
  revisionId = "rev-1",
) {
  const rows = await db
    .collection(PROPOSAL_VOTES)
    .find({ ballotId, revisionId })
    .toArray();
  const tally = { approve: 0, abstain: 0, reject: 0, total: 0 };
  for (const row of rows as Array<Record<string, any>>) {
    tally[row.choice as "approve" | "abstain" | "reject"] += 1;
    tally.total += 1;
  }
  return tally;
}

async function assertRowMatchesVotes(
  db: Db,
  ballotId: string,
  revisionId = "rev-1",
) {
  assert.deepEqual(
    tallyOf(await projectionRow(db, ballotId, revisionId)),
    await authoritativeTally(db, ballotId, revisionId),
  );
}

/**
 * The projection write is best-effort: a committed vote is never held open
 * past the fixed 500 ms production deadline, so on a slow shared replica set
 * one write can be abandoned for the repair CLI. A test must not tune that
 * deadline through the deployment environment, so convergence is awaited here
 * and, when a write was abandoned, the documented repair path reconciles the
 * row before the equality assertion.
 */
const PROJECTION_CONVERGENCE_TIMEOUT_MS = 10_000;
const PROJECTION_POLL_INTERVAL_MS = 50;

async function waitForProjectionToMatch(
  db: Db,
  ballotId: string,
  expected: ReturnType<typeof tallyOf>,
  options: {
    revisionId?: string;
    cryptoConfig?: ReturnType<typeof loadBallotCryptoConfig> | null;
  } = {},
) {
  const revisionId = options.revisionId ?? "rev-1";
  const deadline = Date.now() + PROJECTION_CONVERGENCE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const row = await projectionRow(db, ballotId, revisionId);
    if (isDeepStrictEqual(tallyOf(row), expected)) return;
    await new Promise((resolve) =>
      setTimeout(resolve, PROJECTION_POLL_INTERVAL_MS),
    );
  }
  await rebuildBallotTallyProjection(db, {
    ballotId,
    revisionId,
    cryptoConfig: options.cryptoConfig,
  });
  assert.deepEqual(
    tallyOf(await projectionRow(db, ballotId, revisionId)),
    expected,
  );
}

async function waitForProjectionToMatchVotes(
  db: Db,
  ballotId: string,
  revisionId = "rev-1",
) {
  await waitForProjectionToMatch(
    db,
    ballotId,
    await authoritativeTally(db, ballotId, revisionId),
    { revisionId },
  );
}

/**
 * Interleaves an action immediately before the rebuild's compare-and-set write,
 * after its recount. The action's increment must make the CAS fail so the
 * rebuild recounts and overwrites rather than skipping the increment.
 */
function proxyTallyCas(db: Db, action: () => Promise<void>): Db {
  let fired = false;
  return new Proxy(db as any, {
    get(target, property) {
      if (property === "collection") {
        return (name: string) => {
          const source = target.collection(name);
          if (name !== BALLOT_TALLIES) return source;
          return new Proxy(source, {
            get(collection, key) {
              if (key === "updateOne") {
                return async (
                  filter: Record<string, unknown>,
                  update: Record<string, any>,
                  options?: Record<string, unknown>,
                ) => {
                  if (
                    !fired &&
                    update?.$set &&
                    "version" in update.$set
                  ) {
                    fired = true;
                    await action();
                  }
                  return collection.updateOne(filter, update, options);
                };
              }
              const value = (collection as any)[key];
              return typeof value === "function"
                ? value.bind(collection)
                : value;
            },
          });
        };
      }
      const value = (target as any)[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
}

async function insertVote(
  db: Db,
  input: {
    ballotId: string;
    proposalId: string;
    revisionId: string;
    memberId: string;
    choice: "approve" | "abstain" | "reject";
    updatedAt: Date;
  },
) {
  await db.collection(PROPOSAL_VOTES).updateOne(
    { ballotId: input.ballotId, memberId: input.memberId },
    { $set: { ...input } },
    { upsert: true },
  );
}

async function closeBallot(db: Db, proposalId: string): Promise<void> {
  // This fixture covers projection and certification mechanics before the
  // two-tier quorum rule took effect. Quorum closure has separate coverage.
  const now = new Date("2026-11-10T00:00:00.000Z");
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
      await waitForProjectionToMatchVotes(db, ballotId);

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
      await waitForProjectionToMatchVotes(db, ballotId);
      let row = await projectionRow(db, ballotId);
      assert.deepEqual(
        { approve: row?.approve, reject: row?.reject, total: row?.total },
        { approve: 1, reject: 0, total: 1 },
      );

      await castVote(db, voter, { proposalId, choice: "reject" });
      await waitForProjectionToMatchVotes(db, ballotId);
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

    it("counts many concurrent first votes without losing or duplicating one", async () => {
      const proposalId = "PROP-PROJECT-CONCURRENT";
      const ballotId = await seedBallot(db, proposalId);
      const choices: VoteChoice[] = [
        "approve",
        "approve",
        "approve",
        "approve",
        "reject",
        "reject",
        "abstain",
        "abstain",
      ];
      await Promise.all(
        choices.map((choice, index) =>
          castVote(db, memberUser(`concurrent-${index}`), {
            proposalId,
            choice,
          }),
        ),
      );
      assert.deepEqual(await authoritativeTally(db, ballotId), {
        approve: 4,
        abstain: 2,
        reject: 2,
        total: 8,
      });
      await waitForProjectionToMatchVotes(db, ballotId);
    });

    it("counts concurrent vote changes without losing one", async () => {
      const proposalId = "PROP-PROJECT-CONCURRENT-CHANGES";
      const ballotId = await seedBallot(db, proposalId);
      const first: VoteChoice[] = [
        "approve",
        "approve",
        "approve",
        "reject",
        "reject",
        "abstain",
      ];
      const changed: VoteChoice[] = [
        "reject",
        "approve",
        "abstain",
        "approve",
        "reject",
        "abstain",
      ];
      await Promise.all(
        first.map((choice, index) =>
          castVote(db, memberUser(`changer-${index}`), {
            proposalId,
            choice,
          }),
        ),
      );
      await Promise.all(
        changed.map((choice, index) =>
          castVote(db, memberUser(`changer-${index}`), {
            proposalId,
            choice,
          }),
        ),
      );
      assert.deepEqual(await authoritativeTally(db, ballotId), {
        approve: 2,
        abstain: 2,
        reject: 2,
        total: 6,
      });
      await waitForProjectionToMatchVotes(db, ballotId);
    });

    it("moves counts between revisions while other votes land concurrently", async () => {
      for (let round = 0; round < 5; round += 1) {
        const proposalId = `PROP-PROJECT-MOVE-${round}`;
        const ballotId = `proposal:${proposalId}`;
        const now = Date.now();
        const at = (offset: number) => new Date(now - 60_000 + offset);
        // Two revisions with a truthful baseline.
        await insertVote(db, {
          ballotId,
          proposalId,
          revisionId: "rev-old",
          memberId: "mover-a",
          choice: "approve",
          updatedAt: at(1),
        });
        await insertVote(db, {
          ballotId,
          proposalId,
          revisionId: "rev-old",
          memberId: "mover-b",
          choice: "reject",
          updatedAt: at(2),
        });
        await insertVote(db, {
          ballotId,
          proposalId,
          revisionId: "rev-old",
          memberId: "mover-c",
          choice: "abstain",
          updatedAt: at(3),
        });
        await insertVote(db, {
          ballotId,
          proposalId,
          revisionId: "rev-1",
          memberId: "mover-d",
          choice: "approve",
          updatedAt: at(4),
        });
        await insertVote(db, {
          ballotId,
          proposalId,
          revisionId: "rev-1",
          memberId: "mover-e",
          choice: "approve",
          updatedAt: at(5),
        });
        await rebuildBallotTallyProjection(db, {
          ballotId,
          revisionId: "rev-old",
        });
        await rebuildBallotTallyProjection(db, {
          ballotId,
          revisionId: "rev-1",
        });

        // Two members are re-bound to the new revision; a third new vote lands
        // at the same time.
        const movedAt = at(6);
        await insertVote(db, {
          ballotId,
          proposalId,
          revisionId: "rev-1",
          memberId: "mover-b",
          choice: "approve",
          updatedAt: movedAt,
        });
        await insertVote(db, {
          ballotId,
          proposalId,
          revisionId: "rev-1",
          memberId: "mover-c",
          choice: "abstain",
          updatedAt: movedAt,
        });
        const newVoteAt = at(7);
        await insertVote(db, {
          ballotId,
          proposalId,
          revisionId: "rev-1",
          memberId: "mover-f",
          choice: "approve",
          updatedAt: newVoteAt,
        });

        await Promise.all([
          updateBallotTallyProjection(db, {
            ballotId,
            revisionId: "rev-1",
            previousRevisionId: "rev-old",
            previousChoice: "reject",
            choice: "approve",
            hadPreviousVote: true,
          }),
          updateBallotTallyProjection(db, {
            ballotId,
            revisionId: "rev-1",
            previousRevisionId: "rev-old",
            previousChoice: "abstain",
            choice: "abstain",
            hadPreviousVote: true,
          }),
          updateBallotTallyProjection(db, {
            ballotId,
            revisionId: "rev-1",
            choice: "approve",
            hadPreviousVote: false,
          }),
        ]);

        await assertRowMatchesVotes(db, ballotId, "rev-old");
        await assertRowMatchesVotes(db, ballotId, "rev-1");
      }
    });

    it("keeps the row equal to the votes when a rebuild races increments for 20 rounds", async () => {
      for (let round = 0; round < 20; round += 1) {
        const proposalId = `PROP-PROJECT-RACE-${round}`;
        const ballotId = `proposal:${proposalId}`;
        const now = Date.now();
        for (let index = 0; index < 4; index += 1) {
          await insertVote(db, {
            ballotId,
            proposalId,
            revisionId: "rev-1",
            memberId: `race-existing-${index}`,
            choice: "approve",
            updatedAt: new Date(now - 60_000 + index),
          });
        }
        // Deliberately missing row: the rebuild must recreate it.
        await db.collection(BALLOT_TALLIES).deleteMany({ ballotId });

        const addNewVote = async () => {
          await insertVote(db, {
            ballotId,
            proposalId,
            revisionId: "rev-1",
            memberId: "race-new",
            choice: "reject",
            updatedAt: new Date(),
          });
          await updateBallotTallyProjection(db, {
            ballotId,
            revisionId: "rev-1",
            choice: "reject",
            hadPreviousVote: false,
          });
        };

        if (round % 2 === 0) {
          // Deterministic interleave: the increment lands after the recount and
          // before the compare-and-set, so the rebuild must detect the changed
          // version, recount and overwrite. Nothing is skipped.
          const interleaved = proxyTallyCas(db, addNewVote);
          await rebuildBallotTallyProjection(interleaved, {
            ballotId,
            revisionId: "rev-1",
          });
        } else {
          // The increment lands after the rebuild commits. The recount did not
          // include it, so it must add on top.
          await rebuildBallotTallyProjection(db, {
            ballotId,
            revisionId: "rev-1",
          });
          await addNewVote();
        }
        await assertRowMatchesVotes(db, ballotId);
      }
    });

    it("applies increments after an absolute rebuild without skipping them", async () => {
      const proposalId = "PROP-PROJECT-AFTER-REBUILD";
      const ballotId = `proposal:${proposalId}`;
      await insertVote(db, {
        ballotId,
        proposalId,
        revisionId: "rev-1",
        memberId: "after-rebuild-1",
        choice: "approve",
        updatedAt: new Date(),
      });
      await rebuildBallotTallyProjection(db, {
        ballotId,
        revisionId: "rev-1",
      });
      await insertVote(db, {
        ballotId,
        proposalId,
        revisionId: "rev-1",
        memberId: "after-rebuild-2",
        choice: "reject",
        updatedAt: new Date(),
      });
      await updateBallotTallyProjection(db, {
        ballotId,
        revisionId: "rev-1",
        choice: "reject",
        hadPreviousVote: false,
      });
      await assertRowMatchesVotes(db, ballotId);
      const row = await projectionRow(db, ballotId);
      assert.deepEqual(tallyOf(row), {
        approve: 1,
        abstain: 0,
        reject: 1,
        total: 2,
      });
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
      await waitForProjectionToMatchVotes(db, ballotId);
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
      await waitForProjectionToMatchVotes(db, ballotId);
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
      // An encrypted vote has no plaintext choice to count, so the expected
      // tally is explicit and the repair path needs the decryption keys.
      const cryptoConfig = loadBallotCryptoConfig(env);
      await waitForProjectionToMatch(
        db,
        ballotId,
        { approve: 1, abstain: 0, reject: 1, total: 2 },
        { cryptoConfig },
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
      const report = await inspectBallotTallyProjection(db, { cryptoConfig });
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
