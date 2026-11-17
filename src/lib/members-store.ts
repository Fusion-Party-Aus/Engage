import { ObjectId, type Db } from "mongodb";
import { validPersonName } from "./auth.ts";
import { recordLifecycle } from "./member-lifecycle.ts";
import {
  ALL_NATIONAL_PERMISSIONS,
  LEGACY_MODERATOR_PERMISSIONS,
  canGrantPermissionSet,
  hasPermission,
  normalisePlatformRoles,
  primaryPlatformRole,
} from "./rbac.ts";
import { RBAC_ASSIGNMENTS, RBAC_ROLES } from "./roles-store.ts";
import type { MemberRecord, MembershipStatus, SessionUser, UserRole } from "./types.ts";
import { promotePendingVotePreferences } from "./voting-store.ts";

export async function listMembers(
  db: Db,
  search = "",
): Promise<MemberRecord[]> {
  const [
    users,
    roles,
    memberships,
    branchMemberships,
    assignments,
    roleDefinitions,
    branches,
  ] = await Promise.all([
    db.collection("user").find({}).sort({ createdAt: -1 }).toArray(),
    db
      .collection<{ memberId: string; role: UserRole }>("application_roles")
      .find({})
      .toArray(),
    db
      .collection<{
        memberId: string;
        status: MembershipStatus;
      }>("memberships")
      .find({})
      .toArray(),
    db
      .collection<{
        memberId: string;
        branchId: string;
        branchRole?: string;
        status: string;
      }>("branch_memberships")
      .find({ status: "active", branchRole: "administrator" })
      .toArray(),
    db
      .collection<{
        memberId: string;
        roleId: string;
        branchId?: string | null;
        status: string;
      }>(RBAC_ASSIGNMENTS)
      .find({ status: "active" })
      .toArray(),
    db
      .collection<{ roleId: string; name: string }>(RBAC_ROLES)
      .find({})
      .toArray(),
    db
      .collection<{ branchId: string; name: string }>("branches")
      .find({})
      .toArray(),
  ]);

  const rolesMap = new Map<string, UserRole[]>();
  for (const r of roles) {
    const list = rolesMap.get(r.memberId) ?? [];
    if (!list.includes(r.role)) list.push(r.role);
    rolesMap.set(r.memberId, list);
  }
  const statusMap = new Map<string, MembershipStatus>(
    memberships.map((m) => [m.memberId, m.status]),
  );
  const branchNameById = new Map(
    branches.map((branch) => [branch.branchId, branch.name]),
  );
  const roleNameById = new Map(
    roleDefinitions.map((role) => [role.roleId, role.name]),
  );
  const branchAdministratorOf = new Map<string, string[]>();
  for (const membership of branchMemberships) {
    const list = branchAdministratorOf.get(membership.memberId) ?? [];
    list.push(
      branchNameById.get(membership.branchId) ?? membership.branchId,
    );
    branchAdministratorOf.set(membership.memberId, list);
  }
  const delegatedRoles = new Map<string, string[]>();
  for (const assignment of assignments) {
    const name = roleNameById.get(assignment.roleId) ?? assignment.roleId;
    const branch = assignment.branchId
      ? branchNameById.get(assignment.branchId) ?? assignment.branchId
      : null;
    const label = branch ? `${name} — ${branch}` : name;
    const list = delegatedRoles.get(assignment.memberId) ?? [];
    list.push(label);
    delegatedRoles.set(assignment.memberId, list);
  }
  const q = search.trim().toLowerCase();

  return users
    .map((u) => {
      const memberId = String(u._id);
      const platformRoles = normalisePlatformRoles(
        rolesMap.get(memberId) ?? [],
      );
      return {
        memberId,
        name: String(u.name ?? ""),
        email: String(u.email ?? ""),
        role: primaryPlatformRole(platformRoles),
        roles: platformRoles,
        status: statusMap.get(memberId) ?? "pending",
        disabled: Boolean(u.disabled),
        emailVerified: Boolean(u.emailVerified),
        createdAt: u.createdAt instanceof Date ? u.createdAt : undefined,
        ...(branchAdministratorOf.has(memberId)
          ? { branchAdministratorOf: branchAdministratorOf.get(memberId) }
          : {}),
        ...(delegatedRoles.has(memberId)
          ? { delegatedRoles: delegatedRoles.get(memberId) }
          : {}),
      };
    })
    .filter(
      (m) =>
        !q ||
        `${m.name} ${m.email} ${m.role} ${(m.roles ?? []).join(" ")} ${m.status} ${(m.delegatedRoles ?? []).join(" ")} ${(m.branchAdministratorOf ?? []).join(" ")}`
          .toLowerCase()
          .includes(q),
    );
}

