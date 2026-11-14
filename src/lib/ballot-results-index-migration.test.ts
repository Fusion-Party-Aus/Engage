import assert from "node:assert/strict";
import { test } from "node:test";
import { MongoClient, type Db } from "mongodb";
import { initializeDatabase } from "./db.ts";
import {
  BALLOT_RESULTS_BALLOT_INDEX,
  BALLOT_RESULTS_COLLECTION,
  BALLOT_RESULTS_INDEX_MIGRATION,
  BALLOT_RESULTS_LEGACY_INDEX,
  BALLOT_RESULTS_PROPOSAL_INDEX,
  MIGRATION_BACKUPS_COLLECTION,
  applyBallotResultsIndexMigration,
  ensureBallotResultsIndexes,
  inspectBallotResultsIndexes,
  planBallotResultsIndexRecovery,
} from "./ballot-results-index-migration.ts";

/**
 * Real-MongoDB coverage for the ballot_results index migration (#55). The
 * in-memory database cannot prove index creation, uniqueness, backup or
 * partial-apply behaviour, so these cases run only against a replica set.
 */
const uri = process.env.VOTING_TEST_MONGODB_URI;

async function withDatabase(run: (db: Db) => Promise<void>): Promise<void> {
  const client = await new MongoClient(uri!).connect();
  const db = client.db(
    `engage_ballot_results_index_${crypto.randomUUID().replaceAll("-", "")}`,
  );
  try {
    await run(db);
  } finally {
    await db.dropDatabase();
    await client.close();
  }
}

/** A pre-migration database: unique proposalId index, no ballotId index. */
async function createLegacyCollection(db: Db): Promise<void> {
  await db.collection(BALLOT_RESULTS_COLLECTION).createIndex(
    { proposalId: 1 },
    { unique: true },
  );
}

function indexNames(indexes: Array<{ name?: string }>): string[] {
  return indexes.map((index) => index.name ?? "").sort();
}

test(
  "real MongoDB: a fresh database is migrated at startup and a re-run is read-only",
  { skip: !uri },
  async () => {
    await withDatabase(async (db) => {
      await initializeDatabase(db);

      const report = await inspectBallotResultsIndexes(db);
      assert.equal(report.migrated, true);
      assert.equal(report.requiresMigration, false);
      assert.equal(report.legacyUniqueProposalIndex, false);
      assert.equal(report.ballotUniqueIndex, true);
      assert.equal(report.proposalLookupIndex, true);
      assert.deepEqual(report.blockers, []);

      const before = await db.collection(BALLOT_RESULTS_COLLECTION).indexes();
      await ensureBallotResultsIndexes(db);
      const after = await db.collection(BALLOT_RESULTS_COLLECTION).indexes();
      assert.deepEqual(indexNames(before), indexNames(after));
    });
  },
);

test(
  "real MongoDB: startup reports a legacy database without dropping or creating indexes",
  { skip: !uri },
  async () => {
    await withDatabase(async (db) => {
      await createLegacyCollection(db);
      await db.collection(BALLOT_RESULTS_COLLECTION).insertMany([
        { decisionEventId: "d1", ballotId: "B1", proposalId: "P1" },
        { decisionEventId: "d2", ballotId: "B2", proposalId: "P2" },
      ]);

      const messages: string[] = [];
      const original = console.error;
      console.error = (...parts: unknown[]) => {
        messages.push(parts.map(String).join(" "));
      };
      try {
        await initializeDatabase(db);
      } finally {
        console.error = original;
      }

      assert.ok(
        messages.some((message) =>
          message.includes("requires an explicit migration"),
        ),
        "startup must say the migration is required",
      );

      const names = indexNames(
        await db.collection(BALLOT_RESULTS_COLLECTION).indexes(),
      );
      assert.ok(names.includes(BALLOT_RESULTS_LEGACY_INDEX));
      assert.ok(!names.includes(BALLOT_RESULTS_BALLOT_INDEX));
    });
  },
);

