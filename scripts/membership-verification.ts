import { MongoClient } from "mongodb";
import {
  backfillRegistrationAttempts,
  backfillVerificationAttempts,
  reconcileLinkedMembers,
  runVerificationCycle,
  verifyMemberFromCrm,
} from "../src/lib/membership-verification.ts";

// Direct connection only: never silently modify the development fallback database.
if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");

const apply = process.argv.includes("--apply");
const backfill = process.argv.includes("--backfill");
const reconcile = process.argv.includes("--reconcile");
const memberFlag = process.argv.indexOf("--member");
const memberId = memberFlag >= 0 ? process.argv[memberFlag + 1] : undefined;
const env = process.env as Record<string, string | undefined>;
const client = await new MongoClient(process.env.MONGODB_URI).connect();

try {
  const db = client.db(process.env.MONGODB_DB_NAME || "engage");
  if (!apply) {
    const [pending, attempts, links] = await Promise.all([
      db.collection("memberships").countDocuments({ status: "pending" }),
      db.collection("membership_verification_attempts").countDocuments({}),
      db.collection("crm_identity_links").countDocuments({}),
    ]);
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          pendingMemberships: pending,
          queuedAttempts: attempts,
          linkedMembers: links,
          next: "Run with --apply to perform verification. Use --backfill, --reconcile or --member <id> for a focused run.",
        },
        null,
        2,
      ),
    );
  } else if (memberId) {
    console.log(
      JSON.stringify(
        await verifyMemberFromCrm(db, env, memberId),
        null,
        2,
      ),
    );
  } else if (backfill) {
    const [existingPending, registrations] = await Promise.all([
      backfillVerificationAttempts(db),
      backfillRegistrationAttempts(db),
    ]);
    console.log(
      JSON.stringify(
        {
          backfilledPendingMemberships: existingPending,
          backfilledRegistrations: registrations,
        },
        null,
        2,
      ),
    );
  } else if (reconcile) {
    console.log(
      JSON.stringify(await reconcileLinkedMembers(db, env), null, 2),
    );
  } else {
    console.log(JSON.stringify(await runVerificationCycle(db, env), null, 2));
  }
} finally {
  await client.close();
}
