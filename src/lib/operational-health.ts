import type { Db } from "mongodb";
import {
  JOB_RUN_RETENTION_DAYS,
  latestJobRun,
  type JobName,
  type JobRunRecord,
} from "./job-runs.ts";
import { VERIFICATION_ATTEMPTS } from "./membership-verification.ts";
import { turnstileConfiguration } from "./turnstile.ts";
import { crmVerificationEnabled } from "./underground-crm.ts";
import type { PlatformEnv } from "./types.ts";

/**
 * Operational health for scheduled work (#39).
 *
 * This is the evidence behind `npm run ops:health` and the coarse checks on
 * `/api/health`. It answers operational questions — did the job run, is closure
 * happening, is email delivering, is Turnstile protecting sign-in — without
 * exposing a secret, a provider response, a member identifier or a ballot
 * choice. Every check returns a plain-language message and one next action.
 *
 * Thresholds are named in the report and configurable by environment variable,
 * so an operator can see the rule that produced a state rather than guessing.
 * A check that cannot run reports `unknown`; it is never silently `ok`.
 */

export type OperationalHealthStatus = "ok" | "degraded" | "failing" | "unknown";

export type OperationalCheckId =
  | "governance-scheduler"
  | "ballot-deadlines"
  | "digest"
  | "membership-verification"
  | "email-delivery"
  | "turnstile";

export interface OperationalThreshold {
  /** Stable name; also the environment variable that can override it. */
  name: string;
  hours: number;
  source: "default" | "environment";
}

export interface OperationalCheck {
  id: OperationalCheckId;
  status: OperationalHealthStatus;
  /** Short, human, count-only message. Never contains an identifier. */
  summary: string;
  nextAction: string;
  /** The threshold this check applied, when it applied one. */
  threshold?: string;
}

export interface OperationalHealthReport {
  status: "healthy" | "degraded" | "failing" | "unknown";
  /** ISO timestamp the report was evaluated. */
  generatedAt: string;
  /** Ledger retention, so an operator knows how far back evidence goes. */
  jobRunRetentionDays: number;
  thresholds: Record<string, OperationalThreshold>;
  checks: OperationalCheck[];
}

export const GOVERNANCE_SCHEDULER_WARN_HOURS = 2;
export const GOVERNANCE_SCHEDULER_STALE_HOURS = 26;
export const DIGEST_WARN_HOURS = 1;
export const DIGEST_STALE_HOURS = 24;
export const MEMBERSHIP_VERIFICATION_WARN_HOURS = 2;
export const MEMBERSHIP_VERIFICATION_STALE_HOURS = 24;
export const BALLOT_CLOSURE_GRACE_HOURS = 2;
export const EMAIL_DELIVERY_WINDOW_HOURS = 24;

export const OPERATIONAL_THRESHOLD_ENV = {
  governanceSchedulerWarnHours: "GOVERNANCE_SCHEDULER_WARN_HOURS",
  governanceSchedulerStaleHours: "GOVERNANCE_SCHEDULER_STALE_HOURS",
  digestWarnHours: "DIGEST_WARN_HOURS",
  digestStaleHours: "DIGEST_STALE_HOURS",
  membershipVerificationWarnHours: "MEMBERSHIP_VERIFICATION_WARN_HOURS",
  membershipVerificationStaleHours: "MEMBERSHIP_VERIFICATION_STALE_HOURS",
  ballotClosureGraceHours: "BALLOT_CLOSURE_GRACE_HOURS",
  emailDeliveryWindowHours: "EMAIL_DELIVERY_WINDOW_HOURS",
} as const;

const HOUR_MS = 3_600_000;

function threshold(
  env: PlatformEnv,
  name: string,
  fallback: number,
): OperationalThreshold {
  const raw = String((env as Record<string, unknown>)[name] ?? "").trim();
  const parsed = Number(raw);
  if (raw && Number.isFinite(parsed) && parsed > 0) {
    return { name, hours: parsed, source: "environment" };
  }
  return { name, hours: fallback, source: "default" };
}

function hoursBetween(from: Date, to: Date): number {
  return Math.max(0, (to.getTime() - from.getTime()) / HOUR_MS);
}

function describeAge(hours: number): string {
  if (hours < 1) return "less than an hour ago";
  const rounded = Math.round(hours);
  return `${rounded} hour${rounded === 1 ? "" : "s"} ago`;
}