test(
  "real MongoDB: duplicate ballot results block the migration and change nothing",
  { skip: !uri },
  async () => {
    await withDatabase(async (db) => {
      await createLegacyCollection(db);
      await db.collection(BALLOT_RESULTS_COLLECTION).insertMany([
        { decisionEventId: "d1", ballotId: "B1", proposalId: "P1" },
        { decisionEventId: "d2", ballotId: "B1", proposalId: "P2" },
      ]);

      const report = await inspectBallotResultsIndexes(db);
      assert.equal(report.duplicateBallotIdCount, 1);
      assert.equal(report.duplicateBallotIds[0].value, "B1");
      assert.equal(report.blockers.length, 1);

      const result = await applyBallotResultsIndexMigration(db, {
        actorId: "member-admin",
        apply: true,
      });
      assert.equal(result.refused, true);
      assert.equal(result.applied, false);
      assert.equal(result.backupId, null);

      const names = indexNames(
        await db.collection(BALLOT_RESULTS_COLLECTION).indexes(),
      );
      assert.ok(names.includes(BALLOT_RESULTS_LEGACY_INDEX));
      assert.ok(!names.includes(BALLOT_RESULTS_BALLOT_INDEX));
      assert.equal(await db.collection(BALLOT_RESULTS_COLLECTION).countDocuments(), 2);
    });
  },
);

test(
  "real MongoDB: apply backs up, verifies, then drops the legacy index",
  { skip: !uri },
  async () => {
    await withDatabase(async (db) => {
      await createLegacyCollection(db);
      await db.collection(BALLOT_RESULTS_COLLECTION).insertMany([
        { decisionEventId: "d1", ballotId: "B1", proposalId: "P1" },
        { decisionEventId: "d2", ballotId: "B2", proposalId: "P2" },
        { decisionEventId: "d3", proposalId: "P3", result: "unsuccessful" },
      ]);

      // A dry run must not write anything.
      const dryRun = await applyBallotResultsIndexMigration(db, {
        actorId: "member-admin",
      });
      assert.equal(dryRun.dryRun, true);
      assert.equal(dryRun.backupId, null);
      assert.equal(await db.collection(MIGRATION_BACKUPS_COLLECTION).countDocuments(), 0);

      const result = await applyBallotResultsIndexMigration(db, {
        actorId: "member-admin",
        apply: true,
      });
      assert.equal(result.applied, true);
      assert.equal(result.refused, false);
      assert.ok(result.backupId);
      assert.equal(result.after.migrated, true);
      assert.equal(result.after.legacyUniqueProposalIndex, false);
      assert.equal(result.after.missingBallotId, 1);
      assert.equal(result.after.proposalLookupIndex, true);

      const backup = await db
        .collection(MIGRATION_BACKUPS_COLLECTION)
        .findOne({ backupId: result.backupId });
      assert.ok(backup);
      assert.equal(backup.documentCount, 3);
      assert.equal((backup.documents as unknown[]).length, 3);
      assert.equal(backup.actorId, "member-admin");
      assert.ok(
        (backup.indexes as Array<{ name: string }>).some(
          (index) => index.name === BALLOT_RESULTS_LEGACY_INDEX,
        ),
        "the previous index state is part of the backup",
      );

      const indexes = await db.collection(BALLOT_RESULTS_COLLECTION).indexes();
      const names = indexNames(indexes);
      assert.ok(names.includes(BALLOT_RESULTS_BALLOT_INDEX));
      assert.ok(names.includes(BALLOT_RESULTS_PROPOSAL_INDEX));
      assert.ok(!names.includes(BALLOT_RESULTS_LEGACY_INDEX));
      const ballotIndex = indexes.find(
        (index) => index.name === BALLOT_RESULTS_BALLOT_INDEX,
      );
      assert.equal(ballotIndex?.unique, true);
      assert.deepEqual(ballotIndex?.partialFilterExpression, {
        ballotId: { $type: "string" },
      });

      const record = await db
        .collection("data_migrations")
        .findOne({ migrationId: BALLOT_RESULTS_INDEX_MIGRATION });
      assert.equal(record?.status, "completed");
      assert.equal(record?.lastActorId, "member-admin");
      assert.equal(record?.lastBackupId, result.backupId);
    });
  },
);

