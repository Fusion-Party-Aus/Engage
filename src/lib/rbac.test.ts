import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { getDatabase, createMemoryDb } from "./db.ts";
import {
  canAdministerBranch,
  canManageBranchBallot,
  canManageBranchProposal,
  canViewIdentifiableBallots,
  createDevSessionCookie,
} from "./auth.ts";
import { hasPermission } from "./rbac.ts";
import {
  assignRoleToMember,
  deleteCustomRole,
  resolveMemberEffectivePermissions,
  revokeRoleAssignment,
  saveRoleDefinition,
} from "./roles-store.ts";
import { castVote, listMembers, saveMember, saveProposal } from "./store.ts";
import { GET as getAmendments } from "../pages/api/amendments.ts";
import { POST as postRoles, DELETE as deleteRoles, GET as getRoles } from "../pages/api/admin/roles/index.ts";
import type { SessionUser } from "./types.ts";

const nationalAdmin: SessionUser = {
  memberId: "rbac-nat-admin",
  name: "National Admin",
  email: "nat-admin@example.org",
  role: "administrator",
  status: "verified",
  canParticipate: true,
  isStaff: true,
  isAdmin: true,
  branchAdminIds: [],
  isBranchAdmin: false,
};

const moderatorUser: SessionUser = {
  memberId: "rbac-mod-1",
  name: "Moderator User",
  email: "mod@example.org",
  role: "moderator",
  status: "verified",
  canParticipate: true,
  isStaff: true,
  isAdmin: false,
  branchAdminIds: [],
  isBranchAdmin: false,
};

const vicBranchAdmin: SessionUser = {
  memberId: "rbac-vic-admin",
  name: "VIC Branch Admin",
  email: "vic-admin@example.org",
  role: "member",
  status: "verified",
  canParticipate: true,
  isStaff: false,
  isAdmin: false,
  branchAdminIds: ["vic"],
  isBranchAdmin: true,
  verifiedBranchIds: ["national", "vic"],
  activeBranchIds: ["national", "vic"],
};

const unverifiedMember: SessionUser = {
  memberId: "rbac-pending-1",
  name: "Pending Member",
  email: "pending@example.org",
  role: "member",
  status: "pending",
  canParticipate: false,
  isStaff: false,
  isAdmin: false,
  branchAdminIds: [],
  isBranchAdmin: false,
};

const verifiedMember: SessionUser = {
  memberId: "rbac-member-1",
  name: "Verified Member",
  email: "member@example.org",
  role: "member",
  status: "verified",
  canParticipate: true,
  isStaff: false,
  isAdmin: false,
  branchAdminIds: [],
  isBranchAdmin: false,
  verifiedBranchIds: ["national"],
  activeBranchIds: ["national"],
};

