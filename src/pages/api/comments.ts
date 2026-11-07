import type { APIRoute } from "astro";
import { getSessionUser } from "../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../lib/db.ts";
import {
  addComment,
  deleteComment,
  toggleUpvoteComment,
} from "../../lib/store.ts";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user)
    return Response.json(
      { error: "Please sign in to participate." },
      { status: 401 },
    );

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const db = await getDatabase(env);
    const comment = await addComment(db, user, body);
    return Response.json({ comment }, { status: 201 });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not submit contribution.",
      },
      { status: 400 },
    );
  }
};

export const PATCH: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user)
    return Response.json(
      { error: "Please sign in to endorse points." },
      { status: 401 },
    );

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const commentId = String(body.commentId ?? "");
    const db = await getDatabase(env);
    const result = await toggleUpvoteComment(db, user, commentId);
    return Response.json(result);
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Could not endorse comment.",
      },
      { status: 400 },
    );
  }
};

export const DELETE: APIRoute = async ({ request, url, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user)
    return Response.json({ error: "Sign in required." }, { status: 401 });

  try {
    const body = await request.json().catch(() => ({}));
    const commentId = String(
      body?.commentId || url.searchParams.get("commentId") || "",
    );
    const db = await getDatabase(env);
    await deleteComment(db, user, commentId);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Could not delete comment.",
      },
      { status: 400 },
    );
  }
};
