import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import * as webpush from "web-push";
import type { PlatformEnv } from "./types.ts";

export const PUSH_SUBSCRIPTIONS_COLLECTION = "push_subscriptions";

export interface PushSubscriptionInput {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  deviceLabel?: string;
}

export interface StoredPushSubscription {
  subscriptionId: string;
  memberId: string;
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  deviceLabel: string;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt?: Date;
  revokedAt?: Date | null;
}

export interface SafePushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

export function getVapidConfig(env: PlatformEnv): {
  publicKey: string;
  privateKey: string;
  subject: string;
} | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  const subject = env.VAPID_SUBJECT?.trim() || "mailto:engage@fusionparty.org.au";
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject };
}

function subscriptionIdFor(memberId: string, endpoint: string): string {
  return `push-${createHash("sha256")
    .update(`${memberId}\0${endpoint}`)
    .digest("hex")
    .slice(0, 24)}`;
}

export function validatePushEndpoint(endpoint: string): boolean {
  try {
    const parsed = new URL(endpoint);
    return (
      parsed.protocol === "https:" ||
      (parsed.protocol === "http:" &&
        (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"))
    );
  } catch {
    return false;
  }
}

export async function registerPushSubscription(
  db: Db,
  memberId: string,
  input: PushSubscriptionInput,
  now = new Date(),
): Promise<{ subscriptionId: string; deviceLabel: string }> {
  const endpoint = String(input.endpoint ?? "").trim();
  const p256dh = String(input.keys?.p256dh ?? "").trim();
  const auth = String(input.keys?.auth ?? "").trim();
  if (!validatePushEndpoint(endpoint) || !p256dh || !auth) {
    throw new Error("A valid push subscription endpoint and encryption keys are required.");
  }

  const subscriptionId = subscriptionIdFor(memberId, endpoint);
  const deviceLabel =
    String(input.deviceLabel ?? "").trim().slice(0, 80) || "This browser";

  await db.collection<StoredPushSubscription>(PUSH_SUBSCRIPTIONS_COLLECTION).updateOne(
    { subscriptionId },
    {
      $set: {
        memberId,
        endpoint,
        keys: { p256dh, auth },
        deviceLabel,
        updatedAt: now,
        revokedAt: null,
      },
      $setOnInsert: {
        subscriptionId,
        createdAt: now,
      },
    },
    { upsert: true },
  );

  return { subscriptionId, deviceLabel };
}

export async function revokePushSubscription(
  db: Db,
  memberId: string,
  subscriptionIdOrEndpoint: string,
  now = new Date(),
): Promise<boolean> {
  const target = subscriptionIdOrEndpoint.trim();
  if (!target) return false;
  const result = await db
    .collection<StoredPushSubscription>(PUSH_SUBSCRIPTIONS_COLLECTION)
    .updateOne(
      {
        memberId,
        $or: [{ subscriptionId: target }, { endpoint: target }],
        revokedAt: null,
      },
      {
        $set: { revokedAt: now, updatedAt: now },
      },
    );
  return result.matchedCount > 0;
}

export async function listMemberPushSubscriptions(
  db: Db,
  memberId: string,
): Promise<
  Array<{
    subscriptionId: string;
    deviceLabel: string;
    createdAt: Date;
    lastUsedAt?: Date;
  }>
> {
  const rows = await db
    .collection<StoredPushSubscription>(PUSH_SUBSCRIPTIONS_COLLECTION)
    .find({ memberId, revokedAt: null })
    .sort({ createdAt: -1 })
    .toArray();
  return rows.map((row) => ({
    subscriptionId: row.subscriptionId,
    deviceLabel: row.deviceLabel,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  }));
}

export type PushSender = (
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  options: { vapidDetails: { subject: string; publicKey: string; privateKey: string } },
) => Promise<{ statusCode?: number }>;

export async function sendWebPushToMember(
  db: Db,
  env: PlatformEnv,
  memberId: string,
  payload: SafePushPayload,
  options: { sender?: PushSender; now?: Date } = {},
): Promise<{ sent: number; failed: number; cleanedUp: number }> {
  const vapid = getVapidConfig(env);
  if (!vapid) {
    return { sent: 0, failed: 0, cleanedUp: 0 };
  }

  const now = options.now ?? new Date();
  const sender: PushSender =
    options.sender ??
    ((sub, body, opts) => webpush.sendNotification(sub, body, opts));

  const subscriptions = await db
    .collection<StoredPushSubscription>(PUSH_SUBSCRIPTIONS_COLLECTION)
    .find({ memberId, revokedAt: null })
    .toArray();

  let sent = 0;
  let failed = 0;
  let cleanedUp = 0;
  const serialized = JSON.stringify(payload);

  for (const sub of subscriptions) {
    try {
      await sender(
        { endpoint: sub.endpoint, keys: sub.keys },
        serialized,
        { vapidDetails: vapid },
      );
      sent++;
      await db
        .collection(PUSH_SUBSCRIPTIONS_COLLECTION)
        .updateOne(
          { subscriptionId: sub.subscriptionId },
          { $set: { lastUsedAt: now, updatedAt: now } },
        );
    } catch (error: any) {
      const statusCode = Number(error?.statusCode ?? 0);
      if (statusCode === 404 || statusCode === 410) {
        cleanedUp++;
        await db
          .collection(PUSH_SUBSCRIPTIONS_COLLECTION)
          .updateOne(
            { subscriptionId: sub.subscriptionId },
            { $set: { revokedAt: now, updatedAt: now } },
          );
      } else {
        failed++;
      }
    }
  }

  return { sent, failed, cleanedUp };
}
