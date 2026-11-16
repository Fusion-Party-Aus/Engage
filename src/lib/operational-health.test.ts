import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Db } from "mongodb";
import { createMemoryDb } from "./db.ts";
import {
  JOB_RUNS_COLLECTION,
  type JobName,
  type JobRunMode,
  type JobRunRecord,
} from "./job-runs.ts";
import {
  evaluateOperationalHealth,
  operationalHealthExitCode,
  overallOperationalStatus,
  renderOperationalHealth,
  type OperationalCheck,
  type OperationalHealthReport,
} from "./operational-health.ts";
import {
  DEFAULT_OPERATIONAL_THRESHOLDS,
  OPERATIONAL_SETTINGS_COLLECTION,
  OPERATIONAL_SETTINGS_ID,
  type OperationalThresholdValues,
} from "./operational-settings.ts";
import { VERIFICATION_ATTEMPTS } from "./membership-verification.ts";
import type { PlatformEnv } from "./types.ts";

const NOW = new Date("2026-11-15T12:00:00.000Z");
const HOUR = 3_600_000;

const baseEnv: PlatformEnv = {
  APP_MODE: "test",
  ENGAGE_DIGEST_ENABLED: "true",
  ENGAGE_CRM_VERIFICATION_ENABLED: "true",
};

const defaults = DEFAULT_OPERATIONAL_THRESHOLDS;

async function seedRun(
  db: Db,
  job: JobName,
  options: {
    hoursAgo: number;
    ok?: boolean;
    mode?: JobRunMode;
    summary?: Record<string, number | boolean | string>;
    error?: string;
  },
): Promise<void> {
  const startedAt = new Date(NOW.getTime() - options.hoursAgo * HOUR);
  const record: JobRunRecord = {
    runId: `${job}-${options.hoursAgo}-${options.mode ?? "apply"}`,
    job,
    startedAt,
    finishedAt: new Date(startedAt.getTime() + 1_000),
    ok: options.ok ?? true,
    mode: options.mode ?? "apply",
    ...(options.summary ? { summary: options.summary } : {}),
    ...(options.error ? { error: options.error } : {}),
  };
  await db.collection(JOB_RUNS_COLLECTION).insertOne(record);
}

/** Store thresholds the way the admin form does, bypassing validation. */
async function seedSettings(
  db: Db,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await db.collection<Record<string, unknown> & { _id: string }>(OPERATIONAL_SETTINGS_COLLECTION).insertOne({
    _id: OPERATIONAL_SETTINGS_ID,
    ...defaults,
    ...overrides,
    updatedAt: NOW,
    updatedBy: "admin",
    updatedByName: "Administrator",
  });
}

async function healthyDatabase(): Promise<Db> {
  const db = createMemoryDb();
  await seedRun(db, "governance-scheduler", {
    hoursAgo: 1,
    summary: { advanced: 0, closed: 0, skipped: 0, blockers: 0, errors: 0 },
  });
  await seedRun(db, "ballot-digest", {
    hoursAgo: 1,
    summary: { disabled: false, sent: 0, held: 0 },
  });
  await seedRun(db, "membership-verification", {
    hoursAgo: 1,
    summary: { processed: 0, verified: 0, reviews: 0, retried: 0, blocked: 0, reconciled: 0 },
  });
  return db;
}

async function evaluate(
  db: Db,
  env: PlatformEnv = baseEnv,
): Promise<OperationalHealthReport> {
  return evaluateOperationalHealth({ db, env, now: NOW });
}

function check(report: OperationalHealthReport, id: string): OperationalCheck {
  const found = report.checks.find((candidate) => candidate.id === id);
  assert.ok(found, `missing check ${id}`);
  return found;
}

