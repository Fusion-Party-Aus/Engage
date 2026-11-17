import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BALLOT_ACTS,
  ballotActPermission,
  ballotActs,
  ballotScopeBranchIds,
  hasAnyBallotAct,
  type BallotAct,
  type BallotSubject,
} from "./ballot-authority.ts";
import { GOVERNANCE_COMMANDS } from "./governance-commands.ts";
import type { SessionUser } from "./types.ts";
import type { PermissionKey } from "./rbac.ts";

const ALL_ACTS: readonly BallotAct[] = BALLOT_ACTS;
const MATCHING_SUBJECT: BallotSubject = {
  governanceAuthorityBranchId: "branch-vic",
  jurisdictionBranchId: "branch-vic",
  originatingBranchId: "branch-vic",
};

function viewer(
  overrides: Partial<SessionUser> = {},
  permissions?: { national?: PermissionKey[]; branches?: Record<string, PermissionKey[]> },
): SessionUser {
  return {
    memberId: "member-1",
    name: "Test Member",
    email: "member@example.test",
    role: "member",
    status: "verified",
    canParticipate: true,
    isStaff: false,
    isAdmin: false,
    ...(permissions
      ? {
          permissions: {
            national: permissions.national ?? [],
            branches: permissions.branches ?? {},
            grants: [],
          },
        }
      : {}),
    ...overrides,
  };
}

function allowedActs(user: SessionUser | null, subject: BallotSubject = MATCHING_SUBJECT): BallotAct[] {
  return [...ballotActs(user, subject).allowed].sort();
}

function expectDenied(
  user: SessionUser | null,
  subject: BallotSubject = MATCHING_SUBJECT,
): void {
  const authority = ballotActs(user, subject);
  assert.equal(authority.allowed.size, 0);
  for (const act of ALL_ACTS) {
    assert.equal(authority.can(act), false, act);
    assert.ok(authority.denialReason(act), act);
    assert.ok(authority.denialMessage(act), act);
  }
}

