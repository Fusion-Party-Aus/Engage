import { ObjectId, type Db } from "mongodb";
import { runInTransaction } from "./db.ts";
import { hasPermission } from "./rbac.ts";
import { resolveMemberEffectivePermissions } from "./roles-store.ts";
import type { SessionUser } from "./types.ts";

/**
 * Operational ownership for the collaboration pilot (#143).
 *
 * Who monitors the correction inbox, who backs them up, who runs the monthly
 * retention sweep, and how disputes escalate. This is an administrator-owned
 * record: changing personnel needs no deployment and every change is audited.
 */

const SETTINGS = "collaboration_operations";
const EVENTS = "collaboration_operation_events";

export class OperationSettingsError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "OperationSettingsError";
    this.status = status;
  }
}

export interface OwnerSummary {
  id: string;
  name: string;
  status: string;
  /** Active, verified and holding the permission needed to act on contributions. */
  ready: boolean;
  reasons: string[];
}

export interface OwnersEvent {
  at: string;
  actorId: string;
  changedFields: string[];
}

export interface CollaborationOwnersView {
  /** Everyone has been chosen. This does not mean they can do the work. */
  assigned: boolean;
  /** Every chosen owner is active, verified and authorised. */
  ready: boolean;
  primary: OwnerSummary | null;
  backup: OwnerSummary | null;
  retention: OwnerSummary | null;
  correctionEmail: string;
  escalationDetails: string;
  updatedAt: string | null;
  updatedBy: string | null;
  version: number;
  events: OwnersEvent[];
}

interface OwnersRecord {
  configId: "global";
  primaryOwnerId: string | null;
  backupOwnerId: string | null;
  retentionOwnerId: string | null;
  correctionEmail: string;
  escalationDetails: string;
  version: number;
  updatedAt?: Date;
  updatedBy?: string;
}

function emptyRecord(): OwnersRecord {
  return {
    configId: "global",
    primaryOwnerId: null,
    backupOwnerId: null,
    retentionOwnerId: null,
    correctionEmail: "",
    escalationDetails: "",
    version: 0,
  };
}

function normalise(row: Record<string, any> | null): OwnersRecord {
  const base = emptyRecord();
  if (!row) return base;
  return {
    configId: "global",
    primaryOwnerId: row.primaryOwnerId ? String(row.primaryOwnerId) : null,
    backupOwnerId: row.backupOwnerId ? String(row.backupOwnerId) : null,
    retentionOwnerId: row.retentionOwnerId ? String(row.retentionOwnerId) : null,
    correctionEmail: String(row.correctionEmail ?? ""),
    escalationDetails: String(row.escalationDetails ?? ""),
    version: Number(row.version ?? 0),
    ...(row.updatedAt ? { updatedAt: new Date(row.updatedAt) } : {}),
    ...(row.updatedBy ? { updatedBy: String(row.updatedBy) } : {}),
  };
}

function accountFilter(memberId: string): Record<string, unknown> {
  return /^[0-9a-fA-F]{24}$/.test(memberId)
    ? { _id: new ObjectId(memberId) }
    : { _id: memberId };
}

async function resolveOwner(db: Db, memberId: string | null): Promise<OwnerSummary | null> {
  if (!memberId) return null;
  const account = await db.collection("user").findOne(accountFilter(memberId));
  if (!account) return null;
  const membership = await db.collection("memberships").findOne({ memberId });
  const status = String(membership?.status ?? "unverified");
  const permissions = await resolveMemberEffectivePermissions(db, memberId);
  const reasons: string[] = [];
  if (account.disabled === true) reasons.push("the account is disabled");
  if (status !== "verified") reasons.push("the membership is not verified");
  if (!permissions.national.includes("collaboration.review")) {
    reasons.push("they lack the collaboration.review permission");
  }
  return {
    id: memberId,
    name: String(account.name ?? "Member"),
    status,
    ready: reasons.length === 0,
    reasons,
  };
}

async function assertMember(db: Db, memberId: unknown, label: string): Promise<string> {
  const value = typeof memberId === "string" ? memberId.trim() : "";
  if (!value) throw new OperationSettingsError(`Choose ${label}.`);
  const account = await db.collection("user").findOne(accountFilter(value));
  if (!account) throw new OperationSettingsError(`${label} is not a recognised member.`);
  if (account.disabled === true) throw new OperationSettingsError(`${label} is a disabled account.`);
  return value;
}

function clamp(value: unknown, label: string, min: number, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < min) throw new OperationSettingsError(`${label} is required.`);
  if (text.length > max) throw new OperationSettingsError(`${label} must be ${max} characters or fewer.`);
  return text;
}

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * One address model: the invitation may override the operations default. An
 * empty override inherits. There is no third, invitation-local fallback.
 */
export function resolveCorrectionEmail(
  override: string | null | undefined,
  fallback: string | null | undefined,
): string {
  return String(override ?? "").trim() || String(fallback ?? "").trim();
}

