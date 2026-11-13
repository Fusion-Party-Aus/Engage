import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { digestEnabled } from "./digest-preferences.ts";
import { sendWebPushToMember, type PushSender } from "./web-push.ts";
import type { PlatformEnv } from "./types.ts";

export const MEMBER_NOTIFICATIONS_COLLECTION = "member_notifications";
export const NOTIFICATION_DELIVERIES_COLLECTION = "notification_deliveries";

export type NotificationTopic =
  | "new_ballots"
  | "closing_deadlines"
  | "contribution_responses"
  | "governance_outcomes"
  | "account_membership";

export const NOTIFICATION_TOPICS: ReadonlyArray<{
  key: NotificationTopic;
  label: string;
  description: string;
  category: "engage" | "essential";
}> = [
  {
    key: "new_ballots",
    label: "New ballots",
    description: "When a formal ballot you can vote on opens.",
    category: "engage",
  },
  {
    key: "closing_deadlines",
    label: "Closing deadlines",
    description: "Reminders for eligible ballots closing within seven days.",
    category: "engage",
  },
  {
    key: "contribution_responses",
    label: "Contribution responses",
    description: "When an officer records an outcome on your deliberation comment.",
    category: "engage",
  },
  {
    key: "governance_outcomes",
    label: "Governance outcomes",
    description: "When a ballot you followed or voted on records a formal result.",
    category: "engage",
  },
  {
    key: "account_membership",
    label: "Account and membership",
    description: "Verification updates and branch membership changes.",
    category: "essential",
  },
];

export interface UnifiedNotificationPreferences {
  email: Record<NotificationTopic, boolean>;
  push: Record<NotificationTopic, boolean>;
  generalCommunicationsEnabled: boolean;
  suppressed: boolean;
}

export interface InAppNotificationRecord {
  notificationId: string;
  memberId: string;
  topic: NotificationTopic;
  title: string;
  body: string;
  href: string;
  readAt: Date | null;
  createdAt: Date;
}

export function resolveUnifiedPreferences(
  raw: Record<string, any> | null,
  existingDigestMember = false,
): UnifiedNotificationPreferences {
  const emailEngageDefault = digestEnabled(raw, existingDigestMember);
  const emailAccountDefault = raw?.accountNotificationsEnabled !== false;
  const emailTopics = (raw?.emailTopics ?? {}) as Partial<Record<NotificationTopic, boolean>>;
  const pushTopics = (raw?.pushTopics ?? {}) as Partial<Record<NotificationTopic, boolean>>;

  return {
    email: {
      new_ballots:
        typeof emailTopics.new_ballots === "boolean"
          ? emailTopics.new_ballots
          : emailEngageDefault,
      closing_deadlines:
        typeof emailTopics.closing_deadlines === "boolean"
          ? emailTopics.closing_deadlines
          : emailEngageDefault,
      contribution_responses:
        typeof emailTopics.contribution_responses === "boolean"
          ? emailTopics.contribution_responses
          : emailEngageDefault,
      governance_outcomes:
        typeof emailTopics.governance_outcomes === "boolean"
          ? emailTopics.governance_outcomes
          : emailEngageDefault,
      account_membership:
        typeof emailTopics.account_membership === "boolean"
          ? emailTopics.account_membership
          : emailAccountDefault,
    },
    // Push is strictly opt-in and NEVER inferred from email consent.
    push: {
      new_ballots: pushTopics.new_ballots === true,
      closing_deadlines: pushTopics.closing_deadlines === true,
      contribution_responses: pushTopics.contribution_responses === true,
      governance_outcomes: pushTopics.governance_outcomes === true,
      account_membership: pushTopics.account_membership === true,
    },
    generalCommunicationsEnabled: raw?.generalCommunicationsEnabled === true,
    suppressed: raw?.suppressed === true,
  };
}

export async function getMemberNotificationPreferences(
  db: Db,
  memberId: string,
  existingDigestMember = false,
): Promise<UnifiedNotificationPreferences> {
  const raw = await db
    .collection("engagement_email_preferences")
    .findOne({ memberId });
  return resolveUnifiedPreferences(raw, existingDigestMember);
}

export async function updateMemberNotificationPreferences(
  db: Db,
  memberId: string,
  input: {
    email?: Partial<Record<NotificationTopic, boolean>>;
    push?: Partial<Record<NotificationTopic, boolean>>;
    generalCommunicationsEnabled?: boolean;
  },
  now = new Date(),
): Promise<void> {
  const existing = await db
    .collection("engagement_email_preferences")
    .findOne({ memberId });

  const setFields: Record<string, unknown> = {
    memberId,
    updatedAt: now,
  };

  if (input.email) {
    const nextEmailTopics: Record<string, boolean> = {
      ...((existing?.emailTopics as Record<string, boolean> | undefined) ?? {}),
    };
    for (const topic of NOTIFICATION_TOPICS) {
      if (typeof input.email[topic.key] === "boolean") {
        nextEmailTopics[topic.key] = input.email[topic.key] as boolean;
      }
    }
    setFields.emailTopics = nextEmailTopics;
    if (typeof input.email.closing_deadlines === "boolean") {
      setFields.digestEnabled = input.email.closing_deadlines;
    }
    if (typeof input.email.account_membership === "boolean") {
      setFields.accountNotificationsEnabled = input.email.account_membership;
    }
  }

  if (input.push) {
    const nextPushTopics: Record<string, boolean> = {
      ...((existing?.pushTopics as Record<string, boolean> | undefined) ?? {}),
    };
    for (const topic of NOTIFICATION_TOPICS) {
      if (typeof input.push[topic.key] === "boolean") {
        nextPushTopics[topic.key] = input.push[topic.key] as boolean;
      }
    }
    setFields.pushTopics = nextPushTopics;
  }

  if (typeof input.generalCommunicationsEnabled === "boolean") {
    setFields.generalCommunicationsEnabled = input.generalCommunicationsEnabled;
  }

  await db
    .collection("engagement_email_preferences")
    .updateOne({ memberId }, { $set: setFields }, { upsert: true });
}

