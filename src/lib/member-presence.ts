import type { Db } from "mongodb";
import { recordLifecycle } from "./member-lifecycle.ts";

/**
 * Genuine authenticated use of Engage, recorded once per member per day.
 *
 * This is the activity signal behind the 90-day active electorate. It records a
 * signed-in session opening a page, not a vote, an administrative action or a
 * scheduled job. The write is idempotent and throttled in-process so ordinary
 * browsing does not produce one database write per request.
 */
const recordedThisProcess = new Set<string>();
const MAX_REMEMBERED_MEMBERS = 5_000;

export function activityDayWindow(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export async function recordAuthenticatedActivity(
  db: Db,
  memberId: string,
  now = new Date(),
): Promise<void> {
  const id = memberId.trim();
  if (!id) return;
  const day = activityDayWindow(now);
  const key = `${id}:${day}`;
  if (recordedThisProcess.has(key)) return;
  recordedThisProcess.add(key);
  if (recordedThisProcess.size > MAX_REMEMBERED_MEMBERS) {
    recordedThisProcess.clear();
  }
  // Activity tracking must never prevent sign-in or page rendering. A failed
  // write simply leaves the member's next request to try again.
  await recordLifecycle(db, id, "activity_day", now, day).catch(() => {});
}
