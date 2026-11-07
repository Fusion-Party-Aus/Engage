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
    const amendmentId = String(body.amendmentId ?? "");
    const decisionEventId = String(body.decisionEventId ?? "");
    if (!amendmentId || !decisionEventId)
      return Response.json(
        { error: "amendmentId and formal decisionEventId are required." },
        { status: 400 },
      );
    const db = await getDatabase(env);
    const amendment = await db
      .collection("amendments")
      .findOne({
        amendmentId,
        status: "endorsed",
        "ballotDecision.result": "endorsed",
      });
    if (!amendment)
      return Response.json(
        { error: "Only an endorsed amendment can receive formal approval." },
        { status: 409 },
      );
    const proposal = await db
      .collection("proposals")
      .findOne({ proposalId: amendment.proposalId });
    if (!proposal || proposal.ballotRevisionId !== amendment.ballotRevisionId)
      return Response.json(
        {
          error:
            "Source proposal ballot revision does not match the endorsed amendment.",
        },
        { status: 409 },
      );
    if (
      !amendment.ballotAmendmentRevisionId ||
      amendment.ballotAmendmentRevisionId !== amendment.currentRevisionId ||
      !(await db
        .collection("amendment_revisions")
        .findOne({
          amendmentId,
          revisionId: amendment.ballotAmendmentRevisionId,
        }))
    )
      return Response.json(
        { error: "Endorsed amendment wording revision is missing or changed." },
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
            "You are not authorised to record formal approval for this branch amendment.",
        },
        { status: 403 },
      );
    const result = await db
      .collection("amendments")
      .updateOne(
        {
          amendmentId,
          status: "endorsed",
          currentRevisionId: amendment.ballotAmendmentRevisionId,
          "ballotDecision.decisionEventId":
            amendment.ballotDecision.decisionEventId,
        },
        {
          $set: {
            status: "accepted",
            formalApproval: {
              decisionEventId,
              authorityId: user.memberId,
              approvedAt: new Date(),
              baseRevisionId: amendment.ballotRevisionId,
              amendmentRevisionId: amendment.ballotAmendmentRevisionId,
            },
          },
        },
      );
    if (!result.modifiedCount)
      return Response.json(
        { error: "Amendment state changed; reload and try again." },
        { status: 409 },
      );
    return Response.json(
      {
        amendmentId,
        status: "accepted",
        baseRevisionId: amendment.ballotRevisionId,
        amendmentRevisionId: amendment.ballotAmendmentRevisionId,
      },
      { status: 200 },
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not formally approve amendment.",
      },
      { status: 400 },
    );
  }
};
