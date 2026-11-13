import type { APIRoute } from 'astro';
import { getDatabase, runtimeEnv } from '../../lib/db.ts';
import { resolvePublicOrigin } from '../../lib/public-origin.ts';
import { getSessionUser } from '../../lib/auth.ts';
import { submitSense, listSense, reviewSense, SenseError } from '../../lib/sense-box.ts';
export const prerender = false;
const headers = {'cache-control':'private, no-store'};
async function handle(context: Parameters<APIRoute>[0]) {
  const {request,locals,url} = context;
  const env = runtimeEnv(locals);
  try {
    if (request.method !== 'GET' && request.headers.get('origin') !== resolvePublicOrigin({env,requestUrl:url})) throw new SenseError('Please submit from the Engage website.',403);
    const db = await getDatabase(env);
    if (request.method === 'GET') {
      const user = await getSessionUser(request,env);
      if (!user) throw new SenseError('Sign in required.',401);
      return Response.json(await listSense(db,user,Object.fromEntries(url.searchParams)),{headers});
    }
    const raw = await request.text();
    if (raw.length > 16000) throw new SenseError('Please shorten your submission.',413);
    let body;
    try { body = JSON.parse(raw); } catch { throw new SenseError('Could not read the form. Try again.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SenseError('Invalid form.');
    if (request.method === 'PATCH') {
      const user = await getSessionUser(request,env);
      if (!user) throw new SenseError('Sign in required.',401);
      await reviewSense(db,user,body);
      return Response.json({saved:true},{headers});
    }
    if (body.website) throw new SenseError('Could not accept this submission.');
    const secret = env.BETTER_AUTH_SECRET || env.SESSION_SECRET;
    if (!secret && env.APP_MODE === 'production') throw new SenseError('Sense Box is temporarily unavailable. Please try again later.',503);
    await submitSense(db,body,{address:context.clientAddress,secret:secret || 'local-preview'});
    return Response.json({saved:true},{status:201,headers});
  } catch (error) {
    return Response.json({error:error instanceof SenseError ? error.message : "Couldn't save or load Sense Box. Please try again."},{status:error instanceof SenseError ? error.status : 503,headers});
  }
}
export const POST: APIRoute = handle;
export const GET: APIRoute = handle;
export const PATCH: APIRoute = handle;
