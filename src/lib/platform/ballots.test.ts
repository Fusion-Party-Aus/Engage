import test from "node:test";
import assert from "node:assert/strict";
import { castVote, closeExpiredBallots, getBallotResults, type BallotRecord } from "./ballots.ts";
import type { PlatformIdentity } from "./types.ts";

function createFakeVoteDb(initialBallots: BallotRecord[]) {
  const ballots = initialBallots.map((b) => ({ ...b }));
  const votes = new Map<string, Record<string, unknown>>();
  const audits: Record<string, unknown>[] = [];
  return {
    ballots,
    votes,
    audits,
    collection(name: string) {
      if (name === "votes") {
        return {
          async updateOne(filter: { ballotId: string; memberId: string }, update: { $set: Record<string, unknown>; $setOnInsert?: Record<string, unknown> }, options?: { upsert?: boolean }) {
            const key = `${filter.ballotId}:${filter.memberId}`;
            const current = votes.get(key);
            if (!current && !options?.upsert) return { modifiedCount: 0 };
            votes.set(key, {
              ...(current ?? { ...filter, ...(update.$setOnInsert ?? {}) }),
              ...update.$set,
            });
            return { modifiedCount: current ? 1 : 0, upsertedCount: current ? 0 : 1 };
          },
          async countDocuments(query: { ballotId: string; choice: string }) {
            let count = 0;
            for (const vote of votes.values()) {
              if (vote.ballotId === query.ballotId && vote.choice === query.choice) count += 1;
            }
            return count;
          },
        };
      }
      if (name === "ballots") {
        return {
          async updateMany(filter: { status: string; closesAt: { $lte: Date } }, update: { $set: { status: string; closedAt: Date } }) {
            let modifiedCount = 0;
            for (const b of ballots) {
              if (b.status === filter.status && b.closesAt <= filter.closesAt.$lte) {
                b.status = update.$set.status as BallotRecord["status"];
                b.closedAt = update.$set.closedAt;
                modifiedCount += 1;
              }
            }
            return { modifiedCount };
          },
        };
      }
      if (name === "operational_audit") {
        return {
          async insertOne(doc: Record<string, unknown>) {
            audits.push(doc);
            return { insertedId: doc._id };
          },
        };
      }
      throw new Error(`Unexpected collection: ${name}`);
    },
  };
}

test("unified ballot engine records votes in votes collection, tallies strict majority on close, and blocks production without release gates", async () => {
  const ballot: BallotRecord = {
    ballotId: "ballot-pol-010",
    proposalId: "POL-010",
    policyRevisionId: "POL-010:v2",
    title: "Make It Easier to Buy and Move Home",
    status: "open",
    opensAt: new Date("2026-10-20T00:00:00Z"),
    closesAt: new Date("2026-10-24T00:00:00Z"),
  };
  const db = createFakeVoteDb([ballot]);
  const member1: PlatformIdentity = { memberId: "preview-member-01", source: "synthetic", roles: ["member"] };
  const member2: PlatformIdentity = { memberId: "preview-member-02", source: "synthetic", roles: ["member"] };
  const member3: PlatformIdentity = { memberId: "preview-admin-01", source: "synthetic", roles: ["member", "administrator"] };

  const voteTime = new Date("2026-10-22T12:00:00Z");
  await castVote(db as never, member1, ballot, "approve", { APP_MODE: "preview" }, voteTime);
  await castVote(db as never, member2, ballot, "do-not-approve", { APP_MODE: "preview" }, voteTime);
  await castVote(db as never, member3, ballot, "approve", { APP_MODE: "preview" }, voteTime);

  assert.equal(db.votes.size, 3);
  assert.equal(await getBallotResults(db as never, ballot), null);

  const closedCount = await closeExpiredBallots(db as never, new Date("2026-10-24T01:00:00Z"));
  assert.equal(closedCount, 1);
  assert.equal(db.ballots[0]!.status, "closed");

  const results = await getBallotResults(db as never, db.ballots[0]!);
  assert.deepEqual(results, {
    approve: 2,
    doNotApprove: 1,
    votesCast: 3,
    outcome: "approved",
  });

  // Safeguard: synthetic identity cannot vote when APP_MODE is production
  await assert.rejects(
    () => castVote(db as never, member1, { ...ballot, status: "open" }, "approve", { APP_MODE: "production", FORMAL_BALLOTS_ENABLED: "true" }, voteTime),
    /Underground member identity/,
  );

  // Safeguard: Underground identity cannot vote when binding ballots are disabled or Underground adapter is unavailable
  const undergroundMember: PlatformIdentity = { memberId: "ug-101", source: "underground", roles: ["member"] };
  await assert.rejects(
    () => castVote(db as never, undergroundMember, { ...ballot, status: "open" }, "approve", { APP_MODE: "production", FORMAL_BALLOTS_ENABLED: "false" }, voteTime),
    /Binding ballots are disabled/,
  );
  await assert.rejects(
    () => castVote(db as never, undergroundMember, { ...ballot, status: "open" }, "approve", { APP_MODE: "production", FORMAL_BALLOTS_ENABLED: "true" }, voteTime),
    /eligibility could not be confirmed/,
  );
});
