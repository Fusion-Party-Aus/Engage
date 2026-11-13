#!/usr/bin/env node
/**
 * Idempotent, restartable migration for encrypting legacy plaintext votes in `proposal_votes`.
 *
 * Defaults to DRY-RUN mode. Pass `--apply` to execute writes, and `--rotate` to
 * re-encrypt existing envelopes to the active key ID.
 *
 * Never run automatically in production without verified key backup & dry-run reconciliation.
 */
import { MongoClient } from "mongodb";
import { loadBallotCryptoConfig } from "../src/lib/ballot-crypto.ts";
import { migrateEncryptedVotes } from "../src/lib/ballot-encryption-migration.ts";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const rotate = args.has("--rotate");

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME || "engage";
if (!uri) {
  console.error("MONGODB_URI is required.");
  process.exit(1);
}

const cryptoConfig = loadBallotCryptoConfig(process.env);
if (!cryptoConfig) {
  console.error(
    "BALLOT_ENCRYPTION_KEYS and BALLOT_BLIND_INDEX_KEY must be configured.",
  );
  process.exit(1);
}

const client = new MongoClient(uri);
try {
  await client.connect();
  const db = client.db(dbName);
  const result = await migrateEncryptedVotes(db, cryptoConfig, { apply, rotate });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await client.close();
}
