import type { APIRoute } from "astro";
import { getSessionUser } from "../../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import { PROPOSAL_VOTES } from "../../../../lib/vote-storage.ts";
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
    const amendmentId = String(body.amendmentId ?? "");
    const decisionEventId = String(body.decisionEventId ?? "");
    const result = String(body.result ?? "");
    if (
      !amendmentId ||
      !decisionEventId ||
      !["endorsed", "not-endorsed", "inconclusive"].includes(result)
    )
      return Response.json(
        {
          error:
            "amendmentId, decisionEventId and an explicit ballot result are required.",
        },
        { status: 400 },
      );
    const db = await getDatabase(env);
    const amendment = await db
      .collection("amendments")
      .findOne({ amendmentId, status: "voting" });
    if (!amendment)
      return Response.json(
        { error: "Open amendment ballot not found." },
        { status: 404 },
      );
    const proposal = await db
      .collection("proposals")
      .findOne({
        proposalId: amendment.proposalId,
        stage: "decide",
        ballotRevisionId: amendment.ballotRevisionId,
      });
    if (!proposal)
      return Response.json(
        { error: "The source proposal ballot revision has changed." },
        { status: 409 },
      );
    if (
      !canManageBranchBallot(user, {
        governanceAuthorityBranchId: proposal.governanceAuthorityBranchId,
        jurisdictionBranchId: proposal.jurisdictionBranchId,
      })
    )
      return Response.json(
        { error: "You are not authorised to close this branch ballot." },
        { status: 403 },
      );
    const votes = await db
      .collection(PROPOSAL_VOTES)
      .find({ ballotId: `amendment:${amendmentId}` })
      .toArray();
    const tally = { approve: 0, abstain: 0, reject: 0, total: 0 };
    for (const vote of votes) {
      if (vote.choice === "approve") tally.approve++;
      else if (vote.choice === "abstain") tally.abstain++;
      else tally.reject++;
      tally.total++;
    }
    const ballotDecision = {
      result,
      decisionEventId,
      tally,
      decidedBy: user.memberId,
      decidedAt: new Date(),
      revisionId: amendment.ballotRevisionId,
    };
    const update = await db
      .collection("amendments")
      .updateOne(
        {
          amendmentId,
          status: "voting",
          ballotRevisionId: amendment.ballotRevisionId,
        },
        { $set: { status: result, ballotDecision } },
      );
    if (!update.modifiedCount)
      return Response.json(
        { error: "Amendment ballot was already closed." },
        { status: 409 },
      );
    return Response.json({ amendmentId, status: result, ballotDecision });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not close amendment ballot.",
      },
      { status: 400 },
    );
  }
};
