import { randomUUID } from "node:crypto";
import type { ClientSession, Db } from "mongodb";
import {
  DEFAULT_MATTER_REGISTRY,
  MatterRegistry,
  getMatterDefinition,
  normalizeMatterType,
} from "./matters.ts";

export const GOVERNANCE_EVENTS_COLLECTION = "governance_events";
export const GOVERNANCE_RELATIONSHIPS_COLLECTION = "governance_relationships";

export type GovernanceRelationshipType =
  | "supersedes"
  | "amends"
  | "implements"
  | "derives_from";

export interface GovernanceRelationshipRecord {
  relationshipId: string;
  sourceMatterId: string;
  targetMatterId: string;
  relationshipType: GovernanceRelationshipType;
  note?: string;
  actorId: string;
  createdAt: Date;
}

export interface GovernanceEventRecord {
  eventId: string;
  eventType: string;
  matterId: string;
  ballotId?: string;
  revisionId?: string;
  decisionEventId?: string;
  actorId: string;
  authorityBranchId?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export class GovernanceRelationshipError extends Error {
  status: number;
  code: string;

  constructor(
    message: string,
    status = 409,
    code = "GOVERNANCE_RELATIONSHIP_ERROR",
  ) {
    super(message);
    this.name = "GovernanceRelationshipError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Append-only governance audit event writer.
 */
export async function recordGovernanceEvent(
  db: Db,
  input: Omit<GovernanceEventRecord, "eventId" | "createdAt"> & {
    eventId?: string;
    createdAt?: Date;
  },
  session?: ClientSession,
): Promise<GovernanceEventRecord> {
  const record: GovernanceEventRecord = {
    eventId: input.eventId ?? `gov-evt-${randomUUID()}`,
    eventType: input.eventType,
    matterId: input.matterId,
    ...(input.ballotId ? { ballotId: input.ballotId } : {}),
    ...(input.revisionId ? { revisionId: input.revisionId } : {}),
    ...(input.decisionEventId ? { decisionEventId: input.decisionEventId } : {}),
    actorId: input.actorId,
    ...(input.authorityBranchId
      ? { authorityBranchId: input.authorityBranchId }
      : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    createdAt: input.createdAt ?? new Date(),
  };

  await db
    .collection(GOVERNANCE_EVENTS_COLLECTION)
    .insertOne(record, session ? { session } : undefined);
  return record;
}

/**
 * Record a governance event at most once for a deterministic `eventId`.
 *
 * Scheduled and migration-style writers must be safe to replay: a second run
 * reports the work as already done instead of duplicating audit history. The
 * unique `governance_events.eventId` index is the final authority; the pre-read
 * keeps the in-memory test database (which does not enforce unique indexes)
 * faithful to that behaviour.
 */
export async function recordGovernanceEventOnce(
  db: Db,
  input: Omit<GovernanceEventRecord, "createdAt"> & {
    createdAt?: Date;
  },
  session?: ClientSession,
): Promise<GovernanceEventRecord> {
  const col = db.collection<GovernanceEventRecord>(GOVERNANCE_EVENTS_COLLECTION);
  const sessionOpts = session ? { session } : undefined;
  const existing = await col.findOne({ eventId: input.eventId }, sessionOpts);
  if (existing) return existing;
  try {
    return await recordGovernanceEvent(db, input, session);
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      const recorded = await col.findOne({ eventId: input.eventId }, sessionOpts);
      if (recorded) return recorded;
    }
    throw error;
  }
}

/**
 * Detect whether adding `sourceMatterId -> targetMatterId` as a `supersedes`
 * edge (or `supersededByProposalId`) would introduce a cycle.
 */
export async function detectCircularSupersession(
  db: Db,
  sourceMatterId: string,
  targetMatterId: string,
  maxDepth = 50,
): Promise<boolean> {
  if (sourceMatterId === targetMatterId) return true;

  const visited = new Set<string>([sourceMatterId]);
  const queue: string[] = [targetMatterId];
  let steps = 0;

  while (queue.length > 0 && steps < maxDepth) {
    steps++;
    const current = queue.shift()!;
    if (visited.has(current)) return true;
    visited.add(current);

    const [proposal, rels] = await Promise.all([
      db
        .collection("proposals")
        .findOne(
          { proposalId: current },
          { projection: { supersededByProposalId: 1 } },
        ),
      db
        .collection(GOVERNANCE_RELATIONSHIPS_COLLECTION)
        .find({ sourceMatterId: current, relationshipType: "supersedes" })
        .toArray(),
    ]);

    if (proposal?.supersededByProposalId) {
      const next = String(proposal.supersededByProposalId);
      if (next === sourceMatterId || visited.has(next)) return true;
      queue.push(next);
    }
    for (const rel of rels) {
      const next = String(rel.targetMatterId);
      if (next === sourceMatterId || visited.has(next)) return true;
      queue.push(next);
    }
  }

  return false;
}

/**
 * Validate and record an explicit governance relationship between two matters.
 */
export async function recordGovernanceRelationship(
  db: Db,
  input: {
    sourceMatterId: string;
    targetMatterId: string;
    relationshipType: GovernanceRelationshipType;
    actorId: string;
    note?: string;
    registry?: MatterRegistry;
  },
): Promise<GovernanceRelationshipRecord> {
  const sourceId = input.sourceMatterId.trim();
  const targetId = input.targetMatterId.trim();
  const registry = input.registry ?? DEFAULT_MATTER_REGISTRY;

  if (!sourceId || !targetId) {
    throw new GovernanceRelationshipError(
      "Source and target matter IDs are required.",
      400,
      "MISSING_MATTER_ID",
    );
  }
  if (sourceId === targetId) {
    throw new GovernanceRelationshipError(
      "A matter cannot reference itself in a governance relationship.",
      400,
      "SELF_RELATIONSHIP",
    );
  }

  const [source, target] = await Promise.all([
    db.collection("proposals").findOne({ proposalId: sourceId }),
    db.collection("proposals").findOne({ proposalId: targetId }),
  ]);

  if (!source || !target) {
    throw new GovernanceRelationshipError(
      "Both source and target matters must exist.",
      404,
      "MATTER_NOT_FOUND",
    );
  }

  const sourceType = normalizeMatterType(source.kind, sourceId, registry);
  const targetType = normalizeMatterType(target.kind, targetId, registry);
  const sourceDef = getMatterDefinition(sourceType, registry);

  if (input.relationshipType === "supersedes") {
    if (!sourceDef.capabilities.supportsSupersession) {
      throw new GovernanceRelationshipError(
        `${sourceDef.label} matters do not support supersession.`,
        409,
        "SUPERSESSION_NOT_SUPPORTED",
      );
    }
    if (
      sourceDef.capabilities.compatibleSupersessionTargets.length > 0 &&
      !sourceDef.capabilities.compatibleSupersessionTargets.includes(targetType)
    ) {
      throw new GovernanceRelationshipError(
        `${sourceDef.label} cannot supersede a ${targetType} matter.`,
        409,
        "INCOMPATIBLE_MATTER_TYPES",
      );
    }
    if (await detectCircularSupersession(db, sourceId, targetId)) {
      throw new GovernanceRelationshipError(
        "Circular supersession relationships are not permitted.",
        409,
        "CIRCULAR_SUPERSESSION",
      );
    }
  }

  const now = new Date();
  const record: GovernanceRelationshipRecord = {
    relationshipId: `rel-${randomUUID()}`,
    sourceMatterId: sourceId,
    targetMatterId: targetId,
    relationshipType: input.relationshipType,
    ...(input.note ? { note: input.note.trim() } : {}),
    actorId: input.actorId,
    createdAt: now,
  };

  await db.collection(GOVERNANCE_RELATIONSHIPS_COLLECTION).insertOne(record);
  await recordGovernanceEvent(db, {
    eventType: `relationship.${input.relationshipType}`,
    matterId: sourceId,
    actorId: input.actorId,
    reason: input.note,
    metadata: {
      targetMatterId: targetId,
      relationshipId: record.relationshipId,
    },
  });

  return record;
}