export async function readCollaborationOwners(db: Db): Promise<CollaborationOwnersView> {
  const row = await db.collection(SETTINGS).findOne({ configId: "global" });
  const record = normalise(row);
  const [primary, backup, retention, events] = await Promise.all([
    resolveOwner(db, record.primaryOwnerId),
    resolveOwner(db, record.backupOwnerId),
    resolveOwner(db, record.retentionOwnerId),
    db.collection(EVENTS).find({}).sort({ at: -1, _id: -1 }).limit(5).toArray(),
  ]);
  const chosen = Boolean(primary && backup && retention && record.correctionEmail);
  return {
    assigned: chosen,
    ready: chosen && Boolean(primary?.ready && backup?.ready && retention?.ready),
    primary,
    backup,
    retention,
    correctionEmail: record.correctionEmail,
    escalationDetails: record.escalationDetails,
    updatedAt: record.updatedAt ? record.updatedAt.toISOString() : null,
    updatedBy: record.updatedBy ?? null,
    version: record.version,
    events: events.map((event) => ({
      at: new Date(event.at).toISOString(),
      actorId: String(event.actorId),
      changedFields: Array.isArray(event.changedFields) ? event.changedFields.map(String) : [],
    })),
  };
}

export interface OwnersInput {
  version: unknown;
  primaryOwnerId: unknown;
  backupOwnerId: unknown;
  retentionOwnerId: unknown;
  correctionEmail: unknown;
  escalationDetails: unknown;
}

export async function saveCollaborationOwners(
  db: Db,
  user: SessionUser | null | undefined,
  input: OwnersInput,
): Promise<CollaborationOwnersView> {
  if (!user) throw new OperationSettingsError("Sign in required.", 401);
  if (!hasPermission(user, "collaboration.manage")) {
    throw new OperationSettingsError("You do not have permission to change operational owners.", 403);
  }
  const primaryOwnerId = await assertMember(db, input.primaryOwnerId, "the primary owner");
  const backupOwnerId = await assertMember(db, input.backupOwnerId, "the backup owner");
  const retentionOwnerId = await assertMember(db, input.retentionOwnerId, "the retention sweep owner");
  if (primaryOwnerId === backupOwnerId) {
    throw new OperationSettingsError("The backup must be a different person from the primary owner.");
  }
  const correctionEmail = clamp(input.correctionEmail, "Correction email", 5, 254);
  if (!validEmail(correctionEmail)) {
    throw new OperationSettingsError("Enter a valid correction email address.");
  }
  const escalationDetails = clamp(input.escalationDetails, "Escalation details", 2, 500);
  const expectedVersion = input.version;
  if (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 0) {
    throw new OperationSettingsError("Reload the page and try again.");
  }

  const before = normalise(await db.collection(SETTINGS).findOne({ configId: "global" }));
  if (before.version !== Number(expectedVersion)) {
    throw new OperationSettingsError(
      "These owners changed while you were editing. Reload and try again.",
      409,
    );
  }
  const after = {
    configId: "global" as const,
    primaryOwnerId,
    backupOwnerId,
    retentionOwnerId,
    correctionEmail,
    escalationDetails,
  };
  const changedFields = (Object.keys(after) as Array<keyof typeof after>).filter(
    (key) => key !== "configId" && before[key] !== after[key],
  );
  const now = new Date();
  try {
    await runInTransaction(db, async (session) => {
    const written = await db.collection(SETTINGS).updateOne(
      { configId: "global", version: Number(expectedVersion) },
      {
        $set: {
          ...after,
          version: Number(expectedVersion) + 1,
          updatedAt: now,
          updatedBy: user.memberId,
        },
      },
      // The first save creates version 0; a duplicate unique key from a racing
      // create is treated as a conflict below.
      { upsert: Number(expectedVersion) === 0, session },
    );
    if (!written.matchedCount && !written.upsertedId) {
      throw new OperationSettingsError(
        "These owners changed while you were editing. Reload and try again.",
        409,
      );
    }
    await db.collection(EVENTS).insertOne(
      {
        eventId: new ObjectId().toHexString(),
        actorId: user.memberId,
        changedFields,
        before: {
          primaryOwnerId: before.primaryOwnerId,
          backupOwnerId: before.backupOwnerId,
          retentionOwnerId: before.retentionOwnerId,
          correctionEmail: before.correctionEmail,
          escalationDetails: before.escalationDetails,
        },
        after: {
          primaryOwnerId,
          backupOwnerId,
          retentionOwnerId,
          correctionEmail,
          escalationDetails,
        },
        at: now,
      },
      { session },
    );
  });
  } catch (error) {
    // A racing first save loses the unique-key race. That is a version
    // conflict, not a service failure.
    if ((error as { code?: number }).code === 11000) {
      throw new OperationSettingsError(
        "These owners changed while you were editing. Reload and try again.",
        409,
      );
    }
    throw error;
  }
  return readCollaborationOwners(db);
}
