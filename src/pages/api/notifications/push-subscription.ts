import type { APIRoute } from "astro";
import { getSessionUser } from "../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../lib/db.ts";
import {
  getVapidConfig,
  listMemberPushSubscriptions,
  registerPushSubscription,
  revokePushSubscription,
} from "../../../lib/web-push.ts";

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });

  const db = await getDatabase(env);
  const vapid = getVapidConfig(env);
  const subscriptions = await listMemberPushSubscriptions(db, user.memberId);
  return Response.json({
    ok: true,
    pushConfigured: Boolean(vapid),
    vapidPublicKey: vapid?.publicKey ?? null,
    subscriptions,
  });
};

export const POST: APIRoute = async ({ request, locals, url }) => {
  if (request.headers.get("origin") !== url.origin) {
    return Response.json({ error: "Invalid origin" }, { status: 403 });
  }
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const subscription = (body.subscription ?? body) as Record<string, unknown>;
  const endpoint = typeof subscription.endpoint === "string" ? subscription.endpoint : "";
  const keys = subscription.keys as Record<string, unknown> | undefined;
  const p256dh = typeof keys?.p256dh === "string" ? keys.p256dh : "";
  const auth = typeof keys?.auth === "string" ? keys.auth : "";
  const deviceLabel = typeof body.deviceLabel === "string" ? body.deviceLabel : undefined;

  if (!endpoint || !p256dh || !auth) {
    return Response.json({ error: "Valid push subscription endpoint and keys are required" }, { status: 400 });
  }

  const db = await getDatabase(env);
  try {
    const saved = await registerPushSubscription(db, user.memberId, {
      endpoint,
      keys: { p256dh, auth },
      deviceLabel,
    });
    const subscriptions = await listMemberPushSubscriptions(db, user.memberId);
    return Response.json({ ok: true, saved, subscriptions });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Could not register push subscription" },
      { status: 400 },
    );
  }
};

export const DELETE: APIRoute = async ({ request, locals, url }) => {
  if (request.headers.get("origin") !== url.origin) {
    return Response.json({ error: "Invalid origin" }, { status: 403 });
  }
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // Allow query param fallback
  }

  const target =
    typeof body.subscriptionId === "string"
      ? body.subscriptionId
      : typeof body.endpoint === "string"
        ? body.endpoint
        : url.searchParams.get("subscriptionId") ?? url.searchParams.get("endpoint") ?? "";

  if (!target) {
    return Response.json({ error: "Subscription ID or endpoint is required" }, { status: 400 });
  }

  const db = await getDatabase(env);
  const revoked = await revokePushSubscription(db, user.memberId, target);
  const subscriptions = await listMemberPushSubscriptions(db, user.memberId);
  return Response.json({ ok: true, revoked, subscriptions });
};
