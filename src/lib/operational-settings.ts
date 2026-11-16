import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";

/**
 * Operational thresholds (#128).
 *
 * These values decide when `ops:health` reports scheduled work as late or
 * failing. They are an administrator setting, not deployment configuration:
 * stored in MongoDB, validated, defaulted and audited. Changing one takes
 * effect on the next evaluation without a redeploy.
 *
 * They are operational reporting values only. They never change ballot
 * eligibility, closure semantics or recorded results.
 */

export const OPERATIONAL_SETTINGS_COLLECTION = "operational_settings";
export const OPERATIONAL_SETTINGS_EVENTS_COLLECTION =
  "operational_settings_events";
export const OPERATIONAL_SETTINGS_ID = "thresholds" as const;

export type OperationalThresholdKey =
  | "schedulerWarnHours"
  | "schedulerStaleHours"
  | "digestWarnHours"
  | "digestStaleHours"
  | "verificationWarnHours"
  | "verificationStaleHours"
  | "ballotClosureGraceHours"
  | "emailDeliveryWindowHours";

export type OperationalThresholdValues = Record<
  OperationalThresholdKey,
  number
>;

export type OperationalThresholdGroupKey =
  | "scheduler"
  | "digest"
  | "verification"
  | "ballots"
  | "email";

export interface OperationalThresholdField {
  key: OperationalThresholdKey;
  group: OperationalThresholdGroupKey;
  /** Short label beside the input, e.g. "Warn after". */
  label: string;
  /** Plain-language report name, used instead of an internal key. */
  reportName: string;
  hint: string;
  default: number;
  min: number;
  max: number;
}

export interface OperationalThresholdGroup {
  key: OperationalThresholdGroupKey;
  title: string;
  description: string;
  fields: OperationalThresholdKey[];
}

export const OPERATIONAL_THRESHOLD_FIELDS: OperationalThresholdField[] = [
  {
    key: "schedulerWarnHours",
    group: "scheduler",
    label: "Warn after",
    reportName: "governance scheduler warn threshold",
    hint: "Reports late when the last successful run is older than this.",
    default: 2,
    min: 1,
    max: 168,
  },
  {
    key: "schedulerStaleHours",
    group: "scheduler",
    label: "Fail after",
    reportName: "governance scheduler fail threshold",
    hint: "Reports failing when the last successful run is older than this.",
    default: 26,
    min: 2,
    max: 720,
  },
  {
    key: "digestWarnHours",
    group: "digest",
    label: "Warn after",
    reportName: "ballot digest warn threshold",
    hint: "Reports late when the last successful digest is older than this.",
    default: 1,
    min: 1,
    max: 168,
  },
  {
    key: "digestStaleHours",
    group: "digest",
    label: "Fail after",
    reportName: "ballot digest fail threshold",
    hint: "Reports failing when the last successful digest is older than this.",
    default: 24,
    min: 2,
    max: 720,
  },
  {
    key: "verificationWarnHours",
    group: "verification",
    label: "Warn after",
    reportName: "membership verification warn threshold",
    hint: "Reports late when the last successful cycle is older than this.",
    default: 2,
    min: 1,
    max: 168,
  },
  {
    key: "verificationStaleHours",
    group: "verification",
    label: "Fail after",
    reportName: "membership verification fail threshold",
    hint: "Reports failing when the last successful cycle is older than this.",
    default: 24,
    min: 2,
    max: 720,
  },
  {
    key: "ballotClosureGraceHours",
    group: "ballots",
    label: "Grace period",
    reportName: "ballot closure grace period",
    hint: "Ballots past their deadline are reported as failing after this long.",
    default: 2,
    min: 0,
    max: 48,
  },
  {
    key: "emailDeliveryWindowHours",
    group: "email",
    label: "Reporting window",
    reportName: "email delivery reporting window",
    hint: "Counts failed or held messages sent within this many hours.",
    default: 24,
    min: 1,
    max: 168,
  },
];

export const OPERATIONAL_THRESHOLD_GROUPS: OperationalThresholdGroup[] = [
  {
    key: "scheduler",
    title: "Governance scheduler",
    description: "Advances deadlines and records ballot closure.",
    fields: ["schedulerWarnHours", "schedulerStaleHours"],
  },
  {
    key: "digest",
    title: "Ballot digest email",
    description: "Sends ballot reminders to members.",
    fields: ["digestWarnHours", "digestStaleHours"],
  },
  {
    key: "verification",
    title: "Membership verification",
    description: "Keeps memberships current with the CRM.",
    fields: ["verificationWarnHours", "verificationStaleHours"],
  },
  {
    key: "ballots",
    title: "Ballot deadlines",
    description: "Decides when an unclosed deadline is a failure.",
    fields: ["ballotClosureGraceHours"],
  },
  {
    key: "email",
    title: "Email delivery",
    description: "Decides how far back failed or held messages are counted.",
    fields: ["emailDeliveryWindowHours"],
  },
];

