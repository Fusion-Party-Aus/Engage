import { platformRoles, resolveIdentity } from './auth.ts';
import { getDatabase } from './database.ts';
import { canReadDiscussion } from './discussion-access.ts';
import type { PlatformEnv } from './types.ts';

/** Run before an administration page loads any operator data. */
export async function adminPageDenial(request: Request, env: PlatformEnv, membershipAdministration = false): Promise<Response | null> {
  try {
    const { identity } = await resolveIdentity(request, env);
    if (!identity) return denied('Sign in to access administration.', 401);
    const roles = await platformRoles(identity, env);
    const authorised = membershipAdministration ? roles.includes('administrator') : roles.some(role => role === 'administrator' || role === 'moderator');
    if (!authorised) return denied('You are not authorised to access this administration page.', 403);
    if (!membershipAdministration && !await canReadDiscussion(await getDatabase(env), identity, env)) return denied('Verified membership is required for the review workspace.', 403);
    return null;
  } catch {
    return denied('Administration is temporarily unavailable.', 503);
  }
}

/** Pages call this before loading or rendering any operator records. */
export async function adminPageContext(request: Request, env: PlatformEnv) {
  const denial = await adminPageDenial(request, env);
  if (denial) return denial;
  try {
    const { identity } = await resolveIdentity(request, env);
    if (!identity) return denied('Sign in to access administration.', 401);
    return { env, identity, administrator: (await platformRoles(identity, env)).includes('administrator'), db: await getDatabase(env) };
  } catch {
    return denied('Administration is temporarily unavailable.', 503);
  }
}

function denied(message: string, status: number) {
  return new Response(`<!doctype html><html lang="en-AU"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex,nofollow"><title>Administration access · Engage</title><style>body{font-family:system-ui;color:#32105a;margin:3rem auto;padding:1rem;max-width:40rem;line-height:1.6}a{color:inherit}a:focus-visible{outline:3px solid #006a70;outline-offset:4px}</style><main><p>Engage administration</p><h1>${message}</h1><p><a href="/member/">Sign in or check your verification status</a></p><p><a href="/">Return to Engage</a></p></main></html>`, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store' } });
}
