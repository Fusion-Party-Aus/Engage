import type { PermissionKey } from "./rbac.ts";
import {
  getEffectivePermissionsSnapshot,
  hasPermission,
  hasPermissionAnywhere,
} from "./rbac.ts";
import type { SessionUser } from "./types.ts";

/**
 * Authority for the acts that bind, run, certify and apply formal ballots and
 * their amendments.
 *
 * This module answers one question: may this viewer perform this act on this
 * matter? It deliberately does not answer whether the act is applicable yet —
 * stage, ballot revision, closure and amendment status stay with the caller.
 * Keeping the two apart means a denied control is a permission answer, never a
 * workflow state disguised as one.
 */
export type BallotAct =
  | "bindMatterBallot"
  | "recordMatterResult"
  | "resolveAmendment"
  | "openAmendmentBallot"
  | "closeAmendmentBallot"
  | "acceptAmendment"
  | "applyAmendment";

export const BALLOT_ACTS: readonly BallotAct[] = [
  "bindMatterBallot",
  "recordMatterResult",
  "resolveAmendment",
  "openAmendmentBallot",
  "closeAmendmentBallot",
  "acceptAmendment",
  "applyAmendment",
];

/** The matter facts an authority decision depends on. */
export interface BallotSubject {
  /** Branch whose authority governs the ballot. */
  governanceAuthorityBranchId?: string | null;
  /** Branch whose members vote in the ballot. */
  jurisdictionBranchId?: string | null;
  /** Branch that owns the proposal wording, for amendment edits. */
  originatingBranchId?: string | null;
}

export type BallotActDenialReason =
  | "signed-out"
  | "not-permitted"
  | "authority-mismatch";

export interface BallotAuthority {
  allowed: ReadonlySet<BallotAct>;
  denied: ReadonlyMap<BallotAct, BallotActDenialReason>;
  can(act: BallotAct): boolean;
  denialReason(act: BallotAct): BallotActDenialReason | undefined;
  /** Plain-language refusal, suitable for a route body or an admin page. */
  denialMessage(act: BallotAct): string | undefined;
  /** 200 when allowed, otherwise the HTTP status a route should return. */
  denialStatus(act: BallotAct): 200 | 401 | 403;
}

interface BallotActPolicy {
  permission: PermissionKey;
  /** Branch the grant must name. */
  branch(subject: BallotSubject): string | null | undefined;
  /**
   * A branch grant cannot act when the ballot's authority and jurisdiction
   * differ. National grants are unaffected.
   */
  requireAuthorityMatch: boolean;
  denialMessage: string;
}

const ACT_POLICY: Record<BallotAct, BallotActPolicy> = {
  bindMatterBallot: {
    permission: "ballots.bind",
    branch: (subject) => subject.governanceAuthorityBranchId,
    requireAuthorityMatch: true,
    denialMessage: "You are not authorised to review this ballot.",
  },
  recordMatterResult: {
    permission: "ballots.record_result",
    branch: (subject) => subject.governanceAuthorityBranchId,
    requireAuthorityMatch: true,
    denialMessage:
      "You are not authorised to record an outcome for this ballot. Branch ballots require explicitly matching authority and jurisdiction.",
  },
  resolveAmendment: {
    permission: "amendments.resolve",
    branch: (subject) => subject.originatingBranchId,
    requireAuthorityMatch: false,
    denialMessage:
      "You are not authorised to resolve amendments for this proposal.",
  },
  openAmendmentBallot: {
    permission: "amendments.manage_ballot",
    branch: (subject) => subject.governanceAuthorityBranchId,
    requireAuthorityMatch: true,
    denialMessage:
      "You are not authorised to open this ballot. Branch authority and jurisdiction must explicitly match your assignment.",
  },
  closeAmendmentBallot: {
    permission: "amendments.manage_ballot",
    branch: (subject) => subject.governanceAuthorityBranchId,
    requireAuthorityMatch: true,
    denialMessage: "You are not authorised to close this branch ballot.",
  },
  acceptAmendment: {
    permission: "amendments.manage_ballot",
    branch: (subject) => subject.governanceAuthorityBranchId,
    requireAuthorityMatch: true,
    denialMessage:
      "You are not authorised to record formal approval for this branch amendment.",
  },
  applyAmendment: {
    permission: "amendments.apply",
    branch: (subject) => subject.originatingBranchId,
    requireAuthorityMatch: false,
    denialMessage:
      "You are not authorised to apply amendments to this proposal.",
  },
};

