import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MongoClient } from "mongodb";
import { initializeDatabase } from "./db.ts";
import {
  CRM_OPERATIONAL_SETTINGS_ID,
  DEFAULT_CRM_SETTINGS,
  DEFAULT_OPERATIONAL_THRESHOLDS,
  JOBS_OPERATIONAL_SETTINGS_ID,
  OPERATIONAL_SETTINGS_COLLECTION,
  OPERATIONAL_SETTINGS_EVENTS_COLLECTION,
  OPERATIONAL_SETTINGS_ID,
  getCrmSettingsState,
  getJobsSettingsState,
  getOperationalSettingsState,
  listOperationalSettingsEvents,
  saveCrmSettings,
  saveJobsSettings,
  saveOperationalSettings,
} from "./operational-settings.ts";

/**
 * Real-MongoDB coverage for the operational threshold setting (#128).
 *
 * The in-memory database does not enforce the unique event index or prove that
 * an audited change survives a new connection. A fresh client is used for the
 * re-read so the assertion is persistence, not a shared cache.
 */
const uri = process.env.VOTING_TEST_MONGODB_URI;
const actor = { memberId: "member-admin", name: "Administrator" };

async function withDatabase(run: (db: import("mongodb").Db) => Promise<void>): Promise<void> {
  const client = await new MongoClient(uri!).connect();
  const dbName = `engage_ops_settings_${crypto.randomUUID().replaceAll("-", "")}`;
  const db = client.db(dbName);
  try {
    await initializeDatabase(db);
    await run(db);
  } finally {
    await db.dropDatabase();
    await client.close();
  }
}

describe("operational settings persistence", { skip: !uri }, () => {
  it("initialises its indexes", async () => {
    await withDatabase(async (db) => {
      const eventIndexes = await db
        .collection(OPERATIONAL_SETTINGS_EVENTS_COLLECTION)
        .indexes();
      const eventId = eventIndexes.find((index) => index.key.eventId === 1);
      assert.ok(eventId, "eventId index missing");
      assert.equal(eventId.unique, true);
      assert.ok(
        eventIndexes.some((index) => index.key.createdAt === -1),
        "createdAt index missing",
      );

      const settingsIndexes = await db
        .collection(OPERATIONAL_SETTINGS_COLLECTION)
        .indexes();
      assert.ok(
        settingsIndexes.some((index) => index.key.updatedAt === -1),
        "updatedAt index missing",
      );
    });
  });

  it("persists a validated change and its audit event across connections", async () => {
    const name = `engage_ops_persist_${crypto.randomUUID().replaceAll("-", "")}`;
    const first = await new MongoClient(uri!).connect();
    const firstDb = first.db(name);
    try {
      await initializeDatabase(firstDb);
      const result = await saveOperationalSettings(firstDb, actor, {
        ...DEFAULT_OPERATIONAL_THRESHOLDS,
        schedulerStaleHours: 30,
        ballotClosureGraceHours: 4,
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.deepEqual(result.changedFields.sort(), [
        "ballotClosureGraceHours",
        "schedulerStaleHours",
      ]);
    } finally {
      await first.close();
    }

    const second = await new MongoClient(uri!).connect();
    const secondDb = second.db(name);
    try {
      const state = await getOperationalSettingsState(secondDb);
      assert.equal(state.source, "settings");
      assert.deepEqual(state.invalidFields, []);
      assert.equal(state.values.schedulerStaleHours, 30);
      assert.equal(state.values.ballotClosureGraceHours, 4);
      assert.equal(state.values.digestWarnHours, DEFAULT_OPERATIONAL_THRESHOLDS.digestWarnHours);
      assert.equal(state.updatedBy, actor.memberId);
      assert.equal(state.updatedByName, actor.name);
      assert.ok(state.updatedAt instanceof Date);

      const stored = await secondDb
        .collection<Record<string, unknown> & { _id: string }>(OPERATIONAL_SETTINGS_COLLECTION)
        .findOne({ _id: OPERATIONAL_SETTINGS_ID });
      assert.ok(stored);
      assert.equal(stored.schedulerStaleHours, 30);
      assert.equal("secret" in stored, false);

      const events = await listOperationalSettingsEvents(secondDb);
      assert.equal(events.length, 1);
      const event = events[0]!;
      assert.deepEqual(event.changedFields.sort(), [
        "ballotClosureGraceHours",
        "schedulerStaleHours",
      ]);
      assert.deepEqual(event.before, {
        schedulerStaleHours: DEFAULT_OPERATIONAL_THRESHOLDS.schedulerStaleHours,
        ballotClosureGraceHours: DEFAULT_OPERATIONAL_THRESHOLDS.ballotClosureGraceHours,
      });
      assert.deepEqual(event.after, {
        schedulerStaleHours: 30,
        ballotClosureGraceHours: 4,
      });
      assert.equal(event.actorId, actor.memberId);
      assert.equal(event.actorName, actor.name);
      assert.ok(event.createdAt instanceof Date);
    } finally {
      await secondDb.dropDatabase();
      await second.close();
    }
  });

  it("persists CRM and job settings beside the thresholds with separate audits", async () => {
    const name = `engage_ops_sections_${crypto.randomUUID().replaceAll("-", "")}`;
    const first = await new MongoClient(uri!).connect();
    const firstDb = first.db(name);
    try {
      await initializeDatabase(firstDb);
      const crm = await saveCrmSettings(firstDb, actor, {
        ...DEFAULT_CRM_SETTINGS,
        crmVerificationEnabled: true,
        crmBatchSize: 40,
        crmTimeoutMs: 5_000,
      });
      assert.equal(crm.ok, true);
      if (!crm.ok) return;
      assert.deepEqual(crm.changedFields.sort(), [
        "crmBatchSize",
        "crmTimeoutMs",
        "crmVerificationEnabled",
      ]);

      const jobs = await saveJobsSettings(firstDb, actor, { digestEnabled: true });
      assert.equal(jobs.ok, true);
    } finally {
      await first.close();
    }

    const second = await new MongoClient(uri!).connect();
    const secondDb = second.db(name);
    try {
      const crmState = await getCrmSettingsState(secondDb);
      assert.equal(crmState.values.crmVerificationEnabled, true);
      assert.equal(crmState.values.crmBatchSize, 40);
      assert.equal(crmState.values.crmTimeoutMs, 5_000);
      assert.deepEqual(crmState.invalidFields, []);

      const jobsState = await getJobsSettingsState(secondDb);
      assert.equal(jobsState.values.digestEnabled, true);

      const all = await listOperationalSettingsEvents(secondDb);
      assert.deepEqual(
        all.map((event) => event.setting).sort(),
        ["crm", "jobs"],
      );
      const crmEvent = all.find((event) => event.setting === "crm")!;
      assert.deepEqual(crmEvent.after, {
        crmVerificationEnabled: true,
        crmBatchSize: 40,
        crmTimeoutMs: 5_000,
      });
      assert.equal(crmEvent.actorId, actor.memberId);
      assert.equal(crmEvent.actorName, actor.name);
      assert.ok(crmEvent.createdAt instanceof Date);

      const storedIds = await secondDb
        .collection<Record<string, unknown> & { _id: string }>(OPERATIONAL_SETTINGS_COLLECTION)
        .find({})
        .project({ _id: 1 })
        .toArray();
      assert.deepEqual(
        storedIds.map((row) => row._id).sort(),
        [CRM_OPERATIONAL_SETTINGS_ID, JOBS_OPERATIONAL_SETTINGS_ID],
      );
    } finally {
      await secondDb.dropDatabase();
      await second.close();
    }
  });
});
