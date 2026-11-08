import type { APIRoute } from "astro";
import { randomUUID } from "node:crypto";
import { getSessionUser } from "../../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import { canAdministerBranch } from "../../../../lib/auth.ts";
import { promotePendingVotePreferences } from "../../../../lib/store.ts";
export const prerender = false;
async function admin(request: Request, locals: unknown) {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  return { env, user };
}
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
        { error: "branchId and memberId are required." },
        { status: 400 },
      );
    if (!canAdministerBranch(user, branchId))
      return Response.json(
        {
          error: "You are not authorised to manage membership for this branch.",
        },
        { status: 403 },
      );
    if (
      body.branchRole !== undefined &&
      !["member", "administrator"].includes(String(body.branchRole))
    )
      return Response.json(
        { error: "Choose Member or Branch administrator." },
        { status: 400 },
      );
    const branchRole =
      body.branchRole === "administrator" ? "administrator" : "member";
    if (branchRole === "administrator" && !user.isAdmin)
      return Response.json(
        {
          error:
            "Only a national administrator can delegate branch administrator access.",
        },
        { status: 403 },
      );
    const db = await getDatabase(env);
    const branch = await db.collection("branches").findOne({ branchId });
    if (!branch)
      return Response.json({ error: "Branch not found." }, { status: 404 });
    if (branchRole === "administrator" && branch.recognised !== true)
      return Response.json(
        {
          error:
            "Branch administrator access can only be delegated for a recognised branch.",
        },
        { status: 409 },
      );
    if (
      !(await db
        .collection("memberships")
        .findOne({ memberId, status: "verified" }))
    )
      return Response.json(
        { error: "Verified platform membership is required first." },
        { status: 409 },
      );
    const record = {
      branchId,
      memberId,
      status: "active",
      branchRole,
      assignedBy: user.memberId,
      assignedAt: new Date(),
    };
    const existing = await db
      .collection("branch_memberships")
      .findOne({ branchId, memberId });
    if (!user.isAdmin && existing?.branchRole === "administrator")
      return Response.json(
        {
          error:
            "Only a national administrator can change a branch administrator assignment.",
        },
        { status: 403 },
      );
    if (
      existing?.status === "active" &&
      (existing.branchRole ?? "member") === branchRole
    )
      return Response.json({ membership: existing }, { status: 200 });
    const filter: Record<string, unknown> = { branchId, memberId };
    if (existing) filter.status = existing.status ?? { $exists: false };
    if (!user.isAdmin) filter.branchRole = { $ne: "administrator" };
    const updated = await db
      .collection("branch_memberships")
      .updateOne(filter, { $set: record }, { upsert: !existing });
    if (existing && !updated.matchedCount)
      return Response.json(
        {
          error:
            "Membership changed while you were editing it. Reload and try again.",
        },
        { status: 409 },
      );
    await db
      .collection("branch_membership_events")
      .insertOne({
        eventId: randomUUID(),
        branchId,
        memberId,
        action: existing?.status === "active" ? "role-changed" : "assigned",
        actorId: user.memberId,
        before: existing ?? null,
        after: record,
        createdAt: record.assignedAt,
      });
    await promotePendingVotePreferences(db, memberId);
    return Response.json(
      { membership: record },
      { status: existing?.status === "active" ? 200 : 201 },
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not assign branch membership.",
      },
      { status: 400 },
    );
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
    if (!canAdministerBranch(user, branchId))
      return Response.json(
        {
          error: "You are not authorised to manage membership for this branch.",
        },
        { status: 403 },
      );
    const db = await getDatabase(env);
    const membership = await db
      .collection("branch_memberships")
      .findOne({ branchId, memberId, status: "active" });
    if (membership?.branchRole === "administrator" && !user.isAdmin)
      return Response.json(
        {
          error:
            "Only a national administrator can revoke delegated branch administrator access.",
        },
        { status: 403 },
      );
    const before = membership;
    const revokedAt = new Date();
    const filter: Record<string, unknown> = {
      branchId,
      memberId,
      status: "active",
    };
    if (!user.isAdmin) filter.branchRole = { $ne: "administrator" };
    const result = await db
      .collection("branch_memberships")
      .updateOne(filter, {
        $set: { status: "revoked", revokedBy: user.memberId, revokedAt },
      });
    if (!result.modifiedCount)
      return Response.json(
        { error: "Active branch membership not found." },
        { status: 404 },
      );
    await db
      .collection("branch_membership_events")
      .insertOne({
        eventId: randomUUID(),
        branchId,
        memberId,
        action: "revoked",
        actorId: user.memberId,
        before,
        after: {
          ...before,
          status: "revoked",
          revokedBy: user.memberId,
          revokedAt,
        },
        createdAt: revokedAt,
      });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not revoke branch membership.",
      },
      { status: 400 },
    );
  }
};
