import { MongoClient } from "mongodb";
import { drainNotificationOutbox } from "../src/lib/notification-outbox.ts";
import { withJobRun } from "../src/lib/job-runs.ts";
import type { PlatformEnv } from "../src/lib/types.ts";

// Notification outbox drain (#33).
//
// Dry-run by default: it reports what is due and sends nothing. `--apply` claims
// due rows, dispatches in-app and opted-in Web Push and records sent, suppressed
// or failed with bounded retry. There is no daemon: run this from an existing
// scheduler immediately after `npm run governance:scheduler`.
//
// The JSON summary contains counts only — never a member identifier, push
// payload or ballot choice. Exit code 1 means at least one send failed and needs
// attention; `failed` rows with remaining attempts are retried by a later run.
//
// Direct connection only: never silently touch the development fallback database.
const uri = process.env.MONGODB_URI;
if (!uri) {
  throw new Error(
    "MONGODB_URI is required. The notification outbox drain never falls back to the in-memory development database.",
  );
}

const apply = process.argv.includes("--apply");
const client = await new MongoClient(uri).connect();

try {
  const db = client.db(process.env.MONGODB_DB_NAME || "engage");
  const env = process.env as PlatformEnv;
  const summarise = (report: Awaited<ReturnType<typeof drainNotificationOutbox>>) => ({
    claimed: report.claimed,
    sent: report.sent,
    suppressed: report.suppressed,
    failed: report.failed,
    retried: report.retried,
    exhausted: report.exhausted,
    remaining: report.remaining,
  });
  const report = await withJobRun(
    db,
    "notification-outbox-drain",
    () => drainNotificationOutbox(db, env, { dryRun: !apply }),
    {
      mode: apply ? "apply" : "dry-run",
      summarise,
      // A partial failure is still a failed run for operational health.
      ok: (result) => result.failed === 0,
    },
  );
  console.log(JSON.stringify(report, null, 2));
  if (report.errors.length > 0) process.exitCode = 1;
} finally {
  await client.close();
}
