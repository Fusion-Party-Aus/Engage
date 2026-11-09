import type { APIRoute } from "astro";
import { getSessionUser } from "../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../lib/db.ts";
import { notificationPreferenceChanges } from "../../../lib/digest-preferences.ts";
export const prerender = false;
export const POST: APIRoute = async ({request,locals,url}) => {
 if (request.headers.get("origin") !== url.origin) return Response.json({error:"Invalid origin"},{status:403});
 const env = runtimeEnv(locals), user = await getSessionUser(request,env);
 if (!user) return Response.json({error:"Sign in required"},{status:401});
 const form = await request.formData();
 let changes;
 try { changes = notificationPreferenceChanges(form); } catch { return Response.json({error:"Unknown notification category"},{status:400}); }
 const db = await getDatabase(env);
 const existing = await db.collection("engagement_email_preferences").findOne({memberId:user.memberId});
 if (existing?.suppressed && Object.values(changes).includes(true)) return Response.json({error:"Email delivery is suppressed after a bounce or spam complaint. Contact an administrator to resolve delivery."},{status:409});
 await db.collection("engagement_email_preferences").updateOne({memberId:user.memberId},{$set:{memberId:user.memberId,...changes,preferenceSource:"member",updatedAt:new Date()}},{upsert:true});
 await db.collection("engagement_notification_events").insertOne({memberId:user.memberId,category:String(form.get("category") ?? "engage"),enabled:Object.values(changes)[0],source:"my-engage",at:new Date()});
 return Response.redirect(new URL("/member/?view=notifications&emailPreferences=saved",url),303);
};
