import type { APIRoute } from "astro";
import { getSessionUser } from "../../../lib/auth.ts";
import { privateJson } from "../../../lib/api-contracts.ts";
import { getDatabase, runtimeEnv } from "../../../lib/db.ts";
import { resolvePublicOrigin } from "../../../lib/public-origin.ts";
import {
  NOTIFICATION_TOPICS,
  getMemberNotificationPreferences,
  updateMemberNotificationPreferences,
  type NotificationTopic,
} from "../../../lib/notifications.ts";

export const prerender = false;

const TOPIC_SET = new Set<string>(NOTIFICATION_TOPICS.map((t) => t.key));

function parseTopicMap(raw: unknown): Partial<Record<NotificationTopic, boolean>> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const result: Partial<Record<NotificationTopic, boolean>> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (TOPIC_SET.has(key) && typeof val === "boolean") {
      result[key as NotificationTopic] = val;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export const GET: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user) return privateJson({ error: "Sign in required" }, { status: 401 });

  const db = await getDatabase(env);
  const preferences = await getMemberNotificationPreferences(db, user.memberId);
  return privateJson({ ok: true, preferences });
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
  const existing = await db.collection("engagement_email_preferences").findOne({ memberId: user.memberId });
  const emailChanges = parseTopicMap(body.email);
  const pushChanges = parseTopicMap(body.push);
  const generalCommunicationsEnabled =
    typeof body.generalCommunicationsEnabled === "boolean" ? body.generalCommunicationsEnabled : undefined;

  const enablingEmail =
    (emailChanges && Object.values(emailChanges).includes(true)) || generalCommunicationsEnabled === true;

  if (existing?.suppressed && enablingEmail) {
    return privateJson(
      {
        error:
          "Email delivery is suppressed after a bounce or spam complaint. Contact an administrator to resolve delivery.",
      },
      { status: 409 },
    );
  }

  await updateMemberNotificationPreferences(db, user.memberId, {
    email: emailChanges,
    push: pushChanges,
    generalCommunicationsEnabled,
  });

  const preferences = await getMemberNotificationPreferences(db, user.memberId);
  return privateJson({ ok: true, preferences });
};