describe("operational health evaluation", () => {
  it("reports every check green with default thresholds on a healthy deployment", async () => {
    const report = await evaluate(await healthyDatabase());

    assert.equal(report.status, "healthy");
    assert.deepEqual(
      report.checks.map((entry) => entry.id),
      [
        "governance-scheduler",
        "ballot-deadlines",
        "digest",
        "membership-verification",
        "email-delivery",
        "turnstile",
      ],
    );
    for (const entry of report.checks) {
      assert.equal(entry.status, "ok", entry.summary);
      assert.ok(entry.summary.length > 0);
      assert.ok(entry.nextAction.length > 0);
    }
    assert.equal(report.jobRunRetentionDays, 90);
    assert.deepEqual(report.thresholds.schedulerWarnHours, {
      name: "governance scheduler warn threshold",
      hours: defaults.schedulerWarnHours,
      source: "default",
    });
    assert.deepEqual(report.thresholds.schedulerStaleHours, {
      name: "governance scheduler fail threshold",
      hours: defaults.schedulerStaleHours,
      source: "default",
    });
    assert.equal(
      report.thresholds.digestWarnHours.hours,
      defaults.digestWarnHours,
    );
    assert.equal(report.thresholds.digestStaleHours.hours, defaults.digestStaleHours);
    assert.equal(
      report.thresholds.verificationWarnHours.hours,
      defaults.verificationWarnHours,
    );
    assert.equal(
      check(report, "governance-scheduler").threshold,
      "governance scheduler fail threshold",
    );
    assert.equal(
      Object.values(report.thresholds).every((value) => value.source === "default"),
      true,
    );
  });

  it("applies the governance scheduler warn and fail boundaries exactly", async () => {
    const fresh = createMemoryDb();
    await seedRun(fresh, "governance-scheduler", {
      hoursAgo: defaults.schedulerWarnHours,
    });
    assert.equal(check(await evaluate(fresh), "governance-scheduler").status, "ok");

    const warned = createMemoryDb();
    await seedRun(warned, "governance-scheduler", {
      hoursAgo: defaults.schedulerWarnHours + 0.1,
    });
    const warnedCheck = check(await evaluate(warned), "governance-scheduler");
    assert.equal(warnedCheck.status, "degraded");
    assert.match(
      warnedCheck.summary,
      new RegExp(`warn threshold is ${defaults.schedulerWarnHours} hours`),
    );

    const atFail = createMemoryDb();
    await seedRun(atFail, "governance-scheduler", {
      hoursAgo: defaults.schedulerStaleHours,
    });
    assert.equal(check(await evaluate(atFail), "governance-scheduler").status, "degraded");

    const stale = createMemoryDb();
    await seedRun(stale, "governance-scheduler", {
      hoursAgo: defaults.schedulerStaleHours + 0.1,
    });
    const report = await evaluate(stale);
    assert.equal(check(report, "governance-scheduler").status, "failing");
    assert.match(
      check(report, "governance-scheduler").summary,
      new RegExp(`fail threshold is ${defaults.schedulerStaleHours} hours`),
    );
    assert.equal(report.status, "failing");
  });

  it("uses saved thresholds, names them as settings and ignores dry-run entries", async () => {
    const db = createMemoryDb();
    await seedRun(db, "governance-scheduler", {
      hoursAgo: 0.5,
      mode: "dry-run",
    });
    await seedRun(db, "governance-scheduler", { hoursAgo: 1.5 });
    await seedSettings(db, { schedulerWarnHours: 1, schedulerStaleHours: 2 });

    const report = await evaluate(db);
    assert.deepEqual(report.thresholds.schedulerWarnHours, {
      name: "governance scheduler warn threshold",
      hours: 1,
      source: "settings",
    });
    assert.deepEqual(report.thresholds.schedulerStaleHours, {
      name: "governance scheduler fail threshold",
      hours: 2,
      source: "settings",
    });
    assert.equal(check(report, "governance-scheduler").status, "degraded");
  });

  it("reports unknown rather than trusting invalid saved thresholds", async () => {
    const cases: Array<{
      id: "governance-scheduler" | "digest" | "membership-verification";
      job: "governance-scheduler" | "ballot-digest" | "membership-verification";
      key: keyof OperationalThresholdValues;
      overrides: Record<string, unknown>;
    }> = [
      {
        id: "governance-scheduler",
        job: "governance-scheduler",
        key: "schedulerWarnHours",
        overrides: { schedulerWarnHours: 0 },
      },
      {
        id: "digest",
        job: "ballot-digest",
        key: "digestStaleHours",
        overrides: { digestStaleHours: "soon" },
      },
      {
        id: "membership-verification",
        job: "membership-verification",
        key: "verificationWarnHours",
        overrides: { verificationWarnHours: 2.5 },
      },
    ];

    for (const entry of cases) {
      const db = await healthyDatabase();
      await db
        .collection(JOB_RUNS_COLLECTION)
        .deleteMany({ job: entry.job });
      await seedRun(db, entry.job, { hoursAgo: 0.1 });
      await seedSettings(db, entry.overrides);
      const report = await evaluate(db);
      const result = check(report, entry.id);
      assert.equal(result.status, "unknown", entry.id);
      assert.match(result.summary, /not valid/, entry.id);
      assert.match(result.nextAction, /correct the operational thresholds/i);
      assert.equal(report.status, "unknown");
      assert.equal(operationalHealthExitCode(report), 2);
      // The untrustworthy field falls back to its default and says so.
      assert.equal(report.thresholds[entry.key].source, "default");
    }
  });

  it("reports unknown when saved warn and fail values are not ordered", async () => {
    const db = await healthyDatabase();
    await db
      .collection(JOB_RUNS_COLLECTION)
      .deleteMany({ job: "governance-scheduler" });
    await seedRun(db, "governance-scheduler", { hoursAgo: 0.1 });
    await seedSettings(db, { schedulerWarnHours: 30, schedulerStaleHours: 26 });

    const result = check(await evaluate(db), "governance-scheduler");
    assert.equal(result.status, "unknown");
    assert.match(result.summary, /must be less than/);
    assert.match(result.nextAction, /correct the operational thresholds/i);
  });

  it("reports unknown when the saved thresholds cannot be read", async () => {
    const db = createMemoryDb();
    const broken = new Proxy(db, {
      get(target, property) {
        if (property === "collection") {
          return (name: string) => {
            if (name === OPERATIONAL_SETTINGS_COLLECTION) {
              throw new Error("collection unavailable");
            }
            return target.collection(name);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const report = await evaluate(broken);
    for (const id of [
      "governance-scheduler",
      "ballot-deadlines",
      "digest",
      "membership-verification",
      "email-delivery",
    ]) {
      const result = check(report, id);
      assert.equal(result.status, "unknown", id);
      assert.match(result.summary, /could not be read/, id);
      assert.match(result.nextAction, /correct the operational thresholds/i, id);
    }
    assert.equal(report.status, "unknown");
  });

  it("ignores the removed threshold environment variables", async () => {
    const db = await healthyDatabase();
    const env = {
      ...baseEnv,
      GOVERNANCE_SCHEDULER_WARN_HOURS: "1",
      GOVERNANCE_SCHEDULER_STALE_HOURS: "2",
      DIGEST_WARN_HOURS: "1",
      DIGEST_STALE_HOURS: "2",
      MEMBERSHIP_VERIFICATION_WARN_HOURS: "1",
      MEMBERSHIP_VERIFICATION_STALE_HOURS: "2",
      BALLOT_CLOSURE_GRACE_HOURS: "0",
      EMAIL_DELIVERY_WINDOW_HOURS: "1",
    } as unknown as PlatformEnv;

    const report = await evaluate(db, env);
    assert.equal(report.status, "healthy");
    assert.equal(
      Object.values(report.thresholds).every((value) => value.source === "default"),
      true,
    );
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(report.thresholds).map(([key, value]) => [key, value.hours]),
      ),
      defaults,
    );
  });

  it("fails a scheduler whose last run failed and degrades a partial run", async () => {
    const failed = createMemoryDb();
    await seedRun(failed, "governance-scheduler", { hoursAgo: 1, ok: false });
    const failedCheck = check(await evaluate(failed), "governance-scheduler");
    assert.equal(failedCheck.status, "failing");
    assert.match(failedCheck.summary, /failed/);

    const partial = await healthyDatabase();
    await partial
      .collection(JOB_RUNS_COLLECTION)
      .deleteMany({ job: "governance-scheduler" });
    await seedRun(partial, "governance-scheduler", {
      hoursAgo: 1,
      summary: { advanced: 0, closed: 0, skipped: 0, blockers: 1, errors: 2 },
    });
    const partialReport = await evaluate(partial);
    assert.equal(check(partialReport, "governance-scheduler").status, "degraded");
    assert.match(check(partialReport, "governance-scheduler").summary, /2 matters/);
    assert.equal(partialReport.status, "degraded");
  });

  it("treats ballot deadlines as evidence that closure did not run", async () => {
    const withinGrace = await healthyDatabase();
    await withinGrace.collection("proposals").insertOne({
      proposalId: "PROP-GRACE",
      stage: "decide",
      ballotClosesAt: new Date(NOW.getTime() - 0.5 * HOUR),
    });
    const graceReport = await evaluate(withinGrace);
    assert.equal(check(graceReport, "ballot-deadlines").status, "degraded");
    assert.equal(graceReport.status, "degraded");

    const beyondGrace = await healthyDatabase();
    await beyondGrace.collection("proposals").insertOne({
      proposalId: "PROP-OVERDUE",
      stage: "decide",
      ballotClosesAt: new Date(NOW.getTime() - 5 * HOUR),
    });
    await beyondGrace.collection("proposals").insertOne({
      proposalId: "PROP-CLOSED",
      stage: "decide",
      ballotClosesAt: new Date(NOW.getTime() - 5 * HOUR),
      ballotClosedAt: new Date(NOW.getTime() - 4 * HOUR),
    });
    const overdueReport = await evaluate(beyondGrace);
    assert.equal(check(overdueReport, "ballot-deadlines").status, "failing");
    assert.match(check(overdueReport, "ballot-deadlines").summary, /^1 ballot/);
    assert.equal(overdueReport.status, "failing");
  });

  it("uses a saved ballot closure grace period", async () => {
    const db = await healthyDatabase();
    await seedSettings(db, { ballotClosureGraceHours: 0 });
    await db.collection("proposals").insertOne({
      proposalId: "PROP-GRACE-SETTING",
      stage: "decide",
      ballotClosesAt: new Date(NOW.getTime() - 0.5 * HOUR),
    });

    const report = await evaluate(db);
    assert.equal(check(report, "ballot-deadlines").status, "failing");
    assert.equal(report.thresholds.ballotClosureGraceHours.hours, 0);
    assert.equal(report.thresholds.ballotClosureGraceHours.source, "settings");
  });

  it("reports unknown for an invalid saved email delivery window", async () => {
    const db = await healthyDatabase();
    await seedSettings(db, { emailDeliveryWindowHours: 0 });
    const report = await evaluate(db);
    const result = check(report, "email-delivery");
    assert.equal(result.status, "unknown");
    assert.match(result.summary, /not valid/);
    assert.equal(report.thresholds.emailDeliveryWindowHours.source, "default");
  });

  it("reports the digest cadence, disabled feature and held deliveries", async () => {
    const stale = createMemoryDb();
    await seedRun(stale, "ballot-digest", { hoursAgo: 30 });
    assert.equal(check(await evaluate(stale), "digest").status, "failing");

    const warned = createMemoryDb();
    await seedRun(warned, "ballot-digest", { hoursAgo: 2 });
    const warnedCheck = check(await evaluate(warned), "digest");
    assert.equal(warnedCheck.status, "degraded");
    assert.match(warnedCheck.summary, /warn threshold is 1 hour/);

    const disabled = await evaluate(await healthyDatabase(), {
      ...baseEnv,
      ENGAGE_DIGEST_ENABLED: "false",
    });
    assert.equal(check(disabled, "digest").status, "unknown");
    assert.equal(disabled.status, "unknown");
    assert.equal(operationalHealthExitCode(disabled), 2);

    const held = createMemoryDb();
    await seedRun(held, "ballot-digest", {
      hoursAgo: 1,
      summary: { disabled: false, sent: 3, held: 2 },
    });
    assert.equal(check(await evaluate(held), "digest").status, "degraded");

    const failed = createMemoryDb();
    await seedRun(failed, "ballot-digest", { hoursAgo: 1, ok: false });
    assert.equal(check(await evaluate(failed), "digest").status, "failing");
  });

  it("reports verification disabled, backlog and cadence", async () => {
    const disabled = await evaluate(createMemoryDb(), {
      ...baseEnv,
      ENGAGE_CRM_VERIFICATION_ENABLED: "false",
    });
    assert.equal(
      check(disabled, "membership-verification").status,
      "unknown",
    );
    assert.match(
      check(disabled, "membership-verification").summary,
      /not enabled/,
    );

    const backlog = await healthyDatabase();
    await backlog.collection(VERIFICATION_ATTEMPTS).insertOne({
      memberId: "member-private",
      status: "queued",
      nextAttemptAt: new Date(NOW.getTime() - HOUR),
    });
    const backlogReport = await evaluate(backlog);
    assert.equal(
      check(backlogReport, "membership-verification").status,
      "degraded",
    );
    assert.equal(backlogReport.status, "degraded");

    const missing = createMemoryDb();
    assert.equal(
      check(await evaluate(missing), "membership-verification").status,
      "failing",
    );

    const warned = await healthyDatabase();
    await warned
      .collection(JOB_RUNS_COLLECTION)
      .deleteMany({ job: "membership-verification" });
    await seedRun(warned, "membership-verification", { hoursAgo: 3 });
    assert.equal(
      check(await evaluate(warned), "membership-verification").status,
      "degraded",
    );

    const stale = await healthyDatabase();
    await stale
      .collection(JOB_RUNS_COLLECTION)
      .deleteMany({ job: "membership-verification" });
    await seedRun(stale, "membership-verification", { hoursAgo: 25 });
    assert.equal(
      check(await evaluate(stale), "membership-verification").status,
      "failing",
    );
  });

  it("applies two-tier recency to every scheduled job", async () => {
    const jobs: Array<{
      id: "governance-scheduler" | "digest" | "membership-verification";
      job: "governance-scheduler" | "ballot-digest" | "membership-verification";
      warn: number;
      fail: number;
    }> = [
      {
        id: "governance-scheduler",
        job: "governance-scheduler",
        warn: defaults.schedulerWarnHours,
        fail: defaults.schedulerStaleHours,
      },
      {
        id: "digest",
        job: "ballot-digest",
        warn: defaults.digestWarnHours,
        fail: defaults.digestStaleHours,
      },
      {
        id: "membership-verification",
        job: "membership-verification",
        warn: defaults.verificationWarnHours,
        fail: defaults.verificationStaleHours,
      },
    ];

    for (const entry of jobs) {
      for (const [hoursAgo, expected] of [
        [entry.warn - 0.1, "ok"],
        [entry.warn + 0.1, "degraded"],
        [entry.fail + 0.1, "failing"],
      ] as const) {
        const db = createMemoryDb();
        await seedRun(db, entry.job, { hoursAgo });
        const result = check(await evaluate(db), entry.id);
        assert.equal(
          result.status,
          expected,
          `${entry.id} at ${hoursAgo} hours: ${result.summary}`,
        );
        if (expected === "degraded") {
          assert.match(result.summary, new RegExp(`${entry.warn} hour`));
        }
      }
    }
  });

  it("reports recent failed or held email delivery only", async () => {
    const db = await healthyDatabase();
    const outbox = db.collection("engagement_email_outbox");
    await outbox.insertOne({
      memberId: "member-private",
      status: "failed",
      createdAt: new Date(NOW.getTime() - HOUR),
    });
    await outbox.insertOne({
      memberId: "member-private",
      status: "sent",
      createdAt: new Date(NOW.getTime() - HOUR),
    });
    const report = await evaluate(db);
    assert.equal(check(report, "email-delivery").status, "degraded");

    const old = await healthyDatabase();
    await old.collection("engagement_email_outbox").insertOne({
      memberId: "member-private",
      status: "failed",
      createdAt: new Date(NOW.getTime() - 48 * HOUR),
    });
    assert.equal(check(await evaluate(old), "email-delivery").status, "ok");

    const narrowed = await healthyDatabase();
    await seedSettings(narrowed, { emailDeliveryWindowHours: 5 });
    await narrowed.collection("engagement_email_outbox").insertOne({
      memberId: "member-private",
      status: "failed",
      createdAt: new Date(NOW.getTime() - 10 * HOUR),
    });
    assert.equal(check(await evaluate(narrowed), "email-delivery").status, "ok");
  });

  it("fails closed when Turnstile is misconfigured in production", async () => {
    const db = await healthyDatabase();
    const production = { ...baseEnv, APP_MODE: "production" };

    const misconfigured = await evaluate(db, production);
    assert.equal(check(misconfigured, "turnstile").status, "failing");
    assert.equal(misconfigured.status, "failing");

    const disabled = await evaluate(db, {
      ...production,
      TURNSTILE_ENFORCEMENT: "off",
    });
    assert.equal(check(disabled, "turnstile").status, "degraded");

    const enforced = await evaluate(db, {
      ...production,
      TURNSTILE_SECRET_KEY: "secret-value",
      PUBLIC_TURNSTILE_SITE_KEY: "site-value",
    });
    assert.equal(check(enforced, "turnstile").status, "ok");
    assert.equal(enforced.status, "healthy");
  });

  it("reports the worst check and maps exit codes", async () => {
    const statuses: OperationalCheck[] = [
      { id: "digest", status: "ok", summary: "", nextAction: "" },
      { id: "turnstile", status: "unknown", summary: "", nextAction: "" },
      { id: "email-delivery", status: "degraded", summary: "", nextAction: "" },
    ];
    assert.equal(overallOperationalStatus(statuses), "degraded");
    assert.equal(
      overallOperationalStatus([
        ...statuses,
        { id: "ballot-deadlines", status: "failing", summary: "", nextAction: "" },
      ]),
      "failing",
    );
    assert.equal(overallOperationalStatus([]), "healthy");

    const healthy = await evaluate(await healthyDatabase());
    assert.equal(operationalHealthExitCode(healthy), 0);
    assert.equal(operationalHealthExitCode({ ...healthy, status: "degraded" }), 2);
    assert.equal(operationalHealthExitCode({ ...healthy, status: "unknown" }), 2);
    assert.equal(operationalHealthExitCode({ ...healthy, status: "failing" }), 1);
  });

  it("renders a readable summary with next actions", async () => {
    const report = await evaluate(createMemoryDb());
    const rendered = renderOperationalHealth(report);
    assert.match(rendered, /Engage operational health: failing/);
    assert.match(rendered, /FAILING\s+governance-scheduler/);
    assert.match(rendered, /Next: /);
  });

  it("isolates a check that cannot read its evidence", async () => {
    const db = await healthyDatabase();
    const broken = new Proxy(db, {
      get(target, property) {
        if (property === "collection") {
          return (name: string) =>
            name === "proposals"
              ? {
                  countDocuments: async () => {
                    throw new Error("collection unavailable");
                  },
                }
              : target.collection(name);
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const report = await evaluate(broken);
    assert.equal(check(report, "ballot-deadlines").status, "unknown");
    assert.equal(check(report, "governance-scheduler").status, "ok");
    assert.equal(report.status, "unknown");
  });

  it("never exposes secrets, member identifiers or ballot choices", async () => {
    const db = await healthyDatabase();
    const secret = "tls-secret-value-0123456789abcdef";
    await seedRun(db, "ballot-digest", {
      hoursAgo: 1,
      ok: false,
      error: "Bearer tlssupersecrettoken0123456789abcdef",
    });
    await db.collection(VERIFICATION_ATTEMPTS).insertOne({
      memberId: "member-private-identifier",
      status: "queued",
      nextAttemptAt: new Date(NOW.getTime() - HOUR),
    });
    await db.collection("engagement_email_outbox").insertOne({
      memberId: "member-private-identifier",
      status: "failed",
      createdAt: new Date(NOW.getTime() - HOUR),
    });
    await db.collection("proposals").insertOne({
      proposalId: "PROP-SECRET",
      stage: "decide",
      ballotClosesAt: new Date(NOW.getTime() - 5 * HOUR),
    });

    const report = await evaluate(db, {
      ...baseEnv,
      APP_MODE: "production",
      TURNSTILE_SECRET_KEY: secret,
      ENGAGE_CRM_TOKEN: "crm-token-value-0123456789abcdef",
    } as PlatformEnv & Record<string, string | undefined>);
    const serialised = JSON.stringify(report);
    for (const value of [
      secret,
      "tlssupersecrettoken0123456789abcdef",
      "crm-token-value-0123456789abcdef",
      "member-private-identifier",
      "PROP-SECRET",
    ]) {
      assert.equal(serialised.includes(value), false, `leaked ${value}`);
    }
  });
});
