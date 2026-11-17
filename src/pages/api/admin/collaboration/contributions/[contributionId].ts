import type { APIRoute } from "astro";
import { getSessionUser } from "../../../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../../../lib/db.ts";
import { CollaborationError, reviewContribution } from "../../../../../lib/collaboration.ts";

export const prerender = false;

const headers = { "cache-control": "private, no-store" };

export const PATCH: APIRoute = async ({ request, locals, params }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: "Sign in required." }, { status: 401, headers });
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const saved = await reviewContribution(await getDatabase(env), user, {
      contributionId: params.contributionId,
      action: body.action,
      status: body.status,
      contributorMessage: body.contributorMessage,
      internalNotes: body.internalNotes,
      channel: body.channel,
      reference: body.reference,
      version: body.version,
    });
    return Response.json({ saved: true, ...saved }, { headers });
  } catch (error) {
    if (error instanceof CollaborationError) {
      return Response.json({ error: error.message }, { status: error.status, headers });
    }
    return Response.json(
      { error: "Couldn't save this decision. Try again." },
      { status: 503, headers },
    );
  }
};
