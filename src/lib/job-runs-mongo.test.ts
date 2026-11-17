import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MongoClient, type Db } from "mongodb";
import { ensureDatabaseIndexes } from "./db-indexes.ts";
import { runGovernanceScheduler } from "./governance-scheduler.ts";
import { GOVERNANCE_EVENTS_COLLECTION } from "./governance-relationships.ts";
import { JOB_RUNS_COLLECTION, JOB_RUN_RETENTION_DAYS } from "./job-runs.ts";

/**
 * Real-MongoDB coverage for the job-run ledger (#39). The in-memory database
 * cannot prove that a ledger failure leaves a transaction intact, so these cases
 * run only when a replica set is available.
 */
const uri = process.env.VOTING_TEST_MONGODB_URI;

const DAY = 86_400_000;
const NOW = new Date("2026-11-15T00:00:00.000Z");

async function withDatabase(run: (db: Db) => Promise<void>): Promise<void> {
  const client = await new MongoClient(uri!).connect();
  const db = client.db(
    `engage_job_runs_test_${crypto.randomUUID().replaceAll("-", "")}`,
  );
  try {
    await ensureDatabaseIndexes(db);
    await run(db);
  } finally {
    await db.dropDatabase();
    await client.close();
  }
}

/** A seconded matter whose deliberation deadline has arrived. */
async function insertDueMatter(db: Db, proposalId: string): Promise<void> {
  const secondedAt = new Date(NOW.getTime() - 30 * DAY);
  await db.collection("proposals").insertOne({
    proposalId,
    slug: proposalId.toLowerCase(),
    title: "Ledger coverage",
    space: "Governance",
    summary: "Scheduler ledger coverage.",
    outcomes: [],
    details: "",
    kind: "policy",
    stage: "deliberate",
    secondedBy: "member-seconder",
    secondedAt,
    deliberationEndsAt: NOW,
    createdAt: secondedAt,
    updatedAt: secondedAt,
  });
  await db.collection("proposal_revisions").insertOne({
    revisionId: `rev-${proposalId}`,
    proposalId,
    parentRevisionId: null,
    authorId: "author-1",
    createdAt: secondedAt,
    snapshot: { title: "t", summary: "s", outcomes: [], details: "" },
    contentHash: `hash-${proposalId}`,
  });
}

/** A matter in Decide whose ballot deadline has passed without closure. */
async function insertClosedDueMatter(db: Db, proposalId: string): Promise<void> {
  const secondedAt = new Date(NOW.getTime() - 60 * DAY);
  await db.collection("proposals").insertOne({
    proposalId,
    slug: proposalId.toLowerCase(),
    title: "Ledger closure coverage",
    space: "Governance",
    summary: "Scheduler closure ledger coverage.",
    outcomes: [],
    details: "",
    kind: "policy",
    stage: "decide",
    secondedBy: "member-seconder",
    secondedAt,
    deliberationEndsAt: new Date(NOW.getTime() - 30 * DAY),
    ballotRevisionId: `rev-${proposalId}`,
    ballotClosesAt: new Date(NOW.getTime() - DAY),
    createdAt: secondedAt,
    updatedAt: secondedAt,
  });
  await db.collection("proposal_revisions").insertOne({
    revisionId: `rev-${proposalId}`,
    proposalId,
    parentRevisionId: null,
    authorId: "author-1",
    createdAt: secondedAt,
    snapshot: { title: "t", summary: "s", outcomes: [], details: "" },
    contentHash: `hash-${proposalId}`,
  });
}

function ledgerEntries(db: Db) {
  return db.collection(JOB_RUNS_COLLECTION).find({}).sort({ startedAt: 1 }).toArray();
}

