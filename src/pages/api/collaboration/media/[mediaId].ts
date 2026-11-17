import type { APIRoute } from "astro";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import { CollaborationError, readPublishedMedia } from "../../../../lib/collaboration.ts";

export const prerender = false;

/**
 * Media for a story that is currently published. Withdrawal, declining, hiding
 * or retention clearing removes access immediately: the same URL becomes 404.
 */
export const GET: APIRoute = async ({ locals, params }) => {
  try {
    const media = await readPublishedMedia(
      await getDatabase(runtimeEnv(locals)),
      String(params.mediaId ?? ""),
    );
    return new Response(new Uint8Array(media.bytes), {
      headers: {
        "content-type": media.mimeType,
        "content-length": String(media.bytes.length),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return new Response("That photo is not available.", {
      status: error instanceof CollaborationError ? error.status : 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
};
