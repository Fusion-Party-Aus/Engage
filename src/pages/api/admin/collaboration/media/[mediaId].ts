import type { APIRoute } from "astro";
import { getSessionUser } from "../../../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../../../lib/db.ts";
import {
  CollaborationError,
  readContributionMedia,
} from "../../../../../lib/collaboration.ts";

export const prerender = false;

/**
 * Private media for reviewers only. The bytes are never reachable from a public
 * route, never cached and never indexed.
 */
export const GET: APIRoute = async ({ request, locals, params }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  try {
    const media = await readContributionMedia(
      await getDatabase(env),
      user,
      String(params.mediaId ?? ""),
    );
    return new Response(new Uint8Array(media.bytes), {
      headers: {
        "content-type": media.mimeType,
        "content-length": String(media.bytes.length),
        "content-disposition": `inline; filename="${media.filename.replace(/["\\]/g, "")}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    const status = error instanceof CollaborationError ? error.status : 503;
    return new Response(
      error instanceof CollaborationError ? error.message : "That photo is not available.",
      { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store" } },
    );
  }
};
