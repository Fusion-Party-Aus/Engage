import type { APIRoute } from "astro";
import { getSessionUser } from "../../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import { PERMISSION_CATALOGUE, hasPermission } from "../../../../lib/rbac.ts";
import {
  RbacError,
  assignRoleToMember,
  deleteCustomRole,
  listRolesAndAssignments,
  resolveMemberEffectivePermissions,
  revokeRoleAssignment,
  saveRoleDefinition,
} from "../../../../lib/roles-store.ts";

export const prerender = false;
const headers = { "cache-control": "private, no-store" };

function handleRbacError(error: unknown) {
  if (error instanceof RbacError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  return Response.json(
    {
      error:
        error instanceof Error
          ? error.message
          : "Could not complete role operation.",
    },
    { status: 400 },
  );
}

export const GET: APIRoute = async ({ request, url, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user) {
    return Response.json({ error: "Sign in required." }, { status: 401 });
  }
  if (!hasPermission(user, "roles.manage")) {
    return Response.json(
      { error: "Role management permission required." },
      { status: 403 },
    );
  }
  const db = await getDatabase(env);
  const memberId = (url.searchParams.get("memberId") ?? "").trim();
  const [data, effective] = await Promise.all([
    listRolesAndAssignments(db),
    memberId
      ? resolveMemberEffectivePermissions(db, memberId)
      : Promise.resolve(null),
  ]);
  return Response.json(
    {
      catalogue: PERMISSION_CATALOGUE,
      ...data,
      ...(effective ? { effectivePermissions: effective } : {}),
    },
    { headers },
  );
};

export const POST: APIRoute = async ({ request, url, locals }) => {
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) {
    return Response.json(
      { error: "Cross-site requests are not allowed." },
      { status: 403 },
    );
  }
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user) {
    return Response.json({ error: "Sign in required." }, { status: 401 });
  }
  if (!hasPermission(user, "roles.manage")) {
    return Response.json(
      { error: "Role management permission required." },
      { status: 403 },
    );
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const action = String(body.action ?? "").trim();
    const db = await getDatabase(env);

    if (action === "save_role") {
      const role = await saveRoleDefinition(db, user, {
        roleId: typeof body.roleId === "string" ? body.roleId : undefined,
        name: String(body.name ?? ""),
        description:
          typeof body.description === "string" ? body.description : "",
        scope: body.scope === "branch" ? "branch" : "national",
        permissions: Array.isArray(body.permissions) ? body.permissions : [],
      });
      return Response.json(
        { role },
        { status: body.roleId ? 200 : 201, headers },
      );
    }

    if (action === "assign_role") {
      const assignment = await assignRoleToMember(db, user, {
        memberId: String(body.memberId ?? ""),
        roleId: String(body.roleId ?? ""),
        branchId: typeof body.branchId === "string" ? body.branchId : null,
      });
      return Response.json({ assignment }, { status: 201, headers });
    }

    return Response.json(
      { error: "Choose a valid role action ('save_role' or 'assign_role')." },
      { status: 400 },
    );
  } catch (error) {
    return handleRbacError(error);
  }
};

export const DELETE: APIRoute = async ({ request, url, locals }) => {
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) {
    return Response.json(
      { error: "Cross-site requests are not allowed." },
      { status: 403 },
    );
  }
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user) {
    return Response.json({ error: "Sign in required." }, { status: 401 });
  }
  if (!hasPermission(user, "roles.manage")) {
    return Response.json(
      { error: "Role management permission required." },
      { status: 403 },
    );
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const db = await getDatabase(env);
    if (body.assignmentId) {
      await revokeRoleAssignment(db, user, {
        assignmentId: String(body.assignmentId),
        reason: String(body.reason ?? ""),
      });
      return Response.json({ ok: true }, { headers });
    }
    if (body.roleId) {
      await deleteCustomRole(db, user, String(body.roleId));
      return Response.json({ ok: true }, { headers });
    }
    return Response.json(
      { error: "Provide assignmentId or roleId." },
      { status: 400 },
    );
  } catch (error) {
    return handleRbacError(error);
  }
};
