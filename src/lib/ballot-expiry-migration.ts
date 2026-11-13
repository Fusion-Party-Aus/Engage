import type { ClientSession, Db, MongoClient } from "mongodb";
import {
  OPEN_BALLOT_EXPIRY_DEADLINE,
  ballotDeadlineLabel,
} from "./ballot-deadline.ts";

export const OPEN_BALLOT_EXPIRY_MIGRATION = "open-ballot-expiry-2027-01-14";
export const OPEN_BALLOT_EXPIRY_EVENT = "schedule-open-ballots-2027-01-14";

export interface BallotExpiryCandidate {
  collection: "proposals" | "amendments";
  id: string;
  title: string;
  kind: string;
  status: "eligible" | "skipped_existing" | "conflicting";
  reason?: string;
  existingClosesAt?: string | null;
}

export interface BallotExpiryMigrationReport {
  migrationId: string;
  mode: "dry-run" | "apply";
  targetDeadline: string;
  targetDeadlineLabel: string;
  counts: {
    eligible: number;
    updated: number;
    skipped: number;
    conflicting: number;
    inactiveExcluded: number;
  };
  eligibleProposals: BallotExpiryCandidate[];
  eligibleAmendments: BallotExpiryCandidate[];
  skippedExisting: BallotExpiryCandidate[];
  conflicts: BallotExpiryCandidate[];
}

function parseExistingDeadline(value: unknown): {
  kind: "missing" | "valid" | "invalid";
  iso?: string;
} {
  if (value === undefined || value === null || value === "") {
    return { kind: "missing" };
  }
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) {
    return { kind: "invalid" };
  }
  return { kind: "valid", iso: parsed.toISOString() };
}

/**
 * Inspect all open formal ballots (`proposals` in `decide` and `amendments`
 * in `voting`) without mutating any records.
 */
export async function previewOpenBallotExpiryMigration(
  db: Db,
): Promise<BallotExpiryMigrationReport> {
  const targetDate = new Date(OPEN_BALLOT_EXPIRY_DEADLINE);
  const [openProposals, openAmendments, inactiveProposalsCount, inactiveAmendmentsCount] =
    await Promise.all([
      db.collection("proposals").find({ stage: "decide" }).toArray(),
      db.collection("amendments").find({ status: "voting" }).toArray(),
      db.collection("proposals").countDocuments({ stage: { $ne: "decide" } }),
      db.collection("amendments").countDocuments({ status: { $ne: "voting" } }),
    ]);

  const eligibleProposals: BallotExpiryCandidate[] = [];
  const eligibleAmendments: BallotExpiryCandidate[] = [];
  const skippedExisting: BallotExpiryCandidate[] = [];
  const conflicts: BallotExpiryCandidate[] = [];

  for (const row of openProposals) {
    const id = typeof row.proposalId === "string" ? row.proposalId.trim() : "";
    const title = typeof row.title === "string" ? row.title : id || "Untitled";
    const kind = typeof row.kind === "string" ? row.kind : "policy";
    if (!id) {
      conflicts.push({
        collection: "proposals",
        id: String(row._id ?? "unknown"),
        title,
        kind,
        status: "conflicting",
        reason: "Open proposal ballot is missing proposalId.",
      });
      continue;
    }
    const deadlineState = parseExistingDeadline(row.ballotClosesAt);
    if (deadlineState.kind === "invalid") {
      conflicts.push({
        collection: "proposals",
        id,
        title,
        kind,
        status: "conflicting",
        reason: "Existing ballotClosesAt value is malformed and requires manual review.",
        existingClosesAt: String(row.ballotClosesAt),
      });
      continue;
    }
    if (deadlineState.kind === "valid") {
      skippedExisting.push({
        collection: "proposals",
        id,
        title,
        kind,
        status: "skipped_existing",
        reason: "Preserving existing configured deadline.",
        existingClosesAt: deadlineState.iso ?? null,
      });
      continue;
    }
    eligibleProposals.push({
      collection: "proposals",
      id,
      title,
      kind,
      status: "eligible",
      existingClosesAt: null,
    });
  }

  for (const row of openAmendments) {
    const id = typeof row.amendmentId === "string" ? row.amendmentId.trim() : "";
    const title = typeof row.title === "string" ? row.title : id || "Untitled amendment";
    if (!id) {
      conflicts.push({
        collection: "amendments",
        id: String(row._id ?? "unknown"),
        title,
        kind: "amendment",
        status: "conflicting",
        reason: "Open amendment ballot is missing amendmentId.",
      });
      continue;
    }
    const deadlineState = parseExistingDeadline(row.ballotClosesAt);
    if (deadlineState.kind === "invalid") {
      conflicts.push({
        collection: "amendments",
        id,
        title,
        kind: "amendment",
        status: "conflicting",
        reason: "Existing ballotClosesAt value is malformed and requires manual review.",
        existingClosesAt: String(row.ballotClosesAt),
      });
      continue;
    }
    if (deadlineState.kind === "valid") {
      skippedExisting.push({
        collection: "amendments",
        id,
        title,
        kind: "amendment",
        status: "skipped_existing",
        reason: "Preserving existing configured deadline.",
        existingClosesAt: deadlineState.iso ?? null,
      });
      continue;
    }
    eligibleAmendments.push({
      collection: "amendments",
      id,
      title,
      kind: "amendment",
      status: "eligible",
      existingClosesAt: null,
    });
  }

  return {
    migrationId: OPEN_BALLOT_EXPIRY_MIGRATION,
    mode: "dry-run",
    targetDeadline: targetDate.toISOString(),
    targetDeadlineLabel: ballotDeadlineLabel(targetDate),
    counts: {
      eligible: eligibleProposals.length + eligibleAmendments.length,
      updated: 0,
      skipped: skippedExisting.length,
      conflicting: conflicts.length,
      inactiveExcluded: inactiveProposalsCount + inactiveAmendmentsCount,
    },
    eligibleProposals,
    eligibleAmendments,
    skippedExisting,
    conflicts,
  };
}

