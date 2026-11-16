import type { Db } from "mongodb";
import {
  JOB_RUN_RETENTION_DAYS,
  latestJobRun,
  type JobName,
  type JobRunRecord,
} from "./job-runs.ts";
import { VERIFICATION_ATTEMPTS } from "./membership-verification.ts";
import {
  getOperationalSettingsState,
  OPERATIONAL_THRESHOLD_BY_KEY,
  OPERATIONAL_THRESHOLD_FIELDS,
  type OperationalSettingsState,
  type OperationalThresholdKey,
} from "./operational-settings.ts";
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
 * Thresholds are an administrator setting (#128). The report names each value
 * and whether it came from the saved setting or the documented default, so an
 * operator can see the rule that produced a state rather than guessing. A check
 * that cannot run — including one whose saved thresholds are invalid — reports
 * `unknown`; it is never silently `ok`.
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
  /** Plain-language name shown in the report. */
  name: string;
  hours: number;
  source: "default" | "settings";
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
  thresholds: Record<OperationalThresholdKey, OperationalThreshold>;
  checks: OperationalCheck[];
}

const HOUR_MS = 3_600_000;

const CORRECT_SETTINGS_ACTION =
  "Open Platform settings and correct the operational thresholds.";
const READ_FAILED_SUMMARY =
  "The saved operational thresholds could not be read.";

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
  /** Set when the saved thresholds cannot be trusted. */
  invalidProblem?: string;
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
 * failing; older than warn → degraded; otherwise ok. A saved threshold that is
 * invalid, or a warn value that is not below the fail value, is reported as
 * unknown instead of silently trusting a value that could hide an outage.
 */
async function jobRecencyCheck(
  db: Db,
  now: Date,
  options: JobRecencyOptions,
): Promise<OperationalCheck> {
  const { warn, fail } = options.thresholds;
  if (options.invalidProblem) {
    return {
      id: options.id,
      status: "unknown",
      summary: options.invalidProblem,
      nextAction: options.invalidAction,
      threshold: fail.name,
    };
  }
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

async function governanceSchedulerCheck(
  db: Db,
  now: Date,
  thresholds: RecencyThresholds,
  invalidProblem?: string,
): Promise<OperationalCheck> {
  const base = await jobRecencyCheck(db, now, {
    id: "governance-scheduler",
    job: "governance-scheduler",
    thresholds,
    invalidProblem,
    missingSummary: "No governance scheduler run has been recorded.",
    missingAction:
      "Enable the governance scheduler in the external scheduler and run it with --apply.",
    failedAction:
      "Read the scheduler report and log, fix the cause, then run it with --apply.",
    invalidAction: CORRECT_SETTINGS_ACTION,
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
  invalidProblem?: string,
): Promise<OperationalCheck> {
  if (invalidProblem) {
    return {
      id: "ballot-deadlines",
      status: "unknown",
      summary: invalidProblem,
      nextAction: CORRECT_SETTINGS_ACTION,
      threshold: grace.name,
    };
  }

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
  invalidProblem?: string,
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
    invalidProblem,
    missingSummary: "No digest run has been recorded.",
    missingAction:
      "Schedule POST /api/email/digest in the external scheduler with ENGAGE_CRON_SECRET.",
    failedAction:
      "Inspect delivery holds in email administration, then run the digest again.",
    invalidAction: CORRECT_SETTINGS_ACTION,
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
  invalidProblem?: string,
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
    invalidProblem,
    missingSummary: "No membership verification run has been recorded.",
    missingAction:
      "Schedule POST /api/cron/membership-verification in the external scheduler with its cron secret.",
    failedAction:
      "Check CRM availability and configuration, then run the cycle again. Existing memberships are unchanged by a failure.",
    invalidAction: CORRECT_SETTINGS_ACTION,
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
  invalidProblem?: string,
): Promise<OperationalCheck> {
  if (invalidProblem) {
    return {
      id: "email-delivery",
      status: "unknown",
      summary: invalidProblem,
      nextAction: CORRECT_SETTINGS_ACTION,
      threshold: window.name,
    };
  }

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

function invalidStoredSummary(keys: OperationalThresholdKey[]): string {
  const names = keys.map(
    (key) => OPERATIONAL_THRESHOLD_BY_KEY.get(key)?.reportName ?? key,
  );
  return names.length === 1
    ? `The saved ${names[0]} is not valid.`
    : `The saved ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} are not valid.`;
}

function thresholdProblem(
  state: OperationalSettingsState,
  keys: OperationalThresholdKey[],
): string | undefined {
  if (state.readFailed) return READ_FAILED_SUMMARY;
  const invalid = keys.filter((key) => state.invalidFields.includes(key));
  return invalid.length > 0 ? invalidStoredSummary(invalid) : undefined;
}

function reportThresholds(
  state: OperationalSettingsState,
): Record<OperationalThresholdKey, OperationalThreshold> {
  return Object.fromEntries(
    OPERATIONAL_THRESHOLD_FIELDS.map((field) => [
      field.key,
      {
        name: field.reportName,
        hours: state.values[field.key],
        // A saved value that cannot be trusted is reported as the default it
        // falls back to, and the check itself reports unknown. It is never
        // presented as an applied setting.
        source: state.invalidFields.includes(field.key)
          ? "default"
          : state.source,
      } satisfies OperationalThreshold,
    ]),
  ) as Record<OperationalThresholdKey, OperationalThreshold>;
}

export async function evaluateOperationalHealth(input: {
  db: Db;
  env: PlatformEnv;
  now?: Date;
}): Promise<OperationalHealthReport> {
  const { db, env } = input;
  const now = input.now ?? new Date();
  const settings = await getOperationalSettingsState(db);
  const thresholds = reportThresholds(settings);

  const schedulerProblem = thresholdProblem(settings, [
    "schedulerWarnHours",
    "schedulerStaleHours",
  ]);
  const digestProblem = thresholdProblem(settings, [
    "digestWarnHours",
    "digestStaleHours",
  ]);
  const verificationProblem = thresholdProblem(settings, [
    "verificationWarnHours",
    "verificationStaleHours",
  ]);
  const ballotsProblem = thresholdProblem(settings, ["ballotClosureGraceHours"]);
  const emailProblem = thresholdProblem(settings, ["emailDeliveryWindowHours"]);

  const checks = await Promise.all([
    guarded("governance-scheduler", () =>
      governanceSchedulerCheck(
        db,
        now,
        {
          warn: thresholds.schedulerWarnHours,
          fail: thresholds.schedulerStaleHours,
        },
        schedulerProblem,
      ),
    ),
    guarded("ballot-deadlines", () =>
      ballotDeadlineCheck(
        db,
        now,
        thresholds.ballotClosureGraceHours,
        ballotsProblem,
      ),
    ),
    guarded("digest", () =>
      digestCheck(
        db,
        env,
        now,
        {
          warn: thresholds.digestWarnHours,
          fail: thresholds.digestStaleHours,
        },
        digestProblem,
      ),
    ),
    guarded("membership-verification", () =>
      membershipVerificationCheck(
        db,
        env,
        now,
        {
          warn: thresholds.verificationWarnHours,
          fail: thresholds.verificationStaleHours,
        },
        verificationProblem,
      ),
    ),
    guarded("email-delivery", () =>
      emailDeliveryCheck(
        db,
        now,
        thresholds.emailDeliveryWindowHours,
        emailProblem,
      ),
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
