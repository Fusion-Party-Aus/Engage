import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";

/**
 * Operational settings (#128).
 *
 * These values decide when `ops:health` reports scheduled work as late or
 * failing, how the CRM verification cycle runs, and whether the scheduled jobs
 * are enabled. They are administrator settings, not deployment configuration:
 * stored in MongoDB, validated, defaulted and audited. Changing one takes
 * effect on the next run without a redeploy.
 *
 * Three documents share the `operational_settings` collection:
 *
 * - `_id: "thresholds"` — health warn/fail thresholds and reporting windows;
 * - `_id: "crm"` — CRM verification enablement and tuning;
 * - `_id: "jobs"` — scheduled digest enablement.
 *
 * They are operational values only. They never change ballot eligibility,
 * closure semantics or recorded results.
 */

export const OPERATIONAL_SETTINGS_COLLECTION = "operational_settings";
export const OPERATIONAL_SETTINGS_EVENTS_COLLECTION =
  "operational_settings_events";
export const OPERATIONAL_SETTINGS_ID = "thresholds" as const;
export const CRM_OPERATIONAL_SETTINGS_ID = "crm" as const;
export const JOBS_OPERATIONAL_SETTINGS_ID = "jobs" as const;

export type OperationalSettingsSection = "thresholds" | "crm" | "jobs";

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

/* --------------------------------------------------------------------------
 * CRM verification and scheduled jobs
 * ------------------------------------------------------------------------ */

export type CrmSettingKey =
  | "crmVerificationEnabled"
  | "crmBatchSize"
  | "crmReconcileIntervalMinutes"
  | "crmOutageAlertAfterAttempts"
  | "crmTimeoutMs";

export type JobsSettingKey = "digestEnabled";

export type OperationalSettingKey =
  | OperationalThresholdKey
  | CrmSettingKey
  | JobsSettingKey;

export type OperationalSettingScalar = number | boolean;

export interface CrmOperationalSettingsValues {
  crmVerificationEnabled: boolean;
  crmBatchSize: number;
  crmReconcileIntervalMinutes: number;
  crmOutageAlertAfterAttempts: number;
  crmTimeoutMs: number;
}

export interface JobsOperationalSettingsValues {
  digestEnabled: boolean;
}

export interface IntegerSettingField<Key extends string> {
  key: Key;
  kind: "integer";
  label: string;
  hint: string;
  default: number;
  min: number;
  max: number;
  /** Unit shown beside the input and in the permitted range. */
  unit: string;
}

export interface BooleanSettingField<Key extends string> {
  key: Key;
  kind: "boolean";
  label: string;
  hint: string;
  default: boolean;
}

export type CrmSettingField =
  | BooleanSettingField<CrmSettingKey>
  | IntegerSettingField<CrmSettingKey>;

export type JobsSettingField = BooleanSettingField<JobsSettingKey>;

/**
 * Bounds preserve the limits the environment variables applied: a batch of at
 * least 1 and at most 100 members, a reconcile cadence of at least 15 minutes,
 * at least one failed attempt before an outage alert, and a request timeout
 * from 1 to 60 seconds.
 */
export const CRM_BATCH_SIZE_MAX = 100;
export const CRM_RECONCILE_INTERVAL_MIN_MINUTES = 15;
export const CRM_RECONCILE_INTERVAL_MAX_MINUTES = 43_200;
export const CRM_OUTAGE_ALERT_MAX_ATTEMPTS = 20;
export const CRM_TIMEOUT_MIN_MS = 1_000;
export const CRM_TIMEOUT_MAX_MS = 60_000;

export const DEFAULT_CRM_SETTINGS: CrmOperationalSettingsValues = {
  // Safe default when unset: the job stays off until an administrator turns it
  // on in Platform settings.
  crmVerificationEnabled: false,
  crmBatchSize: 25,
  crmReconcileIntervalMinutes: 1_440,
  crmOutageAlertAfterAttempts: 3,
  crmTimeoutMs: 10_000,
};

export const DEFAULT_JOBS_SETTINGS: JobsOperationalSettingsValues = {
  digestEnabled: false,
};

