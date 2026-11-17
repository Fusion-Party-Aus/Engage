import type { APIRoute } from "astro";
import { getDatabase, runtimeEnv } from "../../../lib/db.ts";
import { resolvePublicOrigin } from "../../../lib/public-origin.ts";
import { CollaborationError, manageContribution } from "../../../lib/collaboration.ts";
import { clientAddress, consumeRateLimit, rateLimitResponse } from "../../../lib/rate-limit.ts";

export const prerender = false;

/**
 * A contributor's private link. The token arrives in the request body, never in
 * a URL the server sees, and is never logged. It is the only authority.
 */
export const POST: APIRoute = async (context) => {
  const { request, locals, url } = context;
  const env = runtimeEnv(locals);
  const headers = { "cache-control": "private, no-store" };
  if (request.headers.get("origin") !== resolvePublicOrigin({ env, requestUrl: url })) {
    return Response.json({ error: "Please use the Engage website." }, { status: 403, headers });
  }
  const raw = await request.text();
  if (raw.length > 16_000) {
    return Response.json({ error: "That request is too large." }, { status: 413, headers });
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Could not read the request." }, { status: 400, headers });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "Could not read the request." }, { status: 400, headers });
  }
  const db = await getDatabase(env);
  const decision = await consumeRateLimit(db, {
    action: "collaboration-manage",
    identifier: clientAddress(request, context.clientAddress),
    env,
  });
  if (!decision.allowed) return rateLimitResponse(decision);
  try {
    const result = await manageContribution(db, {
      token: body.token,
      action: body.action,
      answers: body.answers,
      caption: body.caption,
    });
    return Response.json({ saved: true, ...result }, { headers });
  } catch (error) {
    if (error instanceof CollaborationError) {
      return Response.json({ error: error.message }, { status: error.status, headers });
    }
    return Response.json(
      { error: "Couldn't update your contribution. Try again." },
      { status: 503, headers },
    );
  }
};
