import type { APIRoute } from "astro";
import { getSessionUser } from "../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../lib/db.ts";
import { requireLegalAcceptance } from "../../lib/legal-acceptance.ts";
import { castVote, savePendingVotePreference } from "../../lib/store.ts";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user)
    return Response.json(
      { error: "Please sign in to participate in decisions." },
      { status: 401 },
    );

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const db = await getDatabase(env);
    const gate = await requireLegalAcceptance(db, user, env);
    if (gate) return gate;

    if (!user.canParticipate && user.status === "pending" && !body.amendmentId) {
      const pending = await savePendingVotePreference(db, user, body);
      return Response.json(pending);
    }

    const result = await castVote(db, user, body);
    return Response.json(result);
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Could not record decision.",
      },
      { status: 400 },
    );
  }
};
