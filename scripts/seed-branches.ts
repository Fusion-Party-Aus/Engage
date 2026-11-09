import { MongoClient } from "mongodb";
import { ensureNationalBranchAssignment } from "../src/lib/branch-participation.ts";
import { seedStandardBranches } from "../src/lib/migrations.ts";

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME;
if (!uri || !dbName) throw new Error("MONGODB_URI and MONGODB_DB_NAME are required.");

const client = new MongoClient(uri);
await client.connect();
try {
  const db = client.db(dbName);
  const result = await seedStandardBranches(db);
  const members = await db
    .collection("memberships")
    .find({ status: "verified" }, { projection: { memberId: 1 } })
    .toArray();
  let nationalScopes = 0;
  for (const member of members) {
    if (await ensureNationalBranchAssignment(db, member.memberId)) {
      nationalScopes += 1;
    }
  }
  console.log(
    `Standard branches: ${result.created} added, ${result.existing} already present. National scope recorded for ${nationalScopes} verified member(s).`,
  );
} finally {
  await client.close();
}
