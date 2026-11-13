import { randomUUID } from "node:crypto";
import { ObjectId, type Db } from "mongodb";
import {
  ALL_NATIONAL_PERMISSIONS,
  LEGACY_BRANCH_ADMIN_PERMISSIONS,
  LEGACY_MODERATOR_PERMISSIONS,
  hasPermission,
  validatePermissionsForScope,
  type EffectivePermissionGrant,
  type EffectivePermissionsSnapshot,
  type PermissionKey,
  type PermissionScope,
  type RoleAssignmentRecord,
  type RoleDefinitionRecord,
} from "./rbac.ts";
import type { SessionUser, UserRole } from "./types.ts";

export const RBAC_ROLES = "rbac_roles";
export const RBAC_ASSIGNMENTS = "rbac_assignments";
export const RBAC_AUDIT_LOG = "rbac_audit_log";

export class RbacError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export const SYSTEM_ROLE_DEFINITIONS: Array<
  Omit<RoleDefinitionRecord, "createdAt" | "updatedAt">
> = [
  {
    roleId: "system:national_administrator",
    name: "National Administrator",
    description:
      "Full national platform administration, policy ratification, member verification, and identifiable ballot access.",
    scope: "national",
    permissions: ALL_NATIONAL_PERMISSIONS,
    isSystem: true,
  },
  {
    roleId: "system:moderator",
    name: "Moderator",
    description:
      "Review proposals, moderate deliberation comments, respond to contributions, and view aggregate reports.",
    scope: "national",
    permissions: LEGACY_MODERATOR_PERMISSIONS,
    isSystem: true,
  },
  {
    roleId: "system:branch_administrator",
    name: "Branch Administrator",
    description:
      "Manage branch proposals, amendments, ballots (within matching authority), branch memberships, and branch reports.",
    scope: "branch",
    permissions: LEGACY_BRANCH_ADMIN_PERMISSIONS,
    isSystem: true,
  },
];

async function recordRbacAudit(
  db: Db,
  entry: {
    action:
      | "role_created"
      | "role_updated"
      | "role_deleted"
      | "role_assigned"
      | "role_revoked";
    actorId: string;
    actorName: string;
    roleId: string;
    targetMemberId?: string;
    branchId?: string | null;
    details: Record<string, unknown>;
  },
): Promise<void> {
  await db.collection(RBAC_AUDIT_LOG).insertOne({
    eventId: randomUUID(),
    ...entry,
    createdAt: new Date(),
  });
}

/**
 * Compute a member's effective permissions deterministically from:
 * 1. Legacy `application_roles` (`administrator`, `moderator`)
 * 2. Legacy `branch_memberships` (`status: "active"`, `branchRole: "administrator"`)
 * 3. Active `rbac_assignments` joined with `rbac_roles`
 */
