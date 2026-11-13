import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDb } from "./db.ts";
import { getEffectivePermissionsSnapshot } from "./rbac.ts";
import { resolveMemberEffectivePermissions } from "./roles-store.ts";
import { getProposalEligibility } from "./branch-participation.ts";
import type { SessionUser, UserRole } from "./types.ts";

function member(role: UserRole, branchAdminIds: string[] = []): SessionUser {
  return {
    memberId: "member", name: "Member", email: "member@example.test",
    role, status: "verified", canParticipate: true,
    isAdmin: role === "administrator", isStaff: role !== "member", branchAdminIds,
  };
}

describe("federated permission compatibility", () => {
  for (const role of ["member", "moderator", "administrator"] as const) {
    it(`resolves identical legacy permissions and provenance for ${role} sessions`, async () => {
      const db = createMemoryDb();
      const user = member(role, ["vic"]);
      const resolved = await resolveMemberEffectivePermissions(db, user.memberId, {
        rolesDocs: [{ role }],
        branchMembershipRows: [
          { branchId: "vic", branchRole: "administrator", status: "active" },
          { branchId: "nsw", branchRole: "administrator", status: "revoked" },
          { branchId: "local", branchRole: "member", status: "active" },
        ],
      });
      assert.deepEqual(getEffectivePermissionsSnapshot(user), resolved);
    });
  }

  for (const role of ["member", "moderator", "administrator"] as const) {
    it(`requires independent branch membership for a ${role} ballot participant`, async () => {
      const db = createMemoryDb();
      await db.collection("branches").insertOne({ branchId: "nsw", kind: "state", name: "NSW", recognised: true });
      const user = member(role, ["nsw"]);
      const proposal = { jurisdictionBranchId: "nsw", governanceAuthorityBranchId: "nsw" };
      assert.equal((await getProposalEligibility(db, proposal, user)).eligible, false);
      await db.collection("branch_memberships").insertOne({ memberId: user.memberId, branchId: "nsw", status: "active", branchRole: "member" });
      assert.equal((await getProposalEligibility(db, proposal, user)).eligible, true);
      assert.equal((await getProposalEligibility(db, proposal, { ...user, canParticipate: false, status: "suspended" })).eligible, false);
    });
  }
});