export async function createInAppNotification(
  db: Db,
  input: {
    memberId: string;
    topic: NotificationTopic;
    title: string;
    body: string;
    href: string;
    dedupeKey?: string;
    now?: Date;
  },
): Promise<{ created: boolean; notificationId: string }> {
  const now = input.now ?? new Date();
  if (input.dedupeKey) {
    try {
      await db.collection(NOTIFICATION_DELIVERIES_COLLECTION).insertOne({
        _id: `inapp:${input.memberId}:${input.dedupeKey}` as any,
        memberId: input.memberId,
        channel: "in_app",
        topic: input.topic,
        createdAt: now,
      });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        return { created: false, notificationId: "" };
      }
      throw error;
    }
  }

  const notificationId = `notif-${randomUUID()}`;
  await db.collection<InAppNotificationRecord>(MEMBER_NOTIFICATIONS_COLLECTION).insertOne({
    notificationId,
    memberId: input.memberId,
    topic: input.topic,
    title: input.title,
    body: input.body,
    href: input.href,
    readAt: null,
    createdAt: now,
  });

  return { created: true, notificationId };
}

export async function listMemberNotifications(
  db: Db,
  memberId: string,
  limit = 30,
): Promise<InAppNotificationRecord[]> {
  return db
    .collection<InAppNotificationRecord>(MEMBER_NOTIFICATIONS_COLLECTION)
    .find({ memberId })
    .sort({ createdAt: -1 })
    .limit(Math.min(Math.max(1, limit), 100))
    .toArray();
}

export async function markNotificationRead(
  db: Db,
  memberId: string,
  notificationId: string,
  now = new Date(),
): Promise<boolean> {
  const res = await db
    .collection<InAppNotificationRecord>(MEMBER_NOTIFICATIONS_COLLECTION)
    .updateOne(
      { memberId, notificationId, readAt: null },
      { $set: { readAt: now } },
    );
  return res.matchedCount > 0;
}

export async function markAllNotificationsRead(
  db: Db,
  memberId: string,
  now = new Date(),
): Promise<number> {
  const rows = await db
    .collection<InAppNotificationRecord>(MEMBER_NOTIFICATIONS_COLLECTION)
    .find({ memberId, readAt: null })
    .toArray();
  let count = 0;
  for (const row of rows) {
    const res = await db
      .collection(MEMBER_NOTIFICATIONS_COLLECTION)
      .updateOne({ notificationId: row.notificationId, readAt: null }, { $set: { readAt: now } });
    if (res.matchedCount) count++;
  }
  return count;
}

/**
 * Centralised coordination layer for in-app and Web Push notifications.
 * Respects independent channel preferences, deduplication, and lock-screen
 * confidentiality (never exposes private branch titles on lock screens).
 */
export async function dispatchMemberNotification(
  db: Db,
  env: PlatformEnv,
  input: {
    memberId: string;
    topic: NotificationTopic;
    title: string;
    body: string;
    href: string;
    dedupeKey: string;
    isConfidential?: boolean;
    existingDigestMember?: boolean;
    pushSender?: PushSender;
    now?: Date;
  },
): Promise<{
  inAppCreated: boolean;
  push: { sent: number; failed: number; cleanedUp: number };
}> {
  const now = input.now ?? new Date();
  const prefs = await getMemberNotificationPreferences(
    db,
    input.memberId,
    Boolean(input.existingDigestMember),
  );

  const inAppResult = await createInAppNotification(db, {
    memberId: input.memberId,
    topic: input.topic,
    title: input.title,
    body: input.body,
    href: input.href,
    dedupeKey: input.dedupeKey,
    now,
  });

  let pushResult = { sent: 0, failed: 0, cleanedUp: 0 };
  if (prefs.push[input.topic]) {
    let shouldSendPush = true;
    try {
      await db.collection(NOTIFICATION_DELIVERIES_COLLECTION).insertOne({
        _id: `push:${input.memberId}:${input.dedupeKey}` as any,
        memberId: input.memberId,
        channel: "push",
        topic: input.topic,
        createdAt: now,
      });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        shouldSendPush = false;
      } else {
        throw error;
      }
    }

    if (shouldSendPush) {
      const safeTitle = input.isConfidential
        ? "Fusion Engage update"
        : input.title;
      const safeBody = input.isConfidential
        ? "Open Engage to view an update for your branch."
        : input.body;
      pushResult = await sendWebPushToMember(
        db,
        env,
        input.memberId,
        {
          title: safeTitle,
          body: safeBody,
          url: input.href,
          tag: `engage-${input.topic}`,
        },
        { sender: input.pushSender, now },
      );
    }
  }

  return {
    inAppCreated: inAppResult.created,
    push: pushResult,
  };
}
