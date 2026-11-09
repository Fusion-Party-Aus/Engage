import type { Db } from "mongodb";
export interface DigestPreference {
  [key: string]: unknown;
  digestEnabled?: boolean;
  accountNotificationsEnabled?: boolean;
  generalCommunicationsEnabled?: boolean;
  suppressed?: boolean;
  unsubscribedAt?: Date;
}
export function digestEnabled(preference: DigestPreference | null, existingMember = false): boolean {
  if (preference?.suppressed || preference?.unsubscribedAt && preference.digestEnabled !== true) return false;
  return typeof preference?.digestEnabled === "boolean" ? preference.digestEnabled : existingMember;
}
/** Freeze the rollout cohort once. Future accounts never enter it on restart or redeployment. */
export async function ensureDigestCohort(db: Db): Promise<Set<string>> {
  const collection = db.collection<{_id:string; memberIds:string[]; capturedAt:Date}>("engagement_email_rollouts");
  const id = "ballot-reminders-v1";
  let rollout = await collection.findOne({_id:id});
  if (!rollout) {
    const accounts = await db.collection("user").find({}).project({_id:1}).toArray();
    await collection.updateOne({_id:id}, {$setOnInsert:{memberIds:accounts.map(a=>String(a._id)),capturedAt:new Date()}}, {upsert:true});
    rollout = await collection.findOne({_id:id});
  }
  if (!rollout || !Array.isArray(rollout.memberIds)) throw new Error("The ballot reminder rollout cohort is unavailable");
  return new Set(rollout.memberIds);
}

export type NotificationCategory = "essential" | "engage" | "general";
/** Security/authentication mail is unconditional and never uses these optional-mail preferences. */
export function notificationEnabled(preference: DigestPreference | null, category: NotificationCategory, existingMember = false): boolean {
  if (preference?.suppressed) return false;
  if (category === "engage") return digestEnabled(preference,existingMember);
  if (category === "essential") return preference?.accountNotificationsEnabled !== false;
  return preference?.generalCommunicationsEnabled === true;
}
export function notificationPreferenceChanges(form: FormData) {
  const category = form.get("category") ?? "engage";
  if (category === "essential") return {accountNotificationsEnabled:form.get("accountNotificationsEnabled") === "true"};
  if (category === "general") return {generalCommunicationsEnabled:form.get("generalCommunicationsEnabled") === "true"};
  if (category === "engage") return {digestEnabled:form.get("digestEnabled") === "true"};
  throw new Error("Unknown notification category");
}
