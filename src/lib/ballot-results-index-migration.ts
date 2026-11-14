import { randomUUID } from "node:crypto";
import type { Collection, Db, Document } from "mongodb";

/**
 * Explicit, reviewable migration for the `ballot_results` index shape.
 *
 * Sprint 1 replaced the unique `proposalId_1` index with a unique partial
 * `ballotId` index at startup. That made the change silent and effectively
 * one-way. This module separates inspection from change:
 *
 *   inspect  — read-only preflight; never writes.
 *   apply    — backup, create the new index, verify it, only then drop the
 *              legacy index. Failures are recorded loudly, not swallowed.
 *   recovery — reports what rollback would require. It never deletes results.
 *
 * Ballot results are never deleted or rewritten to satisfy an index. Duplicates
 * are reported for human reconciliation.
 */

export const BALLOT_RESULTS_COLLECTION = "ballot_results";
export const BALLOT_RESULTS_INDEX_MIGRATION = "ballot-results-ballot-index";
export const BALLOT_RESULTS_BALLOT_INDEX = "ballot_results_ballot_unique";
export const BALLOT_RESULTS_PROPOSAL_INDEX = "ballot_results_proposal";
export const BALLOT_RESULTS_LEGACY_INDEX = "proposalId_1";
export const MIGRATION_BACKUPS_COLLECTION = "migration_backups";
export const DATA_MIGRATIONS_COLLECTION = "data_migrations";

const BALLOT_PARTIAL_FILTER = { ballotId: { $type: "string" } };
const SAMPLE_LIMIT = 100;

export interface BallotResultsIndexDescription {
  name: string;
  key: Record<string, number>;
  unique: boolean;
  partial: boolean;
}

export interface DuplicateGroup {
  value: string;
  count: number;
}

export interface BallotResultsIndexReport {
  version: 1;
  generatedAt: string;
  supported: boolean;
  collection: string;
  documentCount: number;
  missingBallotId: number;
  duplicateBallotIds: DuplicateGroup[];
  duplicateBallotIdCount: number;
  duplicateProposalIds: DuplicateGroup[];
  duplicateProposalIdCount: number;
  indexes: BallotResultsIndexDescription[];
  legacyUniqueProposalIndex: boolean;
  ballotUniqueIndex: boolean;
  proposalLookupIndex: boolean;
  requiresMigration: boolean;
  migrated: boolean;
  blockers: string[];
}

export interface BallotResultsIndexApplyOptions {
  actorId: string;
  now?: Date;
  apply?: boolean;
}

export interface BallotResultsIndexApplyResult {
  applied: boolean;
  refused: boolean;
  alreadyMigrated: boolean;
  dryRun: boolean;
  backupId: string | null;
  steps: string[];
  before: BallotResultsIndexReport;
  after: BallotResultsIndexReport;
}

export interface BallotResultsIndexRecoveryPlan {
  generatedAt: string;
  requiresMigration: boolean;
  partial: boolean;
  proposalDuplicateCount: number;
  legacyRestorable: boolean;
  backups: Array<{
    backupId: string;
    createdAt: string;
    documentCount: number;
    actorId: string | null;
  }>;
  actions: string[];
  warnings: string[];
}

function normalizeKey(key: unknown): Record<string, number> {
  if (!key || typeof key !== "object") return {};
  return key as Record<string, number>;
}

function isProposalOnlyKey(key: Record<string, number>): boolean {
  const entries = Object.entries(key);
  return entries.length === 1 && entries[0][0] === "proposalId" && entries[0][1] === 1;
}

function isBallotOnlyKey(key: Record<string, number>): boolean {
  const entries = Object.entries(key);
  return entries.length === 1 && entries[0][0] === "ballotId" && entries[0][1] === 1;
}

function isProposalLookupKey(key: Record<string, number>): boolean {
  return key.proposalId === 1;
}