export const CRM_SETTING_FIELDS: CrmSettingField[] = [
  {
    key: "crmVerificationEnabled",
    kind: "boolean",
    label: "Automatic verification",
    hint: "Checks pending members against the CRM when the scheduled job runs.",
    default: false,
  },
  {
    key: "crmBatchSize",
    kind: "integer",
    label: "Members per cycle",
    hint: "How many queued members each scheduled cycle processes.",
    default: 25,
    min: 1,
    max: CRM_BATCH_SIZE_MAX,
    unit: "members",
  },
  {
    key: "crmReconcileIntervalMinutes",
    kind: "integer",
    label: "Recheck linked members every",
    hint: "How often an already verified member is checked again.",
    default: 1_440,
    min: CRM_RECONCILE_INTERVAL_MIN_MINUTES,
    max: CRM_RECONCILE_INTERVAL_MAX_MINUTES,
    unit: "minutes",
  },
  {
    key: "crmOutageAlertAfterAttempts",
    kind: "integer",
    label: "Alert after failed attempts",
    hint: "Consecutive CRM failures before administrators are notified.",
    default: 3,
    min: 1,
    max: CRM_OUTAGE_ALERT_MAX_ATTEMPTS,
    unit: "attempts",
  },
  {
    key: "crmTimeoutMs",
    kind: "integer",
    label: "CRM request timeout",
    hint: "Stop waiting for a CRM response after this long.",
    default: 10_000,
    min: CRM_TIMEOUT_MIN_MS,
    max: CRM_TIMEOUT_MAX_MS,
    unit: "milliseconds",
  },
];

export const JOBS_SETTING_FIELDS: JobsSettingField[] = [
  {
    key: "digestEnabled",
    kind: "boolean",
    label: "Scheduled ballot digests",
    hint: "Sends ballot reminder emails when the scheduled job runs.",
    default: false,
  },
];

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

export interface CrmSettingsState {
  values: CrmOperationalSettingsValues;
  source: OperationalSettingsSource;
  invalidFields: CrmSettingKey[];
  readFailed?: boolean;
  updatedAt?: Date;
  updatedBy?: string;
  updatedByName?: string;
}

export interface JobsSettingsState {
  values: JobsOperationalSettingsValues;
  source: OperationalSettingsSource;
  invalidFields: JobsSettingKey[];
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
  setting: OperationalSettingsSection;
  actorId: string;
  actorName: string;
  changedFields: OperationalSettingKey[];
  before: Partial<Record<OperationalSettingKey, OperationalSettingScalar>>;
  after: Partial<Record<OperationalSettingKey, OperationalSettingScalar>>;
  createdAt: Date;
}

function parseWholeNumber(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isInteger(raw) ? raw : null;
  }
  if (typeof raw === "string" && /^-?\d+$/.test(raw.trim())) {
    return Number(raw.trim());
  }
  return null;
}

