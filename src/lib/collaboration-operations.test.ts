import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryDb } from "./db.ts";
import {
  OperationSettingsError,
  resolveCorrectionEmail,
  readCollaborationOwners,
  saveCollaborationOwners,
} from "./collaboration-operations.ts";
import type { SessionUser } from "./types.ts";

const manager = {
  memberId: "owner-admin",
  permissions: { national: ["collaboration.manage"], branches: {}, grants: [] },
} as unknown as SessionUser;
const outsider = {
  memberId: "outsider",
  permissions: { national: ["proposals.edit"], branches: {}, grants: [] },
} as unknown as SessionUser;

async function setup() {
  const db = createMemoryDb();
  await Promise.all(
    [
      { _id: "owner-admin", name: "Owner Admin", disabled: false },
      { _id: "primary-person", name: "Primary Person", disabled: false },
      { _id: "backup-person", name: "Backup Person", disabled: false },
      { _id: "sweep-person", name: "Sweep Person", disabled: false },
      { _id: "disabled-person", name: "Disabled Person", disabled: true },
    ].map((user) => db.collection("user").insertOne(user as never)),
  );
  await Promise.all(
    ["owner-admin", "primary-person", "backup-person", "sweep-person"].map((memberId) =>
      db.collection("memberships").insertOne({ memberId, status: "verified" }),
    ),
  );
  await Promise.all(
    ["owner-admin", "primary-person", "backup-person", "sweep-person"].map((memberId) =>
      db.collection("application_roles").insertOne({ memberId, role: "administrator" }),
    ),
  );
  return db;
}

const valid = {
  version: 0,
  primaryOwnerId: "primary-person",
  backupOwnerId: "backup-person",
  retentionOwnerId: "sweep-person",
  correctionEmail: "stories@fusionparty.org.au",
  escalationDetails: "Escalate disputed consent to the national secretary.",
};

test("a fresh installation reports ownership as unassigned", async () => {
  const db = await setup();
  const owners = await readCollaborationOwners(db);
  assert.equal(owners.assigned, false);
  assert.equal(owners.primary, null);
  assert.equal(owners.backup, null);
  assert.deepEqual(owners.events, []);
});

test("only a collaboration manager can assign owners", async () => {
  const db = await setup();
  await assert.rejects(saveCollaborationOwners(db, null, valid), OperationSettingsError);
  await assert.rejects(saveCollaborationOwners(db, outsider, valid), /permission/);
});

test("assignments require real, distinct, enabled members and a usable contact", async () => {
  const db = await setup();
  await assert.rejects(
    saveCollaborationOwners(db, manager, { ...valid, primaryOwnerId: "nobody" }),
    /not a recognised member/,
  );
  await assert.rejects(
    saveCollaborationOwners(db, manager, { ...valid, backupOwnerId: "disabled-person" }),
    /disabled account/,
  );
  await assert.rejects(
    saveCollaborationOwners(db, manager, { ...valid, backupOwnerId: "primary-person" }),
    /different person/,
  );
  await assert.rejects(
    saveCollaborationOwners(db, manager, { ...valid, correctionEmail: "not-an-email" }),
    /valid correction email/,
  );
  await assert.rejects(
    saveCollaborationOwners(db, manager, { ...valid, escalationDetails: "" }),
    /required/,
  );
  await assert.rejects(
    saveCollaborationOwners(db, manager, { ...valid, primaryOwnerId: "" }),
    /Choose the primary owner/,
  );
});

