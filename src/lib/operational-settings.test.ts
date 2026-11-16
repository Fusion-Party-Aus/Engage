import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Db } from "mongodb";
import { createMemoryDb, getDatabase } from "./db.ts";
import {
  DEFAULT_OPERATIONAL_THRESHOLDS,
  OPERATIONAL_SETTINGS_COLLECTION,
  OPERATIONAL_SETTINGS_EVENTS_COLLECTION,
  OPERATIONAL_SETTINGS_ID,
  OPERATIONAL_THRESHOLD_FIELDS,
  getOperationalSettings,
  getOperationalSettingsState,
  listOperationalSettingsEvents,
  saveOperationalSettings,
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
