import type { APIRoute } from 'astro';
import { getSessionUser } from '../../../lib/auth.ts';
import { privateJson } from '../../../lib/api-contracts.ts';
import { getDatabase, runtimeEnv } from '../../../lib/db.ts';
import { requireLegalAcceptance } from '../../../lib/legal-acceptance.ts';
import {
  addSenseComment,
  deleteSenseComment,
  SenseError,
} from '../../../lib/sense-box.ts';

export const prerender = false;

const errorStatus = (error: unknown) =>
  error instanceof SenseError ? error.status : 400;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user) return privateJson({ error: 'Sign in to join the discussion.' }, { status: 401 });
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const db = await getDatabase(env);
    const gate = await requireLegalAcceptance(db, user, env);
    if (gate) return gate;
    const comment = await addSenseComment(db, user, body);
    return privateJson({ comment }, { status: 201 });
  } catch (error) {
    return privateJson(
      { error: error instanceof Error ? error.message : 'Could not save your comment.' },
      { status: errorStatus(error) },
    );
  }
};

export const DELETE: APIRoute = async ({ request, url, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user) return privateJson({ error: 'Sign in required.' }, { status: 401 });
  try {
    const body = await request.json().catch(() => ({}));
    const commentId = String(
      (body as Record<string, unknown>)?.commentId || url.searchParams.get('commentId') || '',
    ).trim();
    if (!commentId) return privateJson({ error: 'Choose a comment to remove.' }, { status: 400 });
    const db = await getDatabase(env);
    await deleteSenseComment(db, user, commentId);
    return privateJson({ removed: true });
  } catch (error) {
    return privateJson(
      { error: error instanceof Error ? error.message : 'Could not remove that comment.' },
      { status: errorStatus(error) },
    );
  }
};