test("a save stores the roster, resolves names and records an audit event", async () => {
  const db = await setup();
  const saved = await saveCollaborationOwners(db, manager, valid);
  assert.equal(saved.assigned, true);
  assert.equal(saved.ready, true);
  assert.equal(saved.primary?.name, "Primary Person");
  assert.equal(saved.primary?.ready, true);
  assert.equal(saved.backup?.name, "Backup Person");
  assert.equal(saved.retention?.name, "Sweep Person");
  assert.equal(saved.correctionEmail, "stories@fusionparty.org.au");
  assert.equal(saved.updatedBy, "owner-admin");
  assert.equal(saved.events.length, 1);
  assert.equal(saved.events[0]?.actorId, "owner-admin");
  assert.equal(saved.events[0]?.changedFields.includes("primaryOwnerId"), true);

  const reread = await readCollaborationOwners(db);
  assert.equal(reread.primary?.id, "primary-person");
  assert.equal(reread.escalationDetails, valid.escalationDetails);
});

test("changing personnel updates the roster without touching contributors", async () => {
  const db = await setup();
  await saveCollaborationOwners(db, manager, valid);
  const changed = await saveCollaborationOwners(db, manager, {
    ...valid,
    version: 1,
    backupOwnerId: "sweep-person",
    retentionOwnerId: "backup-person",
  });
  assert.equal(changed.backup?.name, "Sweep Person");
  assert.equal(changed.retention?.name, "Backup Person");
  assert.equal(changed.events.length, 2);
  const latest = changed.events.find(
    (event) => event.changedFields.length === 2,
  );
  assert.deepEqual(
    latest?.changedFields.sort(),
    ["backupOwnerId", "retentionOwnerId"],
  );
});

test("an owner who later loses their account leaves the roster visibly unassigned", async () => {
  const db = await setup();
  await saveCollaborationOwners(db, manager, valid);
  await db.collection("user").deleteOne({ _id: "primary-person" } as never);
  const owners = await readCollaborationOwners(db);
  assert.equal(owners.assigned, false);
  assert.equal(owners.primary, null);
  assert.equal(owners.backup?.name, "Backup Person");
});

test("an assigned roster is not ready until every owner can act on contributions", async () => {
  const db = await setup();
  const saved = await saveCollaborationOwners(db, manager, valid);
  assert.equal(saved.assigned, true);
  assert.equal(saved.ready, true);

  await db.collection("application_roles").deleteOne({ memberId: "primary-person" });
  const withoutPermission = await readCollaborationOwners(db);
  assert.equal(withoutPermission.assigned, true);
  assert.equal(withoutPermission.ready, false);
  assert.match(withoutPermission.primary?.reasons.join(" ") ?? "", /collaboration\.review/);

  await db.collection("memberships").updateOne(
    { memberId: "backup-person" },
    { $set: { status: "pending" } },
  );
  const unverified = await readCollaborationOwners(db);
  assert.match(unverified.backup?.reasons.join(" ") ?? "", /not verified/);

  await db.collection("user").updateOne(
    { _id: "sweep-person" } as never,
    { $set: { disabled: true } },
  );
  const disabled = await readCollaborationOwners(db);
  assert.match(disabled.retention?.reasons.join(" ") ?? "", /disabled/);
  assert.equal(disabled.ready, false);
});

test("a stale settings version is refused, and the settings and audit event commit together", async () => {
  const db = await setup();
  const first = await saveCollaborationOwners(db, manager, valid);
  assert.equal(first.version, 1);
  await assert.rejects(
    saveCollaborationOwners(db, manager, { ...valid, version: 0 }),
    /changed while you were editing/,
  );
  assert.equal(await db.collection("collaboration_operation_events").countDocuments(), 1);
  const settings = await db.collection("collaboration_operations").findOne({ configId: "global" });
  assert.equal(settings?.version, 1);
});

test("an invitation inherits the operations address unless it sets its own", () => {
  assert.equal(resolveCorrectionEmail("", "default@fusionparty.org.au"), "default@fusionparty.org.au");
  assert.equal(resolveCorrectionEmail(null, "default@fusionparty.org.au"), "default@fusionparty.org.au");
  assert.equal(resolveCorrectionEmail("local@branch.org.au", "default@fusionparty.org.au"), "local@branch.org.au");
  assert.equal(resolveCorrectionEmail("", ""), "");
});
