import type { APIRoute } from "astro";
import { getSessionUser } from "../../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import { saveProposal } from "../../../../lib/store.ts";
import { hasPermission, hasPermissionAnywhere } from "../../../../lib/rbac.ts";
import {
  amendmentsCompete,
  validateWordingChanges,
} from "../../../../lib/amendment-suggestions.ts";
export const prerender = false;
export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user)
    return Response.json({ error: "Sign in required." }, { status: 401 });
  if (!user.isAdmin && !user.isBranchAdmin && !hasPermissionAnywhere(user, "amendments.apply"))
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
      !hasPermission(user, "amendments.apply", proposal.originatingBranchId)
    )
      return Response.json(
        {
          error: "You are not authorised to apply amendments to this proposal.",
        },
        { status: 403 },
      );
    const changes = amendment.changes as Record<string, unknown>;
    const wordingErrors = validateWordingChanges(changes);
    if (wordingErrors.length)
      return Response.json({ error: wordingErrors[0] }, { status: 400 });

    // A warning is not a safeguard. Refuse to apply an amendment that changes
    // the same block as an amendment already applied. The officer still needs
    // to record the precedence decision required by #34.
    const appliedCompetitors = (await db
      .collection("amendments")
      .find({
        proposalId: amendment.proposalId,
        amendmentId: { $ne: amendmentId },
        status: "applied",
      })
      .toArray()) as any[];
    if (appliedCompetitors.some((other) => amendmentsCompete(amendment as any, other)))
      return Response.json(
        {
          error:
            "Another applied amendment changes the same wording. Record an explicit precedence decision before applying this amendment.",
        },
        { status: 409 },
      );

    const updated = await saveProposal(
      db,
      user,
      {
        proposalId: amendment.proposalId,
        ...changes,
      },
      { allowAmendmentApply: true },
    );
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
