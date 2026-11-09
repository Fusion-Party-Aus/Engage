import type { APIRoute } from "astro";
import { getDatabase, runtimeEnv } from "../../../lib/db.ts";
import { runBallotDigests, safeEqual } from "../../../lib/engagement-email.ts";
export const prerender = false;
export const POST: APIRoute = async ({request,locals}) => {
 const env = runtimeEnv(locals);
 if (!env.ENGAGE_CRON_SECRET || !safeEqual(request.headers.get("authorization") || "", `Bearer ${env.ENGAGE_CRON_SECRET}`)) return Response.json({error:"Unauthorised"},{status:401});
 try { return Response.json(await runBallotDigests(await getDatabase(env),env), {headers:{"Cache-Control":"no-store"}}); }
 catch { return Response.json({error:"Digest job failed; inspect delivery holds before retrying."},{status:503}); }
};
