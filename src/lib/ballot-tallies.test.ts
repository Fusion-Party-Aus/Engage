import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "mongodb";
import { createMemoryDb } from "./db.ts";
import {
  BALLOT_TALLIES,
  BALLOT_TALLY_STALENESS_MS,
  ballotTallyKey,
  emptyVoteTally,
  inspectBallotTallyProjection,
  isProjectionFresh,
  projectCommittedVoteTally,
  readBallotTallyProjections,
  repairBallotTallyProjection,
  updateBallotTallyProjection,
  voteTallyDelta,
  rebuildBallotTallyProjection,
} from "./ballot-tallies.ts";
import { PROPOSAL_VOTES } from "./vote-storage.ts";

const BALLOT_ID = "proposal:PROP-1";
const REVISION_ID = "rev-1";

async function seedVotes(
  db: Db,
  votes: Array<{ memberId: string; choice: string; revisionId?: string }>,
): Promise<void> {
  for (const vote of votes) {
    await db.collection(PROPOSAL_VOTES).insertOne({
      ballotId: BALLOT_ID,
      proposalId: "PROP-1",
      revisionId: vote.revisionId ?? REVISION_ID,
      memberId: vote.memberId,
      choice: vote.choice,
      updatedAt: new Date(),
    });
  }
}

describe("ballot tally projection arithmetic", () => {
  it("adds one vote when nothing was recorded before", () => {
    assert.deepEqual(
      voteTallyDelta({ choice: "approve", hadPreviousVote: false }),
      { approve: 1, abstain: 0, reject: 0, total: 1 },
    );
  });

  it("does not double count a re-cast of the same choice", () => {
    assert.deepEqual(
      voteTallyDelta({
        choice: "reject",
        hadPreviousVote: true,
        previousChoice: "reject",
      }),
      emptyVoteTally(),
    );
  });

  it("moves a vote from one choice to another without changing the total", () => {
    assert.deepEqual(
      voteTallyDelta({
        choice: "abstain",
        hadPreviousVote: true,
        previousChoice: "approve",
      }),
      { approve: -1, abstain: 1, reject: 0, total: 0 },
    );
  });

  it("asks for a rebuild when the previous choice cannot be read", () => {
    assert.equal(
      voteTallyDelta({
        choice: "approve",
        hadPreviousVote: true,
        previousChoice: null,
      }),
      null,
    );
  });
});

describe("ballot tally projection freshness", () => {
  const now = new Date("2026-11-16T10:00:00.000Z");

  it("trusts a row inside the documented window", () => {
    assert.equal(
      isProjectionFresh({ updatedAt: new Date(now.getTime() - 1_000) }, now),
      true,
    );
  });

  it("refuses a row exactly at or beyond the window", () => {
    assert.equal(
      isProjectionFresh(
        { updatedAt: new Date(now.getTime() - BALLOT_TALLY_STALENESS_MS) },
        now,
      ),
      true,
    );
    assert.equal(
      isProjectionFresh(
        {
          updatedAt: new Date(
            now.getTime() - BALLOT_TALLY_STALENESS_MS - 1,
          ),
        },
        now,
      ),
      false,
    );
  });

  it("refuses an unreadable timestamp", () => {
    assert.equal(isProjectionFresh({ updatedAt: new Date("nope") }, now), false);
  });
});

