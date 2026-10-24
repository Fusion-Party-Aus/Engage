import test from "node:test";
import assert from "node:assert/strict";
import { castVote, closeExpiredBallots, finalizeBallot, getBallotResults, type BallotRecord } from "./ballots.ts";
import { validateOpenBallotSchedule } from "./draft-admin.mjs";
import type { PlatformIdentity } from "./types.ts";

function createFakeVoteDb(initialBallots: BallotRecord[], initialRevisions: Record<string, unknown>[] = []) {
  const matches = (doc: Record<string, any>, filter: Record<string, any>) => Object.entries(filter).every(([key, value]) => {
    if (key === "$expr") return value.$and.every((clause: Record<string, any>) => {
      const [field, time] = clause.$lte ?? clause.$gt;
      return clause.$lte ? doc[field.slice(1)] <= time : doc[field.slice(1)] > time;
    });
    if (value === null) return doc[key] == null;
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if ("$exists" in value) return (doc[key] !== undefined) === value.$exists;
      if ("$ne" in value) return doc[key] !== value.$ne;
    }
    return doc[key] === value;
  });
  const ballots = initialBallots.map((b) => ({ ...b }));
  const revisions = initialRevisions.map((r) => ({ ...r }));
  const votes = new Map<string, Record<string, unknown>>();
  const audits: Record<string, unknown>[] = [];
  return {
    client: { withSession: async (use: Function) => use({ withTransaction: async (write: Function) => write() }) },
    ballots,
    revisions,
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
          async findOneAndUpdate(filter: Record<string, any>, _update: Record<string, unknown>[]) {
            const target = ballots.find((b) => matches(b, filter));
            if (!target) return null;
            target.lastAdmissionAt = new Date();
            return target;
          },
          find(filter: { status?: string; closesAt?: { $lte: Date } }) {
            return {
              async toArray() {
                return ballots.filter(
                  (b) =>
                    (!filter.status || b.status === filter.status) &&
                    (!filter.closesAt || b.closesAt <= filter.closesAt.$lte),
                );
              },
            };
          },
          async findOne(filter: { ballotId: string }) {
            return ballots.find((b) => b.ballotId === filter.ballotId) ?? null;
          },
          async updateOne(filter: { ballotId: string }, update: { $set: Record<string, unknown>; $currentDate?: Record<string, boolean> }) {
            const target = ballots.find((b) => matches(b, filter));
            if (!target) return { matchedCount: 0, modifiedCount: 0 };
            Object.assign(target, update.$set);
            if (update.$currentDate?.closedAt) target.closedAt = new Date();
            return { matchedCount: 1, modifiedCount: 1 };
          },
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
      if (name === "policy_revisions") {
        return {
          async findOne(filter: { policyId: string; revisionId: string }) {
            return revisions.find((r) => r.policyId === filter.policyId && r.revisionId === filter.revisionId) ?? null;
          },
          async updateOne(filter: { policyId: string; revisionId: string }, update: { $set: Record<string, unknown> }) {
            const target = revisions.find((r) => matches(r, filter));
            if (!target) return { matchedCount: 0, modifiedCount: 0 };
            Object.assign(target, update.$set);
            return { matchedCount: 1, modifiedCount: 1 };
          },
        };
      }
      if (name === "operational_audit") {
        return {
          async updateOne(filter: Record<string, any>, update: { $setOnInsert: Record<string, unknown> }) {
            if (!audits.some((audit) => String(audit._id) === String(filter._id))) audits.push({ _id: filter._id, ...update.$setOnInsert });
            return { matchedCount: 1 };
          },
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
  const db = createFakeVoteDb([ballot], [{ policyId: ballot.proposalId, revisionId: ballot.policyRevisionId }]);
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
    /Engage member identity/,
  );

  // Safeguard: Underground identity cannot vote when binding ballots are disabled or Underground adapter is unavailable
  const undergroundMember: PlatformIdentity = { memberId: "ug-101", source: "underground", roles: ["member"] };
  await assert.rejects(
    () => castVote(db as never, undergroundMember, { ...ballot, status: "open" }, "approve", { APP_MODE: "production", FORMAL_BALLOTS_ENABLED: "false" }, voteTime),
    /Engage member identity/,
  );
  await assert.rejects(
    () => castVote(db as never, undergroundMember, { ...ballot, status: "open" }, "approve", { APP_MODE: "production", FORMAL_BALLOTS_ENABLED: "true" }, voteTime),
    /Engage member identity/,
  );
});

