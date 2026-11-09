import type { APIRoute } from "astro";
import { getDatabase, runtimeEnv } from "../../../lib/db.ts";
import { recordEmailEvent, verifyResendWebhook } from "../../../lib/engagement-email.ts";
export const prerender = false;
export const POST: APIRoute = async ({request,locals}) => {
 const env = runtimeEnv(locals);
 const raw = await request.text();
 if (raw.length > 100000 || !verifyResendWebhook(raw,request.headers,env.RESEND_WEBHOOK_SECRET || "")) return new Response("Invalid signature",{status:401});
 let event; try { event = JSON.parse(raw); } catch { return new Response("Invalid JSON",{status:400}); }
 if (typeof event?.type !== "string" || typeof event?.data?.email_id !== "string") return new Response("Invalid event",{status:400});
 await recordEmailEvent(await getDatabase(env),request.headers.get("svix-id")!,event);
 return new Response("OK");
};
