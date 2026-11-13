import type { APIRoute } from "astro";
import { getSessionUser } from "../../../lib/auth.ts";
import {
  parsePagination,
  privateJson,
  toProposalListItemDto,
} from "../../../lib/api-contracts.ts";
import { getDatabase, runtimeEnv } from "../../../lib/db.ts";
import { requireLegalAcceptance } from "../../../lib/legal-acceptance.ts";
import { listProposals, saveProposal } from "../../../lib/store.ts";

export const prerender = false;

export const GET: APIRoute = async ({ request, url, locals }) => {
  const env = runtimeEnv(locals);
  const [db, user] = await Promise.all([
    getDatabase(env),
    getSessionUser(request, env),
  ]);
  const { limit, offset } = parsePagination(url, { defaultLimit: 50, maxLimit: 100 });
  const proposals = await listProposals(db, {
    includeArchived: Boolean(user?.isStaff),
    user,
    search: url.searchParams.get("q") ?? "",
    space:
      url.searchParams.get("space") ?? url.searchParams.get("category") ?? "",
    stage:
      url.searchParams.get("stage") ?? url.searchParams.get("status") ?? "",
    branch: url.searchParams.get("branch") ?? "",
  });
  const page = proposals.slice(offset, offset + limit).map(toProposalListItemDto);
  return privateJson({
    proposals: page,
    policies: page,
    meta: {
      limit,
      offset,
      total: proposals.length,
      hasMore: offset + page.length < proposals.length,
    },
  });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user)
    return privateJson({ error: "Sign in required." }, { status: 401 });
  if (!user.canParticipate && !user.isStaff) {
    return privateJson(
      { error: "Verified membership required to submit a proposal." },
      { status: 403 },
    );
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const db = await getDatabase(env);
    const gate = await requireLegalAcceptance(db, user, env);
    if (gate) return gate;
    const proposal = await saveProposal(db, user, body);
    const dto = toProposalListItemDto({
      ...proposal,
      commentCount: 0,
      votes: { approve: 0, abstain: 0, reject: 0, total: 0 },
    });
    return privateJson({ proposal: dto, policy: dto }, { status: 201 });
  } catch (error) {
    return privateJson(
      {
        error:
          error instanceof Error ? error.message : "Could not save proposal.",
      },
      { status: 400 },
    );
  }
};
