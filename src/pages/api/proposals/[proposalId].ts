import type { APIRoute } from "astro";
import { getSessionUser } from "../../../lib/auth.ts";
import {
  privateJson,
  toBallotVoteDto,
  toCommentDto,
  toProposalDetailDto,
  toProposalListItemDto,
} from "../../../lib/api-contracts.ts";
import { ballotRecordsForViewer } from "../../../lib/ballot-privacy.ts";
import { getDatabase, runtimeEnv } from "../../../lib/db.ts";
import { requireLegalAcceptance } from "../../../lib/legal-acceptance.ts";
import {
  deleteProposal,
  getProposalDetail,
  saveProposal,
} from "../../../lib/store.ts";

export const prerender = false;

export const GET: APIRoute = async ({ params, request, locals }) => {
  const env = runtimeEnv(locals);
  const [db, user] = await Promise.all([
    getDatabase(env),
    getSessionUser(request, env),
  ]);
  const id = params.proposalId ?? params.policyId ?? "";
  const detail = await getProposalDetail(db, id, user);
  if (!detail)
    return privateJson({ error: "Proposal not found." }, { status: 404 });
  const votesList = ballotRecordsForViewer(detail.votesList, user).map((v) =>
    toBallotVoteDto(v as any, user),
  );
  return privateJson({
    proposal: toProposalDetailDto(detail.proposal),
    comments: detail.comments.map((c) => toCommentDto(c, user)),
    votesList,
    myVote: detail.myVote,
    myReason: detail.myReason,
    ...(detail.myPendingVote !== undefined
      ? { myPendingVote: detail.myPendingVote }
      : {}),
    ...(detail.myPendingReason !== undefined
      ? { myPendingReason: detail.myPendingReason }
      : {}),
  });
};

export const PATCH: APIRoute = async ({ params, request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user)
    return privateJson({ error: "Sign in required." }, { status: 401 });

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const db = await getDatabase(env);
    const gate = await requireLegalAcceptance(db, user, env);
    if (gate) return gate;
    const id = params.proposalId ?? params.policyId ?? "";
    const proposal = await saveProposal(db, user, { ...body, proposalId: id });
    const dto = toProposalListItemDto({
      ...proposal,
      commentCount: 0,
      votes: { approve: 0, abstain: 0, reject: 0, total: 0 },
    });
    return privateJson({ proposal: dto, policy: dto });
  } catch (error) {
    return privateJson(
      {
        error:
          error instanceof Error ? error.message : "Could not update proposal.",
      },
      { status: 400 },
    );
  }
};

export const DELETE: APIRoute = async ({ params, request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user)
    return privateJson({ error: "Sign in required." }, { status: 401 });

  try {
    const db = await getDatabase(env);
    const id = params.proposalId ?? params.policyId ?? "";
    await deleteProposal(db, user, id);
    return privateJson({ ok: true });
  } catch (error) {
    return privateJson(
      {
        error:
          error instanceof Error ? error.message : "Could not delete proposal.",
      },
      { status: 400 },
    );
  }
};
