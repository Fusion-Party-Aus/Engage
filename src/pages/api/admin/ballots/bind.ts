import type { APIRoute } from "astro";
import { getSessionUser, canManageBranchBallot } from "../../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import {
  BallotBindingError,
  bindBallotToRevision,
} from "../../../../lib/ballot-binding.ts";

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
    const proposalId =
      typeof body.proposalId === "string" ? body.proposalId.trim() : "";
    const revisionId =
      typeof body.revisionId === "string" ? body.revisionId.trim() : "";
    const decisionEventId =
      typeof body.decisionEventId === "string"
        ? body.decisionEventId.trim().slice(0, 200)
        : "";
    const reason =
      typeof body.reason === "string" ? body.reason.trim().slice(0, 1000) : "";
    if (!proposalId || !revisionId || !decisionEventId || !reason)
      return Response.json(
        {
          error:
            "Proposal, exact revision, decision event reference and review reason are required.",
        },
        { status: 400 },
      );
    const db = await getDatabase(env);
    const proposal = await db
      .collection("proposals")
      .findOne({ proposalId, stage: "decide" });
    if (!proposal)
      return Response.json(
        { error: "Open proposal ballot not found." },
        { status: 404 },
      );
    if (
      !canManageBranchBallot(user, {
        governanceAuthorityBranchId: proposal.governanceAuthorityBranchId,
        jurisdictionBranchId: proposal.jurisdictionBranchId,
      })
    )
      return Response.json(
        { error: "You are not authorised to review this ballot." },
        { status: 403 },
      );

    const { event, idempotent } = await bindBallotToRevision(db, {
      proposalId,
      revisionId,
      decisionEventId,
      reason,
      actorId: user.memberId,
    });
    return Response.json({ event }, { status: idempotent ? 200 : 201 });
  } catch (error) {
    if (error instanceof BallotBindingError)
      return Response.json(
        { error: error.message },
        { status: error.status },
      );
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not bind the ballot to a reviewed revision.",
      },
      { status: 400 },
    );
  }
};
