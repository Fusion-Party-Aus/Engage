import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { MongoClient, type Db } from "mongodb";
import { initializeDatabase } from "./db.ts";
import { JOB_RUNS_COLLECTION, type JobName } from "./job-runs.ts";
import {
  CRM_OPERATIONAL_SETTINGS_ID,
  DEFAULT_CRM_SETTINGS,
  DEFAULT_OPERATIONAL_THRESHOLDS,
  JOBS_OPERATIONAL_SETTINGS_ID,
  OPERATIONAL_SETTINGS_COLLECTION,
  OPERATIONAL_SETTINGS_ID,
} from "./operational-settings.ts";

/**
 * End-to-end coverage for `npm run ops:health` (#39): the command must be
 * alertable, so its exit codes are part of the contract.
 *
 * 0 healthy · 2 degraded or unknown · 1 failing or unreachable
 *
 * Runs the real CLI against a scratch replica-set database because the ledger
 * and health evidence live in MongoDB.
 */
const uri = process.env.VOTING_TEST_MONGODB_URI;
const root = resolve(import.meta.dirname, "../..");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runOpsHealth(
  args: string[],
  env: Record<string, string>,
): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [
        "--experimental-strip-types",
        "scripts/operational-health.ts",
        ...args,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          APP_MODE: "test",
          TURNSTILE_ENFORCEMENT: "",
          ...env,
        },
        timeout: 60_000,
      },
      (error, stdout, stderr) => {
        resolvePromise({
          code: error ? Number((error as { code?: number }).code ?? 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

async function seedJobRuns(db: Db, jobs: JobName[]): Promise<void> {
  const now = new Date();
  for (const job of jobs) {
    await db.collection(JOB_RUNS_COLLECTION).insertOne({
      runId: `cli-${job}`,
      job,
      mode: "apply",
      ok: true,
      startedAt: new Date(now.getTime() - 60_000),
      finishedAt: now,
      summary: { errors: 0, sent: 0, held: 0, processed: 0 },
    });
  }
}

/** Age every run beyond the warn threshold but inside the fail threshold. */
async function staleJobRuns(db: Db): Promise<void> {
  const startedAt = new Date(Date.now() - 3 * 3_600_000);
  await db.collection(JOB_RUNS_COLLECTION).updateMany(
    {},
    {
      $set: {
        startedAt,
        finishedAt: new Date(startedAt.getTime() + 60_000),
      },
    },
  );
}

async function enableScheduledJobs(db: Db): Promise<void> {
  await Promise.all([
    db.collection<Record<string, unknown> & { _id: string }>(OPERATIONAL_SETTINGS_COLLECTION).insertOne({
      _id: JOBS_OPERATIONAL_SETTINGS_ID,
      digestEnabled: true,
    }),
    db.collection<Record<string, unknown> & { _id: string }>(OPERATIONAL_SETTINGS_COLLECTION).insertOne({
      _id: CRM_OPERATIONAL_SETTINGS_ID,
      ...DEFAULT_CRM_SETTINGS,
      crmVerificationEnabled: true,
    }),
  ]);
}

describe("ops:health command", () => {
  it("exits 0 when healthy, 2 when degraded and 1 when failing", { skip: !uri }, async () => {
    const client = await new MongoClient(uri!).connect();
    const dbName = `engage_ops_health_test_${crypto.randomUUID().replaceAll("-", "")}`;
    const db = client.db(dbName);
    const baseEnv = { MONGODB_URI: uri!, MONGODB_DB_NAME: dbName };
    try {
      await initializeDatabase(db);
      await seedJobRuns(db, [
        "governance-scheduler",
        "ballot-digest",
        "membership-verification",
      ]);

      // Removed environment variables have no effect. Without saved settings,
      // both job gates are off even when the old variables are set to "true".
      const removedDigestGate = ["ENGAGE", "DIGEST", "ENABLED"].join("_");
      const removedCrmGate = ["ENGAGE", "CRM", "VERIFICATION", "ENABLED"].join("_");
      const ignored = await runOpsHealth(["--json"], {
        ...baseEnv,
        [removedDigestGate]: "true",
        [removedCrmGate]: "true",
      });
      assert.equal(ignored.code, 2, ignored.stderr);
      const ignoredReport = JSON.parse(ignored.stdout) as {
        checks: Array<{ id: string; status: string; summary: string }>;
      };
      for (const id of ["digest", "membership-verification"]) {
        const entry = ignoredReport.checks.find((candidate) => candidate.id === id);
        assert.equal(entry?.status, "unknown", id);
        assert.match(entry?.summary ?? "", /turned off/, id);
      }

      await enableScheduledJobs(db);

      const healthy = await runOpsHealth(["--json"], {
        ...baseEnv,
        TURNSTILE_SECRET_KEY: "turnstile-secret-value-0123456789",
      });
      assert.equal(healthy.code, 0, healthy.stderr);
      const report = JSON.parse(healthy.stdout) as {
        status: string;
        checks: Array<{ id: string; status: string }>;
      };
      assert.equal(report.status, "healthy");
      assert.equal(healthy.stdout.includes("turnstile-secret-value"), false);

      await staleJobRuns(db);
      const degraded = await runOpsHealth(["--human"], baseEnv);
      assert.equal(degraded.code, 2, degraded.stderr);
      assert.match(degraded.stdout, /Engage operational health: degraded/);
      assert.match(degraded.stdout, /warn threshold is 1 hour/);

      // A saved administrator setting changes the observed state with no
      // redeploy and no environment variable.
      await db.collection<Record<string, unknown> & { _id: string }>(OPERATIONAL_SETTINGS_COLLECTION).insertOne({
        _id: OPERATIONAL_SETTINGS_ID,
        ...DEFAULT_OPERATIONAL_THRESHOLDS,
        schedulerWarnHours: 4,
        schedulerStaleHours: 30,
        digestWarnHours: 4,
        digestStaleHours: 30,
        verificationWarnHours: 4,
        verificationStaleHours: 30,
      });
      const lifted = await runOpsHealth(["--json"], baseEnv);
      assert.equal(lifted.code, 0, lifted.stderr);
      const liftedReport = JSON.parse(lifted.stdout) as {
        status: string;
        thresholds: Record<string, { source: string }>;
      };
      assert.equal(liftedReport.status, "healthy");
      assert.equal(liftedReport.thresholds.schedulerWarnHours.source, "settings");

      await db.collection(JOB_RUNS_COLLECTION).deleteMany({});
      const failing = await runOpsHealth(["--json"], baseEnv);
      assert.equal(failing.code, 1, failing.stderr);
      assert.equal(
        (JSON.parse(failing.stdout) as { status: string }).status,
        "failing",
      );
    } finally {
      await db.dropDatabase();
      await client.close();
    }
  });

  it("exits 1 when the database is unreachable", { skip: !uri }, async () => {
    const result = await runOpsHealth(["--json"], {
      MONGODB_URI: "mongodb://127.0.0.1:1/?directConnection=true&serverSelectionTimeoutMS=500",
      MONGODB_DB_NAME: "engage_unreachable",
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Operational health could not run/);
  });
});
