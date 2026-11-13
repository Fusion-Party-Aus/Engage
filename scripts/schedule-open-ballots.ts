import { MongoClient } from "mongodb";
import { applyOpenBallotExpiryMigration } from "../src/lib/ballot-expiry-migration.ts";

// Direct connection only: never silently modify the development fallback database.
if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");

const apply = process.argv.includes("--apply");
const client = await new MongoClient(process.env.MONGODB_URI).connect();

try {
  const db = client.db(process.env.MONGODB_DB_NAME || "engage");
  const report = await applyOpenBallotExpiryMigration(db, {
    actorId: process.env.ENGAGE_MIGRATION_ACTOR || "cli:schedule-open-ballots",
    dryRun: !apply,
    client,
  });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await client.close();
}
