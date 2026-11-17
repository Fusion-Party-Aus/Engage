import type { APIRoute } from "astro";
import { getSessionUser } from "../../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import {
  CollaborationError,
  createInitiative,
  updateInitiative,
} from "../../../../lib/collaboration.ts";

export const prerender = false;

const headers = { "cache-control": "private, no-store" };

/** Create an invitation as a draft. A separate save opens it. */
export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: "Sign in required." }, { status: 401, headers });
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const initiative = await createInitiative(await getDatabase(env), user, {
      title: body.title,
      summary: body.summary,
      purpose: body.purpose,
      question: body.question,
      hint: body.hint,
      correctionEmail: body.correctionEmail,
      profile: body.profile,
    });
    return Response.json({ saved: true, initiative }, { status: 201, headers });
  } catch (error) {
    if (error instanceof CollaborationError) {
      return Response.json({ error: error.message }, { status: error.status, headers });
    }
    return Response.json(
      { error: "Couldn't create the invitation. Try again." },
      { status: 503, headers },
    );
  }
};

/** Editors own the invitation's wording, questions and open state. */
export const PATCH: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: "Sign in required." }, { status: 401, headers });
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const saved = await updateInitiative(await getDatabase(env), user, {
      slug: body.slug,
      title: body.title,
      summary: body.summary,
      purpose: body.purpose,
      status: body.status,
      questions: body.questions,
      correctionEmail: body.correctionEmail,
    });
    return Response.json({ saved: true, initiative: saved }, { headers });
  } catch (error) {
    if (error instanceof CollaborationError) {
      return Response.json({ error: error.message }, { status: error.status, headers });
    }
    return Response.json(
      { error: "Couldn't save the invitation. Try again." },
      { status: 503, headers },
    );
  }
};
