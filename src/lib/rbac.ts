import type { SessionUser } from "./types.ts";

export type PermissionKey =
  | "proposals.view_archived"
  | "proposals.edit"
  | "proposals.manage_supersession"
  | "proposals.delete"
  | "comments.moderate"
  | "contributions.respond"
  | "amendments.resolve"
  | "amendments.apply"
  | "amendments.manage_ballot"
  | "ballots.bind"
  | "ballots.record_result"
  | "ballots.view_identifiable"
  | "policies.ratify"
  | "policies.publish"
  | "members.view"
  | "members.verify"
  | "branches.manage"
  | "branches.verify_members"
  | "branches.refer_proposals"
  | "sense_box.review"
  | "reports.export"
  | "engagement.manage"
  | "settings.manage"
  | "roles.manage";

export type PermissionScope = "national" | "branch";

export interface PermissionDefinition {
  key: PermissionKey;
  group:
    | "Proposals & Deliberation"
    | "Amendments & Ballots"
    | "Policy Registry"
    | "Members & Branches"
    | "Reporting & Platform";
  label: string;
  description: string;
  allowedScopes: PermissionScope[];
  sensitive?: boolean;
  sensitivityNote?: string;
}

export const PERMISSION_CATALOGUE: PermissionDefinition[] = [
  {
    key: "proposals.view_archived",
    group: "Proposals & Deliberation",
    label: "View archived proposals",
    description: "Inspect archived proposals and their revision history within scope.",
    allowedScopes: ["national", "branch"],
  },
  {
    key: "proposals.edit",
    group: "Proposals & Deliberation",
    label: "Edit proposals & stage",
    description: "Edit proposal wording (before ballot lock) and advance lifecycle stages within scope.",
    allowedScopes: ["national", "branch"],
  },
  {
    key: "proposals.manage_supersession",
    group: "Proposals & Deliberation",
    label: "Manage supersession & notes",
    description: "Record outcome notes and successor links on completed or archived proposals.",
    allowedScopes: ["national", "branch"],
  },
  {
    key: "proposals.delete",
    group: "Proposals & Deliberation",
    label: "Delete proposals",
    description: "Permanently remove proposals and their deliberation comments.",
    allowedScopes: ["national"],
    sensitive: true,
    sensitivityNote: "Destructive action; restricted to National scope.",
  },
  {
    key: "comments.moderate",
    group: "Proposals & Deliberation",
    label: "Moderate deliberation comments",
    description: "Remove inappropriate member comments in deliberation threads.",
    allowedScopes: ["national"],
  },
  {
    key: "contributions.respond",
    group: "Proposals & Deliberation",
    label: "Respond to contributions",
    description: "Record incorporated, considered, deferred, or declined outcomes and supporting evidence.",
    allowedScopes: ["national", "branch"],
  },
  {
    key: "amendments.resolve",
    group: "Amendments & Ballots",
    label: "Resolve proposed amendments",
    description: "Mark proposed or conflicting amendments as ready, rejected, or withdrawn.",
    allowedScopes: ["national", "branch"],
  },
  {
    key: "amendments.apply",
    group: "Amendments & Ballots",
    label: "Apply accepted amendments",
    description: "Apply formally accepted amendments as new immutable proposal revisions.",
    allowedScopes: ["national", "branch"],
  },
  {
    key: "amendments.manage_ballot",
    group: "Amendments & Ballots",
    label: "Manage amendment ballots",
    description: "Open, close, and formally accept amendment ballots (requires matching branch authority).",
    allowedScopes: ["national", "branch"],
    sensitive: true,
    sensitivityNote: "Governs formal amendment voting and acceptance.",
  },
  {
    key: "ballots.bind",
    group: "Amendments & Ballots",
    label: "Bind proposal ballots",
    description: "Lock a proposal ballot to an exact immutable wording revision.",
    allowedScopes: ["national", "branch"],
    sensitive: true,
    sensitivityNote: "Locks formal ballot wording.",
  },
  {
    key: "ballots.record_result",
    group: "Amendments & Ballots",
    label: "Record ballot results",
    description: "Record returning-officer ballot outcomes and decision event references.",
    allowedScopes: ["national", "branch"],
    sensitive: true,
    sensitivityNote: "Immutable formal decision record.",
  },
  {
    key: "ballots.view_identifiable",
    group: "Amendments & Ballots",
    label: "View identifiable ballots",
    description: "Inspect individual members' ballot choices and reasons.",
    allowedScopes: ["national"],
    sensitive: true,
    sensitivityNote: "Highly sensitive: exposes individual member voting choices.",
  },
  {
    key: "policies.ratify",
    group: "Policy Registry",
    label: "Ratify adopted policies",
    description: "Ratify passed proposals into the official Policy Registry.",
    allowedScopes: ["national"],
    sensitive: true,
    sensitivityNote: "Constitutional policy adoption step.",
  },
  {
    key: "policies.publish",
    group: "Policy Registry",
    label: "Publish, withdraw, or supersede policies",
    description: "Manage public publication status of ratified policies.",
    allowedScopes: ["national"],
    sensitive: true,
    sensitivityNote: "Controls official public party policy.",
  },
  {
    key: "members.view",
    group: "Members & Branches",
    label: "View member directory",
    description: "Inspect member accounts, emails, and verification status.",
    allowedScopes: ["national"],
    sensitive: true,
    sensitivityNote: "Exposes member personal details.",
  },
  {
    key: "members.verify",
    group: "Members & Branches",
    label: "Verify or suspend members",
    description: "Approve or suspend platform membership verification and account status.",
    allowedScopes: ["national"],
    sensitive: true,
    sensitivityNote: "Controls platform voting eligibility and account access.",
  },
  {
    key: "branches.manage",
    group: "Members & Branches",
    label: "Manage recognised branches",
    description: "Create or update recognised national, state, territory, or constituent branches.",
    allowedScopes: ["national"],
  },
  {
    key: "branches.verify_members",
    group: "Members & Branches",
    label: "Verify branch memberships",
    description: "Verify or revoke member branch affiliations within assigned branch scope.",
    allowedScopes: ["national", "branch"],
    sensitive: true,
    sensitivityNote: "Controls branch-level ballot eligibility.",
  },
  {
    key: "branches.refer_proposals",
    group: "Members & Branches",
    label: "Refer proposals between branches",
    description: "Create inter-branch proposal referrals.",
    allowedScopes: ["national"],
  },
  {
    key: "sense_box.review",
    group: "Members & Branches",
    label: "Review Sense Box submissions",
    description: "View and triage private community priority submissions within scope.",
    allowedScopes: ["national", "branch"],
    sensitive: true,
    sensitivityNote: "Contains private member community input.",
  },
  {
    key: "reports.export",
    group: "Reporting & Platform",
    label: "View dashboards & export reports",
    description: "Access administrative dashboards and export aggregate CSV and proposal PDF reports.",
    allowedScopes: ["national", "branch"],
  },
  {
    key: "engagement.manage",
    group: "Reporting & Platform",
    label: "Manage engagement & digests",
    description: "View engagement metrics and send digest test or re-engagement emails.",
    allowedScopes: ["national"],
  },
  {
    key: "settings.manage",
    group: "Reporting & Platform",
    label: "Manage platform settings",
    description: "Update global platform configuration settings.",
    allowedScopes: ["national"],
    sensitive: true,
    sensitivityNote: "Global platform configuration.",
  },
  {
    key: "roles.manage",
    group: "Reporting & Platform",
    label: "Manage roles & permissions",
    description: "Create, edit, assign, and revoke configurable administrative roles.",
    allowedScopes: ["national"],
    sensitive: true,
    sensitivityNote: "Grants ability to delegate administrative permissions.",
  },
];

