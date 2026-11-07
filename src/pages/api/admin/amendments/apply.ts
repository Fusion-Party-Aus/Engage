import type { APIRoute } from "astro";
import { getSessionUser } from "../../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import { saveProposal } from "../../../../lib/store.ts";
import { canManageBranchProposal } from "../../../../lib/auth.ts";
export const prerender = false;
export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user)
    return Response.json({ error: "Sign in required." }, { status: 401 });
  if (!user.isAdmin && !user.isBranchAdmin)
    return Response.json(
      { error: "Administrator access required." },
      { status: 403 },
    );
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const amendmentId = String(body.amendmentId ?? "");
    const db = await getDatabase(env);
    const amendment = await db
      .collection("amendments")
      .findOne({ amendmentId, status: "accepted" });
    if (!amendment)
      return Response.json(
        { error: "Accepted amendment not found." },
        { status: 404 },
      );
    const latestRows = await db
      .collection("proposal_revisions")
      .find({ proposalId: amendment.proposalId })
      .sort({ createdAt: -1 })
      .limit(1)
      .toArray();
    if (latestRows[0]?.revisionId !== amendment.baseRevisionId)
      return Response.json(
        {
          error:
            "Amendment base revision is stale. Resolve the conflict against the current wording first.",
        },
        { status: 409 },
      );
    const proposal = await db
      .collection("proposals")
      .findOne({ proposalId: amendment.proposalId });
    if (!proposal || !["propose", "deliberate"].includes(proposal.stage))
      return Response.json(
        { error: "Amendment cannot be applied after Decide begins." },
        { status: 409 },
      );
    if (
      !canManageBranchProposal(user, {
        originatingBranchId: proposal.originatingBranchId,
      })
    )
      return Response.json(
        {
          error: "You are not authorised to apply amendments to this proposal.",
        },
        { status: 403 },
      );
    const changes = amendment.changes as Record<string, unknown>;
    if (
      "title" in changes &&
      (typeof changes.title !== "string" ||
        changes.title.trim().length < 4 ||
        changes.title.trim().length > 200)
    )
      return Response.json(
        { error: "Amendment title must be 4–200 characters." },
        { status: 400 },
      );
    if (
      "summary" in changes &&
      (typeof changes.summary !== "string" ||
        changes.summary.trim().length < 10 ||
        changes.summary.trim().length > 2000)
    )
      return Response.json(
        { error: "Amendment summary must be 10–2,000 characters." },
        { status: 400 },
      );
    if ("details" in changes && typeof changes.details !== "string")
      return Response.json(
        { error: "Amendment details must be text." },
        { status: 400 },
      );
    if (
      "outcomes" in changes &&
      (!Array.isArray(changes.outcomes) ||
        changes.outcomes.some((v) => typeof v !== "string"))
    )
      return Response.json(
        { error: "Amendment outcomes must be a list of text." },
        { status: 400 },
      );
    const updated = await saveProposal(db, user, {
      proposalId: amendment.proposalId,
      ...changes,
    });
    const latest = await db
      .collection("proposal_revisions")
      .find({ proposalId: amendment.proposalId })
      .sort({ createdAt: -1 })
      .limit(1)
      .toArray();
    const result = await db
      .collection("amendments")
      .updateOne(
        {
          amendmentId,
          status: "accepted",
          baseRevisionId: amendment.baseRevisionId,
        },
        {
          $set: {
            status: "applied",
            appliedRevisionId: latest[0]?.revisionId,
            appliedBy: user.memberId,
            appliedAt: new Date(),
          },
        },
      );
    if (!result.modifiedCount)
      return Response.json(
        {
          error:
            "Amendment state changed while applying; review proposal history.",
        },
        { status: 409 },
      );
    return Response.json({
      proposal: updated,
      appliedRevisionId: latest[0]?.revisionId,
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Could not apply amendment.",
      },
      { status: 400 },
    );
  }
};
