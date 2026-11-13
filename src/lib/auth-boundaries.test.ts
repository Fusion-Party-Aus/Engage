import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hasPermission, requireApiPermission } from "./rbac.ts";
import { canManageBranchBallot } from "./auth.ts";
import { createMemoryDb } from "./db.ts";
import {
  assignRoleToMember,
  resolveMemberEffectivePermissions,
  revokeRoleAssignment,
  saveRoleDefinition,
} from "./roles-store.ts";
import type { SessionUser } from "./types.ts";

describe("hardened authorisation boundaries", () => {
  it("enforces national and branch-scoped permissions and blocks cross-branch access", () => {
    const vicBallotOfficer: SessionUser = {
      memberId: "m-vic-officer",
      name: "VIC Officer",
      email: "vic@example.test",
      role: "member",
      status: "verified",
      canParticipate: true,
      isStaff: false,
      isAdmin: false,
      branchAdminIds: ["branch-vic"],
      isBranchAdmin: true,
      permissions: {
        national: [],
        branches: {
          "branch-vic": ["ballots.bind", "ballots.record_result"],
        },
        grants: [],
      },
    };

    assert.equal(hasPermission(vicBallotOfficer, "ballots.bind", "branch-vic"), true);
    assert.equal(hasPermission(vicBallotOfficer, "ballots.bind", "branch-nsw"), false);
    assert.equal(hasPermission(vicBallotOfficer, "policies.ratify"), false);

    const nswDenied = requireApiPermission(vicBallotOfficer, "ballots.bind", {
      branchId: "branch-nsw",
    });
    assert.equal(nswDenied?.status, 403);

    const vicAllowed = requireApiPermission(vicBallotOfficer, "ballots.bind", {
      branchId: "branch-vic",
    });
    assert.equal(vicAllowed, null);
  });

  it("keeps constitutional ballot governance separate from configurable administrative roles", () => {
    const vicBranchAdmin: SessionUser = {
      memberId: "m-vic-admin",
      name: "VIC Admin",
      email: "vic-admin@example.test",
      role: "member",
      status: "verified",
      canParticipate: true,
      isStaff: false,
      isAdmin: false,
      branchAdminIds: ["branch-vic"],
      isBranchAdmin: true,
    };

    // Even with branch-vic authority, mismatched jurisdictionBranchId is rejected.
    assert.equal(
      canManageBranchBallot(vicBranchAdmin, {
        governanceAuthorityBranchId: "branch-vic",
        jurisdictionBranchId: "branch-nsw",
      }),
      false,
    );
    assert.equal(
      canManageBranchBallot(vicBranchAdmin, {
        governanceAuthorityBranchId: "branch-vic",
        jurisdictionBranchId: "branch-vic",
      }),
      true,
    );
  });

  it("reflects role assignment revocation immediately on permission resolution", async () => {
    const db = createMemoryDb();
    await db.collection("user").insertOne({
      memberId: "m-publisher",
      name: "Publisher",
      email: "publisher@example.test",
      role: "member",
      status: "verified",
      disabled: false,
    });
    const adminActor: SessionUser = {
      memberId: "admin-1",
      name: "Admin",
      email: "admin@example.test",
      role: "administrator",
      status: "verified",
      canParticipate: true,
      isStaff: true,
      isAdmin: true,
    };
    const role = await saveRoleDefinition(db, adminActor, {
      name: "Policy Publisher",
      scope: "national",
      permissions: ["policies.publish"],
    });
    const assignment = await assignRoleToMember(db, adminActor, {
      memberId: "m-publisher",
      roleId: role.roleId,
    });

    const beforeRevoke = await resolveMemberEffectivePermissions(db, "m-publisher");
    assert.equal(beforeRevoke.national.includes("policies.publish"), true);

    await revokeRoleAssignment(db, adminActor, {
      assignmentId: assignment.assignmentId,
      reason: "Term ended",
    });

    const afterRevoke = await resolveMemberEffectivePermissions(db, "m-publisher");
    assert.equal(afterRevoke.national.includes("policies.publish"), false);
  });
});