function parseBoolean(raw: unknown): boolean | null {
  if (typeof raw === "boolean") return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

function rangeMessage(field: OperationalThresholdField): string {
  return `Enter a whole number from ${field.min} to ${field.max} hours.`;
}

function integerRangeMessage(field: IntegerSettingField<string>): string {
  const unit = field.unit ? ` ${field.unit}` : "";
  return `Enter a whole number from ${field.min} to ${field.max}${unit}.`;
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
    const value = parseWholeNumber(raw[field.key]);
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

/**
 * Validate the CRM verification settings.
 *
 * As with the thresholds, every value is required so a save can never
 * accidentally retain a value the administrator did not see. Unknown keys are
 * ignored rather than rejected; nothing outside the documented fields is read.
 */
export function validateCrmSettingsInput(
  raw: Record<string, unknown>,
): {
  values: CrmOperationalSettingsValues | null;
  fieldErrors: Record<string, string>;
} {
  const fieldErrors: Record<string, string> = {};
  const parsed = {} as CrmOperationalSettingsValues;

  for (const field of CRM_SETTING_FIELDS) {
    const rawValue = raw[field.key];
    if (field.kind === "boolean") {
      const value = parseBoolean(rawValue);
      if (value === null) {
        fieldErrors[field.key] = "Choose whether this is on or off.";
        continue;
      }
      parsed[field.key] = value as never;
      continue;
    }
    const value = parseWholeNumber(rawValue);
    if (value === null) {
      fieldErrors[field.key] = "Enter a whole number.";
      continue;
    }
    if (value < field.min || value > field.max) {
      fieldErrors[field.key] = integerRangeMessage(field);
      continue;
    }
    parsed[field.key] = value as never;
  }

  const complete = CRM_SETTING_FIELDS.every(
    (field) => !fieldErrors[field.key],
  );
  return { values: complete ? parsed : null, fieldErrors };
}

export function validateJobsSettingsInput(
  raw: Record<string, unknown>,
): {
  values: JobsOperationalSettingsValues | null;
  fieldErrors: Record<string, string>;
} {
  const fieldErrors: Record<string, string> = {};
  const parsed = {} as JobsOperationalSettingsValues;
  for (const field of JOBS_SETTING_FIELDS) {
    const value = parseBoolean(raw[field.key]);
    if (value === null) {
      fieldErrors[field.key] = "Choose whether this is on or off.";
      continue;
    }
    parsed[field.key] = value;
  }
  const complete = JOBS_SETTING_FIELDS.every(
    (field) => !fieldErrors[field.key],
  );
  return { values: complete ? parsed : null, fieldErrors };
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

function invalidStoredCrmFields(
  stored: Record<string, unknown>,
): CrmSettingKey[] {
  const invalid: CrmSettingKey[] = [];
  for (const field of CRM_SETTING_FIELDS) {
    const value = stored[field.key];
    if (field.kind === "boolean") {
      if (typeof value !== "boolean") invalid.push(field.key);
      continue;
    }
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < field.min ||
      value > field.max
    ) {
      invalid.push(field.key);
    }
  }
  return invalid;
}

function invalidStoredJobsFields(
  stored: Record<string, unknown>,
): JobsSettingKey[] {
  return JOBS_SETTING_FIELDS.filter(
    (field) => typeof stored[field.key] !== "boolean",
  ).map((field) => field.key);
}

interface StoredSettingDocument extends Record<string, unknown> {
  _id: string;
  updatedAt?: Date;
  updatedBy?: string;
  updatedByName?: string;
}

async function readStoredSetting(
  db: Db,
  id: string,
): Promise<{ stored: StoredSettingDocument | null; readFailed: boolean }> {
  try {
    const stored = await db
      .collection<StoredSettingDocument>(OPERATIONAL_SETTINGS_COLLECTION)
      .findOne({ _id: id });
    return { stored, readFailed: false };
  } catch {
    return { stored: null, readFailed: true };
  }
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
  const { stored, readFailed } = await readStoredSetting(
    db,
    OPERATIONAL_SETTINGS_ID,
  );

  if (readFailed) {
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

/**
 * Read the saved CRM verification settings.
 *
 * A missing document means the documented defaults, including the safe
 * `crmVerificationEnabled: false` gate. A stored value that is missing or out
 * of range is reported in `invalidFields`; callers must not run the job with a
 * value that cannot be trusted.
 */
export async function getCrmSettingsState(db: Db): Promise<CrmSettingsState> {
  const { stored, readFailed } = await readStoredSetting(
    db,
    CRM_OPERATIONAL_SETTINGS_ID,
  );

  if (readFailed) {
    return {
      values: { ...DEFAULT_CRM_SETTINGS },
      source: "default",
      invalidFields: [],
      readFailed: true,
    };
  }

  if (!stored) {
    return {
      values: { ...DEFAULT_CRM_SETTINGS },
      source: "default",
      invalidFields: [],
    };
  }

  const invalidFields = invalidStoredCrmFields(stored);
  const values = { ...DEFAULT_CRM_SETTINGS };
  for (const field of CRM_SETTING_FIELDS) {
    const value = stored[field.key];
    if (field.kind === "boolean") {
      if (typeof value === "boolean") values[field.key] = value as never;
      continue;
    }
    if (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= field.min &&
      value <= field.max
    ) {
      values[field.key] = value as never;
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

/** Read the saved scheduled-job gates. Missing means disabled. */
export async function getJobsSettingsState(db: Db): Promise<JobsSettingsState> {
  const { stored, readFailed } = await readStoredSetting(
    db,
    JOBS_OPERATIONAL_SETTINGS_ID,
  );

  if (readFailed) {
    return {
      values: { ...DEFAULT_JOBS_SETTINGS },
      source: "default",
      invalidFields: [],
      readFailed: true,
    };
  }

  if (!stored) {
    return {
      values: { ...DEFAULT_JOBS_SETTINGS },
      source: "default",
      invalidFields: [],
    };
  }

  const invalidFields = invalidStoredJobsFields(stored);
  const values = { ...DEFAULT_JOBS_SETTINGS };
  if (typeof stored.digestEnabled === "boolean") {
    values.digestEnabled = stored.digestEnabled;
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

function pickChanged(
  values: Partial<Record<OperationalSettingKey, OperationalSettingScalar>>,
  keys: OperationalSettingKey[],
): Partial<Record<OperationalSettingKey, OperationalSettingScalar>> {
  const picked: Partial<
    Record<OperationalSettingKey, OperationalSettingScalar>
  > = {};
  for (const key of keys) picked[key] = values[key];
  return picked;
}

async function storeSetting(
  db: Db,
  actor: OperationalSettingsActor,
  id: string,
  values: Partial<Record<OperationalSettingKey, OperationalSettingScalar>>,
  now: Date,
): Promise<void> {
  await db
    .collection<StoredSettingDocument>(OPERATIONAL_SETTINGS_COLLECTION)
    .updateOne(
      { _id: id },
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
}

async function recordSettingChange(
  db: Db,
  actor: OperationalSettingsActor,
  setting: OperationalSettingsSection,
  changedFields: OperationalSettingKey[],
  before: Partial<Record<OperationalSettingKey, OperationalSettingScalar>>,
  after: Partial<Record<OperationalSettingKey, OperationalSettingScalar>>,
  now: Date,
): Promise<OperationalSettingsEvent | null> {
  if (changedFields.length === 0) return null;
  const event: OperationalSettingsEvent = {
    eventId: randomUUID(),
    setting,
    actorId: actor.memberId,
    actorName: actor.name,
    changedFields,
    before: pickChanged(before, changedFields),
    after: pickChanged(after, changedFields),
    createdAt: now,
  };
  await db
    .collection(OPERATIONAL_SETTINGS_EVENTS_COLLECTION)
    .insertOne(event as unknown as Record<string, unknown>);
  return event;
}

export type SaveOperationalSettingsResult =
  | {
      ok: true;
      values: OperationalThresholdValues;
      changedFields: OperationalThresholdKey[];
      event: OperationalSettingsEvent | null;
    }
  | { ok: false; fieldErrors: Record<string, string> };

export type SaveCrmSettingsResult =
  | {
      ok: true;
      values: CrmOperationalSettingsValues;
      changedFields: CrmSettingKey[];
      event: OperationalSettingsEvent | null;
    }
  | { ok: false; fieldErrors: Record<string, string> };

export type SaveJobsSettingsResult =
  | {
      ok: true;
      values: JobsOperationalSettingsValues;
      changedFields: JobsSettingKey[];
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

  await storeSetting(db, actor, OPERATIONAL_SETTINGS_ID, values, now);
  const event = await recordSettingChange(
    db,
    actor,
    "thresholds",
    changedFields,
    current.values,
    values,
    now,
  );

  return { ok: true, values, changedFields, event };
}

/** Validate, store and audit a CRM verification settings change. */
export async function saveCrmSettings(
  db: Db,
  actor: OperationalSettingsActor,
  raw: Record<string, unknown>,
): Promise<SaveCrmSettingsResult> {
  const { values, fieldErrors } = validateCrmSettingsInput(raw);
  if (!values) return { ok: false, fieldErrors };

  const current = await getCrmSettingsState(db);
  const changedFields = CRM_SETTING_FIELDS.map((field) => field.key).filter(
    (key) => current.values[key] !== values[key],
  );
  const now = new Date();

  await storeSetting(db, actor, CRM_OPERATIONAL_SETTINGS_ID, values, now);
  const event = await recordSettingChange(
    db,
    actor,
    "crm",
    changedFields,
    current.values,
    values,
    now,
  );

  return { ok: true, values, changedFields, event };
}

/** Validate, store and audit a scheduled-job gate change. */
export async function saveJobsSettings(
  db: Db,
  actor: OperationalSettingsActor,
  raw: Record<string, unknown>,
): Promise<SaveJobsSettingsResult> {
  const { values, fieldErrors } = validateJobsSettingsInput(raw);
  if (!values) return { ok: false, fieldErrors };

  const current = await getJobsSettingsState(db);
  const changedFields = JOBS_SETTING_FIELDS.map((field) => field.key).filter(
    (key) => current.values[key] !== values[key],
  );
  const now = new Date();

  await storeSetting(db, actor, JOBS_OPERATIONAL_SETTINGS_ID, values, now);
  const event = await recordSettingChange(
    db,
    actor,
    "jobs",
    changedFields,
    current.values,
    values,
    now,
  );

  return { ok: true, values, changedFields, event };
}

export async function listOperationalSettingsEvents(
  db: Db,
  limit = 20,
  setting?: OperationalSettingsSection,
): Promise<OperationalSettingsEvent[]> {
  try {
    const rows = await db
      .collection<OperationalSettingsEvent>(
        OPERATIONAL_SETTINGS_EVENTS_COLLECTION,
      )
      .find(setting ? { setting } : {})
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