function databaseWithFailingLedger(db: Db): Db {
  return new Proxy(db, {
    get(target, property) {
      if (property === "collection") {
        return (name: string) =>
          name === JOB_RUNS_COLLECTION
            ? {
                insertOne: async () => {
                  throw new Error("ledger unavailable");
                },
              }
            : target.collection(name);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("scheduled governance ledger", () => {
  it(
    "records exactly one entry per completed run and dry-runs change nothing",
    { skip: !uri },
    async () => {
      await withDatabase(async (db) => {
        const indexes = await db.collection(JOB_RUNS_COLLECTION).indexes();
        const expiry = indexes.find((index) => index.name === "job_run_expiry");
        assert.ok(expiry, "missing TTL index");
        assert.equal(
          expiry.expireAfterSeconds,
          JOB_RUN_RETENTION_DAYS * 24 * 60 * 60,
        );

        const proposalId = `PROP-LEDGER-${crypto.randomUUID()}`;
        await insertDueMatter(db, proposalId);

        const firstDryRun = await runGovernanceScheduler(db, {
          now: NOW,
          dryRun: true,
        });
        assert.equal(firstDryRun.mode, "dry-run");
        assert.equal(firstDryRun.counts.advanced, 1);

        const secondDryRun = await runGovernanceScheduler(db, {
          now: NOW,
          dryRun: true,
        });
        assert.equal(secondDryRun.mode, "dry-run");
        assert.equal(secondDryRun.counts.advanced, 1);

        assert.equal(
          (await db.collection("proposals").findOne({ proposalId }))?.stage,
          "deliberate",
        );
        assert.equal(
          await db
            .collection(GOVERNANCE_EVENTS_COLLECTION)
            .countDocuments({ eventType: "proposal.stage_transition" }),
          0,
        );
        const afterDryRuns = await ledgerEntries(db);
        assert.equal(afterDryRuns.length, 2);
        assert.deepEqual(
          afterDryRuns.map((entry) => entry.mode),
          ["dry-run", "dry-run"],
        );
        assert.deepEqual(afterDryRuns[0]?.summary, {
          advanced: 1,
          closed: 0,
          skipped: 0,
          blockers: 0,
          errors: 0,
        });

        const apply = await runGovernanceScheduler(db, { now: NOW });
        assert.equal(apply.mode, "apply");
        assert.equal(apply.counts.advanced, 1);
        assert.equal(
          (await db.collection("proposals").findOne({ proposalId }))?.stage,
          "decide",
        );
        assert.equal(
          await db
            .collection(GOVERNANCE_EVENTS_COLLECTION)
            .countDocuments({ eventType: "proposal.stage_transition" }),
          1,
        );

        const replay = await runGovernanceScheduler(db, { now: NOW });
        assert.equal(replay.counts.advanced, 0);
        assert.equal(
          await db
            .collection(GOVERNANCE_EVENTS_COLLECTION)
            .countDocuments({ eventType: "proposal.stage_transition" }),
          1,
        );

        const entries = await ledgerEntries(db);
        assert.equal(entries.length, 4);
        assert.deepEqual(
          entries.map((entry) => entry.mode),
          ["dry-run", "dry-run", "apply", "apply"],
        );
        assert.ok(entries.every((entry) => entry.ok === true));
        assert.deepEqual(entries[2]?.summary, {
          advanced: 1,
          closed: 0,
          skipped: 0,
          blockers: 0,
          errors: 0,
        });
      });
    },
  );

  it(
    "records a completed closure run once",
    { skip: !uri },
    async () => {
      await withDatabase(async (db) => {
        const proposalId = `PROP-LEDGER-CLOSE-${crypto.randomUUID()}`;
        await insertClosedDueMatter(db, proposalId);

        const report = await runGovernanceScheduler(db, { now: NOW });
        assert.equal(report.counts.closed, 1);

        const [entry] = await ledgerEntries(db);
        assert.equal(entry?.job, "governance-scheduler");
        assert.equal(entry?.mode, "apply");
        assert.equal(entry?.ok, true);
        assert.deepEqual(entry?.summary, {
          advanced: 0,
          closed: 1,
          skipped: 0,
          blockers: 0,
          errors: 0,
        });
      });
    },
  );

  it(
    "a forced ledger failure leaves the report and governance writes intact",
    { skip: !uri },
    async () => {
      await withDatabase(async (db) => {
        const proposalId = `PROP-LEDGER-FAIL-${crypto.randomUUID()}`;
        await insertDueMatter(db, proposalId);

        const originalError = console.error;
        const logged: string[] = [];
        console.error = (...args: unknown[]) => {
          logged.push(args.map((value) => String(value)).join(" "));
        };
        let report;
        try {
          report = await runGovernanceScheduler(databaseWithFailingLedger(db), {
            now: NOW,
          });
        } finally {
          console.error = originalError;
        }

        assert.equal(report.mode, "apply");
        assert.equal(report.counts.advanced, 1);
        assert.equal(report.errors.length, 0);
        assert.equal(
          (await db.collection("proposals").findOne({ proposalId }))?.stage,
          "decide",
        );
        assert.equal(
          await db
            .collection(GOVERNANCE_EVENTS_COLLECTION)
            .countDocuments({ eventType: "proposal.stage_transition" }),
          1,
        );
        assert.equal(await db.collection(JOB_RUNS_COLLECTION).countDocuments({}), 0);
        assert.equal(logged.length, 1);
        assert.match(logged[0] ?? "", /job_run_ledger_write_failed/);
      });
    },
  );
});