export const OPERATIONAL_THRESHOLD_BY_KEY = new Map<
  OperationalThresholdKey,
  OperationalThresholdField
>(OPERATIONAL_THRESHOLD_FIELDS.map((field) => [field.key, field]));

/** Warn/fail pairs that must keep warn below fail. */
export const OPERATIONAL_THRESHOLD_PAIRS: Array<{
  warn: OperationalThresholdKey;
  fail: OperationalThresholdKey;
}> = [
  { warn: "schedulerWarnHours", fail: "schedulerStaleHours" },
  { warn: "digestWarnHours", fail: "digestStaleHours" },
  { warn: "verificationWarnHours", fail: "verificationStaleHours" },
];

export const DEFAULT_OPERATIONAL_THRESHOLDS: OperationalThresholdValues = {
  schedulerWarnHours: 2,
  schedulerStaleHours: 26,
  digestWarnHours: 1,
  digestStaleHours: 24,
  verificationWarnHours: 2,
  verificationStaleHours: 24,
  ballotClosureGraceHours: 2,
  emailDeliveryWindowHours: 24,
};

export type OperationalSettingsSource = "settings" | "default";

export interface OperationalSettings extends OperationalThresholdValues {
  updatedAt?: Date;
  updatedBy?: string;
  updatedByName?: string;
}

export interface OperationalSettingsState {
  values: OperationalThresholdValues;
  source: OperationalSettingsSource;
  /** Stored fields that cannot be trusted; health reports them as unknown. */
  invalidFields: OperationalThresholdKey[];
  /** The stored document could not be read at all. */
  readFailed?: boolean;
  updatedAt?: Date;
  updatedBy?: string;
  updatedByName?: string;
}

export interface OperationalSettingsActor {
  memberId: string;
  name: string;
}

export interface OperationalSettingsEvent {
  eventId: string;
  setting: "thresholds";
  actorId: string;
  actorName: string;
  changedFields: OperationalThresholdKey[];
  before: Partial<OperationalThresholdValues>;
  after: Partial<OperationalThresholdValues>;
  createdAt: Date;
}

export function getDefaultOperationalSettings(): OperationalSettings {
  return { ...DEFAULT_OPERATIONAL_THRESHOLDS };
}

function parseWholeHours(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isInteger(raw) ? raw : null;
  }
  if (typeof raw === "string" && /^-?\d+$/.test(raw.trim())) {
    return Number(raw.trim());
  }
  return null;
}

function rangeMessage(field: OperationalThresholdField): string {
  return `Enter a whole number from ${field.min} to ${field.max} hours.`;
}

/**
 * Validate the eight threshold values.
 *
 * Every value is required: a save replaces the whole document, so a partial
 * payload is rejected rather than silently retaining a value the administrator
 * did not see. Bounds and the warn/fail relationship are reported per field in
 * plain language.
 */
export function validateOperationalSettingsInput(
  raw: Record<string, unknown>,
): {
  values: OperationalThresholdValues | null;
  fieldErrors: Record<string, string>;
} {
  const fieldErrors: Record<string, string> = {};
  const parsed = {} as OperationalThresholdValues;

  for (const field of OPERATIONAL_THRESHOLD_FIELDS) {
    const value = parseWholeHours(raw[field.key]);
    if (value === null) {
      fieldErrors[field.key] = "Enter a whole number of hours.";
      continue;
    }
    if (value < field.min || value > field.max) {
      fieldErrors[field.key] = rangeMessage(field);
      continue;
    }
    parsed[field.key] = value;
  }

  for (const pair of OPERATIONAL_THRESHOLD_PAIRS) {
    if (fieldErrors[pair.warn] || fieldErrors[pair.fail]) continue;
    if (parsed[pair.warn] >= parsed[pair.fail]) {
      fieldErrors[pair.warn] =
        "This must be fewer hours than the fail threshold.";
      fieldErrors[pair.fail] =
        "This must be more hours than the warn threshold.";
    }
  }

  const complete = OPERATIONAL_THRESHOLD_FIELDS.every(
    (field) => !fieldErrors[field.key],
  );
  return {
    values: complete ? parsed : null,
    fieldErrors,
  };
}

/** Keys whose stored value is individually invalid (missing, not an integer, out of range). */
function invalidStoredFields(
  stored: Record<string, unknown>,
): OperationalThresholdKey[] {
  const invalid = new Set<OperationalThresholdKey>();

  for (const field of OPERATIONAL_THRESHOLD_FIELDS) {
    const value = stored[field.key];
    if (typeof value !== "number" || !Number.isInteger(value)) {
      invalid.add(field.key);
      continue;
    }
    if (value < field.min || value > field.max) {
      invalid.add(field.key);
    }
  }

  return [...invalid];
}

interface StoredOperationalSettings extends Record<string, unknown> {
  _id: string;
  updatedAt?: Date;
  updatedBy?: string;
  updatedByName?: string;
}

