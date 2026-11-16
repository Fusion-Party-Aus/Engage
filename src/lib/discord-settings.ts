import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";
import type { Db } from "mongodb";
import type { PlatformEnv } from "./types.ts";
import { validateDiscordWebhook } from "./discord-webhook.ts";

const SETTINGS_COLLECTION = "discord_settings";
const EVENTS_COLLECTION = "discord_settings_events";
const SETTINGS_ID = "global";

export interface EncryptedWebhook {
  v: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

interface StoredDiscordSettings {
  _id: string;
  enabled?: boolean;
  liveWebhook?: EncryptedWebhook;
  testWebhook?: EncryptedWebhook;
  liveRoleId?: string;
  testRoleId?: string;
  /** ISO weekday 1=Monday, 7=Sunday. */
  dayOfWeek?: number;
  /** Melbourne local hour, 0–23. */
  hourOfDay?: number;
  updatedAt?: Date;
  updatedBy?: string;
  updatedByName?: string;
}

export interface DiscordSettingsSummary {
  enabled: boolean;
  liveWebhookConfigured: boolean;
  testWebhookConfigured: boolean;
  liveRoleId: string;
  testRoleId: string;
  dayOfWeek: number;
  hourOfDay: number;
  updatedAt: Date | null;
  updatedByName: string | null;
}

export interface EffectiveDiscordSettings extends DiscordSettingsSummary {
  liveWebhookUrl?: string;
  testWebhookUrl?: string;
}

export interface DiscordSettingsPatch {
  enabled?: boolean;
  liveWebhookUrl?: string;
  testWebhookUrl?: string;
  clearLiveWebhook?: boolean;
  clearTestWebhook?: boolean;
  liveRoleId?: string;
  testRoleId?: string;
  dayOfWeek?: number;
  hourOfDay?: number;
}

export class DiscordSettingsError extends Error {
  constructor(message: string, public status = 422) {
    super(message);
    this.name = "DiscordSettingsError";
  }
}

function encryptionKey(env: PlatformEnv): Buffer {
  // Avoid a separate setup secret. This key is derived with domain separation
  // from the mandatory existing Better Auth bootstrap secret. Keep that secret
  // backed up: changing it requires re-entering stored webhooks.
  const root = env.BETTER_AUTH_SECRET;
  if (!root || Buffer.byteLength(root) < 32) {
    throw new DiscordSettingsError(
      "Engage's server security key must be configured before saving webhooks.",
      503,
    );
  }
  return createHmac("sha256", root)
    .update("engage-discord-webhook-encryption-v1")
    .digest();
}

export function encryptDiscordWebhook(
  value: string,
  purpose: "live" | "test",
  env: PlatformEnv,
): EncryptedWebhook {
  validateDiscordWebhook(value);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(env), iv);
  cipher.setAAD(Buffer.from(`engage-discord-webhook-v1:${purpose}`));
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return {
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptDiscordWebhook(
  envelope: EncryptedWebhook,
  purpose: "live" | "test",
  env: PlatformEnv,
): string {
  if (
    !envelope || envelope.v !== 1 ||
    typeof envelope.iv !== "string" ||
    typeof envelope.tag !== "string" ||
    typeof envelope.ciphertext !== "string"
  ) throw new DiscordSettingsError("Saved Discord webhook is unreadable.", 503);
  try {
    const iv = Buffer.from(envelope.iv, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    if (iv.length !== 12 || tag.length !== 16) throw new Error("invalid envelope");
    const cipher = createDecipheriv("aes-256-gcm", encryptionKey(env), iv);
    cipher.setAAD(Buffer.from(`engage-discord-webhook-v1:${purpose}`));
    cipher.setAuthTag(tag);
    const value = Buffer.concat([
      cipher.update(Buffer.from(envelope.ciphertext, "base64")),
      cipher.final(),
    ]).toString("utf8");
    validateDiscordWebhook(value);
    return value;
  } catch {
    throw new DiscordSettingsError(
      "Saved Discord webhook cannot be decrypted. Re-enter it in Platform settings.",
      503,
    );
  }
}

async function readStored(db: Db): Promise<StoredDiscordSettings> {
  const doc = await db.collection<StoredDiscordSettings>(SETTINGS_COLLECTION)
    .findOne({ _id: SETTINGS_ID });
  return doc ?? { _id: SETTINGS_ID };
}

function summary(stored: StoredDiscordSettings): DiscordSettingsSummary {
  return {
    enabled: stored.enabled === true,
    liveWebhookConfigured: Boolean(stored.liveWebhook),
    testWebhookConfigured: Boolean(stored.testWebhook),
    liveRoleId: stored.liveRoleId ?? "",
    testRoleId: stored.testRoleId ?? "",
    dayOfWeek: stored.dayOfWeek ?? 1,
    hourOfDay: stored.hourOfDay ?? 18,
    updatedAt: stored.updatedAt ?? null,
    updatedByName: stored.updatedByName ?? null,
  };
}

/** Safe for administrator JSON. Webhook credentials never leave the server. */
export async function getDiscordSettingsSummary(db: Db): Promise<DiscordSettingsSummary> {
  return summary(await readStored(db));
}

export async function loadDiscordSettings(
  db: Db,
  env: PlatformEnv,
): Promise<EffectiveDiscordSettings> {
  const stored = await readStored(db);
  return {
    ...summary(stored),
    ...(stored.liveWebhook
      ? { liveWebhookUrl: decryptDiscordWebhook(stored.liveWebhook, "live", env) }
      : {}),
    ...(stored.testWebhook
      ? { testWebhookUrl: decryptDiscordWebhook(stored.testWebhook, "test", env) }
      : {}),
  };
}

/** Save only an allowlisted patch; log field names, never credentials or values. */
export async function updateDiscordSettings(
  db: Db,
  env: PlatformEnv,
  actor: { memberId: string; name: string },
  patch: DiscordSettingsPatch,
): Promise<DiscordSettingsSummary> {
  const current = await readStored(db);
  const next: StoredDiscordSettings = { ...current };
  const changed: string[] = [];
  const set = <K extends keyof StoredDiscordSettings>(
    key: K,
    value: StoredDiscordSettings[K],
  ) => {
    if (JSON.stringify(current[key]) !== JSON.stringify(value)) {
      next[key] = value;
      changed.push(String(key));
    }
  };

  for (const [key, value] of [
    ["liveRoleId", patch.liveRoleId],
    ["testRoleId", patch.testRoleId],
  ] as const) {
    if (value === undefined) continue;
    if (typeof value !== "string") throw new DiscordSettingsError("Invalid role ID.");
    const trimmed = value.trim();
    if (trimmed && !/^\d{15,25}$/.test(trimmed)) {
      throw new DiscordSettingsError("Enter a numeric Discord role ID.");
    }
    set(key, trimmed);
  }
  if (patch.dayOfWeek !== undefined) {
    if (!Number.isInteger(patch.dayOfWeek) || patch.dayOfWeek < 1 || patch.dayOfWeek > 7)
      throw new DiscordSettingsError("Choose a valid posting day.");
    set("dayOfWeek", patch.dayOfWeek);
  }
  if (patch.hourOfDay !== undefined) {
    if (!Number.isInteger(patch.hourOfDay) || patch.hourOfDay < 0 || patch.hourOfDay > 23)
      throw new DiscordSettingsError("Choose a valid posting hour.");
    set("hourOfDay", patch.hourOfDay);
  }
  if (patch.liveWebhookUrl !== undefined) {
    if (typeof patch.liveWebhookUrl !== "string" || !patch.liveWebhookUrl.trim())
      throw new DiscordSettingsError("Enter a Discord webhook URL or use Remove.");
    try {
      set("liveWebhook", encryptDiscordWebhook(patch.liveWebhookUrl.trim(), "live", env));
    } catch (error) {
      if (error instanceof DiscordSettingsError) throw error;
      throw new DiscordSettingsError("Enter a Discord webhook URL from the live channel.");
    }
  }
  if (patch.testWebhookUrl !== undefined) {
    if (typeof patch.testWebhookUrl !== "string" || !patch.testWebhookUrl.trim())
      throw new DiscordSettingsError("Enter a Discord webhook URL or use Remove.");
    try {
      set("testWebhook", encryptDiscordWebhook(patch.testWebhookUrl.trim(), "test", env));
    } catch (error) {
      if (error instanceof DiscordSettingsError) throw error;
      throw new DiscordSettingsError("Enter a Discord webhook URL from the test server.");
    }
  }
  if (patch.clearLiveWebhook === true && patch.liveWebhookUrl !== undefined ||
      patch.clearTestWebhook === true && patch.testWebhookUrl !== undefined) {
    throw new DiscordSettingsError("Choose either replace or remove for each webhook.");
  }
  if (patch.clearLiveWebhook === true && next.liveWebhook) {
    delete next.liveWebhook;
    changed.push("liveWebhook");
    set("enabled", false);
  }
  if (patch.clearTestWebhook === true && next.testWebhook) {
    delete next.testWebhook;
    changed.push("testWebhook");
  }
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") throw new DiscordSettingsError("Choose on or off.");
    set("enabled", patch.enabled);
  }
  if (next.enabled && (!next.liveWebhook || !next.liveRoleId)) {
    throw new DiscordSettingsError("Add a live webhook and @Tuned role before enabling Discord posting.");
  }
  if (next.liveWebhook && next.testWebhook) {
    // Compare decrypted values, never ciphertext (random IVs differ).
    if (
      decryptDiscordWebhook(next.liveWebhook, "live", env) ===
      decryptDiscordWebhook(next.testWebhook, "test", env)
    ) throw new DiscordSettingsError("Test and live webhooks must use different channels.");
  }

  if (!changed.length) return summary(current);
  const now = new Date();
  next.updatedAt = now;
  next.updatedBy = actor.memberId;
  next.updatedByName = actor.name;
  const col = db.collection<StoredDiscordSettings>(SETTINGS_COLLECTION);
  const { _id: _key, ...fields } = next;
  const unset: Record<string, ""> = {};
  if (patch.clearLiveWebhook === true) unset.liveWebhook = "";
  if (patch.clearTestWebhook === true) unset.testWebhook = "";
  await col.updateOne(
    { _id: SETTINGS_ID },
    {
      $set: fields,
      ...(Object.keys(unset).length ? { $unset: unset } : {}),
    },
    { upsert: true },
  );
  await db.collection(EVENTS_COLLECTION).insertOne({
    eventId: randomUUID(),
    actorId: actor.memberId,
    actorName: actor.name,
    changedFields: changed,
    createdAt: now,
  });
  return summary(next);
}

/** Schedule is editable in Engage; an external hourly trigger still runs the job. */
export function discordWeeklyDigestDue(
  settings: Pick<DiscordSettingsSummary, "dayOfWeek" | "hourOfDay">,
  now: Date,
): boolean {
  const localDay = new Intl.DateTimeFormat("en-US", {
    timeZone: "Australia/Melbourne",
    weekday: "short",
  }).format(now);
  const dayOfWeek = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    .indexOf(localDay) + 1;
  const localHour = Number(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Australia/Melbourne",
    hour: "2-digit",
    hourCycle: "h23",
  }).format(now));
  return dayOfWeek > settings.dayOfWeek ||
    (dayOfWeek === settings.dayOfWeek && localHour >= settings.hourOfDay);
}