describe("ballot tally projection storage", () => {
  it("stores counts only and never voter identity or choices", async () => {
    const db = createMemoryDb();
    await seedVotes(db, [
      { memberId: "member-a", choice: "approve" },
      { memberId: "member-b", choice: "reject" },
    ]);
    await updateBallotTallyProjection(db, {
      ballotId: BALLOT_ID,
      revisionId: REVISION_ID,
      choice: "approve",
      hadPreviousVote: false,
    });
    const rows = await db.collection(BALLOT_TALLIES).find({}).toArray();
    assert.equal(rows.length, 1);
    const stored = rows[0]!;
    // The row was created by one atomic increment. It does not scan the other
    // seeded votes, which is the repair CLI's job; that is what keeps the
    // normal write race-free.
    assert.equal(stored.approve, 1);
    assert.equal(stored.reject, 0);
    assert.equal(stored.total, 1);
    for (const forbidden of [
      "memberId",
      "choice",
      "authorName",
      "voteEnvelope",
      "voterBlindIndex",
    ]) {
      assert.equal(forbidden in stored, false, `${forbidden} must not be stored`);
    }
    assert.deepEqual(Object.keys(stored).sort(), [
      "_id",
      "abstain",
      "approve",
      "ballotId",
      "reject",
      "revisionId",
      "total",
      "updatedAt",
      "version",
    ]);
  });

  it("increments an existing row and moves a changed vote", async () => {
    const db = createMemoryDb();
    await db.collection(BALLOT_TALLIES).insertOne({
      ballotId: BALLOT_ID,
      revisionId: REVISION_ID,
      approve: 1,
      abstain: 0,
      reject: 0,
      total: 1,
      updatedAt: new Date(),
    });
    await updateBallotTallyProjection(db, {
      ballotId: BALLOT_ID,
      revisionId: REVISION_ID,
      choice: "reject",
      hadPreviousVote: true,
      previousChoice: "approve",
    });
    let row = (await db.collection(BALLOT_TALLIES).findOne({}))!;
    assert.deepEqual(
      { approve: row.approve, reject: row.reject, total: row.total },
      { approve: 0, reject: 1, total: 1 },
    );
    await updateBallotTallyProjection(db, {
      ballotId: BALLOT_ID,
      revisionId: REVISION_ID,
      choice: "reject",
      hadPreviousVote: true,
      previousChoice: "reject",
    });
    row = (await db.collection(BALLOT_TALLIES).findOne({}))!;
    assert.deepEqual(
      { approve: row.approve, reject: row.reject, total: row.total },
      { approve: 0, reject: 1, total: 1 },
    );
  });

  it("moves a count to the row of the revision the member now belongs to", async () => {
    const db = createMemoryDb();
    // The member's previous vote lived on rev-old; both revisions now have
    // votes from other members too.
    await seedVotes(db, [
      { memberId: "member-other", choice: "approve", revisionId: "rev-old" },
      { memberId: "member-1", choice: "reject", revisionId: REVISION_ID },
      { memberId: "member-other-2", choice: "approve", revisionId: REVISION_ID },
    ]);
    await db.collection(BALLOT_TALLIES).insertOne({
      ballotId: BALLOT_ID,
      revisionId: "rev-old",
      approve: 2,
      abstain: 0,
      reject: 0,
      total: 2,
      updatedAt: new Date(),
    });
    await db.collection(BALLOT_TALLIES).insertOne({
      ballotId: BALLOT_ID,
      revisionId: REVISION_ID,
      approve: 1,
      abstain: 0,
      reject: 0,
      total: 1,
      updatedAt: new Date(),
    });
    await updateBallotTallyProjection(db, {
      ballotId: BALLOT_ID,
      revisionId: REVISION_ID,
      choice: "reject",
      hadPreviousVote: true,
      previousChoice: "approve",
      previousRevisionId: "rev-old",
    });
    const oldRow = (await db.collection(BALLOT_TALLIES).findOne({
      revisionId: "rev-old",
    }))!;
    const newRow = (await db.collection(BALLOT_TALLIES).findOne({
      revisionId: REVISION_ID,
    }))!;
    assert.deepEqual(
      { approve: oldRow.approve, reject: oldRow.reject, total: oldRow.total },
      { approve: 1, reject: 0, total: 1 },
    );
    assert.deepEqual(
      { approve: newRow.approve, reject: newRow.reject, total: newRow.total },
      { approve: 1, reject: 1, total: 2 },
    );
  });

  it("creates a missing row with one atomic increment, then recounts on demand", async () => {
    const db = createMemoryDb();
    await seedVotes(db, [
      { memberId: "member-a", choice: "approve" },
      { memberId: "member-b", choice: "approve" },
      { memberId: "member-c", choice: "reject", revisionId: "rev-old" },
    ]);
    await updateBallotTallyProjection(db, {
      ballotId: BALLOT_ID,
      revisionId: REVISION_ID,
      choice: "approve",
      hadPreviousVote: false,
    });
    const row = (await db.collection(BALLOT_TALLIES).findOne({}))!;
    assert.deepEqual(
      { approve: row.approve, reject: row.reject, total: row.total },
      { approve: 1, reject: 0, total: 1 },
    );
    await rebuildBallotTallyProjection(db, {
      ballotId: BALLOT_ID,
      revisionId: REVISION_ID,
    });
    const rebuilt = (await db.collection(BALLOT_TALLIES).findOne({}))!;
    assert.deepEqual(
      { approve: rebuilt.approve, reject: rebuilt.reject, total: rebuilt.total },
      { approve: 2, reject: 0, total: 2 },
    );
  });

  it("reads projections per ballot and revision and reports staleness", async () => {
    const db = createMemoryDb();
    const now = new Date("2026-11-16T10:00:00.000Z");
    await db.collection(BALLOT_TALLIES).insertOne({
      ballotId: BALLOT_ID,
      revisionId: REVISION_ID,
      approve: 4,
      abstain: 1,
      reject: 2,
      total: 7,
      updatedAt: new Date(now.getTime() - 60_000),
    });
    await db.collection(BALLOT_TALLIES).insertOne({
      ballotId: BALLOT_ID,
      revisionId: "rev-2",
      approve: 90,
      abstain: 0,
      reject: 0,
      total: 90,
      updatedAt: new Date(now.getTime() - BALLOT_TALLY_STALENESS_MS - 1),
    });
    const result = await readBallotTallyProjections(
      db,
      [
        { ballotId: BALLOT_ID, revisionId: REVISION_ID },
        { ballotId: BALLOT_ID, revisionId: "rev-2" },
        { ballotId: BALLOT_ID, revisionId: "rev-missing" },
      ],
      { now },
    );
    assert.equal(result.size, 2);
    const fresh = result.get(ballotTallyKey(BALLOT_ID, REVISION_ID))!;
    assert.equal(fresh.fresh, true);
    assert.deepEqual(fresh.tally, { approve: 4, abstain: 1, reject: 2, total: 7 });
    const stale = result.get(ballotTallyKey(BALLOT_ID, "rev-2"))!;
    assert.equal(stale.fresh, false);
    assert.equal(
      result.has(ballotTallyKey(BALLOT_ID, "rev-missing")),
      false,
    );
  });

  it("refuses to trust a non-summing or negative row", async () => {
    const db = createMemoryDb();
    const now = new Date("2026-11-16T10:00:00.000Z");
    await db.collection(BALLOT_TALLIES).insertOne({
      ballotId: BALLOT_ID,
      revisionId: REVISION_ID,
      approve: -1,
      abstain: 0,
      reject: 1,
      total: 0,
      updatedAt: new Date(now.getTime() - 1_000),
    });
    const result = await readBallotTallyProjections(
      db,
      [{ ballotId: BALLOT_ID, revisionId: REVISION_ID }],
      { now },
    );
    assert.equal(
      result.get(ballotTallyKey(BALLOT_ID, REVISION_ID))!.fresh,
      false,
    );
  });

  it("abandons a rebuild at its deadline without writing a stale count", async () => {
    const db = createMemoryDb();
    await seedVotes(db, [{ memberId: "member-a", choice: "approve" }]);
    const slow = new Proxy(db as any, {
      get(target, property) {
        if (property === "collection") {
          return (name: string) => {
            if (name === PROPOSAL_VOTES) {
              return {
                find: () => ({
                  toArray: async () => {
                    await new Promise((resolve) => setTimeout(resolve, 80));
                    return target.collection(name).find({}).toArray();
                  },
                }),
              };
            }
            return target.collection(name);
          };
        }
        return (target as any)[property];
      },
    }) as Db;
    const original = console.warn;
    const logged: string[] = [];
    console.warn = (value?: unknown) => {
      logged.push(String(value));
    };
    try {
      await projectCommittedVoteTally(slow, {
        ballotId: BALLOT_ID,
        revisionId: REVISION_ID,
        choice: "approve",
        hadPreviousVote: true,
        previousChoice: null,
        deadlineMs: 20,
      });
      // Let the abandoned recount finish; it must not write afterwards.
      await new Promise((resolve) => setTimeout(resolve, 120));
    } finally {
      console.warn = original;
    }
    assert.equal(await db.collection(BALLOT_TALLIES).countDocuments(), 0);
    assert.ok(
      logged.some(
        (line) => JSON.parse(line).event === "ballot_tally_projection_timeout",
      ),
      logged.join("\n"),
    );
    assert.equal(
      logged.some((line) =>
        JSON.parse(line).event === "ballot_tally_projection_failed",
      ),
      false,
    );
  });

  it("never lets a projection failure escape as a vote failure", async () => {
    const db = createMemoryDb();
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
    try {
      await projectCommittedVoteTally(failing, {
        ballotId: BALLOT_ID,
        revisionId: REVISION_ID,
        choice: "approve",
        hadPreviousVote: false,
        deadlineMs: 2_000,
      });
    } finally {
      console.error = original;
    }
    assert.equal(logged.length, 1);
    const event = JSON.parse(logged[0]!);
    assert.equal(event.event, "ballot_tally_projection_failed");
    assert.equal(event.ballotId, BALLOT_ID);
    assert.equal("choice" in event, false);
  });
});

