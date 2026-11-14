/**
 * Explicit migration for the `ballot_results` index shape (#55).
 *
 * Usage:
 *   npm run ballots:results-index -- preflight --database engage_production_clone
 *   npm run ballots:results-index -- apply     --database engage_production_clone --actor member-admin --apply
 *   npm run ballots:results-index -- verify    --database engage_production_clone
 *   npm run ballots:results-index -- recovery  --database engage_production_clone
 *
 * The URI comes from --uri or MONGODB_URI. An explicit --database is required:
 * refuse to infer one. Apply is a dry run unless --apply is present. Production
 * additionally requires --allow-production and
 * --confirm-production engage_production.
 */
import { MongoClient } from "mongodb";
import { writeFile } from "node:fs/promises";
import {
  applyBallotResultsIndexMigration,
  inspectBallotResultsIndexes,
  planBallotResultsIndexRecovery,
} from "../src/lib/ballot-results-index-migration.ts";

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith("--") ? args[0] : "preflight";
const value = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);

if (!["preflight", "apply", "verify", "recovery"].includes(command)) {
  throw new Error(
    `Unknown command '${command}'. Use preflight, apply, verify or recovery.`,
  );
}

const uri = value("uri") ?? process.env.MONGODB_URI;
const database = value("database");
if (!uri) {
  throw new Error(
    "MongoDB URI is required via --uri or MONGODB_URI. Never point this at production by accident.",
  );
}
if (!database) {
  throw new Error(
    "An explicit --database is required. Refusing to infer a database from the URI.",
  );
}

const production = database === "engage_production";
const productionWrite = production && command === "apply" && has("apply");
if (
  productionWrite &&
  (!has("allow-production") ||
    value("confirm-production") !== "engage_production")
) {
  throw new Error(
    "Applying to production requires --allow-production and --confirm-production engage_production.",
  );
}
if (production && command === "apply" && !has("apply")) {
  console.log(
    "[ballot-results-index] production dry run: no writes will occur without --apply.",
  );
}

const actor = value("actor") ?? "system:ballot-results-index-migration";
if (command === "apply" && has("apply") && !value("actor")) {
  throw new Error(
    "Applying requires --actor identifying the authorised operator.",
  );
}

const client = await new MongoClient(uri).connect();
const db = client.db(database);
const outJson = value("out-json");
const emit = async (payload: unknown) => {
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  if (outJson) await writeFile(outJson, json);
  console.log(json);
};

try {
  console.log(
    `[ballot-results-index] command=${command} database=${database} actor=${actor}`,
  );

  if (command === "preflight") {
    const report = await inspectBallotResultsIndexes(db);
    await emit(report);
    console.log(
      `[ballot-results-index] results=${report.documentCount} missingBallotId=${report.missingBallotId} ` +
        `duplicateBallots=${report.duplicateBallotIdCount} duplicateProposals=${report.duplicateProposalIdCount} ` +
        `requiresMigration=${report.requiresMigration} migrated=${report.migrated} blockers=${report.blockers.length}`,
    );
    if (report.blockers.length) process.exitCode = 2;
  } else if (command === "apply") {
    const result = await applyBallotResultsIndexMigration(db, {
      actorId: actor,
      apply: has("apply"),
    });
    await emit(result);
    if (result.refused) {
      console.error("[ballot-results-index] refused: resolve the blockers first.");
      process.exitCode = 2;
    } else if (result.dryRun) {
      console.log(
        "[ballot-results-index] dry run only. Re-run with --apply to commit this plan.",
      );
    } else {
      console.log(
        `[ballot-results-index] applied. backup=${result.backupId} migrated=${result.after.migrated}`,
      );
    }
  } else if (command === "verify") {
    const report = await inspectBallotResultsIndexes(db);
    await emit(report);
    if (!report.migrated || report.blockers.length) {
      console.error(
        "[ballot-results-index] verification failed: the required index state is not installed or blockers remain.",
      );
      process.exitCode = 3;
    }
  } else {
    const plan = await planBallotResultsIndexRecovery(db);
    await emit(plan);
    if (plan.requiresMigration) process.exitCode = 2;
  }
} finally {
  await client.close();
}
