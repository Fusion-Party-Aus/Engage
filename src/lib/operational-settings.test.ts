import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Db } from "mongodb";
import { createMemoryDb, getDatabase } from "./db.ts";
import {
  CRM_OPERATIONAL_SETTINGS_ID,
  DEFAULT_CRM_SETTINGS,
  DEFAULT_JOBS_SETTINGS,
  DEFAULT_OPERATIONAL_THRESHOLDS,
  OPERATIONAL_SETTINGS_COLLECTION,
  OPERATIONAL_SETTINGS_EVENTS_COLLECTION,
  OPERATIONAL_SETTINGS_ID,
  OPERATIONAL_THRESHOLD_FIELDS,
  getCrmSettingsState,
  getJobsSettingsState,
  getOperationalSettings,
  getOperationalSettingsState,
  listOperationalSettingsEvents,
  saveCrmSettings,
  saveJobsSettings,
  saveOperationalSettings,
  validateCrmSettingsInput,
  validateJobsSettingsInput,
  validateOperationalSettingsInput,
} from "./operational-settings.ts";
import { POST as saveThresholds } from "../pages/api/admin/operational-settings.ts";

const actor = { memberId: "member-admin", name: "Administrator" };
const valid = { ...DEFAULT_OPERATIONAL_THRESHOLDS };

function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...valid, ...overrides };
}

async function clearSettings(db: Db): Promise<void> {
  await Promise.all([
    db.collection(OPERATIONAL_SETTINGS_COLLECTION).deleteMany({}),
    db.collection(OPERATIONAL_SETTINGS_EVENTS_COLLECTION).deleteMany({}),
  ]);
}

describe("operational threshold validation", () => {
  it("accepts the documented defaults and whole-hour strings", () => {
    const defaults = validateOperationalSettingsInput(valid);
    assert.deepEqual(defaults.fieldErrors, {});
    assert.deepEqual(defaults.values, valid);

    const strings = validateOperationalSettingsInput(
      Object.fromEntries(
        Object.entries(valid).map(([key, value]) => [key, String(value)]),
      ),
    );
    assert.deepEqual(strings.fieldErrors, {});
    assert.deepEqual(strings.values, valid);
  });

  it("rejects missing, fractional and non-numeric values field by field", () => {
    const missing = validateOperationalSettingsInput({});
    assert.equal(missing.values, null);
    for (const field of OPERATIONAL_THRESHOLD_FIELDS) {
      assert.match(missing.fieldErrors[field.key], /whole number/);
    }

    const invalid = validateOperationalSettingsInput(
      input({
        schedulerWarnHours: "2.5",
        schedulerStaleHours: "later",
        digestWarnHours: 1.5,
        digestStaleHours: true,
      }),
    );
    assert.equal(invalid.values, null);
    assert.match(invalid.fieldErrors.schedulerWarnHours, /whole number/);
    assert.match(invalid.fieldErrors.schedulerStaleHours, /whole number/);
    assert.match(invalid.fieldErrors.digestWarnHours, /whole number/);
    assert.match(invalid.fieldErrors.digestStaleHours, /whole number/);
  });

  it("enforces each field's documented bounds", () => {
    const cases: Array<[string, unknown]> = [
      ["schedulerWarnHours", 0],
      ["schedulerWarnHours", 169],
      ["schedulerStaleHours", 1],
      ["schedulerStaleHours", 721],
      ["digestWarnHours", 0],
      ["verificationStaleHours", 721],
      ["ballotClosureGraceHours", -1],
      ["ballotClosureGraceHours", 49],
      ["emailDeliveryWindowHours", 0],
      ["emailDeliveryWindowHours", 169],
    ];
    for (const [key, value] of cases) {
      const result = validateOperationalSettingsInput(input({ [key]: value }));
      assert.equal(result.values, null, `${key}=${String(value)}`);
      assert.match(result.fieldErrors[key], /whole number from \d+ to \d+ hours/, key);
    }
  });

  it("rejects a warn threshold that is not below its fail threshold", () => {
    for (const [warn, fail] of [
      ["schedulerWarnHours", "schedulerStaleHours"],
      ["digestWarnHours", "digestStaleHours"],
      ["verificationWarnHours", "verificationStaleHours"],
    ]) {
      const result = validateOperationalSettingsInput(
        input({ [warn]: 10, [fail]: 10 }),
      );
      assert.equal(result.values, null, warn);
      assert.match(result.fieldErrors[warn], /fewer hours than the fail/);
      assert.match(result.fieldErrors[fail], /more hours than the warn/);
    }

    const above = validateOperationalSettingsInput(
      input({ schedulerWarnHours: 30, schedulerStaleHours: 26 }),
    );
    assert.equal(above.values, null);
    assert.ok(above.fieldErrors.schedulerWarnHours);
    assert.ok(above.fieldErrors.schedulerStaleHours);
  });

  it("never returns partial data and ignores unknown keys", () => {
    const result = validateOperationalSettingsInput(
      input({ archiveAfterDays: 14, digestStaleHours: 0 }),
    );
    assert.equal(result.values, null);
    assert.equal("archiveAfterDays" in result.fieldErrors, false);
    assert.deepEqual(Object.keys(result.fieldErrors), ["digestStaleHours"]);
  });
});