export async function resolveMemberEffectivePermissions(
  db: Db,
  memberId: string,
  preloaded?: {
    rolesDocs?: Array<{ role: UserRole }>;
    branchMembershipRows?: Array<{
      branchId: string;
      branchRole?: string;
      status: string;
    }>;
  },
): Promise<EffectivePermissionsSnapshot> {
  const [rolesDocs, branchMembershipRows, assignmentRows, customRoles] =
    await Promise.all([
      preloaded?.rolesDocs
        ? Promise.resolve(preloaded.rolesDocs)
        : db
            .collection<{ role: UserRole }>("application_roles")
            .find({ memberId })
            .toArray(),
      preloaded?.branchMembershipRows
        ? Promise.resolve(preloaded.branchMembershipRows)
        : db
            .collection<{
              branchId: string;
              branchRole?: string;
              status: string;
            }>("branch_memberships")
            .find({ memberId, status: "active" })
            .toArray(),
      db
        .collection<RoleAssignmentRecord>(RBAC_ASSIGNMENTS)
        .find({ memberId, status: "active" })
        .toArray(),
      db.collection<RoleDefinitionRecord>(RBAC_ROLES).find({}).toArray(),
    ]);

  const roleById = new Map<string, RoleDefinitionRecord>();
  for (const sys of SYSTEM_ROLE_DEFINITIONS) {
    roleById.set(sys.roleId, {
      ...sys,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
  }
  for (const r of customRoles) {
    roleById.set(r.roleId, r);
  }

  const nationalSet = new Set<PermissionKey>();
  const branchSets = new Map<string, Set<PermissionKey>>();
  const grants: EffectivePermissionGrant[] = [];

  const legacyRoles = rolesDocs.map((r) => r.role);
  if (legacyRoles.includes("administrator")) {
    for (const key of ALL_NATIONAL_PERMISSIONS) {
      nationalSet.add(key);
      grants.push({
        permission: key,
        scopeType: "national",
        sourceKind: "legacy-role",
        roleId: "system:national_administrator",
        roleName: "National Administrator",
      });
    }
  } else if (legacyRoles.includes("moderator")) {
    for (const key of LEGACY_MODERATOR_PERMISSIONS) {
      nationalSet.add(key);
      grants.push({
        permission: key,
        scopeType: "national",
        sourceKind: "legacy-role",
        roleId: "system:moderator",
        roleName: "Moderator",
      });
    }
  }

  for (const bm of branchMembershipRows) {
    if (bm.status === "active" && bm.branchRole === "administrator") {
      const set = branchSets.get(bm.branchId) ?? new Set<PermissionKey>();
      for (const key of LEGACY_BRANCH_ADMIN_PERMISSIONS) {
        set.add(key);
        grants.push({
          permission: key,
          scopeType: "branch",
          branchId: bm.branchId,
          sourceKind: "legacy-branch-admin",
          roleId: "system:branch_administrator",
          roleName: "Branch Administrator",
        });
      }
      branchSets.set(bm.branchId, set);
    }
  }

  for (const assignment of assignmentRows) {
    const def = roleById.get(assignment.roleId);
    if (!def) continue;
    if (assignment.scopeType === "national" && def.scope === "national") {
      for (const key of def.permissions) {
        nationalSet.add(key);
        grants.push({
          permission: key,
          scopeType: "national",
          sourceKind: "custom-role",
          roleId: def.roleId,
          roleName: def.name,
        });
      }
    } else if (
      assignment.scopeType === "branch" &&
      assignment.branchId &&
      def.scope === "branch"
    ) {
      const set =
        branchSets.get(assignment.branchId) ?? new Set<PermissionKey>();
      for (const key of def.permissions) {
        set.add(key);
        grants.push({
          permission: key,
          scopeType: "branch",
          branchId: assignment.branchId,
          sourceKind: "custom-role",
          roleId: def.roleId,
          roleName: def.name,
        });
      }
      branchSets.set(assignment.branchId, set);
    }
  }

  const branches: Record<string, PermissionKey[]> = {};
  for (const [bId, set] of branchSets.entries()) {
    branches[bId] = [...set];
  }

  return {
    national: [...nationalSet],
    branches,
    grants,
  };
}

export async function listRolesAndAssignments(db: Db): Promise<{
  roles: RoleDefinitionRecord[];
  assignments: RoleAssignmentRecord[];
  auditLog: Array<Record<string, unknown>>;
}> {
  const [customRoles, assignments, auditLog] = await Promise.all([
    db
      .collection<RoleDefinitionRecord>(RBAC_ROLES)
      .find({}, { projection: { _id: 0 } })
      .sort({ name: 1 })
      .toArray(),
    db
      .collection<RoleAssignmentRecord>(RBAC_ASSIGNMENTS)
      .find({}, { projection: { _id: 0 } })
      .sort({ assignedAt: -1 })
      .limit(200)
      .toArray(),
    db
      .collection(RBAC_AUDIT_LOG)
      .find({}, { projection: { _id: 0 } })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray(),
  ]);

  const systemRoles: RoleDefinitionRecord[] = SYSTEM_ROLE_DEFINITIONS.map(
    (r) => ({
      ...r,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    }),
  );

  return {
    roles: [
      ...systemRoles,
      ...customRoles.map(({ _id, ...role }: any) => role as RoleDefinitionRecord),
    ],
    assignments: assignments.map(({ _id, ...assignment }: any) => assignment as RoleAssignmentRecord),
    auditLog: auditLog.map(({ _id, ...entry }) => entry),
  };
}

export async function saveRoleDefinition(
  db: Db,
  actor: SessionUser,
  input: {
    roleId?: string;
    name: string;
    description?: string;
    scope: PermissionScope;
    permissions: unknown[];
  },
): Promise<RoleDefinitionRecord> {
  if (!hasPermission(actor, "roles.manage")) {
    throw new RbacError(
      "You do not have permission to manage roles.",
      403,
    );
  }

  const name = String(input.name ?? "").trim();
  if (name.length < 2 || name.length > 80) {
    throw new RbacError("Role name must be between 2 and 80 characters.", 400);
  }
  const description = String(input.description ?? "").trim().slice(0, 300);
  const scope: PermissionScope =
    input.scope === "branch" ? "branch" : "national";
  if (input.scope !== "national" && input.scope !== "branch") {
    throw new RbacError("Role scope must be 'national' or 'branch'.", 400);
  }

  const permissions = validatePermissionsForScope(
    Array.isArray(input.permissions) ? input.permissions : [],
    scope,
  );
  if (permissions.length === 0) {
    throw new RbacError("Select at least one permission for this role.", 400);
  }

  // Prevent privilege escalation: actor cannot create/edit a role granting permissions they do not hold
  for (const perm of permissions) {
    if (!hasPermission(actor, perm)) {
      throw new RbacError(
        `Cannot grant '${perm}' because you do not hold that permission.`,
        403,
      );
    }
  }

  const rawId = typeof input.roleId === "string" ? input.roleId.trim() : "";
  if (rawId && rawId.startsWith("system:")) {
    throw new RbacError("Built-in system roles cannot be modified.", 403);
  }

  const col = db.collection<RoleDefinitionRecord>(RBAC_ROLES);
  const now = new Date();

  if (rawId) {
    const existing = await col.findOne({ roleId: rawId });
    if (!existing) {
      throw new RbacError("Role definition not found.", 404);
    }
    if (existing.scope !== scope) {
      const activeCount = await db
        .collection(RBAC_ASSIGNMENTS)
        .countDocuments({ roleId: rawId, status: "active" });
      if (activeCount > 0) {
        throw new RbacError(
          "Cannot change a role's scope while it has active assignments.",
          409,
        );
      }
    }
    const updated: RoleDefinitionRecord = {
      ...existing,
      name,
      description,
      scope,
      permissions,
      updatedAt: now,
      updatedBy: actor.memberId,
    };
    await col.updateOne(
      { roleId: rawId },
      { $set: { name, description, scope, permissions, updatedAt: now, updatedBy: actor.memberId } },
    );
    await recordRbacAudit(db, {
      action: "role_updated",
      actorId: actor.memberId,
      actorName: actor.name,
      roleId: rawId,
      details: { name, scope, permissions },
    });
    return updated;
  }

  const roleId = `role_${randomUUID().slice(0, 12)}`;
  const created: RoleDefinitionRecord = {
    roleId,
    name,
    description,
    scope,
    permissions,
    isSystem: false,
    createdAt: now,
    updatedAt: now,
    updatedBy: actor.memberId,
  };
  await col.insertOne(created);
  await recordRbacAudit(db, {
    action: "role_created",
    actorId: actor.memberId,
    actorName: actor.name,
    roleId,
    details: { name, scope, permissions },
  });
  return created;
}

export async function assignRoleToMember(
  db: Db,
  actor: SessionUser,
  input: {
    memberId: string;
    roleId: string;
    branchId?: string | null;
  },
): Promise<RoleAssignmentRecord> {
  if (!hasPermission(actor, "roles.manage")) {
    throw new RbacError(
      "You do not have permission to assign roles.",
      403,
    );
  }

  const memberId = String(input.memberId ?? "").trim();
  const roleId = String(input.roleId ?? "").trim();
  const branchId = input.branchId ? String(input.branchId).trim() : null;
  if (!memberId || !roleId) {
    throw new RbacError("Choose a member and a role.", 400);
  }
  if (memberId === actor.memberId) {
    throw new RbacError("You cannot assign roles to yourself.", 403);
  }

  // Verify target member exists and is not disabled
  let targetUser: any = null;
  if (/^[a-f0-9]{24}$/.test(memberId)) {
    targetUser = await db
      .collection("user")
      .findOne({ _id: new ObjectId(memberId) });
  }
  if (!targetUser) {
    targetUser = await db.collection("user").findOne({ memberId });
  }
  if (!targetUser || targetUser.disabled === true) {
    throw new RbacError("Active member account not found.", 404);
  }

  const sysRole = SYSTEM_ROLE_DEFINITIONS.find((r) => r.roleId === roleId);
  const roleDef = sysRole
    ? { ...sysRole, createdAt: new Date(0), updatedAt: new Date(0) }
    : await db.collection<RoleDefinitionRecord>(RBAC_ROLES).findOne({ roleId });

  if (!roleDef) {
    throw new RbacError("Role definition not found.", 404);
  }
  if (roleDef.isSystem) {
    throw new RbacError(
      "Use Member or Branch administration for built-in legacy roles, or assign a custom role.",
      400,
    );
  }

  if (roleDef.scope === "branch") {
    if (!branchId) {
      throw new RbacError(
        "Select a recognised branch for a branch-scoped role.",
        400,
      );
    }
    const branch = await db
      .collection("branches")
      .findOne({ branchId, recognised: true });
    if (!branch) {
      throw new RbacError("Selected branch was not found or is not recognised.", 404);
    }
  } else if (branchId) {
    throw new RbacError(
      "A national-scoped role cannot be restricted to a single branch.",
      400,
    );
  }

  // Prevent privilege escalation: actor must hold every permission granted by the role
  for (const perm of roleDef.permissions) {
    if (!hasPermission(actor, perm, branchId ?? undefined)) {
      throw new RbacError(
        `Cannot assign role '${roleDef.name}' because it includes '${perm}', which you do not hold.`,
        403,
      );
    }
  }

  const col = db.collection<RoleAssignmentRecord>(RBAC_ASSIGNMENTS);
  const existing = await col.findOne({
    memberId,
    roleId,
    branchId: roleDef.scope === "branch" ? branchId : null,
    status: "active",
  });
  if (existing) {
    return existing;
  }

  const assignment: RoleAssignmentRecord = {
    assignmentId: `assign_${randomUUID().slice(0, 12)}`,
    memberId,
    roleId,
    scopeType: roleDef.scope,
    branchId: roleDef.scope === "branch" ? branchId : null,
    status: "active",
    assignedBy: actor.memberId,
    assignedAt: new Date(),
  };
  await col.insertOne(assignment);
  await recordRbacAudit(db, {
    action: "role_assigned",
    actorId: actor.memberId,
    actorName: actor.name,
    roleId,
    targetMemberId: memberId,
    branchId: assignment.branchId,
    details: { roleName: roleDef.name, scopeType: roleDef.scope },
  });
  return assignment;
}

export async function revokeRoleAssignment(
  db: Db,
  actor: SessionUser,
  input: { assignmentId: string; reason: string },
): Promise<void> {
  if (!hasPermission(actor, "roles.manage")) {
    throw new RbacError(
      "You do not have permission to revoke role assignments.",
      403,
    );
  }
  const assignmentId = String(input.assignmentId ?? "").trim();
  const reason = String(input.reason ?? "").trim().slice(0, 500);
  if (!assignmentId) {
    throw new RbacError("Assignment ID is required.", 400);
  }
  if (reason.length < 3) {
    throw new RbacError("Give a short reason for revoking this role (at least 3 characters).", 400);
  }

  const col = db.collection<RoleAssignmentRecord>(RBAC_ASSIGNMENTS);
  const existing = await col.findOne({ assignmentId, status: "active" });
  if (!existing) {
    throw new RbacError("Active role assignment not found.", 404);
  }
  if (existing.memberId === actor.memberId) {
    throw new RbacError("You cannot revoke your own role assignment.", 403);
  }

  const now = new Date();
  await col.updateOne(
    { assignmentId, status: "active" },
    {
      $set: {
        status: "revoked",
        revokedBy: actor.memberId,
        revokedAt: now,
        revocationReason: reason,
      },
    },
  );
  await recordRbacAudit(db, {
    action: "role_revoked",
    actorId: actor.memberId,
    actorName: actor.name,
    roleId: existing.roleId,
    targetMemberId: existing.memberId,
    branchId: existing.branchId,
    details: { assignmentId, reason },
  });
}

export async function deleteCustomRole(
  db: Db,
  actor: SessionUser,
  roleId: string,
): Promise<void> {
  if (!hasPermission(actor, "roles.manage")) {
    throw new RbacError("You do not have permission to delete roles.", 403);
  }
  const id = String(roleId ?? "").trim();
  if (!id || id.startsWith("system:")) {
    throw new RbacError("Built-in system roles cannot be deleted.", 403);
  }
  const activeCount = await db
    .collection(RBAC_ASSIGNMENTS)
    .countDocuments({ roleId: id, status: "active" });
  if (activeCount > 0) {
    throw new RbacError(
      "Revoke all active assignments for this role before deleting it.",
      409,
    );
  }
  const result = await db.collection(RBAC_ROLES).deleteOne({ roleId: id });
  if (result.deletedCount === 0) {
    throw new RbacError("Custom role not found.", 404);
  }
  await recordRbacAudit(db, {
    action: "role_deleted",
    actorId: actor.memberId,
    actorName: actor.name,
    roleId: id,
    details: {},
  });
}
