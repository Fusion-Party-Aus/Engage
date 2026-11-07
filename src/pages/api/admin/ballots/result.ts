import type { APIRoute } from "astro";
import { getSessionUser } from "../../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import { canManageBranchBallot } from "../../../../lib/auth.ts";

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
    if (
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
    const existing = await db
      .collection("ballot_results")
      .findOne({ proposalId });
    if (existing)
      return Response.json(
        { error: "Ballot result is already recorded and cannot be replaced." },
        { status: 409 },
      );
    const record = {
      proposalId,
      revisionId: proposal.ballotRevisionId,
      result,
      decisionEventId,
      recordedBy: user.memberId,
      recordedAt: new Date(),
    };
    await db.collection("ballot_results").insertOne(record);
    return Response.json({ result: record }, { status: 201 });
  } catch (error) {
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
