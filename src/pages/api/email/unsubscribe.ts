import type { APIRoute } from "astro";
import { getDatabase, runtimeEnv } from "../../../lib/db.ts";
import { escapeEmailHtml, readUnsubscribeToken } from "../../../lib/engagement-email.ts";
export const prerender = false;
export const ALL: APIRoute = async ({request,url,locals}) => {
 if (!["GET","POST"].includes(request.method)) return new Response(null,{status:405,headers:{Allow:"GET, POST"}});
 const env = runtimeEnv(locals), token = url.searchParams.get("token") || "";
 const memberId = readUnsubscribeToken(token,env.ENGAGE_EMAIL_SECRET || "");
 const headers = {"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Referrer-Policy":"no-referrer"};
 if (!memberId) return new Response("This unsubscribe link is not valid. Use a link from a recent Engage email, or change your settings in My Engage.",{status:400,headers});
 if (request.method === "GET") return new Response(`<!doctype html><html lang="en-AU"><title>Engage email preferences</title><body style="font-family:Arial;background:#f2eef9;color:#271047;padding:2rem"><h1>Unsubscribe from Engage reminders</h1><p>This turns off Engage digests. Your account notifications, other party communications and membership will stay as they are.</p><form method="post" action="?token=${escapeEmailHtml(token)}"><button>Unsubscribe</button></form></body></html>`,{headers});
 if (memberId.startsWith("test:")) return new Response("Test unsubscribe confirmed. No notification preferences changed.",{headers});
 const db = await getDatabase(env);
 await db.collection("engagement_email_preferences").updateOne({memberId},{$set:{memberId,digestEnabled:false,unsubscribedAt:new Date()}},{upsert:true});
 await db.collection("engagement_notification_events").insertOne({memberId,category:"engage",enabled:false,source:"email-unsubscribe",at:new Date()});
 return new Response("You are unsubscribed from Engage digests. Account notifications and general communications are unchanged. Re-enable digests in My Engage → Notifications.",{headers});
};