/**
 * Read the saved thresholds merged over the documented defaults.
 *
 * A missing document means the defaults. A stored field that fails validation
 * is replaced by its default in the merged values so callers always have a
 * usable number, but it is listed in `invalidFields` and health refuses to
 * report a state from it. Invalid stored settings never silently look healthy.
 */
export async function getOperationalSettingsState(
  db: Db,
): Promise<OperationalSettingsState> {
  let stored: StoredOperationalSettings | null;
  try {
    stored = await db
      .collection<StoredOperationalSettings>(OPERATIONAL_SETTINGS_COLLECTION)
      .findOne({ _id: OPERATIONAL_SETTINGS_ID });
  } catch {
    return {
      values: { ...DEFAULT_OPERATIONAL_THRESHOLDS },
      source: "default",
      invalidFields: [],
      readFailed: true,
    };
  }

  if (!stored) {
    return {
      values: { ...DEFAULT_OPERATIONAL_THRESHOLDS },
      source: "default",
      invalidFields: [],
    };
  }

  const invalidFields = invalidStoredFields(stored);
  const values = { ...DEFAULT_OPERATIONAL_THRESHOLDS };
  for (const field of OPERATIONAL_THRESHOLD_FIELDS) {
    const value = stored[field.key];
    if (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= field.min &&
      value <= field.max
    ) {
      values[field.key] = value;
    }
  }

  return {
    values,
    source: "settings",
    invalidFields,
    ...(stored.updatedAt ? { updatedAt: new Date(stored.updatedAt) } : {}),
    ...(stored.updatedBy ? { updatedBy: stored.updatedBy } : {}),
    ...(stored.updatedByName ? { updatedByName: stored.updatedByName } : {}),
  };
}

/** Saved threshold values merged over the defaults. */
export async function getOperationalSettings(
  db: Db,
): Promise<OperationalSettings> {
  const state = await getOperationalSettingsState(db);
  return {
    ...state.values,
    ...(state.updatedAt ? { updatedAt: state.updatedAt } : {}),
    ...(state.updatedBy ? { updatedBy: state.updatedBy } : {}),
    ...(state.updatedByName ? { updatedByName: state.updatedByName } : {}),
  };
}

function pickChanged(
  values: OperationalThresholdValues,
  keys: OperationalThresholdKey[],
): Partial<OperationalThresholdValues> {
  const picked: Partial<OperationalThresholdValues> = {};
  for (const key of keys) picked[key] = values[key];
  return picked;
}

export type SaveOperationalSettingsResult =
  | {
      ok: true;
      values: OperationalThresholdValues;
      changedFields: OperationalThresholdKey[];
      event: OperationalSettingsEvent | null;
    }
  | { ok: false; fieldErrors: Record<string, string> };

/**
 * Validate, store and audit a threshold change.
 *
 * The audit event records only the fields that actually changed, with their
 * before and after values. Nothing else is stored: there are no secrets here
 * and no member data.
 */
export async function saveOperationalSettings(
  db: Db,
  actor: OperationalSettingsActor,
  raw: Record<string, unknown>,
): Promise<SaveOperationalSettingsResult> {
  const { values, fieldErrors } = validateOperationalSettingsInput(raw);
  if (!values) return { ok: false, fieldErrors };

  const current = await getOperationalSettingsState(db);
  const changedFields = OPERATIONAL_THRESHOLD_FIELDS.map(
    (field) => field.key,
  ).filter((key) => current.values[key] !== values[key]);
  const now = new Date();

  await db
    .collection<StoredOperationalSettings>(OPERATIONAL_SETTINGS_COLLECTION)
    .updateOne(
      { _id: OPERATIONAL_SETTINGS_ID },
      {
        $set: {
          ...values,
          updatedAt: now,
          updatedBy: actor.memberId,
          updatedByName: actor.name,
        },
      },
      { upsert: true },
    );

  let event: OperationalSettingsEvent | null = null;
  if (changedFields.length > 0) {
    event = {
      eventId: randomUUID(),
      setting: "thresholds",
      actorId: actor.memberId,
      actorName: actor.name,
      changedFields,
      before: pickChanged(current.values, changedFields),
      after: pickChanged(values, changedFields),
      createdAt: now,
    };
    await db
      .collection(OPERATIONAL_SETTINGS_EVENTS_COLLECTION)
      .insertOne(event as unknown as Record<string, unknown>);
  }

  return { ok: true, values, changedFields, event };
}

export async function listOperationalSettingsEvents(
  db: Db,
  limit = 20,
): Promise<OperationalSettingsEvent[]> {
  try {
    const rows = await db
      .collection<OperationalSettingsEvent>(
        OPERATIONAL_SETTINGS_EVENTS_COLLECTION,
      )
      .find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    return rows.map(({ _id, ...rest }: any) => ({
      ...rest,
      createdAt: rest.createdAt ? new Date(rest.createdAt) : new Date(),
    }));
  } catch {
    return [];
  }
}
