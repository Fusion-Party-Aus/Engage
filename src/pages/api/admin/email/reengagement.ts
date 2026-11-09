import type { APIRoute } from 'astro';
import { getSessionUser } from '../../../../lib/auth.ts';
import { getDatabase, runtimeEnv } from '../../../../lib/db.ts';
import { previewMemberReengagement } from '../../../../lib/member-reengagement.ts';
export const prerender=false;
export const GET: APIRoute=async({request,locals,url})=>{
  const env=runtimeEnv(locals), user=await getSessionUser(request,env);
  if (!user?.isAdmin) return Response.json({error:'Administrator access required'},{status:403});
  try {
    const report=await previewMemberReengagement(await getDatabase(env),new Date(url.searchParams.get('cutoff') || ''),new Date(),url.searchParams.get('include') === 'members');
    return Response.json(report,{headers:{'Cache-Control':'private, no-store'}});
  } catch { return Response.json({error:'Supply a valid historical cutoff date.'},{status:400}); }
};
