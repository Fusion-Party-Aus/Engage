import type { APIRoute } from "astro";
import { getSessionUser } from "../../../lib/auth.ts";
import { privateJson, toNotificationDto } from "../../../lib/api-contracts.ts";
import { getDatabase, runtimeEnv } from "../../../lib/db.ts";
import { resolvePublicOrigin } from "../../../lib/public-origin.ts";
import {
  listMemberNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "../../../lib/notifications.ts";

export const prerender = false;

export const GET: APIRoute = async ({ request, locals, url }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user) return privateJson({ error: "Sign in required" }, { status: 401 });

  const limitParam = Number(url.searchParams.get("limit") ?? "25");
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(1, Math.trunc(limitParam)), 100) : 25;

  const db = await getDatabase(env);
  const notifications = await listMemberNotifications(db, user.memberId, limit);
  const unreadCount = notifications.filter((item) => !item.readAt).length;
  return privateJson({
    ok: true,
    unreadCount,
    notifications: notifications.map(toNotificationDto),
  });
};

export const POST: APIRoute = async ({ request, locals, url }) => {
  const env = runtimeEnv(locals);
  if (request.headers.get("origin") !== resolvePublicOrigin({ env, requestUrl: url })) {
    return privateJson({ error: "Invalid origin" }, { status: 403 });
  }
  const user = await getSessionUser(request, env);
  if (!user) return privateJson({ error: "Sign in required" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return privateJson({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const db = await getDatabase(env);
  if (body.action === "mark_all_read") {
    const updated = await markAllNotificationsRead(db, user.memberId);
    return privateJson({ ok: true, updated });
  }

  if (body.action === "mark_read" && typeof body.notificationId === "string" && body.notificationId) {
    const updated = await markNotificationRead(db, user.memberId, body.notificationId);
    return privateJson({ ok: true, updated });
  }

  return privateJson({ error: "Unsupported inbox action" }, { status: 400 });
};
