import { ObjectId, type Db } from "mongodb";
import { hasPermission } from "./rbac.ts";
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
}

export interface OwnersEvent {
  at: string;
  actorId: string;
  changedFields: string[];
}

export interface CollaborationOwnersView {
  assigned: boolean;
  primary: OwnerSummary | null;
  backup: OwnerSummary | null;
  retention: OwnerSummary | null;
  correctionEmail: string;
  escalationDetails: string;
  updatedAt: string | null;
  updatedBy: string | null;
  events: OwnersEvent[];
}

interface OwnersRecord {
  configId: "global";
  primaryOwnerId: string | null;
  backupOwnerId: string | null;
  retentionOwnerId: string | null;
  correctionEmail: string;
  escalationDetails: string;
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
  return {
    id: memberId,
    name: String(account.name ?? "Member"),
    status: String(membership?.status ?? "unverified"),
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

export async function readCollaborationOwners(db: Db): Promise<CollaborationOwnersView> {
  const row = await db.collection(SETTINGS).findOne({ configId: "global" });
  const record = normalise(row);
  const [primary, backup, retention, events] = await Promise.all([
    resolveOwner(db, record.primaryOwnerId),
    resolveOwner(db, record.backupOwnerId),
    resolveOwner(db, record.retentionOwnerId),
    db.collection(EVENTS).find({}).sort({ at: -1, _id: -1 }).limit(5).toArray(),
  ]);
  return {
    assigned: Boolean(primary && backup && retention && record.correctionEmail),
    primary,
    backup,
    retention,
    correctionEmail: record.correctionEmail,
    escalationDetails: record.escalationDetails,
    updatedAt: record.updatedAt ? record.updatedAt.toISOString() : null,
    updatedBy: record.updatedBy ?? null,
    events: events.map((event) => ({
      at: new Date(event.at).toISOString(),
      actorId: String(event.actorId),
      changedFields: Array.isArray(event.changedFields) ? event.changedFields.map(String) : [],
    })),
  };
}

export interface OwnersInput {
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

  const before = normalise(await db.collection(SETTINGS).findOne({ configId: "global" }));
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
  await db.collection(SETTINGS).updateOne(
    { configId: "global" },
    { $set: { ...after, updatedAt: now, updatedBy: user.memberId } },
    { upsert: true },
  );
  await db.collection(EVENTS).insertOne({
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
  });
  return readCollaborationOwners(db);
}
