/**
 * Repair and verify the display-only `ballot_tallies` projection (I12/S4, #52).
 *
 * Usage:
 *   npm run ballots:tally-projection -- --database engage_scratch
 *   npm run ballots:tally-projection -- --database engage_scratch --apply
 *   npm run ballots:tally-projection -- --database engage_scratch --verify
 *
 * Reads `proposal_votes` and rebuilds one aggregate row per
 * `(ballotId, revisionId)`. It never deletes, edits or rewrites a vote, and it
 * never certifies a result: `ballot_results` stays authoritative.
 *
 * Dry run is the default. An explicit --database is required. Production writes
 * additionally require --allow-production and --confirm-production engage_production.
 * Encrypted votes need the ballot decryption keys in the environment; the tool
 * refuses to write a partial tally when it cannot read them.
 */
import { MongoClient } from "mongodb";
import { writeFile } from "node:fs/promises";
import {
  ensureBallotTallyIndexes,
  inspectBallotTallyProjection,
  repairBallotTallyProjection,
} from "../src/lib/ballot-tallies.ts";
import { loadBallotCryptoConfig } from "../src/lib/ballot-crypto.ts";

const args = process.argv.slice(2);
const has = (name: string) => args.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

if (has("help")) {
  console.log(
    "Usage: npm run ballots:tally-projection -- --database <name> [--apply | --verify] [--uri <mongodb-uri>] [--allow-production --confirm-production engage_production] [--out-json <file>]",
  );
  process.exit(0);
}

const BOOLEAN_FLAGS = new Set([
  "apply",
  "verify",
  "allow-production",
  "help",
]);
const VALUE_FLAGS = new Set([
  "uri",
  "database",
  "confirm-production",
  "out-json",
]);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]!;
  if (!arg.startsWith("--")) {
    throw new Error(`Unexpected positional argument '${arg}'.`);
  }
  const name = arg.slice(2);
  if (BOOLEAN_FLAGS.has(name)) continue;
  if (VALUE_FLAGS.has(name)) {
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`--${name} requires a value.`);
    }
    index += 1;
    continue;
  }
  throw new Error(`Unknown argument '${arg}'.`);
}

if (has("apply") && has("verify")) {
  throw new Error("--apply and --verify are mutually exclusive.");
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
const apply = has("apply");
const verify = has("verify");
if (
  production &&
  apply &&
  (!has("allow-production") ||
    value("confirm-production") !== "engage_production")
) {
  throw new Error(
    "Applying to production requires --allow-production and --confirm-production engage_production.",
  );
}
if (production && !apply) {
  console.log(
    "[ballot-tally-projection] production dry run: no writes will occur without --apply.",
  );
}

let cryptoConfig;
try {
  cryptoConfig = loadBallotCryptoConfig(process.env);
} catch (error) {
  console.error(
    `[ballot-tally-projection] ballot decryption keys are not configured correctly: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exit(2);
}

const client = new MongoClient(uri);
await client.connect();
const db = client.db(database);
const emit = async (payload: unknown) => {
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  const outJson = value("out-json");
  if (outJson) await writeFile(outJson, json);
  console.log(json);
};

try {
  console.log(
    `[ballot-tally-projection] database=${database} mode=${
      apply ? "apply" : verify ? "verify" : "dry-run"
    }`,
  );
  if (apply) {
    await ensureBallotTallyIndexes(db);
    const result = await repairBallotTallyProjection(db, {
      cryptoConfig,
      apply: true,
    });
    await emit(result);
    console.log(
      `[ballot-tally-projection] scannedVotes=${result.report.scannedVotes} groups=${result.report.groups} ` +
        `written=${result.written} zeroed=${result.zeroed} skipped=${result.skipped} ` +
        `unreadableVotes=${result.report.unreadableVotes} orphans=${result.report.orphanRows}`,
    );
    if (result.skipped > 0 || result.report.needsRepair) {
      // needsRepair is computed before the writes, so verify again.
      const after = await inspectBallotTallyProjection(db, { cryptoConfig });
      await emit(after);
      if (after.needsRepair) {
        console.error(
          "[ballot-tally-projection] rows still need repair after apply; review unreadable votes.",
        );
        process.exitCode = 3;
      }
    }
  } else {
    const report = await inspectBallotTallyProjection(db, { cryptoConfig });
    await emit(report);
    console.log(
      `[ballot-tally-projection] scannedVotes=${report.scannedVotes} groups=${report.groups} ` +
        `mismatches=${report.rows.filter((row) => row.status !== "match").length} ` +
        `orphans=${report.orphanRows} unreadableVotes=${report.unreadableVotes} ` +
        `needsRepair=${report.needsRepair}`,
    );
    if (report.needsRepair) {
      if (verify) {
        console.error(
          "[ballot-tally-projection] verification failed: the projection does not match the votes.",
        );
        process.exitCode = 3;
      } else {
        console.log(
          "[ballot-tally-projection] dry run only. Re-run with --apply to rebuild these rows.",
        );
        process.exitCode = 2;
      }
    }
  }
} finally {
  await client.close();
}
