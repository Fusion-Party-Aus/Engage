import { MongoClient } from "mongodb";
import { migrateProposalVotes } from "../src/lib/vote-storage.ts";

const args = process.argv.slice(2);
if (
  args.some(
    (a) => !["--dry-run", "--apply", "--writers-stopped"].includes(a),
  ) ||
  (args.includes("--dry-run") && args.includes("--apply"))
)
  throw new Error("Invalid arguments.");
const apply = args.includes("--apply");
if (apply && !args.includes("--writers-stopped"))
  throw new Error(
    "Stop all writers and pass --writers-stopped before applying.",
  );
if (!process.env.MONGODB_URI || !process.env.MONGODB_DB_NAME)
  throw new Error("Set MONGODB_URI and MONGODB_DB_NAME explicitly.");
const client = new MongoClient(process.env.MONGODB_URI, {
  serverSelectionTimeoutMS: 5000,
});
try {
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME);
  const indexes = {};
  for (const name of ["votes", "proposal_votes"]) {
    indexes[name] = await db
      .collection(name)
      .listIndexes()
      .toArray()
      .catch((e) => {
        if (e.code === 26) return [];
        throw e;
      });
  }
  const { copies, ...report } = await migrateProposalVotes(db, apply);
  // No member identities, choices, reasons or credentials in operational output.
  console.log(
    JSON.stringify(
      { mode: apply ? "apply" : "dry-run", indexes, ...report },
      null,
      2,
    ),
  );
} catch (error) {
  // Avoid leaking driver errors containing vote keys or connection strings.
  console.error(
    "Vote migration did not complete. Review data shape/index conflicts privately; do not delete or deduplicate records.",
  );
  process.exitCode = 1;
} finally {
  await client.close();
}
