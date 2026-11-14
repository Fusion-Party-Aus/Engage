import type { APIRoute } from "astro";
import { getSessionUser } from "../../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import { createAmendmentRevision } from "../../../../lib/amendments.ts";
import { hasPermission, hasPermissionAnywhere } from "../../../../lib/rbac.ts";
export const prerender = false;
export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user)
    return Response.json({ error: "Sign in required." }, { status: 401 });
  if (!user.isAdmin && !user.isBranchAdmin && !hasPermissionAnywhere(user, "amendments.resolve"))
    return Response.json(
      { error: "Administrator access required." },
      { status: 403 },
    );
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const amendmentId = String(body.amendmentId ?? "");
    const outcome = String(body.outcome ?? "");
    const reason =
      typeof body.reason === "string" ? body.reason.trim().slice(0, 1000) : "";
    if (
      !amendmentId ||
      !["ready", "rejected", "withdrawn"].includes(outcome) ||
      !reason
    )
      return Response.json(
        {
          error:
            "amendmentId, an explicit review outcome, and a reason are required.",
        },
        { status: 400 },
      );
    const db = await getDatabase(env);
    const col = db.collection("amendments");
    const amendment = await col.findOne({
      amendmentId,
      status: { $in: ["proposed", "stale", "conflict"] },
    });
    if (!amendment)
      return Response.json(
        { error: "Amendment is missing or already resolved." },
        { status: 409 },
      );
    const proposal = await db
      .collection("proposals")
      .findOne({ proposalId: amendment.proposalId });
    if (
      (!user.isAdmin && !proposal) ||
      (proposal &&
        !hasPermission(user, "amendments.resolve", proposal.originatingBranchId))
    )
      return Response.json(
        {
          error:
            "You are not authorised to resolve amendments for this proposal.",
        },
        { status: 403 },
      );
    const set: Record<string, unknown> = {
      status: outcome,
      resolution: {
        outcome,
        reason,
        resolvedBy: user.memberId,
        resolvedAt: new Date(),
      },
    };
    if (outcome === "ready") {
      const latest = await db
        .collection("proposal_revisions")
        .find({ proposalId: amendment.proposalId })
        .sort({ createdAt: -1 })
        .limit(1)
        .toArray();
      if (!latest[0])
        return Response.json(
          { error: "Current proposal revision not found." },
          { status: 409 },
        );
      let changes = amendment.changes as Record<string, unknown>;
      if (amendment.status === "conflict") {
        const resolutionChanges =
          body.changes &&
          typeof body.changes === "object" &&
          !Array.isArray(body.changes)
            ? (body.changes as Record<string, unknown>)
            : null;
        if (!resolutionChanges)
          return Response.json(
            {
              error:
                "Overlapping amendment fields require explicit replacement changes to resolve.",
            },
            { status: 409 },
          );
        if (
          !Object.keys(resolutionChanges).length ||
          Object.keys(resolutionChanges).some(
            (field) =>
              !["title", "summary", "details", "outcomes"].includes(field),
          )
        )
          return Response.json(
            {
              error: "Provide resolved changes using supported content fields.",
            },
            { status: 400 },
          );
        changes = resolutionChanges;
      }
      const parentRevisionId =
        typeof amendment.currentRevisionId === "string"
          ? amendment.currentRevisionId
          : null;
      const revisionId = await createAmendmentRevision(
        db,
        amendmentId,
        changes,
        user.memberId,
        parentRevisionId,
      );
      set.changes = changes;
      set.fields = Object.keys(changes);
      set.baseRevisionId = latest[0].revisionId;
      set.currentRevisionId = revisionId;
      set.conflicts = [];
      set.rebasedFromRevisionId = amendment.baseRevisionId;
    }
    const result = await col.updateOne(
      {
        amendmentId,
        status: amendment.status,
        baseRevisionId: amendment.baseRevisionId,
      },
      { $set: set },
    );
    if (!result.modifiedCount)
      return Response.json(
        { error: "Amendment is missing or already resolved." },
        { status: 409 },
      );
    return Response.json({ ok: true, outcome });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not resolve amendment.",
      },
      { status: 400 },
    );
  }
};
