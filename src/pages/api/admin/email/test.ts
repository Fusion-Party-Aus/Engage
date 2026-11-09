import type { APIRoute } from "astro";
import { getSessionUser } from "../../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import { sendAdminTestEmail, TestEmailError } from "../../../../lib/engagement-email.ts";
import { resolvePublicOrigin } from "../../../../lib/public-origin.ts";
import { testDeliveryHistory } from "../../../../lib/admin-engagement.ts";
export const prerender = false;
export const GET: APIRoute = async ({request,locals}) => {
 const env=runtimeEnv(locals), user=await getSessionUser(request,env);
 if (!user) return Response.json({error:"Sign in required."},{status:401});
 if (!user.isAdmin) return Response.json({error:"Administrator access required."},{status:403});
 try { return Response.json({recipient:user.email,messages:await testDeliveryHistory(await getDatabase(env),user.memberId)},{headers:{"Cache-Control":"private, no-store"}}); }
 catch { return Response.json({error:"Delivery history is unavailable. Try refreshing shortly."},{status:503,headers:{"Cache-Control":"no-store"}}); }
};
export const POST: APIRoute = async ({request,url,locals}) => {
 const env=runtimeEnv(locals);
 // Coolify may present an internal HTTP URL. Trust configured origin, never forwarded host headers.
 if (request.headers.get("origin") !== resolvePublicOrigin({env,requestUrl:url})) return Response.json({error:"This request came from a different site. Open Engage directly and try again."},{status:403});
 const user=await getSessionUser(request,env);
 if (!user) return Response.json({error:"Sign in required."},{status:401});
 if (!user.isAdmin) return Response.json({error:"Administrator access required."},{status:403});
 try { return Response.json(await sendAdminTestEmail(await getDatabase(env),env,user),{headers:{"Cache-Control":"no-store"}}); }
 catch(error) { return Response.json({error:error instanceof TestEmailError ? error.message : "Could not send the test email."},{status:error instanceof TestEmailError ? error.status : 500}); }
};