describe("operational settings persistence", () => {
  it("starts from the documented defaults when nothing is stored", async () => {
    const db = createMemoryDb();
    const state = await getOperationalSettingsState(db);
    assert.deepEqual(state.values, DEFAULT_OPERATIONAL_THRESHOLDS);
    assert.equal(state.source, "default");
    assert.deepEqual(state.invalidFields, []);
    assert.deepEqual(await getOperationalSettings(db), DEFAULT_OPERATIONAL_THRESHOLDS);
  });

  it("merges saved values over the defaults", async () => {
    const db = createMemoryDb();
    await db.collection<Record<string, unknown> & { _id: string }>(OPERATIONAL_SETTINGS_COLLECTION).insertOne({
      _id: OPERATIONAL_SETTINGS_ID,
      ...DEFAULT_OPERATIONAL_THRESHOLDS,
      digestWarnHours: 3,
      emailDeliveryWindowHours: 12,
      updatedAt: new Date("2026-11-16T01:00:00.000Z"),
      updatedBy: actor.memberId,
      updatedByName: actor.name,
    });

    const state = await getOperationalSettingsState(db);
    assert.equal(state.source, "settings");
    assert.deepEqual(state.values, {
      ...DEFAULT_OPERATIONAL_THRESHOLDS,
      digestWarnHours: 3,
      emailDeliveryWindowHours: 12,
    });
    assert.deepEqual(state.invalidFields, []);
    assert.equal(state.updatedByName, actor.name);
    assert.equal((await getOperationalSettings(db)).digestWarnHours, 3);
  });

  it("flags missing or out-of-bounds stored fields without trusting them", async () => {
    const db = createMemoryDb();
    await db.collection<Record<string, unknown> & { _id: string }>(OPERATIONAL_SETTINGS_COLLECTION).insertOne({
      _id: OPERATIONAL_SETTINGS_ID,
      ...DEFAULT_OPERATIONAL_THRESHOLDS,
      digestWarnHours: 0,
      schedulerStaleHours: "26",
      emailDeliveryWindowHours: undefined,
    });

    const state = await getOperationalSettingsState(db);
    assert.deepEqual(
      [...state.invalidFields].sort(),
      ["digestWarnHours", "emailDeliveryWindowHours", "schedulerStaleHours"].sort(),
    );
    assert.equal(state.values.digestWarnHours, DEFAULT_OPERATIONAL_THRESHOLDS.digestWarnHours);
    assert.equal(
      state.values.schedulerStaleHours,
      DEFAULT_OPERATIONAL_THRESHOLDS.schedulerStaleHours,
    );
    assert.equal(
      state.values.emailDeliveryWindowHours,
      DEFAULT_OPERATIONAL_THRESHOLDS.emailDeliveryWindowHours,
    );
  });

  it("reports a database read failure instead of pretending the defaults apply", async () => {
    const db = createMemoryDb();
    const broken = new Proxy(db, {
      get(target, property) {
        if (property === "collection") {
          return () => {
            throw new Error("collection unavailable");
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const state = await getOperationalSettingsState(broken);
    assert.equal(state.readFailed, true);
    assert.deepEqual(state.values, DEFAULT_OPERATIONAL_THRESHOLDS);
  });

  it("stores values and audits only the fields that changed", async () => {
    const db = createMemoryDb();
    const result = await saveOperationalSettings(db, actor, {
      ...valid,
      schedulerWarnHours: 3,
      emailDeliveryWindowHours: 12,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.changedFields.sort(), [
      "emailDeliveryWindowHours",
      "schedulerWarnHours",
    ]);

    const stored = await db
      .collection<Record<string, unknown> & { _id: string }>(OPERATIONAL_SETTINGS_COLLECTION)
      .findOne({ _id: OPERATIONAL_SETTINGS_ID });
    assert.ok(stored);
    assert.equal(stored.schedulerWarnHours, 3);
    assert.equal(stored.emailDeliveryWindowHours, 12);
    assert.equal(stored.updatedBy, actor.memberId);
    assert.equal(stored.updatedByName, actor.name);
    assert.ok(stored.updatedAt instanceof Date);

    const events = await listOperationalSettingsEvents(db);
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.deepEqual(event.changedFields.sort(), [
      "emailDeliveryWindowHours",
      "schedulerWarnHours",
    ]);
    assert.deepEqual(event.before, {
      schedulerWarnHours: DEFAULT_OPERATIONAL_THRESHOLDS.schedulerWarnHours,
      emailDeliveryWindowHours: DEFAULT_OPERATIONAL_THRESHOLDS.emailDeliveryWindowHours,
    });
    assert.deepEqual(event.after, {
      schedulerWarnHours: 3,
      emailDeliveryWindowHours: 12,
    });
    assert.equal(event.actorId, actor.memberId);
    assert.equal(event.actorName, actor.name);
    assert.equal(event.setting, "thresholds");
    assert.ok(event.createdAt instanceof Date);
    assert.equal(typeof event.eventId, "string");
    assert.equal(event.eventId.length > 10, true);
  });

  it("does not audit an unchanged save", async () => {
    const db = createMemoryDb();
    await saveOperationalSettings(db, actor, { ...valid, digestWarnHours: 2 });
    const unchanged = await saveOperationalSettings(db, actor, {
      ...valid,
      digestWarnHours: 2,
    });
    assert.equal(unchanged.ok, true);
    if (!unchanged.ok) return;
    assert.deepEqual(unchanged.changedFields, []);
    assert.equal((await listOperationalSettingsEvents(db)).length, 1);

    const changed = await saveOperationalSettings(db, actor, valid);
    assert.equal(changed.ok, true);
    if (!changed.ok) return;
    assert.deepEqual(changed.changedFields, ["digestWarnHours"]);
    assert.equal((await listOperationalSettingsEvents(db)).length, 2);
  });

  it("rejects invalid input without writing or auditing anything", async () => {
    const db = createMemoryDb();
    const before = await db.collection(OPERATIONAL_SETTINGS_COLLECTION).countDocuments();
    const result = await saveOperationalSettings(
      db,
      actor,
      input({ digestWarnHours: 30, digestStaleHours: 24 }),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.fieldErrors.digestWarnHours);
    assert.ok(result.fieldErrors.digestStaleHours);
    assert.equal(
      await db.collection(OPERATIONAL_SETTINGS_COLLECTION).countDocuments(),
      before,
    );
    assert.equal(
      await db.collection(OPERATIONAL_SETTINGS_EVENTS_COLLECTION).countDocuments(),
      0,
    );
  });
});

describe("operational settings API", () => {
  const env = { APP_MODE: "development" };
  const admin = {
    Cookie: "engage_dev_user=administrator",
    "Content-Type": "application/json",
  };
  const member = {
    Cookie: "engage_dev_user=member",
    "Content-Type": "application/json",
  };
  const call = (
    body: unknown,
    headers: HeadersInit = admin,
    origin?: string,
  ) =>
    saveThresholds({
      request: new Request("http://localhost/api/admin/operational-settings", {
        method: "POST",
        headers: origin ? { ...(headers as Record<string, string>), Origin: origin } : headers,
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      url: new URL("http://localhost/api/admin/operational-settings"),
      locals: { runtime: { env } },
    } as never);

  it("requires an administrator", async () => {
    const db = await getDatabase(env);
    await clearSettings(db);
    assert.equal((await call(valid, { "Content-Type": "application/json" })).status, 401);
    assert.equal((await call(valid, member)).status, 403);
    assert.equal(
      await db.collection(OPERATIONAL_SETTINGS_COLLECTION).countDocuments(),
      0,
    );
  });

  it("rejects cross-site writes", async () => {
    const db = await getDatabase(env);
    await clearSettings(db);
    assert.equal((await call(valid, admin, "https://evil.example")).status, 403);
  });

  it("returns field errors for invalid input and no raw internals", async () => {
    const db = await getDatabase(env);
    await clearSettings(db);
    const response = await call({
      ...valid,
      schedulerWarnHours: 30,
      schedulerStaleHours: 26,
    });
    assert.equal(response.status, 422);
    const payload = (await response.json()) as Record<string, any>;
    assert.equal(payload.error, "Some fields need attention.");
    assert.ok(payload.fieldErrors.schedulerWarnHours);
    assert.ok(payload.fieldErrors.schedulerStaleHours);
    assert.equal(JSON.stringify(payload).includes("Mongo"), false);

    const malformed = await call("{not json");
    assert.equal(malformed.status, 400);
    assert.equal(((await malformed.json()) as any).error.includes("Mongo"), false);
  });

  it("saves valid input and returns the audit event to the page", async () => {
    const db = await getDatabase(env);
    await clearSettings(db);
    const response = await call({ ...valid, verificationStaleHours: 36 });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as Record<string, any>;
    assert.equal(payload.values.verificationStaleHours, 36);
    assert.deepEqual(payload.changedFields, ["verificationStaleHours"]);
    assert.equal(payload.events.length, 1);
    assert.equal(payload.events[0].actorName, "Local Administrator");
    assert.deepEqual(payload.events[0].before, {
      verificationStaleHours: DEFAULT_OPERATIONAL_THRESHOLDS.verificationStaleHours,
    });
    assert.deepEqual(payload.events[0].after, { verificationStaleHours: 36 });

    const state = await getOperationalSettingsState(db);
    assert.equal(state.values.verificationStaleHours, 36);
  });
});

describe("CRM verification settings", () => {
  it("accepts the documented defaults, booleans and numeric strings", () => {
    const defaults = validateCrmSettingsInput(
      DEFAULT_CRM_SETTINGS as unknown as Record<string, unknown>,
    );
    assert.deepEqual(defaults.fieldErrors, {});
    assert.deepEqual(defaults.values, DEFAULT_CRM_SETTINGS);

    const strings = validateCrmSettingsInput({
      ...DEFAULT_CRM_SETTINGS,
      crmVerificationEnabled: "true",
      crmBatchSize: "50",
    });
    assert.deepEqual(strings.fieldErrors, {});
    assert.equal(strings.values?.crmVerificationEnabled, true);
    assert.equal(strings.values?.crmBatchSize, 50);
  });

  it("rejects missing, non-boolean, fractional and out-of-range values", () => {
    const missing = validateCrmSettingsInput({});
    assert.equal(missing.values, null);
    assert.match(missing.fieldErrors.crmVerificationEnabled, /on or off/);
    assert.match(missing.fieldErrors.crmBatchSize, /whole number/);

    const cases: Array<[string, unknown]> = [
      ["crmVerificationEnabled", "yes"],
      ["crmBatchSize", 1.5],
      ["crmBatchSize", 0],
      ["crmBatchSize", 101],
      ["crmReconcileIntervalMinutes", 14],
      ["crmReconcileIntervalMinutes", 43_201],
      ["crmOutageAlertAfterAttempts", 0],
      ["crmOutageAlertAfterAttempts", 21],
      ["crmTimeoutMs", 999],
      ["crmTimeoutMs", 60_001],
    ];
    for (const [key, value] of cases) {
      const result = validateCrmSettingsInput({ ...DEFAULT_CRM_SETTINGS, [key]: value });
      assert.equal(result.values, null, `${key}=${String(value)}`);
      assert.ok(result.fieldErrors[key], key);
    }
  });

  it("ignores unknown keys and never returns a partial set", () => {
    const result = validateCrmSettingsInput({
      ...DEFAULT_CRM_SETTINGS,
      archivedAfterDays: 10,
      crmBatchSize: 0,
    });
    assert.equal(result.values, null);
    assert.equal("archivedAfterDays" in result.fieldErrors, false);
    assert.deepEqual(Object.keys(result.fieldErrors), ["crmBatchSize"]);
  });
});

describe("scheduled job settings", () => {
  it("accepts only a boolean", () => {
    assert.deepEqual(validateJobsSettingsInput({ digestEnabled: true }).fieldErrors, {});
    assert.equal(validateJobsSettingsInput({ digestEnabled: "true" }).values?.digestEnabled, true);
    assert.equal(validateJobsSettingsInput({}).values, null);
    assert.match(validateJobsSettingsInput({}).fieldErrors.digestEnabled, /on or off/);
    assert.equal(validateJobsSettingsInput({ digestEnabled: "yes" }).values, null);
    const unknown = validateJobsSettingsInput({ digestEnabled: false, crmBatchSize: 5 });
    assert.deepEqual(unknown, { values: { digestEnabled: false }, fieldErrors: {} });
  });

  it("defaults to disabled when nothing is stored", async () => {
    const db = createMemoryDb();
    const state = await getJobsSettingsState(db);
    assert.deepEqual(state.values, DEFAULT_JOBS_SETTINGS);
    assert.equal(state.source, "default");
    assert.deepEqual(state.invalidFields, []);
  });
});

describe("CRM and job settings persistence", () => {
  it("defaults the CRM gate off and flags invalid stored values", async () => {
    const db = createMemoryDb();
    const empty = await getCrmSettingsState(db);
    assert.deepEqual(empty.values, DEFAULT_CRM_SETTINGS);
    assert.equal(empty.values.crmVerificationEnabled, false);

    await db.collection<Record<string, unknown> & { _id: string }>(OPERATIONAL_SETTINGS_COLLECTION).insertOne({
      _id: CRM_OPERATIONAL_SETTINGS_ID,
      ...DEFAULT_CRM_SETTINGS,
      crmVerificationEnabled: true,
      crmBatchSize: 0,
      crmTimeoutMs: "10000",
    });
    const state = await getCrmSettingsState(db);
    assert.deepEqual([...state.invalidFields].sort(), ["crmBatchSize", "crmTimeoutMs"]);
    assert.equal(state.values.crmVerificationEnabled, true);
    assert.equal(state.values.crmBatchSize, DEFAULT_CRM_SETTINGS.crmBatchSize);
    assert.equal(state.values.crmTimeoutMs, DEFAULT_CRM_SETTINGS.crmTimeoutMs);
  });

  it("stores CRM values and audits only the changed fields", async () => {
    const db = createMemoryDb();
    const result = await saveCrmSettings(db, actor, {
      ...DEFAULT_CRM_SETTINGS,
      crmVerificationEnabled: true,
      crmBatchSize: 50,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.changedFields.sort(), ["crmBatchSize", "crmVerificationEnabled"]);

    const stored = await db
      .collection<Record<string, unknown> & { _id: string }>(OPERATIONAL_SETTINGS_COLLECTION)
      .findOne({ _id: CRM_OPERATIONAL_SETTINGS_ID });
    assert.ok(stored);
    assert.equal(stored.crmVerificationEnabled, true);
    assert.equal(stored.crmBatchSize, 50);
    assert.equal(stored.updatedByName, actor.name);

    const events = await listOperationalSettingsEvents(db, 20, "crm");
    assert.equal(events.length, 1);
    assert.equal(events[0]!.setting, "crm");
    assert.deepEqual(events[0]!.changedFields.sort(), ["crmBatchSize", "crmVerificationEnabled"]);
    assert.deepEqual(events[0]!.before, {
      crmVerificationEnabled: false,
      crmBatchSize: DEFAULT_CRM_SETTINGS.crmBatchSize,
    });
    assert.deepEqual(events[0]!.after, { crmVerificationEnabled: true, crmBatchSize: 50 });
    assert.equal((await listOperationalSettingsEvents(db, 20, "thresholds")).length, 0);
  });

  it("stores the digest gate and audits a single change", async () => {
    const db = createMemoryDb();
    const result = await saveJobsSettings(db, actor, { digestEnabled: true });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.changedFields, ["digestEnabled"]);

    const state = await getJobsSettingsState(db);
    assert.equal(state.values.digestEnabled, true);
    const events = await listOperationalSettingsEvents(db, 20, "jobs");
    assert.equal(events.length, 1);
    assert.equal(events[0]!.setting, "jobs");
    assert.deepEqual(events[0]!.before, { digestEnabled: false });
    assert.deepEqual(events[0]!.after, { digestEnabled: true });
  });

  it("rejects invalid input without writing or auditing anything", async () => {
    const db = createMemoryDb();
    const result = await saveCrmSettings(db, actor, {
      ...DEFAULT_CRM_SETTINGS,
      crmTimeoutMs: 500,
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.fieldErrors.crmTimeoutMs);
    assert.equal(await db.collection(OPERATIONAL_SETTINGS_COLLECTION).countDocuments(), 0);
    assert.equal(await db.collection(OPERATIONAL_SETTINGS_EVENTS_COLLECTION).countDocuments(), 0);
  });
});

describe("operational settings API sections", () => {
  const env = { APP_MODE: "development" };
  const admin = {
    Cookie: "engage_dev_user=administrator",
    "Content-Type": "application/json",
  };
  const member = {
    Cookie: "engage_dev_user=member",
    "Content-Type": "application/json",
  };
  const call = (body: unknown, headers: HeadersInit = admin, origin?: string) =>
    saveThresholds({
      request: new Request("http://localhost/api/admin/operational-settings", {
        method: "POST",
        headers: origin ? { ...(headers as Record<string, string>), Origin: origin } : headers,
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      url: new URL("http://localhost/api/admin/operational-settings"),
      locals: { runtime: { env } },
    } as never);

  it("rejects an unknown section", async () => {
    const response = await call({ section: "secrets", digestEnabled: true });
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as any).error, "Unknown settings section.");
  });

  it("denies members and cross-site writes for every section", async () => {
    const db = await getDatabase(env);
    await clearSettings(db);
    for (const section of ["crm", "jobs"]) {
      assert.equal((await call({ section, ...DEFAULT_CRM_SETTINGS, digestEnabled: true }, member)).status, 403);
      assert.equal(
        (await call({ section, ...DEFAULT_CRM_SETTINGS, digestEnabled: true }, admin, "https://evil.example")).status,
        403,
      );
    }
    assert.equal(await db.collection(OPERATIONAL_SETTINGS_COLLECTION).countDocuments(), 0);
  });

  it("saves CRM and job sections with field errors and filtered events", async () => {
    const db = await getDatabase(env);
    await clearSettings(db);

    const invalid = await call({ section: "crm", ...DEFAULT_CRM_SETTINGS, crmBatchSize: 0 });
    assert.equal(invalid.status, 422);
    const invalidBody = (await invalid.json()) as Record<string, any>;
    assert.equal(invalidBody.error, "Some fields need attention.");
    assert.ok(invalidBody.fieldErrors.crmBatchSize);
    assert.equal(JSON.stringify(invalidBody).includes("Mongo"), false);

    const crm = await call({ section: "crm", ...DEFAULT_CRM_SETTINGS, crmVerificationEnabled: true });
    assert.equal(crm.status, 200);
    const crmBody = (await crm.json()) as Record<string, any>;
    assert.equal(crmBody.section, "crm");
    assert.equal(crmBody.values.crmVerificationEnabled, true);
    assert.deepEqual(crmBody.changedFields, ["crmVerificationEnabled"]);
    assert.equal(crmBody.events.length, 1);
    assert.equal(crmBody.events[0].setting, "crm");

    const jobs = await call({ section: "jobs", digestEnabled: true });
    assert.equal(jobs.status, 200);
    const jobsBody = (await jobs.json()) as Record<string, any>;
    assert.equal(jobsBody.section, "jobs");
    assert.deepEqual(jobsBody.changedFields, ["digestEnabled"]);
    assert.equal(jobsBody.events.length, 1);
    assert.equal(jobsBody.events[0].setting, "jobs");

    const crmState = await getCrmSettingsState(db);
    assert.equal(crmState.values.crmVerificationEnabled, true);
    const jobsState = await getJobsSettingsState(db);
    assert.equal(jobsState.values.digestEnabled, true);
  });
});
