import type { APIRoute } from "astro";
import { getSessionUser } from "../../../../lib/auth.ts";
import { privateJson, toProposalDetailDto } from "../../../../lib/api-contracts.ts";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import { requireLegalAcceptance } from "../../../../lib/legal-acceptance.ts";
import {
  ProposalSecondingError,
  secondProposal,
} from "../../../../lib/store.ts";

export const prerender = false;

/**
 * POST /api/proposals/[proposalId]/second
 *
 * Records the independent seconder a proposal needs before it enters
 * Deliberate (D3). Authorisation and governance rules live in `secondProposal`;
 * this route only translates them into a response.
 */
export const POST: APIRoute = async ({ params, request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user) return privateJson({ error: "Sign in required." }, { status: 401 });

  try {
    const db = await getDatabase(env);
    const gate = await requireLegalAcceptance(db, user, env);
    if (gate) return gate;
    const id = params.proposalId ?? "";
    const proposal = await secondProposal(db, user, id);
    const dto = toProposalDetailDto({
      ...proposal,
      commentCount: 0,
      votes: { approve: 0, abstain: 0, reject: 0, total: 0 },
    });
    return privateJson({ proposal: dto }, { status: 201 });
  } catch (error) {
    const status =
      error instanceof ProposalSecondingError ? error.status : 400;
    return privateJson(
      {
        error:
          error instanceof Error ? error.message : "Could not second proposal.",
      },
      { status },
    );
  }
};
