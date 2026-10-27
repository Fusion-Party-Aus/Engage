import type { APIRoute } from "astro";
import { getSessionUser } from "../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../lib/db.ts";
import { listProposals, saveProposal } from "../../../lib/store.ts";

export const prerender = false;

export const GET: APIRoute = async ({ request, url, locals }) => {
  const env = runtimeEnv(locals);
  const [db, user] = await Promise.all([getDatabase(env), getSessionUser(request, env)]);
  const proposals = await listProposals(db, {
    includeArchived: Boolean(user?.isStaff),
    search: url.searchParams.get("q") ?? "",
    space: url.searchParams.get("space") ?? url.searchParams.get("category") ?? "",
    stage: url.searchParams.get("stage") ?? url.searchParams.get("status") ?? "",
  });
  return Response.json({ proposals, policies: proposals }, { headers: { "cache-control": "private, no-store" } });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: "Sign in required." }, { status: 401 });
  if (!user.canParticipate && !user.isStaff) {
    return Response.json({ error: "Verified membership required to submit a proposal." }, { status: 403 });
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const db = await getDatabase(env);
    const proposal = await saveProposal(db, user, body);
    return Response.json({ proposal, policy: proposal }, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not save proposal." },
      { status: 400 },
    );
  }
};