test(
  "real MongoDB: a partial apply is completed by re-running, and a re-run is a no-op",
  { skip: !uri },
  async () => {
    await withDatabase(async (db) => {
      await createLegacyCollection(db);
      await db.collection(BALLOT_RESULTS_COLLECTION).insertMany([
        { decisionEventId: "d1", ballotId: "B1", proposalId: "P1" },
        { decisionEventId: "d2", ballotId: "B2", proposalId: "P2" },
      ]);
      // Simulate a run interrupted after creating the replacement index.
      await db.collection(BALLOT_RESULTS_COLLECTION).createIndex(
        { ballotId: 1 },
        {
          unique: true,
          name: BALLOT_RESULTS_BALLOT_INDEX,
          partialFilterExpression: { ballotId: { $type: "string" } },
        },
      );

      const partial = await inspectBallotResultsIndexes(db);
      assert.equal(partial.ballotUniqueIndex, true);
      assert.equal(partial.legacyUniqueProposalIndex, true);
      assert.equal(partial.migrated, false);

      const completed = await applyBallotResultsIndexMigration(db, {
        actorId: "member-admin",
        apply: true,
      });
      assert.equal(completed.applied, true);
      assert.equal(completed.after.migrated, true);

      const rerun = await applyBallotResultsIndexMigration(db, {
        actorId: "member-admin",
        apply: true,
      });
      assert.equal(rerun.applied, false);
      assert.equal(rerun.alreadyMigrated, true);
      assert.equal(rerun.backupId, null);
      assert.equal(
        await db.collection(MIGRATION_BACKUPS_COLLECTION).countDocuments(),
        1,
      );
    });
  },
);

test(
  "real MongoDB: an index-creation failure is recorded and raised, not swallowed",
  { skip: !uri },
  async () => {
    await withDatabase(async (db) => {
      await createLegacyCollection(db);
      await db.collection(BALLOT_RESULTS_COLLECTION).insertOne({
        decisionEventId: "d1",
        ballotId: "B1",
        proposalId: "P1",
      });
      // Same name, different keys: the lookup-index step must fail loudly.
      await db
        .collection(BALLOT_RESULTS_COLLECTION)
        .createIndex({ matterId: 1 }, { name: BALLOT_RESULTS_PROPOSAL_INDEX });

      await assert.rejects(
        applyBallotResultsIndexMigration(db, {
          actorId: "member-admin",
          apply: true,
        }),
        /index migration failed after backup/,
      );

      const record = await db
        .collection("data_migrations")
        .findOne({ migrationId: BALLOT_RESULTS_INDEX_MIGRATION });
      assert.equal(record?.status, "failed");
      assert.ok(String(record?.lastError).length > 0);
      assert.equal(
        await db.collection(MIGRATION_BACKUPS_COLLECTION).countDocuments(),
        1,
      );
    });
  },
);

test(
  "real MongoDB: recovery reports rollback limits and never deletes results",
  { skip: !uri },
  async () => {
    await withDatabase(async (db) => {
      await createLegacyCollection(db);
      await db.collection(BALLOT_RESULTS_COLLECTION).insertOne({
        decisionEventId: "d1",
        ballotId: "B1",
        proposalId: "P1",
      });

      await applyBallotResultsIndexMigration(db, {
        actorId: "member-admin",
        apply: true,
      });
      // After migration a matter may legitimately have more than one ballot.
      await db.collection(BALLOT_RESULTS_COLLECTION).insertOne({
        decisionEventId: "d2",
        ballotId: "B2",
        proposalId: "P1",
      });

      const after = await planBallotResultsIndexRecovery(db);
      assert.equal(after.requiresMigration, false);
      assert.equal(after.partial, false);
      assert.equal(after.proposalDuplicateCount, 1);
      assert.equal(after.legacyRestorable, false);
      assert.ok(
        after.warnings.some((warning) =>
          warning.includes("deleting later results"),
        ),
      );
      assert.equal(after.backups.length, 1);
      assert.equal(after.backups[0].actorId, "member-admin");
      assert.equal(
        await db.collection(BALLOT_RESULTS_COLLECTION).countDocuments(),
        2,
      );
    });
  },
);

test(
  "real MongoDB: recovery reports that legacy rollback is possible but destructive",
  { skip: !uri },
  async () => {
    await withDatabase(async (db) => {
      await createLegacyCollection(db);
      await db.collection(BALLOT_RESULTS_COLLECTION).insertOne({
        decisionEventId: "d1",
        ballotId: "B1",
        proposalId: "P1",
      });

      await applyBallotResultsIndexMigration(db, {
        actorId: "member-admin",
        apply: true,
      });
      const plan = await planBallotResultsIndexRecovery(db);
      assert.equal(plan.legacyRestorable, true);
      assert.ok(
        plan.warnings.some((warning) =>
          warning.includes("more than one ballot"),
        ),
      );
    });
  },
);
