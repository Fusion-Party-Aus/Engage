import type { APIRoute } from "astro";
import { getSessionUser } from "../../lib/auth.ts";
import { privateJson, toCommentDto } from "../../lib/api-contracts.ts";
import { getDatabase, runtimeEnv } from "../../lib/db.ts";
import { requireLegalAcceptance } from "../../lib/legal-acceptance.ts";
import {
  addComment,
  deleteComment,
  setCommentFeedback,
  toggleUpvoteComment,
} from "../../lib/store.ts";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user)
    return privateJson(
      { error: "Please sign in to participate." },
      { status: 401 },
    );

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const db = await getDatabase(env);
    const gate = await requireLegalAcceptance(db, user, env);
    if (gate) return gate;
    const comment = await addComment(db, user, body);
    return privateJson({ comment: toCommentDto(comment, user) }, { status: 201 });
  } catch (error) {
    return privateJson(
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
    return privateJson(
      { error: "Please sign in to endorse points." },
      { status: 401 },
    );

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const commentId = String(body.commentId ?? "");
    const db = await getDatabase(env);
    const gate = await requireLegalAcceptance(db, user, env);
    if (gate) return gate;
    const result = await toggleUpvoteComment(db, user, commentId);
    return privateJson({
      count: result.count,
      endorsed: result.endorsed,
      hasUpvoted: result.hasUpvoted,
    });
  } catch (error) {
    return privateJson(
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
    return privateJson({ error: "Sign in required." }, { status: 401 });

  try {
    const body = await request.json().catch(() => ({}));
    const commentId = String(
      body?.commentId || url.searchParams.get("commentId") || "",
    );
    const db = await getDatabase(env);
    await deleteComment(db, user, commentId);
    return privateJson({ ok: true });
  } catch (error) {
    return privateJson(
      {
        error:
          error instanceof Error ? error.message : "Could not delete comment.",
      },
      { status: 400 },
    );
  }
};

export const PUT: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user)
    return privateJson({ error: "Sign in required." }, { status: 401 });

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const db = await getDatabase(env);
    const gate = await requireLegalAcceptance(db, user, env);
    if (gate) return gate;
    const result = await setCommentFeedback(db, user, body);
    return privateJson(result);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Could not save contribution outcome.";
    const status = message.startsWith("Only administrators")
      ? 403
      : message.endsWith("not found.")
        ? 404
        : 400;
    return privateJson({ error: message }, { status });
  }
};
