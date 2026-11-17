import { getDatabase, closeDatabase, runtimeEnv } from "../src/lib/db.ts";
import { seedPilotInitiative } from "../src/lib/collaboration.ts";
import { PILOT_SLUG } from "../src/lib/collaboration-options.ts";

/**
 * Create the pilot collaboration invitation if it does not exist.
 *
 * This is a bootstrap, not a deployment step that overwrites editors: wording,
 * questions and the open/paused/closed decision are owned by the admin panel.
 * Safe to rerun.
 */
async function main() {
  const env = runtimeEnv();
  const db = await getDatabase(env);
  const initiative = await seedPilotInitiative(db);
  console.log(
    `Collaboration invitation '${initiative.slug}' is ${initiative.status} with ${initiative.questions.length} questions.`,
  );
  if (initiative.slug !== PILOT_SLUG) {
    console.warn(`Expected pilot slug '${PILOT_SLUG}'.`);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
