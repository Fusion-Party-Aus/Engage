import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDb, getDatabase } from "./db.ts";
import {
  BRANCH_PARTICIPATION_MIGRATION,
  MIGRATIONS_COLLECTION,
  STANDARD_BRANCHES,
  STANDARD_BRANCHES_MIGRATION,
  getMigrationStatus,
  previewStandardBranches,
  runAllMigrations,
  runMigration,
  seedStandardBranches,
} from "./migrations.ts";
import { GET as getMigrationsApi } from "../pages/api/admin/migrations.ts";

describe("durable database migrations", () => {
  it("adds the standard branches once and preserves existing branch records", async () => {
    const db = createMemoryDb();
    await db.collection("branches").insertOne({
      branchId: "branch-vic",
      name: "Victoria — existing local name",
      kind: "state",
      recognised: false,
    });

    const before = await previewStandardBranches(db);
    assert.equal(before.total, STANDARD_BRANCHES.length);
    assert.ok(before.total >= 9);
    assert.equal(before.missing, before.total - 1);
    assert.equal(before.existing, 1);

    const first = await seedStandardBranches(db);
    assert.equal(first.created, before.missing);
    assert.equal(first.existing, 1);

    const national = await db
      .collection("branches")
      .findOne({ branchId: "branch-nat" });
    assert.equal(national?.name, "Fusion National");
    assert.equal(national?.kind, "national");
    const victoria = await db
      .collection("branches")
      .findOne({ branchId: "branch-vic" });
    assert.equal(
      victoria?.name,
      "Victoria — existing local name",
      "an existing branch is never renamed by the seed",
    );
    assert.equal(victoria?.recognised, false);
    const nsw = await db
      .collection("branches")
      .findOne({ branchId: "branch-nsw" });
    assert.equal(nsw?.name, "Fusion New South Wales");
    assert.equal(nsw?.parentBranchId, "branch-nat");

    const second = await seedStandardBranches(db);
    assert.equal(second.created, 0);
    assert.equal(
      await db.collection("branches").countDocuments({}),
      STANDARD_BRANCHES.length,
    );
    const after = await previewStandardBranches(db);
    assert.equal(after.missing, 0);
  });

  it("records migration runs and keeps branch participation blocked until branches exist", async () => {
    const db = createMemoryDb();
    const initial = await getMigrationStatus(db);
    const branchStatus = initial.find(
      (item) => item.id === STANDARD_BRANCHES_MIGRATION,
    );
    const participationStatus = initial.find(
      (item) => item.id === BRANCH_PARTICIPATION_MIGRATION,
    );
    assert.equal(branchStatus?.status, "pending");
    assert.equal(participationStatus?.status, "blocked");

    const seeded = await runMigration(
      db,
      STANDARD_BRANCHES_MIGRATION,
      "admin-1",
    );
    assert.equal(seeded.status, "completed");
    assert.ok(Number(seeded.result.created) > 0);

    const record = await db
      .collection(MIGRATIONS_COLLECTION)
      .findOne({ migrationId: STANDARD_BRANCHES_MIGRATION });
    assert.equal(record?.status, "completed");
    assert.equal(record?.lastActorId, "admin-1");
    assert.ok(record?.lastCompletedAt instanceof Date);
    assert.equal(record?.runCount, 1);

    const afterSeed = await getMigrationStatus(db);
    assert.equal(
      afterSeed.find((item) => item.id === STANDARD_BRANCHES_MIGRATION)?.status,
      "completed",
    );

    await db.collection("branch_memberships").insertOne({
      branchId: "branch-vic",
      memberId: "legacy-member",
      status: "active",
      branchRole: "member",
    });
    await db.collection("proposals").insertOne({
      proposalId: "open-proposal",
      slug: "open-proposal",
      title: "Open proposal",
      stage: "deliberate",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const participation = await runMigration(
      db,
      BRANCH_PARTICIPATION_MIGRATION,
      "admin-1",
    );
    assert.equal(participation.status, "completed");
    assert.equal(participation.result.annotatedMemberships, 1);
    assert.equal(participation.result.createdSubscriptions, 1);
    assert.equal(participation.result.assignedProposals, 1);

    const final = await getMigrationStatus(db);
    assert.equal(
      final.find((item) => item.id === BRANCH_PARTICIPATION_MIGRATION)?.status,
      "completed",
    );
    const membership = await db
      .collection("branch_memberships")
      .findOne({ branchId: "branch-vic", memberId: "legacy-member" });
    assert.equal(membership?.status, "active");
    assert.equal(membership?.source, "engage-legacy");
  });

  it("runs migrations in order and is safe to repeat", async () => {
    const db = createMemoryDb();
    const first = await runAllMigrations(db, "admin-2");
    assert.deepEqual(
      first.map((item) => item.migrationId),
      [
        STANDARD_BRANCHES_MIGRATION,
        BRANCH_PARTICIPATION_MIGRATION,
        "open-ballot-expiry-2027-01-14",
      ],
    );
    const second = await runAllMigrations(db, "admin-2");
    assert.equal(second[0]?.result.created, 0);
    assert.equal(
      second[1]?.result.createdSubscriptions,
      0,
      "a repeated participation migration does not duplicate subscriptions",
    );
    assert.equal(
      await db
        .collection(MIGRATIONS_COLLECTION)
        .countDocuments({ migrationId: BRANCH_PARTICIPATION_MIGRATION }),
      1,
    );
  });

  it("rejects an unknown migration and requires national administrator access", async () => {
    const db = createMemoryDb();
    await assert.rejects(
      runMigration(db, "not-a-migration", "admin-1"),
      /Choose a database migration/,
    );

    const env = { APP_MODE: "development" };
    await getDatabase(env);
    const request = (cookie?: string) =>
      new Request("http://localhost/api/admin/migrations", {
        headers: cookie ? { Cookie: cookie } : {},
      });
    const anonymous = await getMigrationsApi({
      request: request(),
      locals: { runtime: { env } },
    } as never);
    assert.equal(anonymous.status, 401);
    const member = await getMigrationsApi({
      request: request("engage_dev_user=member"),
      locals: { runtime: { env } },
    } as never);
    assert.equal(member.status, 403);
    const admin = await getMigrationsApi({
      request: request("engage_dev_user=administrator"),
      locals: { runtime: { env } },
    } as never);
    assert.equal(admin.status, 200);
    const payload = (await admin.json()) as { migrations: unknown[] };
    assert.equal(payload.migrations.length, 3);
  });
});

it('reuses existing National and Victoria identities when seeding standard branches',async()=>{
 const db=createMemoryDb();
 await db.collection('branches').insertOne({branchId:'existing-national',name:'Fusion National',kind:'national',recognised:true});
 await db.collection('branches').insertOne({branchId:'existing-victoria',name:'Fusion Victoria',kind:'state',recognised:true,parentBranchId:'existing-national'});
 assert.equal((await previewStandardBranches(db)).missing,7);
 await seedStandardBranches(db);
 assert.equal(await db.collection('branches').countDocuments(),9);
 assert.equal((await db.collection('branches').findOne({branchId:'branch-nsw'}))?.parentBranchId,'existing-national');
});
