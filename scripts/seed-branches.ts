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
    await db.collection("branch_memberships").updateOne(
      { memberId: member.memberId, branchId: nationalBranchId },
      { $setOnInsert: { memberId: member.memberId, branchId: nationalBranchId, status: "active", branchRole: "member", assignedAt: new Date(), assignedBy: "migration:seed-branches" } },
      { upsert: true },
    );
  }
  console.log(`Seeded ${branches.length} branches and ensured National membership for ${members.length} verified members.`);
} finally {
  await client.close();
}
