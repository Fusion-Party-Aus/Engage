import type { APIRoute } from "astro";
import { getSessionUser, canAdministerBranch } from "../../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import { branchesWithPermission } from "../../../../lib/rbac.ts";
import {
  BranchParticipationError,
  countBranchParticipation,
  listBranchPeople,
  revokeBranchMember,
  verifyBranchMember,
} from "../../../../lib/branch-participation.ts";
import { listMembers } from "../../../../lib/store.ts";

export const prerender = false;

async function admin(request: Request, locals: unknown) {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  return { env, user };
}

function errorResponse(error: unknown) {
  if (error instanceof BranchParticipationError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status },
    );
  }
  return Response.json(
    {
      error:
        error instanceof Error
          ? error.message
          : "Could not complete this branch change.",
    },
    { status: 400 },
  );
}

/**
 * People in the branches this administrator can manage. The response keeps the
 * original `memberships` array for existing clients and adds the combined
 * follower/member view used by the branch governance workspace.
 */
export const GET: APIRoute = async ({ request, url, locals }) => {
  const { env, user } = await admin(request, locals);
  if (!user)
    return Response.json({ error: "Sign in required." }, { status: 401 });
  const scoped = branchesWithPermission(user, "branches.verify_members");
  if (!scoped.national && scoped.branchIds.length === 0)
    return Response.json(
      { error: "Branch administrator access required." },
      { status: 403 },
    );
  const branchId = url.searchParams.get("branchId") ?? "";
  const memberId = url.searchParams.get("memberId") ?? "";
  const search = (url.searchParams.get("q") ?? "").trim().slice(0, 120);
  if (branchId && !canAdministerBranch(user, branchId))
    return Response.json(
      { error: "You are not authorised to view this branch." },
      { status: 403 },
    );
  const db = await getDatabase(env);
  const branchIds = branchId
    ? [branchId]
    : scoped.national
      ? (
          await db
            .collection("branches")
            .find({})
            .project({ branchId: 1 })
            .toArray()
        ).map((row: any) => String(row.branchId))
      : scoped.branchIds;

  const filter: Record<string, unknown> = { status: "active" };
  if (branchId) filter.branchId = branchId;
  else if (!scoped.national) filter.branchId = { $in: branchIds };
  if (memberId) filter.memberId = memberId;
  const [rows, members, people, counts] = await Promise.all([
    db
      .collection("branch_memberships")
      .find(filter)
      .sort({ assignedAt: -1 })
      .limit(2000)
      .toArray(),
    listMembers(db, ""),
    listBranchPeople(db, branchIds, search),
    countBranchParticipation(db, branchIds),
  ]);
  const memberById = new Map(members.map((member) => [member.memberId, member]));
  const headers = { "cache-control": "private, no-store" };
  return Response.json(
    {
      memberships: rows.map((row: any) => ({
        branchId: row.branchId,
        memberId: row.memberId,
        branchRole: row.branchRole ?? "member",
        assignedAt: row.assignedAt,
        name: memberById.get(row.memberId)?.name ?? "",
        email: memberById.get(row.memberId)?.email ?? "",
      })),
      people: memberId
        ? people.filter((person) => person.memberId === memberId)
        : people,
      counts: Object.fromEntries(counts),
    },
    { headers },
  );
};

export const POST: APIRoute = async ({ request, locals }) => {
  const { env, user } = await admin(request, locals);
  if (!user)
    return Response.json({ error: "Sign in required." }, { status: 401 });
  if (!user.isAdmin && !user.isBranchAdmin)
    return Response.json(
      { error: "Branch administrator access required." },
      { status: 403 },
    );
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const branchId = String(body.branchId ?? "");
    const memberId = String(body.memberId ?? "");
    if (!branchId || !memberId)
      return Response.json(
        { error: "Choose a branch and a person." },
        { status: 400 },
      );
    const branchRole =
      body.branchRole === "administrator" ? "administrator" : "member";
    const db = await getDatabase(env);
    const existing = await db
      .collection("branch_memberships")
      .findOne({ branchId, memberId });
    const membership = await verifyBranchMember(db, user, {
      branchId,
      memberId,
      branchRole,
      reason:
        typeof body.reason === "string" ? body.reason.slice(0, 500) : undefined,
    });
    return Response.json(
      { membership },
      { status: existing?.status === "active" ? 200 : 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  const { env, user } = await admin(request, locals);
  if (!user)
    return Response.json({ error: "Sign in required." }, { status: 401 });
  if (!user.isAdmin && !user.isBranchAdmin)
    return Response.json(
      { error: "Branch administrator access required." },
      { status: 403 },
    );
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const branchId = String(body.branchId ?? "");
    const memberId = String(body.memberId ?? "");
    const reason =
      typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
    const db = await getDatabase(env);
    await revokeBranchMember(db, user, { branchId, memberId, reason });
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
};
