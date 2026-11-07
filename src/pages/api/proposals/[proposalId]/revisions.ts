import type { APIRoute } from "astro";
import { getSessionUser } from "../../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import { listProposalRevisions } from "../../../../lib/store.ts";

export const prerender = false;

export const GET: APIRoute = async ({ params, request, locals }) => {
  const env = runtimeEnv(locals);
  const [db, user] = await Promise.all([
    getDatabase(env),
    getSessionUser(request, env),
  ]);
  const proposalId = params.proposalId ?? "";
  const result = await listProposalRevisions(db, proposalId, user);
  if (!result)
    return Response.json({ error: "Proposal not found." }, { status: 404 });
  return Response.json(result, {
    headers: { "cache-control": "private, no-store" },
  });
};
