import { MongoClient } from "mongodb";
import {
  evaluateOperationalHealth,
  operationalHealthExitCode,
  renderOperationalHealth,
} from "../src/lib/operational-health.ts";
import type { PlatformEnv } from "../src/lib/types.ts";

// Operational health for scheduled work (#39).
//
// Prints the report as JSON by default. `--human` prints a short readable
// summary instead. Both forms contain no secrets, provider responses, member
// identifiers or ballot choices.
//
// Exit codes: 0 healthy, 2 degraded or unknown, 1 failing or unreachable.
// Direct connection only: never silently read the development fallback database.
const uri = process.env.MONGODB_URI;
if (!uri) {
  throw new Error(
    "MONGODB_URI is required. Operational health never falls back to the in-memory development database.",
  );
}

const human = process.argv.includes("--human") || process.argv.includes("--summary");
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });

try {
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME || "engage");
  const report = await evaluateOperationalHealth({
    db,
    env: process.env as PlatformEnv,
  });
  process.stdout.write(
    human
      ? renderOperationalHealth(report)
      : `${JSON.stringify(report, null, 2)}\n`,
  );
  process.exitCode = operationalHealthExitCode(report);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  // Configuration errors and connection failures are operational failures, not
  // crashes with a stack trace an operator has to decode.
  process.stderr.write(
    `Operational health could not run: ${message.replace(/\s+/g, " ").trim()}\n`,
  );
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
