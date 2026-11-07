import { it } from "node:test";
import assert from "node:assert/strict";
import {
  canAdministerBranch,
  canManageBranchBallot,
  canManageBranchProposal,
} from "./auth.ts";
import type { SessionUser } from "./types.ts";

const localOfficer: SessionUser = {
  memberId: "local-officer",
  name: "Local Officer",
  email: "officer@example.org",
  role: "member",
  status: "verified",
  canParticipate: true,
  isStaff: false,
  isAdmin: false,
  isBranchAdmin: true,
  branchAdminIds: ["branch-state"],
};

it("keeps delegated branch administration inside the explicitly assigned branch", () => {
  assert.equal(canAdministerBranch(localOfficer, "branch-state"), true);
  assert.equal(canAdministerBranch(localOfficer, "branch-territory"), false);
  assert.equal(
    canManageBranchProposal(localOfficer, {
      originatingBranchId: "branch-state",
    }),
    true,
  );
  assert.equal(
    canManageBranchProposal(localOfficer, {
      originatingBranchId: "branch-territory",
    }),
    false,
  );
  assert.equal(
    canManageBranchBallot(localOfficer, {
      governanceAuthorityBranchId: "branch-state",
      jurisdictionBranchId: "branch-state",
    }),
    true,
  );
  assert.equal(
    canManageBranchBallot(localOfficer, {
      governanceAuthorityBranchId: "branch-state",
      jurisdictionBranchId: "branch-national",
    }),
    false,
  );
  assert.equal(
    canManageBranchBallot(localOfficer, {
      governanceAuthorityBranchId: "branch-national",
      jurisdictionBranchId: "branch-national",
    }),
    false,
  );
});
