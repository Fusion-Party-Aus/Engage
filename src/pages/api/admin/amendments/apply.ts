import type { APIRoute } from "astro";
import { randomUUID } from "node:crypto";
import { getSessionUser } from "../../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import { saveProposal } from "../../../../lib/proposals-store.ts";
import { hasPermission, hasPermissionAnywhere } from "../../../../lib/rbac.ts";
import {
  amendmentsCompete,
  validateWordingChanges,
} from "../../../../lib/amendment-suggestions.ts";

const APPLY_RECOVERY_MS = 60_000;
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
      .findOne({ amendmentId, status: { $in: ["accepted", "applying"] } });
    if (!amendment)
      return Response.json(
        { error: "Accepted amendment not found." },
        { status: 404 },
      );
    const recovering = amendment.status === "applying";
    if (recovering) {
      if (!amendment.applyingToken)
        return Response.json(
          {
            error:
              "This amendment is in an incomplete application state without a recovery token. Review the proposal history before continuing.",
          },
          { status: 409 },
        );
      const startedAt = amendment.applyingStartedAt
        ? new Date(amendment.applyingStartedAt).getTime()
        : 0;
      if (Date.now() - startedAt < APPLY_RECOVERY_MS)
        return Response.json(
          {
            error:
              "This amendment is already being applied. Wait a moment and retry if it did not finish.",
          },
          { status: 409 },
        );
    }
    const latestRows = await db
      .collection("proposal_revisions")
      .find({ proposalId: amendment.proposalId })
      .sort({ createdAt: -1 })
      .limit(1)
      .toArray();
    if (!recovering && latestRows[0]?.revisionId !== amendment.baseRevisionId)
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

    const applyingToken = recovering ? String(amendment.applyingToken ?? "") : randomUUID();
    if (!recovering) {
      const claim = await db.collection("amendments").updateOne(
        { amendmentId, status: "accepted", baseRevisionId: amendment.baseRevisionId },
        {
          $set: {
            status: "applying",
            applyingToken,
            applyingStartedAt: new Date(),
            applyingBy: user.memberId,
          },
        },
      );
      if (claim.modifiedCount !== 1)
        return Response.json(
          {
            error:
              "The amendment changed before it could be applied. Reload the proposal and review its current state.",
          },
          { status: 409 },
        );
    } else {
      // Refresh the recovery lease so two late retries cannot run together.
      const refresh = await db.collection("amendments").updateOne(
        { amendmentId, status: "applying", applyingToken },
        { $set: { applyingStartedAt: new Date(), applyingBy: user.memberId } },
      );
      if (refresh.modifiedCount !== 1)
        return Response.json(
          {
            error:
              "The amendment application state changed. Reload the proposal and review its current state.",
          },
          { status: 409 },
        );
    }

    let updated;
    try {
      updated = await saveProposal(
        db,
        user,
        {
          proposalId: amendment.proposalId,
          ...changes,
        },
        { allowAmendmentApply: true },
      );
    } catch (error) {
      // A failed proposal write can release a fresh claim. A recovery attempt
      // stays `applying` so the same operation can be retried safely.
      if (!recovering) {
        await db.collection("amendments").updateOne(
          { amendmentId, status: "applying", applyingToken },
          {
            $set: { status: "accepted" },
            $unset: { applyingToken: "", applyingStartedAt: "", applyingBy: "" },
          },
        );
      }
      throw error;
    }

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
          status: "applying",
          applyingToken,
        },
        {
          $set: {
            status: "applied",
            appliedRevisionId: latest[0]?.revisionId,
            appliedBy: user.memberId,
            appliedAt: new Date(),
          },
          $unset: { applyingToken: "", applyingStartedAt: "", applyingBy: "" },
        },
      );
    if (!result.modifiedCount)
      return Response.json(
        {
          error:
            "The proposal changed but the amendment status could not be finalised. Retry apply; the operation is idempotent.",
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
