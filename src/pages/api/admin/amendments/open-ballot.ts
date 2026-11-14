import type { APIRoute } from "astro";
import { getSessionUser } from "../../../../lib/auth.ts";
import { getDatabase, runInTransaction, runtimeEnv } from "../../../../lib/db.ts";
import { canManageBranchBallot } from "../../../../lib/auth.ts";
import { ballotExpired } from "../../../../lib/ballot-deadline.ts";
import { recordGovernanceEvent } from "../../../../lib/governance-relationships.ts";
import { hasPermission } from "../../../../lib/rbac.ts";
export const prerender = false;
export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user)
    return Response.json({ error: "Sign in required." }, { status: 401 });
  if (!user.isAdmin && !user.isBranchAdmin && !hasPermission(user, "amendments.manage_ballot"))
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
      .findOne({ amendmentId, status: "ready" });
    if (!amendment)
      return Response.json(
        { error: "Ready amendment not found. Resolve the amendment as ready before opening a ballot." },
        { status: 404 },
      );
    const proposal = await db
      .collection("proposals")
      .findOne({ proposalId: amendment.proposalId, stage: "decide" });
    if (
      !proposal?.ballotRevisionId ||
      proposal.ballotRevisionId !== amendment.baseRevisionId ||
      !amendment.currentRevisionId ||
      !(await db
        .collection("amendment_revisions")
        .findOne({ amendmentId, revisionId: amendment.currentRevisionId }))
    )
      return Response.json(
        {
          error:
            "Amendment must target the proposal's frozen ballot revision and an immutable amendment wording revision.",
        },
        { status: 409 },
      );
    const branchScope =
      typeof proposal.governanceAuthorityBranchId === "string"
        ? proposal.governanceAuthorityBranchId
        : undefined;
    if (
      !hasPermission(user, "amendments.manage_ballot", branchScope) ||
      !canManageBranchBallot(user, {
        governanceAuthorityBranchId: proposal.governanceAuthorityBranchId,
        jurisdictionBranchId: proposal.jurisdictionBranchId,
      })
    )
      return Response.json(
        {
          error:
            "You are not authorised to open this ballot. Branch authority and jurisdiction must explicitly match your assignment.",
        },
        { status: 403 },
      );
    if (ballotExpired({ballotClosesAt:proposal.ballotClosesAt})) return Response.json({error: "The proposal ballot has closed."}, {status: 409});
    const now = new Date();
    const modifiedCount = await runInTransaction(db, async (session) => {
      const sessionOpts = session ? { session } : undefined;
      const result = await db
        .collection("amendments")
        .updateOne(
          {
            amendmentId,
            status: amendment.status,
            baseRevisionId: proposal.ballotRevisionId,
            currentRevisionId: amendment.currentRevisionId,
          },
          {
            $set: {
              status: "voting",
              ballotRevisionId: proposal.ballotRevisionId,
              ballotAmendmentRevisionId: amendment.currentRevisionId,
              ballotOpenedBy: user.memberId,
              ballotOpenedAt: now,
              ...(proposal.ballotClosesAt ? {ballotClosesAt: proposal.ballotClosesAt} : {}),
            },
          },
          sessionOpts,
        );
      if (result.modifiedCount) {
        await recordGovernanceEvent(
          db,
          {
            eventType: "amendment.ballot_opened",
            matterId: amendment.proposalId,
            ballotId: `amendment:${amendmentId}`,
            revisionId: proposal.ballotRevisionId,
            actorId: user.memberId,
            authorityBranchId: branchScope,
            metadata: {
              amendmentId,
              amendmentRevisionId: amendment.currentRevisionId,
              ...(proposal.ballotClosesAt
                ? { ballotClosesAt: new Date(proposal.ballotClosesAt).toISOString() }
                : {}),
            },
            createdAt: now,
          },
          session,
        );
      }
      return result.modifiedCount;
    });
    if (!modifiedCount)
      return Response.json(
        { error: "Amendment state changed; reload before opening the ballot." },
        { status: 409 },
      );
    return Response.json(
      {
        amendmentId,
        proposalId: amendment.proposalId,
        ballotRevisionId: proposal.ballotRevisionId,
        ballotAmendmentRevisionId: amendment.currentRevisionId,
        status: "voting",
      },
      { status: 201 },
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not open amendment ballot.",
      },
      { status: 400 },
    );
  }
};

