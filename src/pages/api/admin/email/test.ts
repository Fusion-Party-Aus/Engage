import type { APIRoute } from "astro";
import { getSessionUser } from "../../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import { sendAdminTestEmail, TestEmailError } from "../../../../lib/engagement-email.ts";
export const prerender = false;
export const POST: APIRoute = async ({request,url,locals}) => {
 if (request.headers.get("origin") !== url.origin) return Response.json({error:"Invalid origin"},{status:403});
 const env=runtimeEnv(locals), user=await getSessionUser(request,env);
 if (!user) return Response.json({error:"Sign in required."},{status:401});
 if (!user.isAdmin) return Response.json({error:"Administrator access required."},{status:403});
 try { return Response.json(await sendAdminTestEmail(await getDatabase(env),env,user),{headers:{"Cache-Control":"no-store"}}); }
 catch(error) { return Response.json({error:error instanceof TestEmailError ? error.message : "Could not send the test email."},{status:error instanceof TestEmailError ? error.status : 500}); }
};