test("automatic deadline closure and administrative closure use the same idempotent finalisation and publish approved revisions", async () => {
  const deadlineBallot: BallotRecord = {
    ballotId: "ballot-deadline-01",
    proposalId: "POL-010",
    policyRevisionId: "POL-010:v2",
    title: "Make It Easier to Buy and Move Home",
    status: "open",
    opensAt: new Date("2026-10-20T00:00:00Z"),
    closesAt: new Date("2026-10-24T00:00:00Z"),
  };
  const adminBallot: BallotRecord = {
    ballotId: "ballot-admin-01",
    proposalId: "POL-011",
    policyRevisionId: "POL-011:v2",
    title: "Make Housing Tax Fair Across Generations",
    status: "open",
    opensAt: new Date("2026-10-20T00:00:00Z"),
    closesAt: new Date("2026-10-28T00:00:00Z"),
  };
  const db = createFakeVoteDb(
    [deadlineBallot, adminBallot],
    [
      { policyId: "POL-010", revisionId: "POL-010:v2", title: "Make It Easier to Buy and Move Home" },
      { policyId: "POL-011", revisionId: "POL-011:v2", title: "Make Housing Tax Fair Across Generations" },
    ],
  );
  const member1: PlatformIdentity = { memberId: "preview-member-01", source: "synthetic", roles: ["member"] };
  const voteTime = new Date("2026-10-22T12:00:00Z");

  await castVote(db as never, member1, deadlineBallot, "approve", { APP_MODE: "preview" }, voteTime);
  await castVote(db as never, member1, adminBallot, "approve", { APP_MODE: "preview" }, voteTime);

  // 1. Automatic deadline closure via closeExpiredBallots
  const closeNow = new Date("2026-10-25T00:00:00Z");
  const closedCount = await closeExpiredBallots(db as never, closeNow);
  assert.equal(closedCount, 1);

  const deadlineRev = db.revisions.find((r) => r.revisionId === "POL-010:v2")!;
  assert.ok(deadlineRev.publishedAt instanceof Date, "Deadline closure must publish the approved revision");
  assert.equal(deadlineRev.approvedByBallotId, "ballot-deadline-01");
  assert.equal(db.ballots[0]!.outcome, "approved");
  assert.equal(db.ballots[0]!.publishedRevisionId, "POL-010:v2");

  // 2. Administrative closure via finalizeBallot
  const adminFinalized = await finalizeBallot(db as never, "ballot-admin-01", {
    actorId: "preview-admin-01",
    actorSource: "synthetic",
    now: closeNow,
    closeReason: "administrative",
  });
  assert.ok(adminFinalized);
  assert.equal(adminFinalized.outcome, "approved");
  assert.equal(adminFinalized.publishedRevisionId, "POL-011:v2");
  assert.equal(adminFinalized.alreadyFinalized, false);

  const adminRev = db.revisions.find((r) => r.revisionId === "POL-011:v2")!;
  assert.ok(adminRev.publishedAt instanceof Date, "Administrative closure must publish the approved revision");
  assert.equal(adminRev.approvedByBallotId, "ballot-admin-01");

  // 3. Idempotency: calling finalizeBallot again on either ballot does not duplicate audit events or overwrite timestamps
  const auditCountBefore = db.audits.length;
  const repeatDeadline = await finalizeBallot(db as never, "ballot-deadline-01", { now: new Date("2026-10-26T00:00:00Z") });
  const repeatAdmin = await finalizeBallot(db as never, "ballot-admin-01", { now: new Date("2026-10-26T00:00:00Z") });
  assert.equal(repeatDeadline?.alreadyFinalized, true);
  assert.equal(repeatAdmin?.alreadyFinalized, true);
  assert.equal(db.audits.length, auditCountBefore, "Repeated finalisation must be idempotent and add no new audit events");
});

test("opening a ballot requires an explicitly configured valid voting window and rejects expired schedules", () => {
  const now = new Date("2026-10-24T12:00:00Z");

  // Expired ballot schedule must be rejected, never silently extended
  const expired = validateOpenBallotSchedule(
    {},
    { opensAt: new Date("2026-10-01T00:00:00Z"), closesAt: new Date("2026-10-20T00:00:00Z") },
    now,
  );
  assert.ok("error" in expired);
  assert.match(expired.error ?? "", /expired/);

  // Future opening time that has not started yet must be rejected unless an active window is configured
  const notYetStarted = validateOpenBallotSchedule(
    {},
    { opensAt: new Date("2026-11-01T00:00:00Z"), closesAt: new Date("2026-11-15T00:00:00Z") },
    now,
  );
  assert.ok("error" in notYetStarted);
  assert.match(notYetStarted.error ?? "", /before its configured opening time/);

  // Explicit active voting window succeeds
  const active = validateOpenBallotSchedule(
    { opensAt: "2026-10-24T00:00:00Z", closesAt: "2026-10-31T00:00:00Z" },
    { opensAt: new Date("2026-10-01T00:00:00Z"), closesAt: new Date("2026-10-20T00:00:00Z") },
    now,
  );
  assert.equal("error" in active, false);
});