function groupDuplicates(
  documents: Array<Record<string, any>>,
  field: string,
): DuplicateGroup[] {
  const counts = new Map<string, number>();
  for (const document of documents) {
    const value = document[field];
    if (typeof value !== "string") continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, SAMPLE_LIMIT)
    .map(([value, count]) => ({ value, count }));
}

async function duplicateGroups(
  collection: Collection<Document>,
  field: "ballotId" | "proposalId",
): Promise<DuplicateGroup[]> {
  const groups = await collection
    .aggregate<{ _id: string; count: number }>([
      { $match: { [field]: { $type: "string" } } },
      { $group: { _id: `$${field}`, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: SAMPLE_LIMIT },
    ])
    .toArray();
  return groups.map((group) => ({
    value: String(group._id),
    count: Number(group.count),
  }));
}

/**
 * Read-only preflight. Never creates, drops or writes anything.
 */
export async function inspectBallotResultsIndexes(
  db: Db,
  options: { now?: Date } = {},
): Promise<BallotResultsIndexReport> {
  const collection = db.collection(BALLOT_RESULTS_COLLECTION);
  const supported = typeof collection.indexes === "function";
  const rawIndexes = supported
    ? await collection.indexes().catch(() => [])
    : [];

  const indexes: BallotResultsIndexDescription[] = rawIndexes.map((index) => ({
    name: String(index.name ?? ""),
    key: normalizeKey(index.key),
    unique: Boolean((index as { unique?: boolean }).unique),
    partial: Boolean(
      (index as { partialFilterExpression?: unknown }).partialFilterExpression,
    ),
  }));

  // The in-memory database used by fast tests has no aggregation pipeline, so
  // the same report is derived in JavaScript when it is unavailable.
  const supportsAggregation = typeof collection.aggregate === "function";
  let documentCount: number;
  let missingBallotId: number;
  let duplicateBallotIds: DuplicateGroup[];
  let duplicateProposalIds: DuplicateGroup[];

  if (supportsAggregation) {
    documentCount = await collection.countDocuments({});
    missingBallotId = await collection.countDocuments({
      $or: [
        { ballotId: { $exists: false } },
        { ballotId: { $not: { $type: "string" } } },
      ],
    });
    duplicateBallotIds = await duplicateGroups(collection, "ballotId");
    duplicateProposalIds = await duplicateGroups(collection, "proposalId");
  } else {
    const documents = await collection.find({}).toArray();
    documentCount = documents.length;
    missingBallotId = documents.filter(
      (document) => typeof document.ballotId !== "string",
    ).length;
    duplicateBallotIds = groupDuplicates(documents, "ballotId");
    duplicateProposalIds = groupDuplicates(documents, "proposalId");
  }

  const legacyIndex = indexes.find(
    (index) => index.unique && isProposalOnlyKey(index.key),
  );
  const ballotIndex = indexes.find(
    (index) => index.unique && isBallotOnlyKey(index.key),
  );
  const proposalLookupIndex = indexes.find(
    (index) => !index.unique && isProposalLookupKey(index.key),
  );

  const blockers: string[] = [];
  if (duplicateBallotIds.length) {
    blockers.push(
      `${duplicateBallotIds.length} ballot(s) have more than one recorded result. ` +
        "The unique ballotId index cannot be created until a human reconciles them. " +
        "Results are never deleted or rewritten by this migration.",
    );
  }
  const namedIndex = indexes.find(
    (index) => index.name === BALLOT_RESULTS_BALLOT_INDEX,
  );
  if (
    namedIndex &&
    (!namedIndex.unique || !isBallotOnlyKey(namedIndex.key) || !namedIndex.partial)
  ) {
    blockers.push(
      `Index '${BALLOT_RESULTS_BALLOT_INDEX}' already exists with an unexpected definition. ` +
        "Inspect it and decide the reconciliation manually; this migration will not replace it.",
    );
  }

  const requiresMigration = Boolean(legacyIndex) || !ballotIndex;

  return {
    version: 1,
    generatedAt: (options.now ?? new Date()).toISOString(),
    supported,
    collection: BALLOT_RESULTS_COLLECTION,
    documentCount,
    missingBallotId,
    duplicateBallotIds,
    duplicateBallotIdCount: duplicateBallotIds.length,
    duplicateProposalIds,
    duplicateProposalIdCount: duplicateProposalIds.length,
    indexes,
    legacyUniqueProposalIndex: Boolean(legacyIndex),
    ballotUniqueIndex: Boolean(ballotIndex),
    proposalLookupIndex: Boolean(proposalLookupIndex),
    requiresMigration,
    migrated: Boolean(ballotIndex) && !legacyIndex,
    blockers,
  };
}

async function recordRun(
  db: Db,
  status: "running" | "completed" | "failed",
  fields: Record<string, unknown>,
): Promise<void> {
  const now = new Date();
  const existing = await db
    .collection(DATA_MIGRATIONS_COLLECTION)
    .findOne({ migrationId: BALLOT_RESULTS_INDEX_MIGRATION });
  const runCount =
    status === "running" ? Number(existing?.runCount ?? 0) + 1 : Number(existing?.runCount ?? 1);

  await db.collection(DATA_MIGRATIONS_COLLECTION).updateOne(
    { migrationId: BALLOT_RESULTS_INDEX_MIGRATION },
    {
      $set: {
        migrationId: BALLOT_RESULTS_INDEX_MIGRATION,
        status,
        runCount,
        updatedAt: now,
        ...(status === "running" ? { lastRunId: randomUUID(), lastStartedAt: now } : {}),
        ...(status === "completed" ? { lastCompletedAt: now } : {}),
        ...fields,
      },
      ...(status === "failed" ? {} : { $unset: { lastError: "" } }),
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
}

/**
 * Apply the migration explicitly. A dry run (the default) performs no writes.
 *
 * Order matters: the replacement index is proven before the legacy unique index
 * is dropped, so an interrupted run leaves both indexes in place and can be
 * completed by re-running.
 */
export async function applyBallotResultsIndexMigration(
  db: Db,
  options: BallotResultsIndexApplyOptions,
): Promise<BallotResultsIndexApplyResult> {
  const now = options.now ?? new Date();
  const collection = db.collection(BALLOT_RESULTS_COLLECTION);
  const before = await inspectBallotResultsIndexes(db, { now });

  if (!before.supported) {
    return {
      applied: false,
      refused: true,
      alreadyMigrated: false,
      dryRun: options.apply !== true,
      backupId: null,
      steps: ["This database driver does not expose index metadata."],
      before,
      after: before,
    };
  }

  if (before.blockers.length) {
    return {
      applied: false,
      refused: true,
      alreadyMigrated: before.migrated,
      dryRun: options.apply !== true,
      backupId: null,
      steps: before.blockers,
      before,
      after: before,
    };
  }

  if (before.migrated && !before.legacyUniqueProposalIndex) {
    return {
      applied: false,
      refused: false,
      alreadyMigrated: true,
      dryRun: options.apply !== true,
      backupId: null,
      steps: ["Already migrated: no change required."],
      before,
      after: before,
    };
  }

  const steps = [
    ...(before.ballotUniqueIndex
      ? []
      : ["Create the unique partial ballotId index."]),
    ...(before.legacyUniqueProposalIndex
      ? ["Verify the new index, then drop the legacy unique proposalId index."]
      : []),
    ...(before.proposalLookupIndex
      ? []
      : ["Create the non-unique proposalId lookup index."]),
    "Verify the final index state and record the run.",
  ];

  if (options.apply !== true) {
    return {
      applied: false,
      refused: false,
      alreadyMigrated: false,
      dryRun: true,
      backupId: null,
      steps,
      before,
      after: before,
    };
  }

  if (!options.actorId || options.actorId.startsWith("system:")) {
    throw new Error(
      "Applying the ballot_results index migration requires an explicit actor identifying the authorised operator.",
    );
  }

  const backupId = `ballot-results-index-${now.toISOString()}-${randomUUID().slice(0, 8)}`;
  await recordRun(db, "running", { lastActorId: options.actorId });

  try {
    const documents = await collection.find({}).toArray();
    await db.collection(MIGRATION_BACKUPS_COLLECTION).insertOne({
      backupId,
      migrationId: BALLOT_RESULTS_INDEX_MIGRATION,
      createdAt: now,
      actorId: options.actorId,
      collection: BALLOT_RESULTS_COLLECTION,
      documentCount: documents.length,
      indexes: before.indexes,
      documents,
    });

    if (!before.ballotUniqueIndex) {
      await collection.createIndex(
        { ballotId: 1 },
        {
          unique: true,
          name: BALLOT_RESULTS_BALLOT_INDEX,
          partialFilterExpression: BALLOT_PARTIAL_FILTER,
        },
      );
      const afterCreate = await inspectBallotResultsIndexes(db, { now });
      if (!afterCreate.ballotUniqueIndex) {
        throw new Error(
          "The unique ballotId index was not present after creation. The legacy index was not dropped.",
        );
      }
    }

    if (before.legacyUniqueProposalIndex) {
      const legacy = before.indexes.find(
        (index) => index.unique && isProposalOnlyKey(index.key),
      );
      if (legacy) await collection.dropIndex(legacy.name);
    }

    if (!before.proposalLookupIndex) {
      await collection.createIndex(
        { proposalId: 1 },
        { name: BALLOT_RESULTS_PROPOSAL_INDEX },
      );
    }

    const after = await inspectBallotResultsIndexes(db, { now });
    if (!after.migrated || after.legacyUniqueProposalIndex) {
      throw new Error(
        `Index verification failed after apply: migrated=${after.migrated}, ` +
          `legacyUniqueProposalIndex=${after.legacyUniqueProposalIndex}. ` +
          `Inspect the collection; the backup '${backupId}' is retained.`,
      );
    }

    await recordRun(db, "completed", {
      lastActorId: options.actorId,
      lastBackupId: backupId,
      lastResult: {
        documentCount: after.documentCount,
        missingBallotId: after.missingBallotId,
        duplicateProposalIds: after.duplicateProposalIdCount,
        legacyDropped: before.legacyUniqueProposalIndex,
      },
    });

    return {
      applied: true,
      refused: false,
      alreadyMigrated: false,
      dryRun: false,
      backupId,
      steps,
      before,
      after,
    };
  } catch (error) {
    await recordRun(db, "failed", {
      lastActorId: options.actorId,
      lastBackupId: backupId,
      lastError: String((error as Error)?.message ?? error).slice(0, 500),
    });
    const message = (error as Error)?.message ?? String(error);
    throw new Error(
      `ballot_results index migration failed after backup '${backupId}'. ` +
        `Any earlier step may be partially applied; re-run to complete it. ${message}`,
    );
  }
}

/**
 * Reports what recovery would require. Never deletes results.
 */
export async function planBallotResultsIndexRecovery(
  db: Db,
  options: { now?: Date } = {},
): Promise<BallotResultsIndexRecoveryPlan> {
  const now = options.now ?? new Date();
  const report = await inspectBallotResultsIndexes(db, { now });
  const backups = await db
    .collection(MIGRATION_BACKUPS_COLLECTION)
    .find({ migrationId: BALLOT_RESULTS_INDEX_MIGRATION })
    .sort({ createdAt: -1 })
    .limit(5)
    .toArray();

  const actions: string[] = [];
  const warnings: string[] = [];

  if (report.blockers.length) {
    actions.push(
      "Reconcile the reported duplicates manually, then re-run the preflight.",
    );
  } else if (report.requiresMigration) {
    actions.push(
      "Run the preflight, then apply the migration with --apply and an explicit --actor.",
    );
  } else {
    actions.push("No migration is required.");
  }

  const partial =
    report.ballotUniqueIndex && report.legacyUniqueProposalIndex;
  if (partial) {
    warnings.push(
      "The new index exists alongside the legacy unique index. Re-running apply completes the migration without data loss.",
    );
  }

  const legacyRestorable = report.duplicateProposalIdCount === 0;
  if (report.duplicateProposalIdCount > 0) {
    warnings.push(
      `${report.duplicateProposalIdCount} proposal(s) now have more than one result. ` +
        "Recreating the legacy unique proposalId index would fail, and deleting later results to make it fit is not permitted.",
    );
  }
  if (!report.legacyUniqueProposalIndex && legacyRestorable) {
    warnings.push(
      "Rollback would recreate the unique proposalId index and break proposals with more than one ballot. Prefer completing the migration.",
    );
  }
  if (backups.length) {
    warnings.push(
      "Backups are evidence, not an automatic restore. Restoring one discards results recorded after it was taken; a human must decide.",
    );
  }

  return {
    generatedAt: now.toISOString(),
    requiresMigration: report.requiresMigration,
    partial,
    proposalDuplicateCount: report.duplicateProposalIdCount,
    legacyRestorable,
    backups: backups.map((backup) => ({
      backupId: String(backup.backupId ?? ""),
      createdAt: new Date(backup.createdAt as Date).toISOString(),
      documentCount: Number(backup.documentCount ?? 0),
      actorId: backup.actorId ? String(backup.actorId) : null,
    })),
    actions,
    warnings,
  };
}

/**
 * Startup behaviour.
 *
 * - Already migrated: read-only no-op.
 * - Fresh database (no legacy unique proposalId index): create the indexes.
 * - Legacy database: never drop anything at startup. Report that the explicit
 *   migration is required, so a duplicate conflict cannot crash or silently
 *   re-shape production indexes.
 */
export async function ensureBallotResultsIndexes(
  db: Db,
): Promise<BallotResultsIndexReport> {
  const report = await inspectBallotResultsIndexes(db);
  if (!report.supported) return report;

  if (report.legacyUniqueProposalIndex) {
    const reason = report.blockers.length
      ? ` ${report.blockers.join(" ")}`
      : "";
    console.error(
      `[db] ballot_results still has the legacy unique proposalId index and requires an explicit migration.${reason} ` +
        "Run `npm run ballots:results-index -- preflight` then apply with --apply and an explicit --actor. No index was changed at startup.",
    );
    return report;
  }

  if (!report.ballotUniqueIndex) {
    if (report.blockers.length) {
      console.error(
        `[db] the unique ballot_results ballotId index could not be created: ${report.blockers.join(" ")}`,
      );
      return report;
    }
    try {
      await db.collection(BALLOT_RESULTS_COLLECTION).createIndex(
        { ballotId: 1 },
        {
          unique: true,
          name: BALLOT_RESULTS_BALLOT_INDEX,
          partialFilterExpression: BALLOT_PARTIAL_FILTER,
        },
      );
    } catch (error) {
      console.error(
        `[db] failed to create the unique ballot_results ballotId index: ${(error as Error)?.message ?? error}. ` +
          "Startup continues; run `npm run ballots:results-index -- verify` to inspect the real state.",
      );
      return report;
    }
  }

  if (!report.proposalLookupIndex) {
    try {
      await db
        .collection(BALLOT_RESULTS_COLLECTION)
        .createIndex(
          { proposalId: 1 },
          { name: BALLOT_RESULTS_PROPOSAL_INDEX },
        );
    } catch (error) {
      console.error(
        `[db] failed to create the ballot_results proposalId lookup index: ${(error as Error)?.message ?? error}. ` +
          "Correctness is unaffected; run `npm run ballots:results-index -- verify` to inspect the real state.",
      );
      return report;
    }
  }

  return inspectBallotResultsIndexes(db);
}