describe("RBAC audit & configurable roles", () => {
  it("enforces contextual permissions, branch isolation, and ballot secrecy across roles", () => {
    assert.equal(canViewIdentifiableBallots(null), false);
    assert.equal(canViewIdentifiableBallots(unverifiedMember), false);
    assert.equal(canViewIdentifiableBallots(verifiedMember), false);
    assert.equal(canViewIdentifiableBallots(moderatorUser), false);
    assert.equal(canViewIdentifiableBallots(vicBranchAdmin), false);
    assert.equal(canViewIdentifiableBallots(nationalAdmin), true);

    assert.equal(canAdministerBranch(vicBranchAdmin, "vic"), true);
    assert.equal(canAdministerBranch(vicBranchAdmin, "nsw"), false);

    assert.equal(
      canManageBranchProposal(vicBranchAdmin, { originatingBranchId: "vic" }),
      true,
    );
    assert.equal(
      canManageBranchProposal(vicBranchAdmin, { originatingBranchId: "nsw" }),
      false,
    );

    // Branch ballot authority requires matching governanceAuthorityBranchId and jurisdictionBranchId
    assert.equal(
      canManageBranchBallot(vicBranchAdmin, {
        governanceAuthorityBranchId: "vic",
        jurisdictionBranchId: "vic",
      }),
      true,
    );
    assert.equal(
      canManageBranchBallot(vicBranchAdmin, {
        governanceAuthorityBranchId: "vic",
        jurisdictionBranchId: "nsw",
      }),
      false,
    );
  });

  it("blocks unauthorised access to archived proposal amendments via GET /api/amendments", async () => {
    const prevMode = process.env.APP_MODE;
    process.env.APP_MODE = "development";
    try {
      const db = await getDatabase({ APP_MODE: "development" });
      const archived = await saveProposal(db, nationalAdmin, {
        title: "Archived Amendment Access Test",
        space: "Governance",
        summary: "Archived proposal summary.",
        outcomes: ["Outcome"],
        details: "Archived details.",
        stage: "archived",
      });
      await db.collection("amendments").insertOne({
        amendmentId: "am-archived-idor-test",
        proposalId: archived.proposalId,
        title: "Secret archived amendment",
        status: "proposed",
        createdAt: new Date(),
      });

      const memberCookie = createDevSessionCookie("member").split(";")[0]!;
      const adminCookie = createDevSessionCookie("administrator").split(";")[0]!;

      const memberRes = await getAmendments({
        request: new Request(
          `http://localhost/api/amendments?proposalId=${archived.proposalId}`,
          { headers: { cookie: memberCookie } },
        ),
        url: new URL(
          `http://localhost/api/amendments?proposalId=${archived.proposalId}`,
        ),
        locals: { env: { APP_MODE: "development" } },
      } as never);
      assert.equal(memberRes.status, 404);

      const adminRes = await getAmendments({
        request: new Request(
          `http://localhost/api/amendments?proposalId=${archived.proposalId}`,
          { headers: { cookie: adminCookie } },
        ),
        url: new URL(
          `http://localhost/api/amendments?proposalId=${archived.proposalId}`,
        ),
        locals: { env: { APP_MODE: "development" } },
      } as never);
      assert.equal(adminRes.status, 200);
      const payload = await adminRes.json();
      assert.equal(payload.amendments.length, 1);
    } finally {
      process.env.APP_MODE = prevMode;
    }
  });

  it("supports configurable roles with scope validation, anti-escalation, immediate revocation, and audit logs", async () => {
    const db = await getDatabase({ APP_MODE: "development" });
    await db.collection("branches").updateOne(
      { branchId: "vic" },
      { $setOnInsert: { branchId: "vic", name: "Victoria", kind: "state", recognised: true } },
      { upsert: true },
    );

    const targetId = new ObjectId().toString();
    await db.collection("user").insertOne({
      _id: new ObjectId(targetId),
      name: "Delegated Officer",
      email: `officer-${targetId}@example.org`,
      disabled: false,
      createdAt: new Date(),
    });

    // Reject National-only permission on a branch-scoped role
    await assert.rejects(
      () =>
        saveRoleDefinition(db, nationalAdmin, {
          name: "Invalid Branch Role",
          scope: "branch",
          permissions: ["ballots.view_identifiable"],
        }),
      /restricted to National scope/i,
    );

    // Reject non-admin creating a role
    await assert.rejects(
      () =>
        saveRoleDefinition(db, vicBranchAdmin, {
          name: "Unauthorised Role",
          scope: "branch",
          permissions: ["contributions.respond"],
        }),
      /permission to manage roles/i,
    );

    // Create valid branch-scoped role
    const role = await saveRoleDefinition(db, nationalAdmin, {
      name: "Branch Deliberation Facilitator",
      description: "Respond to contributions and view branch reports.",
      scope: "branch",
      permissions: ["contributions.respond", "reports.export"],
    });
    assert.ok(role.roleId.startsWith("role_"));

    // Reject self-assignment
    await assert.rejects(
      () =>
        assignRoleToMember(db, nationalAdmin, {
          memberId: nationalAdmin.memberId,
          roleId: role.roleId,
          branchId: "vic",
        }),
      /assign roles to yourself/i,
    );

    // Reject assigning branch role without a branch
    await assert.rejects(
      () =>
        assignRoleToMember(db, nationalAdmin, {
          memberId: targetId,
          roleId: role.roleId,
        }),
      /recognised branch/i,
    );

    // Assign role to target member for VIC branch
    const assignment = await assignRoleToMember(db, nationalAdmin, {
      memberId: targetId,
      roleId: role.roleId,
      branchId: "vic",
    });
    assert.equal(assignment.status, "active");

    // Verify effective permissions & origins
    const effective = await resolveMemberEffectivePermissions(db, targetId);
    assert.deepEqual(effective.national, []);
    assert.ok(effective.branches.vic?.includes("contributions.respond"));
    assert.ok(effective.branches.vic?.includes("reports.export"));
    assert.equal(effective.branches.nsw, undefined);
    assert.equal(effective.grants[0]?.roleName, "Branch Deliberation Facilitator");

    // Verify voting eligibility is NOT granted by administrative role assignments
    const branchBallot = await saveProposal(db, nationalAdmin, {
      title: "VIC Branch Ballot Eligibility Isolation",
      space: "Governance",
      summary: "Branch ballot eligibility test summary.",
      outcomes: ["Outcome"],
      details: "Details.",
      originatingBranchId: "vic",
      jurisdictionBranchId: "vic",
      governanceAuthorityBranchId: "vic",
      publicationScope: "branch",
      stage: "decide",
      ballotClosesAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    });
    const officerSession: SessionUser = {
      memberId: targetId,
      name: "Delegated Officer",
      email: `officer-${targetId}@example.org`,
      role: "member",
      status: "pending",
      canParticipate: false,
      isStaff: false,
      isAdmin: false,
      permissions: effective,
    };
    assert.equal(hasPermission(officerSession, "contributions.respond", "vic"), true);
    assert.equal(hasPermission(officerSession, "contributions.respond", "nsw"), false);
    await assert.rejects(
      () =>
        castVote(db, officerSession, {
          proposalId: branchBallot.proposalId,
          choice: "approve",
        }),
      /verified/i,
    );

    // Revoke assignment and verify immediate loss of permissions
    await revokeRoleAssignment(db, nationalAdmin, {
      assignmentId: assignment.assignmentId,
      reason: "Delegation ended.",
    });
    const afterRevoke = await resolveMemberEffectivePermissions(db, targetId);
    assert.equal(afterRevoke.grants.length, 0);
    assert.deepEqual(afterRevoke.branches, {});

    // Delete unused custom role
    await deleteCustomRole(db, nationalAdmin, role.roleId);
  });

  it("enforces roles API HTTP boundaries against non-admins and cross-origin requests", async () => {
    const prevMode = process.env.APP_MODE;
    process.env.APP_MODE = "development";
    try {
      const memberCookie = createDevSessionCookie("member").split(";")[0]!;
      const adminCookie = createDevSessionCookie("administrator").split(";")[0]!;

      const unauthGet = await getRoles({
        request: new Request("http://localhost/api/admin/roles"),
        url: new URL("http://localhost/api/admin/roles"),
        locals: { env: { APP_MODE: "development" } },
      } as never);
      assert.equal(unauthGet.status, 401);

      const memberGet = await getRoles({
        request: new Request("http://localhost/api/admin/roles", {
          headers: { cookie: memberCookie },
        }),
        url: new URL("http://localhost/api/admin/roles"),
        locals: { env: { APP_MODE: "development" } },
      } as never);
      assert.equal(memberGet.status, 403);

      const crossOriginPost = await postRoles({
        request: new Request("http://localhost/api/admin/roles", {
          method: "POST",
          headers: {
            cookie: adminCookie,
            origin: "https://evil.example",
            "content-type": "application/json",
          },
          body: JSON.stringify({ action: "save_role", name: "X", scope: "branch", permissions: ["reports.export"] }),
        }),
        url: new URL("http://localhost/api/admin/roles"),
        locals: { env: { APP_MODE: "development" } },
      } as never);
      assert.equal(crossOriginPost.status, 403);

      const adminGet = await getRoles({
        request: new Request("http://localhost/api/admin/roles", {
          headers: { cookie: adminCookie },
        }),
        url: new URL("http://localhost/api/admin/roles"),
        locals: { env: { APP_MODE: "development" } },
      } as never);
      assert.equal(adminGet.status, 200);
      const data = await adminGet.json();
      assert.ok(Array.isArray(data.catalogue));
      assert.ok(Array.isArray(data.roles));

      const badDelete = await deleteRoles({
        request: new Request("http://localhost/api/admin/roles", {
          method: "DELETE",
          headers: {
            cookie: adminCookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({ roleId: "system:national_administrator" }),
        }),
        url: new URL("http://localhost/api/admin/roles"),
        locals: { env: { APP_MODE: "development" } },
      } as never);
      assert.equal(badDelete.status, 403);
    } finally {
      process.env.APP_MODE = prevMode;
    }
  });

  it("uses one permission model across member management and delegated role display", async () => {
    const db = createMemoryDb();
    const targetId = new ObjectId().toString();
    await db.collection("user").insertOne({
      _id: new ObjectId(targetId),
      name: "Delegated Officer",
      email: `officer-${targetId}@example.org`,
      createdAt: new Date(),
    });
    await db.collection("branches").insertOne({
      branchId: "vic",
      name: "Victoria",
      kind: "state",
      recognised: true,
    });

    const delegated: SessionUser = {
      ...verifiedMember,
      permissions: {
        national: ["members.view", "members.verify", "roles.manage"],
        branches: {},
        grants: [],
      },
    };

    await saveMember(db, delegated, { memberId: targetId, status: "verified" });
    assert.equal(
      (await db.collection("memberships").findOne({ memberId: targetId }))
        ?.status,
      "verified",
    );

    // The actor can demote to Member but cannot grant a system role whose
    // permissions they do not hold.
    await saveMember(db, delegated, { memberId: targetId, role: "member" });
    await assert.rejects(
      saveMember(db, delegated, { memberId: targetId, role: "administrator" }),
      /cannot grant National Administrator/i,
    );
    await assert.rejects(
      saveMember(db, delegated, { memberId: targetId, role: "moderator" }),
      /cannot grant Moderator/i,
    );

    const noVerify: SessionUser = {
      ...delegated,
      permissions: {
        national: ["roles.manage"],
        branches: {},
        grants: [],
      },
    };
    await assert.rejects(
      saveMember(db, noVerify, { memberId: targetId, status: "suspended" }),
      /verification permission/i,
    );

    // A delegated verifier cannot suspend or demote a national administrator.
    await db.collection("application_roles").insertOne({
      memberId: targetId,
      role: "administrator",
      grantedAt: new Date(),
      grantedBy: nationalAdmin.memberId,
    });
    await assert.rejects(
      saveMember(db, delegated, { memberId: targetId, status: "suspended" }),
      /Only a national administrator/i,
    );

    // Branch administration and custom roles are visible in the same member
    // record, so Member Management does not present a different role set.
    await db.collection("branch_memberships").insertOne({
      branchId: "vic",
      memberId: targetId,
      status: "active",
      branchRole: "administrator",
    });
    await db.collection("rbac_roles").insertOne({
      roleId: "role_ballot_officer",
      name: "Ballot Officer",
      description: "Branch ballot administration.",
      scope: "branch",
      permissions: ["ballots.bind"],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection("rbac_assignments").insertOne({
      assignmentId: "assignment_ballot_officer",
      memberId: targetId,
      roleId: "role_ballot_officer",
      scopeType: "branch",
      branchId: "vic",
      status: "active",
      assignedBy: nationalAdmin.memberId,
      assignedAt: new Date(),
    });

    const row = (await listMembers(db)).find(
      (member) => member.memberId === targetId,
    );
    assert.deepEqual(row?.branchAdministratorOf, ["Victoria"]);
    assert.deepEqual(row?.delegatedRoles, ["Ballot Officer — Victoria"]);
  });

  it("supports multiple platform roles and replaces the set without losing other grants", async () => {
    const db = createMemoryDb();
    const targetId = new ObjectId().toString();
    await db.collection("user").insertOne({
      _id: new ObjectId(targetId),
      name: "Multi Role Officer",
      email: `multi-${targetId}@example.org`,
      createdAt: new Date(),
    });

    await saveMember(db, nationalAdmin, {
      memberId: targetId,
      status: "verified",
      roles: ["moderator", "administrator"],
    });
    const afterGrant = (await listMembers(db)).find(
      (member) => member.memberId === targetId,
    );
    assert.deepEqual(afterGrant?.roles, ["member", "moderator", "administrator"]);
    assert.equal(afterGrant?.role, "administrator");
    assert.equal(
      await db.collection("application_roles").countDocuments({ memberId: targetId }),
      2,
    );
    const grantedPermissions = await resolveMemberEffectivePermissions(db, targetId);
    assert.ok(grantedPermissions.national.includes("ballots.view_identifiable"));
    assert.ok(grantedPermissions.national.includes("comments.moderate"));

    // Removing one role leaves the other intact.
    await saveMember(db, nationalAdmin, {
      memberId: targetId,
      roles: ["moderator"],
    });
    const afterDemote = (await listMembers(db)).find(
      (member) => member.memberId === targetId,
    );
    assert.deepEqual(afterDemote?.roles, ["member", "moderator"]);
    assert.equal(afterDemote?.role, "moderator");
    assert.equal(
      await db.collection("application_roles").countDocuments({ memberId: targetId }),
      1,
    );

    await assert.rejects(
      saveMember(db, nationalAdmin, {
        memberId: targetId,
        role: "moderator",
        roles: ["administrator"],
      }),
      /one set of platform roles/i,
    );
  });
});