function hourLabel(hours: number): string {
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

function countSummary(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function errorsIn(record: JobRunRecord): number {
  const reported = record.summary?.errors;
  return typeof reported === "number" ? countSummary(reported) : 0;
}

const SEVERITY: Record<OperationalHealthStatus, number> = {
  ok: 0,
  unknown: 1,
  degraded: 2,
  failing: 3,
};

/** Overall state is the worst check: failing > degraded > unknown > ok. */
export function overallOperationalStatus(
  checks: OperationalCheck[],
): OperationalHealthReport["status"] {
  const worst = checks.reduce<OperationalHealthStatus>(
    (current, check) =>
      SEVERITY[check.status] > SEVERITY[current] ? check.status : current,
    "ok",
  );
  return worst === "ok" ? "healthy" : worst;
}

/** `0` healthy, `1` failing, `2` degraded or unknown. */
export function operationalHealthExitCode(
  report: OperationalHealthReport,
): 0 | 1 | 2 {
  if (report.status === "healthy") return 0;
  if (report.status === "failing") return 1;
  return 2;
}

interface RecencyThresholds {
  warn: OperationalThreshold;
  fail: OperationalThreshold;
}

interface JobRecencyOptions {
  id: OperationalCheckId;
  job: JobName;
  thresholds: RecencyThresholds;
  missingSummary: string;
  missingAction: string;
  failedAction: string;
  invalidAction: string;
}

/**
 * Shared two-tier recency rule for a scheduled job.
 *
 * A job that runs every 15 minutes cannot be judged healthy for a day: a single
 * missed tick is normal jitter, but a complete outage must be visible quickly.
 * The warn threshold is a handful of ticks; the fail threshold is the point at
 * which the job's guarantee has definitely not been met.
 *
 * States: no run → failing; older than fail → failing; last run failed →
 * failing; older than warn → degraded; otherwise ok. A warn threshold that is
 * not below the fail threshold is a configuration error, reported as unknown
 * instead of silently trusting a value that could hide an outage.
 */
async function jobRecencyCheck(
  db: Db,
  now: Date,
  options: JobRecencyOptions,
): Promise<OperationalCheck> {
  const { warn, fail } = options.thresholds;
  if (!(warn.hours < fail.hours)) {
    return {
      id: options.id,
      status: "unknown",
      summary: `The warn threshold (${hourLabel(warn.hours)}) must be less than the fail threshold (${hourLabel(fail.hours)}).`,
      nextAction: options.invalidAction,
      threshold: fail.name,
    };
  }

  const last = await latestJobRun(db, { job: options.job, mode: "apply" });
  if (!last) {
    return {
      id: options.id,
      status: "failing",
      summary: options.missingSummary,
      nextAction: options.missingAction,
      threshold: fail.name,
    };
  }
  const ageHours = hoursBetween(new Date(last.startedAt), now);
  if (ageHours > fail.hours) {
    return {
      id: options.id,
      status: "failing",
      summary: `Last run was ${describeAge(ageHours)}; the fail threshold is ${hourLabel(fail.hours)}.`,
      nextAction: options.missingAction,
      threshold: fail.name,
    };
  }
  if (!last.ok) {
    return {
      id: options.id,
      status: "failing",
      summary: `The last run (${describeAge(ageHours)}) failed.`,
      nextAction: options.failedAction,
      threshold: fail.name,
    };
  }
  if (ageHours > warn.hours) {
    return {
      id: options.id,
      status: "degraded",
      summary: `Last run was ${describeAge(ageHours)}; the warn threshold is ${hourLabel(warn.hours)} and the fail threshold is ${hourLabel(fail.hours)}.`,
      nextAction: options.missingAction,
      threshold: fail.name,
    };
  }
  return {
    id: options.id,
    status: "ok",
    summary: `Last run completed ${describeAge(ageHours)}.`,
    nextAction: "No action needed.",
    threshold: fail.name,
  };
}

function invalidThresholdAction(warnName: string, failName: string): string {
  return `Correct ${warnName} or ${failName} so the warn threshold is below the fail threshold.`;
}

async function governanceSchedulerCheck(
  db: Db,
  now: Date,
  thresholds: RecencyThresholds,
): Promise<OperationalCheck> {
  const base = await jobRecencyCheck(db, now, {
    id: "governance-scheduler",
    job: "governance-scheduler",
    thresholds,
    missingSummary: "No governance scheduler run has been recorded.",
    missingAction:
      "Enable the governance scheduler in the external scheduler and run it with --apply.",
    failedAction:
      "Read the scheduler report and log, fix the cause, then run it with --apply.",
    invalidAction: invalidThresholdAction(
      thresholds.warn.name,
      thresholds.fail.name,
    ),
  });
  if (base.status !== "ok") return base;

  const last = await latestJobRun(db, {
    job: "governance-scheduler",
    mode: "apply",
  });
  const errors = last ? errorsIn(last) : 0;
  if (errors > 0) {
    return {
      ...base,
      status: "degraded",
      summary: `The last run completed, but ${errors} matter${errors === 1 ? "" : "s"} could not be processed.`,
      nextAction:
        "Review the scheduler report blockers and errors; they need an officer decision or a data fix.",
    };
  }
  return base;
}

async function ballotDeadlineCheck(
  db: Db,
  now: Date,
  grace: OperationalThreshold,
): Promise<OperationalCheck> {
  const overdue = {
    stage: "decide",
    ballotClosesAt: { $lte: now },
    ballotClosedAt: { $exists: false },
  };
  const [passed, beyondGrace] = await Promise.all([
    db.collection("proposals").countDocuments(overdue),
    db.collection("proposals").countDocuments({
      ...overdue,
      ballotClosesAt: { $lte: new Date(now.getTime() - grace.hours * HOUR_MS) },
    }),
  ]);
  if (beyondGrace > 0) {
    return {
      id: "ballot-deadlines",
      status: "failing",
      summary: `${beyondGrace} ballot${beyondGrace === 1 ? "" : "s"} passed the deadline more than ${grace.hours} hours ago without a recorded closure.`,
      nextAction:
        "Run the governance scheduler with --apply and check its report. Closure records the deadline; it does not record a result.",
      threshold: grace.name,
    };
  }
  if (passed > 0) {
    return {
      id: "ballot-deadlines",
      status: "degraded",
      summary: `${passed} ballot${passed === 1 ? "" : "s"} reached the deadline within the last ${grace.hours} hours and await closure.`,
      nextAction:
        "No action if the scheduler is running. If this persists for an hour, check the scheduler.",
      threshold: grace.name,
    };
  }
  return {
    id: "ballot-deadlines",
    status: "ok",
    summary: "No ballot deadline has passed without a recorded closure.",
    nextAction: "No action needed.",
    threshold: grace.name,
  };
}

async function digestCheck(
  db: Db,
  env: PlatformEnv,
  now: Date,
  thresholds: RecencyThresholds,
): Promise<OperationalCheck> {
  if (env.ENGAGE_DIGEST_ENABLED !== "true") {
    return {
      id: "digest",
      status: "unknown",
      summary: "Ballot digest email is disabled in this deployment.",
      nextAction:
        "Set ENGAGE_DIGEST_ENABLED=true and schedule POST /api/email/digest to send ballot reminders.",
    };
  }
  const base = await jobRecencyCheck(db, now, {
    id: "digest",
    job: "ballot-digest",
    thresholds,
    missingSummary: "No digest run has been recorded.",
    missingAction:
      "Schedule POST /api/email/digest in the external scheduler with ENGAGE_CRON_SECRET.",
    failedAction:
      "Inspect delivery holds in email administration, then run the digest again.",
    invalidAction: invalidThresholdAction(
      thresholds.warn.name,
      thresholds.fail.name,
    ),
  });
  if (base.status !== "ok") return base;

  const last = await latestJobRun(db, { job: "ballot-digest", mode: "apply" });
  const held = last?.summary?.held;
  if (typeof held === "number" && held > 0) {
    return {
      ...base,
      status: "degraded",
      summary: `${held} digest message${held === 1 ? " was" : "s were"} held by the email provider in the last run.`,
      nextAction:
        "Check email delivery and provider status before the next reminder cycle.",
    };
  }
  return base;
}

async function membershipVerificationCheck(
  db: Db,
  env: PlatformEnv,
  now: Date,
  thresholds: RecencyThresholds,
): Promise<OperationalCheck> {
  if (!crmVerificationEnabled(env as Record<string, string | undefined>)) {
    return {
      id: "membership-verification",
      status: "unknown",
      summary: "Automatic membership verification is not enabled.",
      nextAction:
        "No action while the feature is off. Enable ENGAGE_CRM_VERIFICATION_ENABLED and schedule the endpoint to keep memberships current.",
    };
  }
  const base = await jobRecencyCheck(db, now, {
    id: "membership-verification",
    job: "membership-verification",
    thresholds,
    missingSummary: "No membership verification run has been recorded.",
    missingAction:
      "Schedule POST /api/cron/membership-verification in the external scheduler with its cron secret.",
    failedAction:
      "Check CRM availability and configuration, then run the cycle again. Existing memberships are unchanged by a failure.",
    invalidAction: invalidThresholdAction(
      thresholds.warn.name,
      thresholds.fail.name,
    ),
  });
  if (base.status !== "ok") return base;

  const due = await db.collection(VERIFICATION_ATTEMPTS).countDocuments({
    status: { $in: ["queued", "retrying"] },
    nextAttemptAt: { $lte: now },
  });
  if (due > 0) {
    return {
      ...base,
      status: "degraded",
      summary: `${due} verification attempt${due === 1 ? " is" : "s are"} due.`,
      nextAction:
        "The next scheduled cycle will process them. If the backlog grows, check CRM availability.",
    };
  }
  return base;
}

/**
 * Outbox statuses are the existing delivery evidence: `failed` and `held` are
 * written by the digest and admin test paths, and counting them is cheap because
 * the outbox is indexed by `memberId, createdAt`.
 *
 * Bounces are deliberately not counted here. The Resend webhook records them as
 * `bouncedAt` and suppresses the address, so a recent bounce is already-resolved
 * state rather than a delivery fault needing an operator action.
 */
async function emailDeliveryCheck(
  db: Db,
  now: Date,
  window: OperationalThreshold,
): Promise<OperationalCheck> {
  const since = new Date(now.getTime() - window.hours * HOUR_MS);
  const [failed, held] = await Promise.all([
    db
      .collection("engagement_email_outbox")
      .countDocuments({ status: "failed", createdAt: { $gte: since } }),
    db
      .collection("engagement_email_outbox")
      .countDocuments({ status: "held", createdAt: { $gte: since } }),
  ]);
  if (failed + held > 0) {
    const parts = [
      ...(failed > 0 ? [`${failed} failed`] : []),
      ...(held > 0 ? [`${held} held`] : []),
    ];
    return {
      id: "email-delivery",
      status: "degraded",
      summary: `${parts.join(" and ")} message${failed + held === 1 ? "" : "s"} in the last ${window.hours} hours.`,
      nextAction:
        "Review email delivery in administration and check the provider before the next send.",
      threshold: window.name,
    };
  }
  return {
    id: "email-delivery",
    status: "ok",
    summary: `No failed or held messages in the last ${window.hours} hours.`,
    nextAction: "No action needed.",
    threshold: window.name,
  };
}

function turnstileCheck(env: PlatformEnv): OperationalCheck {
  const configuration = turnstileConfiguration(env);
  const production = env.APP_MODE === "production";
  if (configuration.state === "enforced") {
    return {
      id: "turnstile",
      status: "ok",
      summary: "Turnstile protects sign-in and public submission.",
      nextAction: "No action needed.",
    };
  }
  if (configuration.state === "misconfigured") {
    return {
      id: "turnstile",
      status: production ? "failing" : "degraded",
      summary:
        "Turnstile enforcement is requested but its keys are incomplete, so protected actions fail closed.",
      nextAction:
        "Set the Turnstile secret and public site key in the deployment environment.",
    };
  }
  if (production) {
    return {
      id: "turnstile",
      status: "degraded",
      summary: "Turnstile is disabled in production.",
      nextAction:
        "Enable Turnstile unless this is a deliberate incident control, and restore it afterwards.",
    };
  }
  return {
    id: "turnstile",
    status: "ok",
    summary: "Turnstile is not enforced outside production.",
    nextAction: "No action needed.",
  };
}

async function guarded(
  id: OperationalCheckId,
  run: () => Promise<OperationalCheck>,
): Promise<OperationalCheck> {
  try {
    return await run();
  } catch {
    return {
      id,
      status: "unknown",
      summary: "This check could not run.",
      nextAction:
        "Check database connectivity, then run npm run ops:health again.",
    };
  }
}

export async function evaluateOperationalHealth(input: {
  db: Db;
  env: PlatformEnv;
  now?: Date;
}): Promise<OperationalHealthReport> {
  const { db, env } = input;
  const now = input.now ?? new Date();
  const thresholds = {
    governanceSchedulerWarnHours: threshold(
      env,
      OPERATIONAL_THRESHOLD_ENV.governanceSchedulerWarnHours,
      GOVERNANCE_SCHEDULER_WARN_HOURS,
    ),
    governanceSchedulerStaleHours: threshold(
      env,
      OPERATIONAL_THRESHOLD_ENV.governanceSchedulerStaleHours,
      GOVERNANCE_SCHEDULER_STALE_HOURS,
    ),
    digestWarnHours: threshold(
      env,
      OPERATIONAL_THRESHOLD_ENV.digestWarnHours,
      DIGEST_WARN_HOURS,
    ),
    digestStaleHours: threshold(
      env,
      OPERATIONAL_THRESHOLD_ENV.digestStaleHours,
      DIGEST_STALE_HOURS,
    ),
    membershipVerificationWarnHours: threshold(
      env,
      OPERATIONAL_THRESHOLD_ENV.membershipVerificationWarnHours,
      MEMBERSHIP_VERIFICATION_WARN_HOURS,
    ),
    membershipVerificationStaleHours: threshold(
      env,
      OPERATIONAL_THRESHOLD_ENV.membershipVerificationStaleHours,
      MEMBERSHIP_VERIFICATION_STALE_HOURS,
    ),
    ballotClosureGraceHours: threshold(
      env,
      OPERATIONAL_THRESHOLD_ENV.ballotClosureGraceHours,
      BALLOT_CLOSURE_GRACE_HOURS,
    ),
    emailDeliveryWindowHours: threshold(
      env,
      OPERATIONAL_THRESHOLD_ENV.emailDeliveryWindowHours,
      EMAIL_DELIVERY_WINDOW_HOURS,
    ),
  };

  const checks = await Promise.all([
    guarded("governance-scheduler", () =>
      governanceSchedulerCheck(db, now, {
        warn: thresholds.governanceSchedulerWarnHours,
        fail: thresholds.governanceSchedulerStaleHours,
      }),
    ),
    guarded("ballot-deadlines", () =>
      ballotDeadlineCheck(db, now, thresholds.ballotClosureGraceHours),
    ),
    guarded("digest", () =>
      digestCheck(db, env, now, {
        warn: thresholds.digestWarnHours,
        fail: thresholds.digestStaleHours,
      }),
    ),
    guarded("membership-verification", () =>
      membershipVerificationCheck(db, env, now, {
        warn: thresholds.membershipVerificationWarnHours,
        fail: thresholds.membershipVerificationStaleHours,
      }),
    ),
    guarded("email-delivery", () =>
      emailDeliveryCheck(db, now, thresholds.emailDeliveryWindowHours),
    ),
    guardTurnstile(env),
  ]);

  return {
    status: overallOperationalStatus(checks),
    generatedAt: now.toISOString(),
    jobRunRetentionDays: JOB_RUN_RETENTION_DAYS,
    thresholds,
    checks,
  };
}

function guardTurnstile(env: PlatformEnv): OperationalCheck {
  try {
    return turnstileCheck(env);
  } catch {
    return {
      id: "turnstile",
      status: "unknown",
      summary: "This check could not run.",
      nextAction:
        "Check Turnstile configuration in the deployment environment.",
    };
  }
}

/** Human-readable summary for `npm run ops:health -- --human`. */
export function renderOperationalHealth(
  report: OperationalHealthReport,
): string {
  const lines = [`Engage operational health: ${report.status}`];
  for (const check of report.checks) {
    lines.push(`  ${check.status.toUpperCase().padEnd(8)} ${check.id}`);
    lines.push(`           ${check.summary}`);
    if (check.status !== "ok") lines.push(`           Next: ${check.nextAction}`);
  }
  return `${lines.join("\n")}\n`;
}
