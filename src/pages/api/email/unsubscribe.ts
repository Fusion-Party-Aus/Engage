import type { APIRoute } from "astro";
import { getDatabase, runtimeEnv } from "../../../lib/db.ts";
import { escapeEmailHtml, readUnsubscribeToken } from "../../../lib/engagement-email.ts";
export const prerender = false;
export const ALL: APIRoute = async ({request,url,locals}) => {
 if (!["GET","POST"].includes(request.method)) return new Response(null,{status:405,headers:{Allow:"GET, POST"}});
 const env = runtimeEnv(locals), token = url.searchParams.get("token") || "";
 const memberId = readUnsubscribeToken(token,env.ENGAGE_EMAIL_SECRET || "");
 const headers = {"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Referrer-Policy":"no-referrer"};
 if (!memberId) return new Response("Invalid unsubscribe link.",{status:400,headers});
 if (request.method === "GET") return new Response(`<!doctype html><html lang="en"><title>Engage email preferences</title><body style="font-family:Arial;background:#f2eef9;color:#271047;padding:2rem"><h1>Unsubscribe from Engage reminders</h1><p>Sign-in emails and your membership are unaffected.</p><form method="post" action="?token=${escapeEmailHtml(token)}"><button>Unsubscribe</button></form></body></html>`,{headers});
 const db = await getDatabase(env);
 await db.collection("engagement_email_preferences").updateOne({memberId},{$set:{memberId,digestEnabled:false,unsubscribedAt:new Date()}},{upsert:true});
 await db.collection("engagement_notification_events").insertOne({memberId,category:"engage",enabled:false,source:"email-unsubscribe",at:new Date()});
 return new Response("You are unsubscribed from Engage digests. Account notifications and general communications are unchanged. Re-enable digests in My Engage → Notifications.",{headers});
};