describe("ballot authority", () => {
  it("partitions every act into allowed or denied", () => {
    const authority = ballotActs(viewer(), MATCHING_SUBJECT);
    assert.equal(authority.allowed.size + authority.denied.size, ALL_ACTS.length);
    for (const act of ALL_ACTS) {
      assert.equal(authority.can(act), authority.allowed.has(act));
      assert.equal(authority.denialReason(act) === undefined, authority.allowed.has(act));
    }
  });

  it("treats a signed-out viewer as unauthenticated", () => {
    expectDenied(null);
    const authority = ballotActs(null, MATCHING_SUBJECT);
    for (const act of ALL_ACTS) {
      assert.equal(authority.denialReason(act), "signed-out");
      assert.equal(authority.denialStatus(act), 401);
    }
  });

  it("denies an ordinary member without exposing branch detail", () => {
    expectDenied(viewer());
    const authority = ballotActs(viewer(), MATCHING_SUBJECT);
    for (const act of ALL_ACTS) {
      assert.equal(authority.denialReason(act), "not-permitted");
      assert.equal(authority.denialStatus(act), 403);
    }
  });

  it("does not let moderator status confer ballot authority", () => {
    const moderator = viewer(
      { role: "moderator", isStaff: true },
      {
        national: [
          "proposals.edit",
          "proposals.view_archived",
          "comments.moderate",
        ],
      },
    );
    expectDenied(moderator);
  });

  it("allows every act to a national administrator", () => {
    const administrator = viewer({ role: "administrator", isAdmin: true, isStaff: true });
    assert.deepEqual(allowedActs(administrator), [...ALL_ACTS].sort());
  });

  it("grants only the act whose permission is held nationally", () => {
    const officer = viewer({}, { national: ["ballots.bind"] });
    assert.deepEqual(allowedActs(officer), ["bindMatterBallot"]);
  });

  it("grants each act from its own permission", () => {
    const cases: Array<[PermissionKey, BallotAct]> = [
      ["ballots.bind", "bindMatterBallot"],
      ["ballots.record_result", "recordMatterResult"],
      ["amendments.resolve", "resolveAmendment"],
      ["amendments.manage_ballot", "openAmendmentBallot"],
      ["amendments.manage_ballot", "closeAmendmentBallot"],
      ["amendments.manage_ballot", "acceptAmendment"],
      ["amendments.apply", "applyAmendment"],
    ];
    for (const [permission, act] of cases) {
      const officer = viewer({}, { national: [permission] });
      assert.ok(ballotActs(officer, MATCHING_SUBJECT).can(act), `${permission} grants ${act}`);
    }
  });

  it("allows a branch-delegated officer when authority and jurisdiction match", () => {
    const officer = viewer(
      {},
      {
        branches: {
          "branch-vic": [
            "ballots.bind",
            "ballots.record_result",
            "amendments.manage_ballot",
            "amendments.resolve",
            "amendments.apply",
          ],
        },
      },
    );
    assert.deepEqual(allowedActs(officer), [...ALL_ACTS].sort());
  });

  it("denies a branch officer whose authority and jurisdiction differ", () => {
    const officer = viewer(
      {},
      { branches: { "branch-vic": ["ballots.bind", "amendments.manage_ballot"] } },
    );
    const authority = ballotActs(officer, {
      governanceAuthorityBranchId: "branch-vic",
      jurisdictionBranchId: "branch-nsw",
    });
    assert.equal(authority.can("bindMatterBallot"), false);
    assert.equal(authority.denialReason("bindMatterBallot"), "authority-mismatch");
    assert.equal(authority.denialStatus("bindMatterBallot"), 403);
    assert.match(
      authority.denialMessage("bindMatterBallot") ?? "",
      /authority|jurisdiction|authorised/i,
    );
  });

  it("keeps amendment resolution and application on the originating branch", () => {
    const officer = viewer(
      {},
      { branches: { "branch-vic": ["amendments.resolve", "amendments.apply"] } },
    );
    const authority = ballotActs(officer, {
      governanceAuthorityBranchId: "branch-vic",
      jurisdictionBranchId: "branch-nsw",
      originatingBranchId: "branch-vic",
    });
    assert.equal(authority.can("resolveAmendment"), true);
    assert.equal(authority.can("applyAmendment"), true);
    assert.equal(authority.can("bindMatterBallot"), false);
  });

  it("denies a branch grant for a different branch", () => {
    const officer = viewer({}, { branches: { "branch-nsw": ["ballots.bind"] } });
    const authority = ballotActs(officer, MATCHING_SUBJECT);
    assert.equal(authority.denialReason("bindMatterBallot"), "not-permitted");
  });

  it("denies branch grants when the subject has no branch", () => {
    const officer = viewer({}, { branches: { "branch-vic": ["ballots.bind"] } });
    const authority = ballotActs(officer, {});
    assert.equal(authority.can("bindMatterBallot"), false);
    assert.equal(authority.denialReason("bindMatterBallot"), "not-permitted");
  });

  it("still allows a national permission holder when the subject has no branch", () => {
    const officer = viewer({}, { national: ["ballots.bind"] });
    assert.deepEqual(
      allowedActs(officer, {}),
      ["bindMatterBallot"],
    );
  });

  it("does not let one ballot permission confer another", () => {
    const officer = viewer({}, { national: ["ballots.bind"] });
    const authority = ballotActs(officer, MATCHING_SUBJECT);
    assert.equal(authority.can("recordMatterResult"), false);
    assert.equal(authority.can("openAmendmentBallot"), false);
    assert.equal(authority.can("applyAmendment"), false);
  });

  it("grants a branch administrator the legacy ballot permissions", () => {
    const branchAdmin = viewer({
      isBranchAdmin: true,
      branchAdminIds: ["branch-vic"],
    });
    assert.deepEqual(allowedActs(branchAdmin), [...ALL_ACTS].sort());
  });

  it("does not add authority from a custom permission snapshot", () => {
    const branchAdminWithCustomSnapshot = viewer(
      { isBranchAdmin: true, branchAdminIds: ["branch-vic"] },
      { national: [], branches: { "branch-vic": ["proposals.edit"] } },
    );
    expectDenied(branchAdminWithCustomSnapshot);
  });

  it("reports whether an officer surface is worth opening", () => {
    assert.equal(hasAnyBallotAct(null), false);
    assert.equal(hasAnyBallotAct(viewer()), false);
    assert.equal(
      hasAnyBallotAct(viewer({}, { national: ["ballots.bind"] })),
      true,
    );
    assert.equal(
      hasAnyBallotAct(viewer({}, { branches: { "branch-vic": ["amendments.apply"] } })),
      true,
    );
    assert.equal(
      hasAnyBallotAct(viewer({ role: "administrator", isAdmin: true })),
      true,
    );
  });

  it("keeps governance command act permissions aligned", () => {
    const ballotCommands = Object.values(GOVERNANCE_COMMANDS).filter(
      (command) => command.ballotAct,
    );
    assert.ok(ballotCommands.length >= 2, "ballot commands declare an act");
    for (const command of ballotCommands) {
      assert.equal(
        ballotActPermission(command.ballotAct!),
        command.requiredPermission,
        `${command.id} must use the permission its act declares`,
      );
    }
  });

  it("reports the branch scope of an officer's act grants", () => {
    assert.deepEqual(ballotScopeBranchIds(null), []);
    assert.equal(
      ballotScopeBranchIds(viewer({ role: "administrator", isAdmin: true })),
      null,
    );
    assert.equal(
      ballotScopeBranchIds(viewer({}, { national: ["ballots.bind"] })),
      null,
    );
    assert.deepEqual(
      ballotScopeBranchIds(
        viewer(
          {},
          {
            branches: {
              "branch-vic": ["ballots.bind"],
              "branch-nsw": ["amendments.apply"],
            },
          },
        ),
      ),
      ["branch-nsw", "branch-vic"],
    );
    assert.deepEqual(
      ballotScopeBranchIds(
        viewer({}, { branches: { "branch-vic": ["proposals.edit"] } }),
      ),
      [],
      "a non-act permission does not widen the register scope",
    );
    assert.deepEqual(
      ballotScopeBranchIds(
        viewer({ isBranchAdmin: true, branchAdminIds: ["branch-vic"] }),
      ),
      ["branch-vic"],
      "legacy branch administrators hold the act permissions at their branch",
    );
  });

  it("gives every act a plain-language denial message", () => {
    const authority = ballotActs(viewer(), MATCHING_SUBJECT);
    for (const act of ALL_ACTS) {
      const message = authority.denialMessage(act);
      assert.ok(message && message.length > 20, act);
      assert.doesNotMatch(message!, /undefined|null|BALLOT_/i);
    }
  });
});
