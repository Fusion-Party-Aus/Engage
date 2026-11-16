import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Db } from "mongodb";
import { getDatabase } from "./db.ts";
import { JOB_RUNS_COLLECTION, type JobName } from "./job-runs.ts";
import {
  CRM_OPERATIONAL_SETTINGS_ID,
  DEFAULT_CRM_SETTINGS,
  JOBS_OPERATIONAL_SETTINGS_ID,
  OPERATIONAL_SETTINGS_COLLECTION,
} from "./operational-settings.ts";
import { GET as getHealth } from "../pages/api/health.ts";
import type { PlatformEnv } from "./types.ts";

/**
 * `/api/health` stays a coarse probe: a database failure is 503, but a degraded
 * or failing job is 200 so container healthchecks do not restart-loop over a
 * missing external scheduler. Checks are status strings only.
 */

const env: PlatformEnv = {
  APP_MODE: "test",
  MONGODB_URI: "",
};

async function enableScheduledJobs(db: Db): Promise<void> {
  await Promise.all([
    db.collection<Record<string, unknown> & { _id: string }>(OPERATIONAL_SETTINGS_COLLECTION).updateOne(
      { _id: JOBS_OPERATIONAL_SETTINGS_ID },
      { $set: { digestEnabled: true } },
      { upsert: true },
    ),
    db.collection<Record<string, unknown> & { _id: string }>(OPERATIONAL_SETTINGS_COLLECTION).updateOne(
      { _id: CRM_OPERATIONAL_SETTINGS_ID },
      {
        $set: {
          ...DEFAULT_CRM_SETTINGS,
          crmVerificationEnabled: true,
        },
      },
      { upsert: true },
    ),
  ]);
}

async function health(
  overrides: PlatformEnv = env,
): Promise<{ response: Response; body: Record<string, any> }> {
  const response = await getHealth({
    locals: { runtime: { env: overrides } },
  } as never);
  return { response, body: (await response.json()) as Record<string, any> };
}

async function seedHealthyRuns(db: Db): Promise<void> {
  await db.collection(JOB_RUNS_COLLECTION).deleteMany({});
  await enableScheduledJobs(db);
  const now = new Date();
  const jobs: JobName[] = [
    "governance-scheduler",
    "ballot-digest",
    "membership-verification",
  ];
  for (const job of jobs) {
    await db.collection(JOB_RUNS_COLLECTION).insertOne({
      runId: `health-${job}`,
      job,
      mode: "apply",
      ok: true,
      startedAt: new Date(now.getTime() - 60_000),
      finishedAt: now,
      summary: { errors: 0, sent: 0, held: 0, processed: 0 },
    });
  }
}

describe("/api/health", () => {
  it("reports healthy job checks as coarse status strings", async () => {
    const db = await getDatabase(env);
    await seedHealthyRuns(db);

    const { response, body } = await health();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.status, "healthy");
    assert.deepEqual(body.checks, {
      database: "ok",
      governanceScheduler: "ok",
      jobs: "ok",
    });
    for (const value of Object.values(body.checks)) {
      assert.equal(typeof value, "string");
    }
    assert.equal(typeof body.latencyMs, "number");
  });

  it("returns 200 and degraded when a job needs attention", async () => {
    const db = await getDatabase(env);
    await db.collection(JOB_RUNS_COLLECTION).deleteMany({});
    await enableScheduledJobs(db);

    const { response, body } = await health();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.status, "failing");
    assert.equal(body.checks.database, "ok");
    assert.equal(body.checks.governanceScheduler, "failing");
    assert.equal(body.checks.jobs, "failing");
    // No counts, internals, identifiers or configuration names on a public probe.
    const serialised = JSON.stringify(body.checks);
    assert.doesNotMatch(serialised, /\d/);
  });

  it("keeps a database failure as 503", async () => {
    const { response, body } = await health({ APP_MODE: "production" });
    assert.equal(response.status, 503);
    assert.equal(body.ok, false);
    assert.equal(body.status, "unhealthy");
    assert.deepEqual(body.checks, { database: "error" });
  });
});
