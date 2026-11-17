import type { APIRoute } from "astro";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import { resolvePublicOrigin } from "../../../../lib/public-origin.ts";
import {
  authoriseHorizonFeed,
  buildHorizonFeed,
  horizonFeedEtag,
  parseSince,
} from "../../../../lib/collaboration-horizon.ts";

export const prerender = false;

/**
 * Read-only story feed for Horizon. Requires a bearer credential and returns
 * only material a reviewer has published, the contributor allowed on the
 * website, and no reviewer has hidden. Supports incremental polling with
 * `since` and `If-None-Match`.
 */
export const GET: APIRoute = async ({ request, locals, url }) => {
  const env = runtimeEnv(locals);
  const auth = authoriseHorizonFeed(request.headers.get("authorization"), env);
  if (!auth.ok) {
    return Response.json(
      { error: auth.error },
      { status: auth.status, headers: { "cache-control": "private, no-store" } },
    );
  }

  const sinceParam = url.searchParams.get("since");
  const since = parseSince(sinceParam);
  if (sinceParam && !since) {
    return Response.json(
      { error: "Use an ISO 8601 date for since." },
      { status: 400, headers: { "cache-control": "private, no-store" } },
    );
  }
  const initiativeSlug = url.searchParams.get("initiative");

  const db = await getDatabase(env);
  const feed = await buildHorizonFeed(db, {
    initiativeSlug,
    baseUrl: resolvePublicOrigin({ env, requestUrl: url }),
    since,
  });
  if (!feed) {
    return Response.json(
      { error: "That invitation does not exist." },
      { status: 404, headers: { "cache-control": "private, no-store" } },
    );
  }

  const etag = horizonFeedEtag(feed);
  const headers = {
    "cache-control": "private, max-age=60",
    etag,
    "content-type": "application/json; charset=utf-8",
  };
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return Response.json(feed, { headers });
};
