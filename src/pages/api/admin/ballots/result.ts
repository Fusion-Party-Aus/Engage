import type { APIRoute } from "astro";
import { getSessionUser, canManageBranchBallot } from "../../../../lib/auth.ts";
import {
  BallotDomainError,
  recordFormalDecision,
} from "../../../../lib/ballots.ts";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import { hasPermission } from "../../../../lib/rbac.ts";

export const prerender = false;
export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user)
    return Response.json({ error: "Sign in required." }, { status: 401 });
  if (
    !user.isAdmin &&
    !user.isBranchAdmin &&
    !hasPermission(user, "ballots.record_result")
  )
    return Response.json(
      { error: "Administrator access required." },
      { status: 403 },
    );
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const proposalId = String(body.proposalId ?? "");
    const result = String(body.result ?? "");
    const decisionEventId = String(body.decisionEventId ?? "");
    if (
      !proposalId ||
      !decisionEventId ||
      !["successful", "unsuccessful", "inconclusive"].includes(result)
    )
      return Response.json(
        {
          error: "proposalId, decisionEventId and a valid result are required.",
        },
        { status: 400 },
      );
    const db = await getDatabase(env);
    const proposal = await db.collection("proposals").findOne({ proposalId });
    if (!proposal || proposal.stage !== "decide" || !proposal.ballotRevisionId)
      return Response.json(
        { error: "Proposal must have an active, revision-bound ballot." },
        { status: 409 },
      );
  const branchScope =
    typeof proposal.governanceAuthorityBranchId === "string"
      ? proposal.governanceAuthorityBranchId
      : undefined;
  if (
    !hasPermission(user, "ballots.record_result", branchScope) ||
    !canManageBranchBallot(user, {
      governanceAuthorityBranchId: proposal.governanceAuthorityBranchId,
      jurisdictionBranchId: proposal.jurisdictionBranchId,
    })
  )
    return Response.json(
      {
        error:
          "You are not authorised to record an outcome for this ballot. Branch ballots require explicitly matching authority and jurisdiction.",
      },
      { status: 403 },
    );
  const record = await recordFormalDecision(db, {
    matterId: proposalId,
    revisionId: String(proposal.ballotRevisionId),
    result: result as "successful" | "unsuccessful" | "inconclusive",
    decisionEventId,
    authorityBranchId: branchScope,
    recordedBy: user.memberId,
  });
  const { _id: _resultId, ...publicResult } = record as unknown as Record<string, unknown>;
  return Response.json(
    { result: publicResult },
    { status: 201, headers: { "cache-control": "private, no-store" } },
  );
} catch (error) {
  if (error instanceof BallotDomainError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not record ballot result.",
      },
      { status: 400 },
    );
  }
};
