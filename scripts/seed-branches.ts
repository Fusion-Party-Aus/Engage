import { MongoClient } from "mongodb";
import { DEFAULT_STATE_SITES } from "../src/lib/site-config.ts";

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME;
if (!uri || !dbName) throw new Error("MONGODB_URI and MONGODB_DB_NAME are required.");

const client = new MongoClient(uri);
await client.connect();
try {
  const db = client.db(dbName);
  const branches = DEFAULT_STATE_SITES.map((site) => ({
    branchId: `branch-${site.code.toLowerCase()}`,
    name: site.name,
    kind: site.code === "NAT" ? "national" : site.code === "ACT" || site.code === "NT" ? "territory" : "state",
    recognised: true,
    websiteHref: site.websiteHref,
    updatedAt: new Date(),
  }));
  for (const branch of branches) {
    await db.collection("branches").updateOne(
      { branchId: branch.branchId },
      { $setOnInsert: branch },
      { upsert: true },
    );
  }
  const nationalBranchId = "branch-nat";
  const members = await db.collection("memberships").find({ status: "verified" }, { projection: { memberId: 1 } }).toArray();
  for (const member of members) {
    // National governance scope is a following preference, not a verified
    // organisational membership fact. It must never certify party membership.
    await db.collection("branch_subscriptions").updateOne(
      { memberId: member.memberId, branchId: nationalBranchId },
      {
        $setOnInsert: {
          memberId: member.memberId,
          branchId: nationalBranchId,
          status: "following",
          source: "migration",
          autoAssignedNational: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }
  console.log(`Seeded ${branches.length} branches and ensured National scope for ${members.length} verified members.`);
} finally {
  await client.close();
}