describe("ballot tally projection repair", () => {
  it("reports missing, mismatched and orphan rows without writing in dry run", async () => {
    const db = createMemoryDb();
    await seedVotes(db, [
      { memberId: "member-a", choice: "approve" },
      { memberId: "member-b", choice: "reject" },
    ]);
    await db.collection(BALLOT_TALLIES).insertOne({
      ballotId: "proposal:OTHER",
      revisionId: "rev-x",
      approve: 9,
      abstain: 0,
      reject: 0,
      total: 9,
      updatedAt: new Date(),
    });
    const report = await inspectBallotTallyProjection(db, { cryptoConfig: null });
    assert.equal(report.scannedVotes, 2);
    assert.equal(report.groups, 1);
    assert.equal(report.rows[0]!.status, "missing");
    assert.equal(report.rows[0]!.expected.total, 2);
    assert.equal(report.orphanRows, 1);
    assert.equal(report.needsRepair, true);
    assert.equal(
      await db.collection(BALLOT_TALLIES).countDocuments({
        ballotId: BALLOT_ID,
      }),
      0,
    );
  });

  it("writes expected counts and zeroes orphan rows on apply", async () => {
    const db = createMemoryDb();
    await seedVotes(db, [
      { memberId: "member-a", choice: "approve" },
      { memberId: "member-b", choice: "reject" },
    ]);
    await db.collection(BALLOT_TALLIES).insertOne({
      ballotId: BALLOT_ID,
      revisionId: REVISION_ID,
      approve: 7,
      abstain: 0,
      reject: 0,
      total: 7,
      updatedAt: new Date(),
    });
    await db.collection(BALLOT_TALLIES).insertOne({
      ballotId: "proposal:OTHER",
      revisionId: "rev-x",
      approve: 9,
      abstain: 0,
      reject: 0,
      total: 9,
      updatedAt: new Date(),
    });
    const result = await repairBallotTallyProjection(db, {
      cryptoConfig: null,
      apply: true,
    });
    assert.equal(result.written, 1);
    assert.equal(result.zeroed, 1);
    const row = (await db.collection(BALLOT_TALLIES).findOne({
      ballotId: BALLOT_ID,
    }))!;
    assert.deepEqual(
      { approve: row.approve, reject: row.reject, total: row.total },
      { approve: 1, reject: 1, total: 2 },
    );
    const orphan = (await db.collection(BALLOT_TALLIES).findOne({
      ballotId: "proposal:OTHER",
    }))!;
    assert.equal(orphan.total, 0);
    const after = await inspectBallotTallyProjection(db, { cryptoConfig: null });
    assert.equal(after.needsRepair, false);
  });

  it("refuses to write a partial tally when encrypted votes cannot be read", async () => {
    const db = createMemoryDb();
    await db.collection(PROPOSAL_VOTES).insertOne({
      ballotId: BALLOT_ID,
      proposalId: "PROP-1",
      revisionId: REVISION_ID,
      voterBlindIndex: "blind",
      voteEnvelope: { v: 1, alg: "aes-256-gcm", kid: "v1", iv: "", tag: "", ct: "" },
      updatedAt: new Date(),
    });
    const report = await inspectBallotTallyProjection(db, { cryptoConfig: null });
    assert.equal(report.encryptedWithoutKeys, 1);
    await assert.rejects(
      repairBallotTallyProjection(db, { cryptoConfig: null, apply: true }),
      /decryption keys are not configured/,
    );
    assert.equal(await db.collection(BALLOT_TALLIES).countDocuments(), 0);
  });
});
