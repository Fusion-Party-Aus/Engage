import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { logOperationalEvent } from "./resilience.ts";

/**
 * Durable job-run ledger (#39).
 *
 * Every authorised, scheduled run of a job records one small document so that
 * "did the job run, and did it work?" is answerable without grepping logs. The
 * ledger is deliberately boring:
 *
 * - counts and modes only — never a secret, token, provider response, member
 *   identifier or ballot choice;
 * - 90-day retention through a TTL index, because this is operational
 *   evidence, not a governance record;
 * - a ledger write can never turn a successful job into a failure. A job that
 *   ran is successful even if the ledger is unavailable; the ledger error is
 *   logged instead.
 *
 * The run is recorded only after the job has finished, so a crashed process
 * leaves no false "ok" entry.
 */

export const JOB_RUNS_COLLECTION = "job_runs";

/** Operational evidence only. Matches the TTL index on `startedAt`. */
export const JOB_RUN_RETENTION_DAYS = 90;

export type JobName =
  | "governance-scheduler"
  | "ballot-digest"
  | "membership-verification"
  | "notification-outbox-drain";

/** A dry-run is a real run for observability, but it performed no writes. */
export type JobRunMode = "apply" | "dry-run";

/** Small, non-sensitive counts and flags. */
export type JobRunSummary = Record<string, number | boolean | string>;

export interface JobRunRecord {
  runId: string;
  job: JobName;
  startedAt: Date;
  finishedAt: Date;
  ok: boolean;
  mode?: JobRunMode;
  summary?: JobRunSummary;
  /** Human message only. Never a secret, token or provider response. */
  error?: string;
}

export interface JobRunFilter {
  job?: JobName;
  mode?: JobRunMode;
}

export interface WithJobRunOptions<T> {
  /** Clock for `startedAt`; the job and its ledger share one notion of "now". */
  now?: Date;
  mode?: JobRunMode;
  /** Counts worth keeping. Return only non-sensitive values. */
  summarise?: (result: T) => JobRunSummary | undefined;
  /**
   * Decide the ledger success flag for a job that reports partial failures in
   * its result instead of throwing. Defaults to success.
   */
  ok?: (result: T) => boolean;
}

const MAXIMUM_ERROR_LENGTH = 300;

/**
 * Reduce an error to a short, human message.
 *
 * Provider responses and credentials must never reach the ledger, and an
 * exception message can carry either. Bearer values and long opaque tokens are
 * redacted; everything else is trimmed and length-capped. This is a backstop,
 * not permission to pass secrets through errors.
 */
export function jobErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const message = raw
    .replace(/bearer\s+[a-z0-9._~+/=-]+/gi, "bearer [redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAXIMUM_ERROR_LENGTH);
  return message || "Job failed without a message.";
}

/** The newest ledger entry for a job, optionally limited to one mode. */
export async function latestJobRun(
  db: Db,
  filter: JobRunFilter = {},
): Promise<JobRunRecord | null> {
  const [record] = await db
    .collection<JobRunRecord>(JOB_RUNS_COLLECTION)
    .find(filter)
    .sort({ startedAt: -1 })
    .limit(1)
    .toArray();
  return record ?? null;
}

/** Indexes required by the ledger. Safe to call repeatedly. */
export async function ensureJobRunIndexes(db: Db): Promise<void> {
  await db.collection(JOB_RUNS_COLLECTION).createIndex(
    { startedAt: 1 },
    {
      expireAfterSeconds: JOB_RUN_RETENTION_DAYS * 24 * 60 * 60,
      name: "job_run_expiry",
    },
  );
  await db.collection(JOB_RUNS_COLLECTION).createIndex(
    { job: 1, mode: 1, startedAt: -1 },
    { name: "job_mode_started" },
  );
}

/**
 * Write one ledger entry, swallowing and logging any ledger failure.
 *
 * `false` means the entry was not written; it never means the job failed.
 */
async function recordJobRunSafely(
  db: Db,
  entry: JobRunRecord,
): Promise<boolean> {
  try {
    await db.collection(JOB_RUNS_COLLECTION).insertOne(entry);
    return true;
  } catch (error) {
    logOperationalEvent("error", "job_run_ledger_write_failed", {
      job: entry.job,
      runId: entry.runId,
      message: jobErrorMessage(error),
    });
    return false;
  }
}

/**
 * Run a job and record exactly one ledger entry for the attempt.
 *
 * - The job's result is returned unchanged.
 * - The job's own error is always rethrown to the caller.
 * - A ledger failure is logged and ignored, so observability can never break
 *   the thing it observes.
 */
export async function withJobRun<T>(
  db: Db,
  job: JobName,
  run: () => Promise<T>,
  options: WithJobRunOptions<T> = {},
): Promise<T> {
  const startedAt = options.now ?? new Date();
  const runId = randomUUID();

  const finish = async (
    ok: boolean,
    details: { summary?: JobRunSummary; error?: unknown },
  ): Promise<void> => {
    await recordJobRunSafely(db, {
      runId,
      job,
      startedAt,
      finishedAt: new Date(),
      ok,
      ...(options.mode ? { mode: options.mode } : {}),
      ...(details.summary && Object.keys(details.summary).length > 0
        ? { summary: details.summary }
        : {}),
      ...(details.error === undefined
        ? {}
        : { error: jobErrorMessage(details.error) }),
    });
  };

  try {
    const result = await run();
    let summary: JobRunSummary | undefined;
    if (options.summarise) {
      try {
        summary = options.summarise(result);
      } catch (error) {
        // A broken summary must not turn a successful job into a failure.
        logOperationalEvent("error", "job_run_summary_failed", {
          job,
          runId,
          message: jobErrorMessage(error),
        });
      }
    }
    let ok = true;
    if (options.ok) {
      try {
        ok = options.ok(result);
      } catch (error) {
        // A broken success check must not change the job's result either.
        logOperationalEvent("error", "job_run_ok_check_failed", {
          job,
          runId,
          message: jobErrorMessage(error),
        });
      }
    }
    await finish(ok, { summary });
    return result;
  } catch (error) {
    await finish(false, { error });
    throw error;
  }
}
