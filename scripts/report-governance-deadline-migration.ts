import { MongoClient } from "mongodb";
import { buildLifecycleMigrationReport } from "../src/lib/lifecycle-migration-report.ts";

// Read-only report for governance records created before the approved lifecycle
// schedule (D3–D7). It never writes; see `recoveryOptions` in the output.
const uri = process.env.MONGODB_URI;
if (!uri) {
  throw new Error(
    "MONGODB_URI is required. This report never falls back to the in-memory development database.",
  );
}

const client = await new MongoClient(uri).connect();

try {
  const db = client.db(process.env.MONGODB_DB_NAME || "engage");
  const report = await buildLifecycleMigrationReport(db);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await client.close();
}
