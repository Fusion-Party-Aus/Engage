import type { APIRoute } from "astro";
import { getSessionUser } from "../../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import { CollaborationError, exportApproved } from "../../../../lib/collaboration.ts";

export const prerender = false;

/** Approved material only, for hand-off to the website team. */
export const GET: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  try {
    const payload = await exportApproved(await getDatabase(env), user);
    return Response.json(payload, {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": 'attachment; filename="fusion-stories-approved.json"',
      },
    });
  } catch (error) {
    const status = error instanceof CollaborationError ? error.status : 503;
    return Response.json(
      {
        error:
          error instanceof CollaborationError
            ? error.message
            : "Couldn't prepare the export. Try again.",
      },
      { status, headers: { "cache-control": "private, no-store" } },
    );
  }
};
