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

function denied(message: string, status: number) {
  return new Response(`${message} Visit /member/ to sign in or check your verification status.`, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, no-store' } });
}