export async function saveMember(
  db: Db,
  actor: SessionUser,
  body: Record<string, unknown>,
  create = false,
): Promise<{ memberId: string }> {
  const changingMembership =
    create ||
    body.name !== undefined ||
    body.status !== undefined ||
    body.disabled !== undefined;
  const rolesProvided = body.roles !== undefined;
  const roleProvided = body.role !== undefined;
  const changingRole = rolesProvided || roleProvided;
  if (changingMembership && !hasPermission(actor, "members.verify")) {
    throw new Error("Member verification permission required.");
  }
  if (changingRole && !hasPermission(actor, "roles.manage")) {
    throw new Error(
      "Role management permission is required to change a platform role.",
    );
  }
  if (!changingMembership && !changingRole) {
    throw new Error("Choose a membership or role change.");
  }

  const name = body.name === undefined ? undefined : validPersonName(body.name);
  if (name === null || (create && !name)) {
    throw new Error("Enter a full name (2–100 characters).");
  }

  let requestedRoles: UserRole[] | undefined;
  if (rolesProvided) {
    if (!Array.isArray(body.roles)) {
      throw new Error("Choose a valid set of platform roles.");
    }
    requestedRoles = normalisePlatformRoles(body.roles);
    if (roleProvided) {
      const single = normalisePlatformRoles([String(body.role)]);
      if (single.join(",") !== requestedRoles.join(",")) {
        throw new Error("Choose one set of platform roles.");
      }
    }
  } else if (roleProvided) {
    requestedRoles = normalisePlatformRoles([String(body.role)]);
  }

  // Anti-escalation: a delegated role manager cannot promote anyone into a
  // system role whose permissions they do not personally hold.
  const actorIsNationalAdministrator = canGrantPermissionSet(
    actor,
    ALL_NATIONAL_PERMISSIONS,
  );
  if (
    requestedRoles?.includes("administrator") &&
    !actorIsNationalAdministrator
  ) {
    throw new Error(
      "You cannot grant National Administrator because you do not hold all national permissions.",
    );
  }
  if (
    requestedRoles?.includes("moderator") &&
    !canGrantPermissionSet(actor, LEGACY_MODERATOR_PERMISSIONS)
  ) {
    throw new Error(
      "You cannot grant Moderator because you do not hold all moderator permissions.",
    );
  }

  const status = body.status !== undefined ? String(body.status) : undefined;
  if (
    status !== undefined &&
    !["pending", "verified", "suspended"].includes(status)
  ) {
    throw new Error("Choose a valid membership status.");
  }

  const disabled =
    body.disabled !== undefined ? Boolean(body.disabled) : undefined;
  const users = db.collection("user");
  const now = new Date();
  let memberId: string;

  if (create) {
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("Enter a valid email address.");
    }
    if (await users.findOne({ email })) {
      throw new Error("An account with that email already exists.");
    }
    const saved = await users.insertOne({
      name,
      email,
      emailVerified: false,
      disabled: disabled === true,
      createdAt: now,
      updatedAt: now,
    });
    memberId = saved.insertedId.toString();
    await recordLifecycle(db, memberId, "registration_completed", now);
    await recordLifecycle(db, memberId, "verification_requested", now);
  } else {
    if (
      typeof body.memberId !== "string" ||
      !/^[a-f0-9]{24}$/.test(body.memberId)
    ) {
      throw new Error("Choose a valid member account.");
    }
    memberId = body.memberId;
    if (!(await users.findOne({ _id: new ObjectId(memberId) }))) {
      throw new Error("Account not found.");
    }
    const targetRoles = await db
      .collection<{ role: UserRole }>("application_roles")
      .find({ memberId })
      .toArray();
    const targetIsAdministrator = targetRoles.some(
      (row) => row.role === "administrator",
    );
    if (targetIsAdministrator && !actorIsNationalAdministrator) {
      throw new Error(
        "Only a national administrator can change a national administrator account.",
      );
    }
    if (
      memberId === actor.memberId &&
      (disabled === true ||
        (actorIsNationalAdministrator &&
          requestedRoles !== undefined &&
          !requestedRoles.includes("administrator")) ||
        (status !== undefined && status !== "verified"))
    ) {
      throw new Error("You cannot remove your own administrator access.");
    }
    await users.updateOne(
      { _id: new ObjectId(memberId) },
      {
        $set: {
          ...(name ? { name } : {}),
          ...(disabled !== undefined ? { disabled } : {}),
          updatedAt: now,
        },
      },
    );
  }

  if (requestedRoles !== undefined) {
    const roleCollection = db.collection("application_roles");
    const desired = requestedRoles.filter((item) => item !== "member");
    const desiredSet = new Set<string>(desired);
    const existingRoles = await roleCollection.find({ memberId }).toArray();
    for (const row of existingRoles) {
      if (!desiredSet.has(String(row.role))) {
        await roleCollection.deleteOne({ _id: row._id });
      }
    }
    for (const role of desired) {
      await roleCollection.updateOne(
        { memberId, role },
        {
          $setOnInsert: {
            memberId,
            role,
            grantedAt: now,
            grantedBy: actor.memberId,
          },
        },
        { upsert: true },
      );
    }
  }

  if (status !== undefined) {
    const previous = await db.collection("memberships").findOne({ memberId });
    await db.collection("memberships").updateOne(
      { memberId },
      {
        $set: {
          memberId,
          status,
          ...(status === "verified" && previous?.status !== "verified"
            ? {
                verifiedAt: now,
                verifiedBy: actor.memberId,
                verificationSource: "manual-admin",
              }
            : {}),
          updatedAt: now,
          updatedBy: actor.memberId,
        },
      },
      { upsert: true },
    );
    if (status === "verified" && previous?.status !== "verified") {
      await recordLifecycle(db, memberId, "verification_approved", now);
    }
    if (status === "verified" && disabled !== true) {
      await promotePendingVotePreferences(db, memberId);
    }
  }

  if (status === "pending") {
    try {
      const { enqueueVerificationAttempt } = await import(
        "./membership-verification.ts"
      );
      await enqueueVerificationAttempt(db, memberId, {
        source: "admin-pending",
        force: true,
      });
    } catch (error) {
      const { logOperationalEvent } = await import("./resilience.ts");
      logOperationalEvent("error", "verification_queue_failed", {
        code: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  if (disabled === true) {
    await db
      .collection("session")
      .deleteMany({ userId: { $in: [memberId, new ObjectId(memberId)] } });
  }

  return { memberId };
}