export const PERMISSION_MAP = new Map<PermissionKey, PermissionDefinition>(
  PERMISSION_CATALOGUE.map((p) => [p.key, p]),
);

export const ALL_NATIONAL_PERMISSIONS: PermissionKey[] = PERMISSION_CATALOGUE.map(
  (p) => p.key,
);

export const LEGACY_MODERATOR_PERMISSIONS: PermissionKey[] = [
  "proposals.view_archived",
  "proposals.edit",
  "proposals.manage_supersession",
  "comments.moderate",
  "contributions.respond",
  "reports.export",
];

export const LEGACY_BRANCH_ADMIN_PERMISSIONS: PermissionKey[] = [
  "proposals.view_archived",
  "proposals.edit",
  "proposals.manage_supersession",
  "contributions.respond",
  "amendments.resolve",
  "amendments.apply",
  "amendments.manage_ballot",
  "ballots.bind",
  "ballots.record_result",
  "branches.verify_members",
  "sense_box.review",
  "reports.export",
];

export interface EffectivePermissionGrant {
  permission: PermissionKey;
  scopeType: PermissionScope;
  branchId?: string;
  sourceKind: "legacy-role" | "legacy-branch-admin" | "custom-role";
  roleId: string;
  roleName: string;
}

export interface EffectivePermissionsSnapshot {
  national: PermissionKey[];
  branches: Record<string, PermissionKey[]>;
  grants: EffectivePermissionGrant[];
}

export interface RoleDefinitionRecord {
  roleId: string;
  name: string;
  description: string;
  scope: PermissionScope;
  permissions: PermissionKey[];
  isSystem?: boolean;
  createdAt: Date;
  updatedAt: Date;
  updatedBy?: string;
}

