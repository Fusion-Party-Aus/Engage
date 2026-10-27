import type { APIRoute } from "astro";
import { getSessionUser } from "../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../lib/db.ts";
import { deleteProposal, getProposalDetail, saveProposal } from "../../../lib/store.ts";

export const prerender = false;

export const GET: APIRoute = async ({ params, request, locals }) => {
  const env = runtimeEnv(locals);
  const [db, user] = await Promise.all([getDatabase(env), getSessionUser(request, env)]);
  const id = params.proposalId ?? params.policyId ?? "";
  const detail = await getProposalDetail(db, id, user);
  if (!detail) return Response.json({ error: "Proposal not found." }, { status: 404 });
  return Response.json(detail, { headers: { "cache-control": "private, no-store" } });
};

export const PATCH: APIRoute = async ({ params, request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: "Sign in required." }, { status: 401 });

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const db = await getDatabase(env);
    const id = params.proposalId ?? params.policyId ?? "";
    const proposal = await saveProposal(db, user, { ...body, proposalId: id });
    return Response.json({ proposal, policy: proposal });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not update proposal." },
      { status: 400 },
    );
  }
};

export const DELETE: APIRoute = async ({ params, request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: "Sign in required." }, { status: 401 });

  try {
    const db = await getDatabase(env);
    const id = params.proposalId ?? params.policyId ?? "";
    await deleteProposal(db, user, id);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not delete proposal." },
      { status: 400 },
    );
  }
};
