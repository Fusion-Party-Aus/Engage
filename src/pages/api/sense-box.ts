import type { APIRoute } from 'astro';
import { getSessionUser } from '../../lib/auth.ts';
import { getDatabase, runtimeEnv } from '../../lib/db.ts';
import {
  listPublicSense,
  listSense,
  reviewSense,
  SenseError,
  senseReviewScope,
  submitSense,
} from '../../lib/sense-box.ts';
import { enforceAbuseProtection } from '../../lib/turnstile-guard.ts';
import { tokenFromBody } from '../../lib/turnstile.ts';
import { resolvePublicOrigin } from '../../lib/public-origin.ts';

export const prerender = false;

const headers = { 'cache-control': 'private, no-store' };
const safeError = (error: unknown) =>
  error instanceof SenseError
    ? Response.json({ error: error.message }, { status: error.status, headers })
    : Response.json({ error: 'Couldn’t save or load Sense Box. Please try again.' }, { status: 503, headers });

export const GET: APIRoute = async ({ request, url, locals }) => {
  try {
    const env = runtimeEnv(locals);
    const db = await getDatabase(env);
    const user = await getSessionUser(request, env);
    const params = Object.fromEntries(url.searchParams);
    // Anonymous reads are public-only. Signed-in reviewers get the inbox unless
    // they explicitly ask for the public view; everyone else gets the public view.
    const scope = user ? senseReviewScope(user) : null;
    if (!user || url.searchParams.get('view') === 'public' || (!scope?.national && !scope?.branchIds.length)) {
      return Response.json(await listPublicSense(db, params), { headers });
    }
    return Response.json(await listSense(db, user, params), { headers });
  } catch (error) {
    return safeError(error);
  }
};

export const PATCH: APIRoute = async ({ request, locals, url }) => {
  try {
    const env = runtimeEnv(locals);
    if (request.headers.get('origin') !== resolvePublicOrigin({ env, requestUrl: url }))
      throw new SenseError('Please make this change from the Engage website.', 403);
    const user = await getSessionUser(request, env);
    if (!user) throw new SenseError('Sign in required.', 401);
    const body = (await request.json()) as Record<string, unknown>;
    const db = await getDatabase(env);
    await reviewSense(db, user, body);
    return Response.json({ saved: true }, { headers });
  } catch (error) {
    return safeError(error);
  }
};

export const POST: APIRoute = async ({ request, locals, url, clientAddress }) => {
  try {
    const env = runtimeEnv(locals);
    if (request.headers.get('origin') !== resolvePublicOrigin({ env, requestUrl: url }))
      throw new SenseError('Please submit from the Engage website.', 403);
    const db = await getDatabase(env);
    const raw = await request.text();
    if (raw.length > 16000) throw new SenseError('Please shorten your submission.', 413);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new SenseError('Please reload the form and try again.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new SenseError('Please reload the form and try again.');
    if (body.website) throw new SenseError('Could not accept this submission.');
    const refusal = await enforceAbuseProtection({
      request,
      env,
      db,
      action: 'sense-box-submit',
      token: tokenFromBody(body),
      adapterAddress: clientAddress,
    });
    if (refusal) return refusal;
    await submitSense(db, body);
    return Response.json({ saved: true }, { status: 201, headers });
  } catch (error) {
    return safeError(error);
  }
};