export interface RoleAssignmentRecord {
  assignmentId: string;
  memberId: string;
  roleId: string;
  scopeType: PermissionScope;
  branchId: string | null;
  status: "active" | "revoked";
  assignedBy: string;
  assignedAt: Date;
  revokedBy?: string;
  revokedAt?: Date;
  revocationReason?: string;
}

/**
 * Compute legacy-compatible permission snapshot when `user.permissions` is not
 * pre-populated (for example in unit tests constructing synthetic SessionUser).
 */
function legacySnapshotForUser(user: SessionUser): EffectivePermissionsSnapshot {
  const national = new Set<PermissionKey>();
  const branches: Record<string, PermissionKey[]> = {};
  const grants: EffectivePermissionGrant[] = [];

  if (user.isAdmin || user.role === "administrator") {
    for (const key of ALL_NATIONAL_PERMISSIONS) {
      national.add(key);
      grants.push({
        permission: key,
        scopeType: "national",
        sourceKind: "legacy-role",
        roleId: "legacy:administrator",
        roleName: "National Administrator",
      });
    }
  } else if (user.isStaff || user.role === "moderator") {
    for (const key of LEGACY_MODERATOR_PERMISSIONS) {
      national.add(key);
      grants.push({
        permission: key,
        scopeType: "national",
        sourceKind: "legacy-role",
        roleId: "legacy:moderator",
        roleName: "Moderator",
      });
    }
  }

  for (const branchId of user.branchAdminIds ?? []) {
    branches[branchId] = [...LEGACY_BRANCH_ADMIN_PERMISSIONS];
    for (const key of LEGACY_BRANCH_ADMIN_PERMISSIONS) {
      grants.push({
        permission: key,
        scopeType: "branch",
        branchId,
        sourceKind: "legacy-branch-admin",
        roleId: "legacy:branch-admin",
        roleName: "Branch Administrator",
      });
    }
  }

  return {
    national: [...national],
    branches,
    grants,
  };
}

export function getEffectivePermissionsSnapshot(
  user: SessionUser | null | undefined,
): EffectivePermissionsSnapshot {
  if (!user) return { national: [], branches: {}, grants: [] };
  return user.permissions ?? legacySnapshotForUser(user);
}

/**
 * Evaluate whether `user` holds `permission` nationally or for a specific `branchId`.
 * National grants satisfy branch-scoped checks for permissions that allow branch scope.
 */
export function hasPermission(
  user: SessionUser | null | undefined,
  permission: PermissionKey,
  branchId?: string,
): boolean {
  if (!user) return false;
  const snap = getEffectivePermissionsSnapshot(user);
  if (snap.national.includes(permission)) return true;
  if (branchId && snap.branches[branchId]?.includes(permission)) return true;
  return false;
}

/**
 * Reusable API authorisation guard. Returns a 401 or 403 Response when the
 * caller lacks `permission` (nationally or for `branchId`), or `null` when
 * permitted.
 */
export function requireApiPermission(
  user: SessionUser | null | undefined,
  permission: PermissionKey,
  options: { branchId?: string; message?: string } = {},
): Response | null {
  if (!user) {
    return Response.json({ error: "Sign in required." }, { status: 401 });
  }
  if (!hasPermission(user, permission, options.branchId)) {
    return Response.json(
      { error: options.message ?? "You do not have permission for this action." },
      { status: 403 },
    );
  }
  return null;
}

/**
 * Return all branch IDs where the user holds `permission` (or null if they hold it nationally).
 */
export function branchesWithPermission(
  user: SessionUser | null | undefined,
  permission: PermissionKey,
): { national: boolean; branchIds: string[] } {
  if (!user) return { national: false, branchIds: [] };
  const snap = getEffectivePermissionsSnapshot(user);
  if (snap.national.includes(permission)) {
    return { national: true, branchIds: [] };
  }
  const branchIds = Object.entries(snap.branches)
    .filter(([, perms]) => perms.includes(permission))
    .map(([bId]) => bId);
  return { national: false, branchIds };
}

export function isValidPermissionKey(value: unknown): value is PermissionKey {
  return typeof value === "string" && PERMISSION_MAP.has(value as PermissionKey);
}

export function validatePermissionsForScope(
  permissions: unknown[],
  scope: PermissionScope,
): PermissionKey[] {
  const valid: PermissionKey[] = [];
  for (const raw of permissions) {
    if (!isValidPermissionKey(raw)) {
      throw new Error(`Unknown permission key: '${String(raw)}'.`);
    }
    const def = PERMISSION_MAP.get(raw)!;
    if (!def.allowedScopes.includes(scope)) {
      throw new Error(
        `Permission '${def.label}' (${raw}) is restricted to National scope and cannot be added to a branch role.`,
      );
    }
    if (!valid.includes(raw)) valid.push(raw);
  }
  return valid;
}
