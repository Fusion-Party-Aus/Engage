import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDb } from "./db.ts";
import {
  decryptDiscordWebhook,
  discordWeeklyDigestDue,
  encryptDiscordWebhook,
  getDiscordSettingsSummary,
  loadDiscordSettings,
  updateDiscordSettings,
} from "./discord-settings.ts";

const env = {
  BETTER_AUTH_SECRET: "test-only-engage-auth-secret-must-be-32-or-more",
};
const actor = { memberId: "admin", name: "Administrator" };
const liveUrl = "https://discord.com/api/webhooks/123456789012345678/liveTestCredential";
const testUrl = "https://discord.com/api/webhooks/234567890123456789/testCredential";
const role = "123456789012345678";
type StoredRow = { _id: string; liveWebhook?: unknown; testWebhook?: unknown };

describe("in-app Discord integration configuration", () => {
  it("starts disabled with editable Melbourne schedule and no secrets", async () => {
    const db = createMemoryDb();
    assert.deepEqual(await getDiscordSettingsSummary(db), {
      enabled: false,
      liveWebhookConfigured: false,
      testWebhookConfigured: false,
      liveRoleId: "",
      testRoleId: "",
      dayOfWeek: 1,
      hourOfDay: 18,
      updatedAt: null,
      updatedByName: null,
    });
  });

  it("encrypts webhooks at rest, never returns secrets in admin summaries or audit records", async () => {
    const db = createMemoryDb();
    const result = await updateDiscordSettings(db, env, actor, {
      liveWebhookUrl: liveUrl,
      testWebhookUrl: testUrl,
      liveRoleId: role,
      testRoleId: role,
      dayOfWeek: 2,
      hourOfDay: 19,
    });
    assert.equal(result.liveWebhookConfigured, true);
    assert.equal(result.enabled, false);
    assert.equal(result.dayOfWeek, 2);
    const stored = await db.collection<StoredRow>("discord_settings").findOne({ _id: "global" });
    assert.ok(stored);
    assert.equal(JSON.stringify(stored).includes(liveUrl), false);
    assert.equal(JSON.stringify(stored).includes(testUrl), false);
    assert.match(JSON.stringify(stored), /ciphertext/);
    const events = await db.collection("discord_settings_events").find({}).toArray();
    assert.equal(events.length, 1);
    assert.equal(JSON.stringify(events).includes(liveUrl), false);
    assert.equal(JSON.stringify(events).includes(testUrl), false);
    assert.equal(JSON.stringify(result).includes("Credential"), false);
    const effective = await loadDiscordSettings(db, env);
    assert.equal(effective.liveWebhookUrl, liveUrl);
    assert.equal(effective.testWebhookUrl, testUrl);
    assert.equal(effective.liveRoleId, role);
  });

  it("refuses enabling without live channel and @Tuned, and isolates test/live servers", async () => {
    const db = createMemoryDb();
    await assert.rejects(
      updateDiscordSettings(db, env, actor, { enabled: true }),
      /live webhook and @Tuned role/,
    );
    await updateDiscordSettings(db, env, actor, { liveWebhookUrl: liveUrl });
    await assert.rejects(
      updateDiscordSettings(db, env, actor, { enabled: true }),
      /live webhook and @Tuned role/,
    );
    await assert.rejects(
      updateDiscordSettings(db, env, actor, { testWebhookUrl: liveUrl }),
      /different channels/,
    );
    assert.equal((await getDiscordSettingsSummary(db)).testWebhookConfigured, false);
    const enabled = await updateDiscordSettings(db, env, actor, {
      liveRoleId: role,
      testWebhookUrl: testUrl,
      enabled: true,
    });
    assert.equal(enabled.enabled, true);
  });

  it("removes webhook ciphertext from storage and disables the live channel", async () => {
    const db = createMemoryDb();
    await updateDiscordSettings(db, env, actor, {
      liveWebhookUrl: liveUrl, liveRoleId: role, enabled: true,
      testWebhookUrl: testUrl,
    });
    const removed = await updateDiscordSettings(db, env, actor, { clearLiveWebhook: true });
    assert.equal(removed.enabled, false);
    assert.equal(removed.liveWebhookConfigured, false);
    const stored = await db.collection<StoredRow>("discord_settings").findOne({ _id: "global" });
    assert.equal(stored?.liveWebhook, undefined);
    assert.ok(stored?.testWebhook);
    const testRemoved = await updateDiscordSettings(db, env, actor, { clearTestWebhook: true });
    assert.equal(testRemoved.testWebhookConfigured, false);
    assert.equal(
      (await db.collection<StoredRow>("discord_settings").findOne({ _id: "global" }))?.testWebhook,
      undefined,
    );
  });

  it("binds ciphertext to intended channel and existing bootstrap key", () => {
    const cipher = encryptDiscordWebhook(testUrl, "test", env);
    assert.equal(decryptDiscordWebhook(cipher, "test", env), testUrl);
    assert.throws(() => decryptDiscordWebhook(cipher, "live", env));
    assert.throws(() => decryptDiscordWebhook(cipher, "test", {
      BETTER_AUTH_SECRET: "some-other-test-only-secret-that-is-long-enough",
    }));
    assert.throws(() => encryptDiscordWebhook(testUrl, "test", {}), /server security key/);
  });

  it("validates role ID, week day and hour without silently changing configuration", async () => {
    const db = createMemoryDb();
    await assert.rejects(updateDiscordSettings(db, env, actor, { liveRoleId: "@Tuned" }));
    await assert.rejects(updateDiscordSettings(db, env, actor, { dayOfWeek: 0 }));
    await assert.rejects(updateDiscordSettings(db, env, actor, { hourOfDay: 24 }));
    assert.equal((await getDiscordSettingsSummary(db)).liveRoleId, "");
  });

  it("honours the in-app Melbourne schedule without changing an external cron", () => {
    const schedule = { dayOfWeek: 1, hourOfDay: 18 };
    assert.equal(discordWeeklyDigestDue(schedule, new Date("2026-11-16T06:59:00Z")), false);
    assert.equal(discordWeeklyDigestDue(schedule, new Date("2026-11-16T07:00:00Z")), true);
    assert.equal(discordWeeklyDigestDue(schedule, new Date("2026-11-17T00:00:00Z")), true);
    assert.equal(discordWeeklyDigestDue(schedule, new Date("2026-11-15T12:00:00Z")), false);
  });
});