/**
 * Apply (or dry-run) the one-time open ballot expiry migration.
 *
 * Uses atomic conditional updates so that:
 * - ballots whose deadline was configured concurrently between preview and apply
 *   are never overwritten;
 * - closed, archived, or non-voting records are never touched;
 * - re-running after completion makes zero additional writes.
 */
export async function applyOpenBallotExpiryMigration(
  db: Db,
  options: {
    actorId: string;
    dryRun?: boolean;
    client?: MongoClient;
    now?: Date;
  },
): Promise<BallotExpiryMigrationReport> {
  const dryRun = options.dryRun !== false;
  const now = options.now ?? new Date();
  const targetDate = new Date(OPEN_BALLOT_EXPIRY_DEADLINE);
  if (!Number.isFinite(targetDate.getTime()) || targetDate <= now) {
    throw new Error("Target ballot expiry deadline is invalid or already in the past.");
  }

  const preview = await previewOpenBallotExpiryMigration(db);
  if (dryRun) {
    return preview;
  }

  let updated = 0;
  let concurrentConflicts = 0;
  const conflicts = [...preview.conflicts];

  const executeUpdates = async (session?: ClientSession) => {
    const sessionOpts = session ? { session } : undefined;
    const missingDeadlineFilter = {
      $or: [{ ballotClosesAt: { $exists: false } }, { ballotClosesAt: null }],
    };

    for (const item of preview.eligibleProposals) {
      const result = await db.collection("proposals").updateOne(
        {
          proposalId: item.id,
          stage: "decide",
          ...missingDeadlineFilter,
        },
        {
          $set: {
            ballotClosesAt: targetDate,
          },
        },
        sessionOpts,
      );
      if (result.modifiedCount === 1) {
        updated++;
      } else {
        concurrentConflicts++;
        conflicts.push({
          ...item,
          status: "conflicting",
          reason:
            "Ballot state or closing deadline changed concurrently before update; skipped without overwriting.",
        });
      }
    }

    for (const item of preview.eligibleAmendments) {
      const result = await db.collection("amendments").updateOne(
        {
          amendmentId: item.id,
          status: "voting",
          ...missingDeadlineFilter,
        },
        {
          $set: {
            ballotClosesAt: targetDate,
          },
        },
        sessionOpts,
      );
      if (result.modifiedCount === 1) {
        updated++;
      } else {
        concurrentConflicts++;
        conflicts.push({
          ...item,
          status: "conflicting",
          reason:
            "Amendment ballot state or closing deadline changed concurrently before update; skipped without overwriting.",
        });
      }
    }

    // Keep distinct ballot records in sync if the `ballots` collection has matching open records.
    const openBallotRecords = await db
      .collection("ballots")
      .find({ status: "open", ...missingDeadlineFilter }, sessionOpts)
      .toArray();
    for (const ballot of openBallotRecords) {
      await db.collection("ballots").updateOne(
        { _id: ballot._id, status: "open", ...missingDeadlineFilter },
        {
          $set: {
            closesAt: targetDate,
            ballotClosesAt: targetDate,
            updatedAt: now,
          },
        },
        sessionOpts,
      );
    }

    if (updated > 0) {
      await db.collection("ballot_schedule_events").insertOne(
        {
          event: OPEN_BALLOT_EXPIRY_EVENT,
          migrationId: OPEN_BALLOT_EXPIRY_MIGRATION,
          actorId: options.actorId,
          at: now,
          closesAt: targetDate,
          updatedCount: updated,
          skippedCount: preview.counts.skipped,
          conflictingCount: preview.counts.conflicting + concurrentConflicts,
          proposals: preview.eligibleProposals.map((p) => ({
            id: p.id,
            previous: null,
          })),
          amendments: preview.eligibleAmendments.map((a) => ({
            id: a.id,
            previous: null,
          })),
        },
        sessionOpts,
      );
    }
  };

  if (options.client) {
    const session = options.client.startSession();
    try {
      await session.withTransaction(async () => {
        await executeUpdates(session);
      });
    } finally {
      await session.endSession();
    }
  } else {
    await executeUpdates();
  }

  return {
    ...preview,
    mode: "apply",
    counts: {
      eligible: preview.counts.eligible,
      updated,
      skipped: preview.counts.skipped,
      conflicting: preview.counts.conflicting + concurrentConflicts,
      inactiveExcluded: preview.counts.inactiveExcluded,
    },
    conflicts,
  };
}
