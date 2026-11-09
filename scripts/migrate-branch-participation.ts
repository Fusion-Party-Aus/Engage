import { MongoClient } from "mongodb";
import { migrateBranchParticipation } from "../src/lib/branch-participation.ts";

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME;
if (!uri || !dbName) {
  throw new Error("MONGODB_URI and MONGODB_DB_NAME are required.");
}

const apply = !process.argv.includes("--dry-run");
const client = new MongoClient(uri);
await client.connect();
try {
  const db = client.db(dbName);
  const result = await migrateBranchParticipation(db, { apply });
  console.log(
    JSON.stringify(
      {
        mode: apply ? "applied" : "dry-run",
        ...result,
      },
      null,
      2,
    ),
  );
  if (!apply) console.log("Dry run only. Re-run without --dry-run to apply.");
} finally {
  await client.close();
}
