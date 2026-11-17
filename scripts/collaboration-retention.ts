import { getDatabase, closeDatabase, runtimeEnv } from "../src/lib/db.ts";
import { purgeExpiredContent, RETENTION } from "../src/lib/collaboration.ts";

/**
 * Story contribution retention sweep.
 *
 * Dry-run by default. `--apply` clears the words, name, contact address and
 * photographs of declined contributions past the retention window, of
 * withdrawals made before automatic clearing existed, and of approved
 * contributions whose reply address is no longer needed. The review record and
 * its audit events remain.
 */
async function main() {
  const apply = process.argv.includes("--apply");
  const db = await getDatabase(runtimeEnv());
  const result = await purgeExpiredContent(db, { apply });
  console.log(
    `${result.applied ? "Cleared" : "Would clear"}: ` +
      `${result.declined} declined past ${RETENTION.declinedDays} days, ` +
      `${result.withdrawn} legacy withdrawals past ${RETENTION.withdrawnDays} days, ` +
      `${result.contactAddresses} approved contact addresses past ${RETENTION.approvedContactDays} days.`,
  );
  if (!apply) console.log("Dry run. Re-run with --apply to clear.");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
