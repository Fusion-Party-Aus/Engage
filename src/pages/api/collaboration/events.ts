import type { APIRoute } from "astro";
import { getDatabase, runtimeEnv } from "../../../lib/db.ts";
import { resolvePublicOrigin } from "../../../lib/public-origin.ts";
import { getPublicInitiative } from "../../../lib/collaboration.ts";
import { parseFunnelEvent, recordFunnelEvent } from "../../../lib/collaboration-funnel.ts";
import { clientAddress, consumeRateLimit, rateLimitResponse } from "../../../lib/rate-limit.ts";

export const prerender = false;

/**
 * Aggregate funnel counts. The request carries an invitation slug and a stage,
 * nothing else. No identifier is read, stored or returned.
 */
export const POST: APIRoute = async (context) => {
  const { request, locals, url } = context;
  const env = runtimeEnv(locals);
  if (request.headers.get("origin") !== resolvePublicOrigin({ env, requestUrl: url })) {
    return new Response(null, { status: 403 });
  }
  const raw = await request.text();
  if (raw.length > 512) return new Response(null, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response(null, { status: 400 });
  }
  const parsed = parseFunnelEvent(body);
  if ("error" in parsed) return new Response(null, { status: 400 });

  const db = await getDatabase(env);
  const decision = await consumeRateLimit(db, {
    action: "collaboration-event",
    identifier: clientAddress(request, context.clientAddress),
    env,
  });
  if (!decision.allowed) return rateLimitResponse(decision);

  // Only a currently public invitation has a page to measure.
  if (!(await getPublicInitiative(db, parsed.initiativeSlug))) {
    return new Response(null, { status: 404 });
  }
  await recordFunnelEvent(db, parsed.initiativeSlug, parsed.stage);
  return new Response(null, { status: 204 });
};
