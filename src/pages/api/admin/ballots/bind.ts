import type { APIRoute } from "astro";
import { createHash } from "node:crypto";
import { getSessionUser, canManageBranchBallot } from "../../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import {
  PROPOSAL_VOTES,
  proposalBallotId,
} from "../../../../lib/vote-storage.ts";

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
    if (
      !(await db
        .collection("proposal_revisions")
        .findOne({ proposalId, revisionId }))
    )
      return Response.json(
        {
          error:
            "The selected wording revision does not belong to this proposal.",
        },
        { status: 404 },
      );

    const eventId = `bind-${createHash("sha256").update(`${proposalId}\0${decisionEventId}`).digest("hex")}`;
    const priorEvent = await db
      .collection("ballot_binding_events")
      .findOne({ eventId });
    if (priorEvent) {
      if (priorEvent.revisionId !== revisionId || priorEvent.reason !== reason)
        return Response.json(
          {
            error:
              "Decision event reference was already used for a different ballot binding.",
          },
          { status: 409 },
        );
      return Response.json({ event: priorEvent }, { status: 200 });
    }

    const ballotId = proposalBallotId(proposalId);
    const votes = await db
      .collection(PROPOSAL_VOTES)
      .find({ proposalId, ballotId })
      .toArray();
    const inconsistent = votes.some(
      (vote: any) => vote.revisionId && vote.revisionId !== revisionId,
    );
    if (
      inconsistent ||
      (proposal.ballotRevisionId && proposal.ballotRevisionId !== revisionId)
    )
      return Response.json(
        {
          error:
            "Recorded ballot wording conflicts with the selected revision. Engage will not reassign those votes.",
        },
        { status: 409 },
      );

    if (!proposal.ballotRevisionId) {
      const bound = await db
        .collection("proposals")
        .updateOne(
          { proposalId, stage: "decide", ballotRevisionId: { $exists: false } },
          {
            $set: {
              ballotRevisionId: revisionId,
              ballotRevisionBoundAt: new Date(),
              ballotRevisionBoundBy: user.memberId,
            },
          },
        );
      if (!bound.matchedCount) {
        const current = await db
          .collection("proposals")
          .findOne({ proposalId, stage: "decide" });
        if (current?.ballotRevisionId !== revisionId)
          return Response.json(
            {
              error:
                "Ballot wording changed during review. Reload and confirm the recorded revision.",
            },
            { status: 409 },
          );
      }
    }
    let reboundVoteCount = 0;
    for (const vote of votes as any[]) {
      if (vote.revisionId === revisionId) continue;
      if (vote.revisionId && vote.revisionId !== revisionId)
        return Response.json(
          {
            error:
              "A vote changed during review; no conflicting vote was reassigned.",
          },
          { status: 409 },
        );
      await db
        .collection(PROPOSAL_VOTES)
        .updateOne(
          { _id: vote._id, ballotId, proposalId },
          { $set: { revisionId, revisionBindingEventId: eventId } },
        );
      reboundVoteCount++;
    }
    const event = {
      eventId,
      proposalId,
      ballotId,
      revisionId,
      decisionEventId,
      reason,
      reviewedVoteCount: votes.length,
      reboundVoteCount,
      actorId: user.memberId,
      createdAt: new Date(),
    };
    await db.collection("ballot_binding_events").insertOne(event);
    return Response.json({ event }, { status: 201 });
  } catch (error) {
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