function decide(
  viewer: SessionUser | null | undefined,
  subject: BallotSubject,
  policy: BallotActPolicy,
): BallotActDenialReason | null {
  if (!viewer) return "signed-out";
  // A national administrator holds every operational permission by role.
  if (viewer.isAdmin) return null;
  // A national grant satisfies branch-scoped checks for branch-capable keys.
  if (hasPermission(viewer, policy.permission)) return null;

  const branchId = policy.branch(subject);
  if (!branchId) return "not-permitted";

  const holdsHere = hasPermission(viewer, policy.permission, branchId);
  if (holdsHere) {
    if (
      policy.requireAuthorityMatch &&
      subject.governanceAuthorityBranchId !== subject.jurisdictionBranchId
    ) {
      return "authority-mismatch";
    }
    return null;
  }

  // A branch grant made for another branch does not travel.
  return "not-permitted";
}

/** The permission that grants one act. Used by contract tests and documentation. */
export function ballotActPermission(act: BallotAct): PermissionKey {
  return ACT_POLICY[act].permission;
}

/** The exact matter scope of a viewer's act grants, for list queries. */
export interface BallotAuthorityScope {
  /** A national grant or administrator covers every matter. */
  all: boolean;
  /** Branches whose ballot acts require matching governance authority and jurisdiction. */
  authorityBranchIds: string[];
  /** Branches whose resolve/apply acts follow the matter's originating branch. */
  originatingBranchIds: string[];
}

/**
 * Express {@link ballotActs} as a scope a list query can apply.
 *
 * Derived from the same act policy table, so a register cannot include a matter
 * on which the viewer has no permitted act. `all` is true for an administrator
 * or a national grant; otherwise the two branch sets name the only matters that
 * can qualify.
 */
export function ballotAuthorityScope(
  viewer: SessionUser | null | undefined,
): BallotAuthorityScope {
  if (!viewer) {
    return { all: false, authorityBranchIds: [], originatingBranchIds: [] };
  }
  if (viewer.isAdmin) {
    return { all: true, authorityBranchIds: [], originatingBranchIds: [] };
  }
  const snapshot = getEffectivePermissionsSnapshot(viewer);
  const authorityBranchIds = new Set<string>();
  const originatingBranchIds = new Set<string>();
  for (const act of BALLOT_ACTS) {
    const policy = ACT_POLICY[act];
    if (snapshot.national.includes(policy.permission)) {
      return { all: true, authorityBranchIds: [], originatingBranchIds: [] };
    }
    for (const [branchId, permissions] of Object.entries(snapshot.branches)) {
      if (!permissions.includes(policy.permission)) continue;
      if (policy.requireAuthorityMatch) authorityBranchIds.add(branchId);
      else originatingBranchIds.add(branchId);
    }
  }
  return {
    all: false,
    authorityBranchIds: [...authorityBranchIds].sort(),
    originatingBranchIds: [...originatingBranchIds].sort(),
  };
}

/**
 * Whether the viewer holds any ballot or amendment act permission at any
 * scope. Used to decide whether an officer surface is worth opening before a
 * matter is loaded; it is not an authorisation for any specific act.
 */
export function hasAnyBallotAct(
  viewer: SessionUser | null | undefined,
): boolean {
  if (!viewer) return false;
  if (viewer.isAdmin) return true;
  return BALLOT_ACTS.some((act) =>
    hasPermissionAnywhere(viewer, ACT_POLICY[act].permission),
  );
}

/**
 * Decide every ballot act for one viewer and one matter.
 *
 * The result is a partition: every act appears in exactly one of `allowed` or
 * `denied`. Routes map a denial to its status and message; pages render the
 * acts the viewer can perform and can explain the rest.
 */
export function ballotActs(
  viewer: SessionUser | null | undefined,
  subject: BallotSubject,
): BallotAuthority {
  const allowed = new Set<BallotAct>();
  const denied = new Map<BallotAct, BallotActDenialReason>();

  for (const act of BALLOT_ACTS) {
    const reason = decide(viewer, subject, ACT_POLICY[act]);
    if (reason) denied.set(act, reason);
    else allowed.add(act);
  }

  return {
    allowed,
    denied,
    can: (act) => allowed.has(act),
    denialReason: (act) => denied.get(act),
    denialMessage: (act) =>
      denied.has(act) ? ACT_POLICY[act].denialMessage : undefined,
    denialStatus: (act) =>
      allowed.has(act)
        ? 200
        : denied.get(act) === "signed-out"
          ? 401
          : 403,
  };
}
