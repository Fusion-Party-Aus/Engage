import { MongoClient } from "mongodb";
import { runGovernanceScheduler } from "../src/lib/governance-scheduler.ts";

// Approved proposal lifecycle scheduler (RFC 0001 Phase 1, D4–D7).
//
// Dry-run by default. `--apply` performs the conditional, idempotent writes.
// There is no daemon: run this from an existing scheduler (cron, Coolify job or
// CI) and read the JSON report.
//
// Direct connection only: never silently touch the development fallback database.
const uri = process.env.MONGODB_URI;
if (!uri) {
  throw new Error(
    "MONGODB_URI is required. The governance scheduler never falls back to the in-memory development database.",
  );
}

const apply = process.argv.includes("--apply");
const client = await new MongoClient(uri).connect();

try {
  const db = client.db(process.env.MONGODB_DB_NAME || "engage");
  const report = await runGovernanceScheduler(db, { dryRun: !apply });
  console.log(JSON.stringify(report, null, 2));
  if (report.errors.length > 0) process.exitCode = 1;
} finally {
  await client.close();
}
