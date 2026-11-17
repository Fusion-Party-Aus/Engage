import assert from "node:assert/strict";
import { test } from "node:test";
import { MongoClient, type Db } from "mongodb";
import { ensureDatabaseIndexes } from "./db-indexes.ts";
import {
  OperationSettingsError,
  readCollaborationOwners,
  saveCollaborationOwners,
} from "./collaboration-operations.ts";
import type { SessionUser } from "./types.ts";

/**
 * The in-memory preview has no unique indexes, so it cannot prove that two
 * simultaneous first saves resolve to one record and one version conflict.
 */
const uri = process.env.VOTING_TEST_MONGODB_URI;

const manager = {
  memberId: "owner-a",
  permissions: { national: ["collaboration.manage"], branches: {}, grants: [] },
} as unknown as SessionUser;

const input = {
  version: 0,
  primaryOwnerId: "p1",
  backupOwnerId: "b1",
  retentionOwnerId: "s1",
  correctionEmail: "ops@example.org",
  escalationDetails: "Escalate disputed consent to the secretary.",
};

async function withDatabase(run: (db: Db) => Promise<void>): Promise<void> {
  const client = await new MongoClient(uri!).connect();
  const db = client.db(`engage_ops_test_${crypto.randomUUID().replaceAll("-", "")}`);
  try {
    await ensureDatabaseIndexes(db);
    for (const id of ["owner-a", "p1", "b1", "s1"]) {
      await db.collection("user").insertOne({ _id: id as never, name: id, disabled: false } as never);
      await db.collection("memberships").insertOne({ memberId: id, status: "verified" });
      await db.collection("application_roles").insertOne({ memberId: id, role: "administrator" });
    }
    await run(db);
  } finally {
    await db.dropDatabase();
    await client.close();
  }
}

test("two simultaneous first saves produce one record and one version conflict", { skip: !uri }, async () => {
  await withDatabase(async (db) => {
    const results = await Promise.allSettled([
      saveCollaborationOwners(db, manager, input),
      saveCollaborationOwners(db, manager, input),
    ]);
    const saved = results.filter((entry) => entry.status === "fulfilled");
    const failed = results.filter((entry) => entry.status === "rejected");
    assert.equal(saved.length, 1);
    assert.equal(failed.length, 1);
    const reason = (failed[0] as PromiseRejectedResult).reason;
    assert.ok(reason instanceof OperationSettingsError);
    assert.equal(reason.status, 409);
    assert.match(reason.message, /changed while you were editing/);
    assert.equal(await db.collection("collaboration_operations").countDocuments(), 1);
    assert.equal(await db.collection("collaboration_operation_events").countDocuments(), 1);
    const owners = await readCollaborationOwners(db);
    assert.equal(owners.version, 1);
    assert.equal(owners.ready, true);
  });
});

test("a stale save after a successful one is refused", { skip: !uri }, async () => {
  await withDatabase(async (db) => {
    await saveCollaborationOwners(db, manager, input);
    await assert.rejects(
      saveCollaborationOwners(db, manager, input),
      (error: unknown) =>
        error instanceof OperationSettingsError &&
        error.status === 409 &&
        /changed while you were editing/.test(error.message),
    );
    assert.equal(await db.collection("collaboration_operation_events").countDocuments(), 1);
  });
});
