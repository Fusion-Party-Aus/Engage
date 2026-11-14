/**
 * Ballot deadline helpers.
 *
 * Deadlines are exclusive: at `ballotClosesAt` (and any instant after), no
 * further votes can be accepted. Display helpers subtract 1ms so members see
 * the last voting minute in Australia/Melbourne time (e.g. 11:59 pm).
 */

/**
 * Fixed one-time expiry target for open formal ballots without an existing
 * deadline: Thursday, 14 January 2027 at 11:59 pm AEDT (Australia/Melbourne).
 * Exclusive boundary: 2027-01-15 00:00:00 AEDT = 2027-01-14T13:00:00.000Z.
 */
export const OPEN_BALLOT_EXPIRY_DEADLINE = "2027-01-14T13:00:00.000Z";
export const CURRENT_BALLOT_CLOSES_AT = OPEN_BALLOT_EXPIRY_DEADLINE;

export const BALLOT_TIMEZONE = "Australia/Melbourne";

export function ballotExpired(
  ballot: { ballotClosesAt?: Date | string | null },
  now = new Date(),
): boolean {
  if (ballot.ballotClosesAt === undefined || ballot.ballotClosesAt === null) {
    return false;
  }
  const end = new Date(ballot.ballotClosesAt).getTime();
  return !Number.isFinite(end) || end <= now.getTime();
}

function inclusiveDisplayInstant(value: Date | string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new RangeError(`Invalid ballot deadline: ${String(value)}`);
  }
  return new Date(parsed.getTime() - 1);
}

/**
 * Full Australia/Melbourne deadline label, e.g.
 * "Thursday, 14 January 2027 at 11:59 pm (Melbourne time)".
 */
export function ballotDeadlineLabel(value: Date | string): string {
  return (
    inclusiveDisplayInstant(value).toLocaleString("en-AU", {
      timeZone: BALLOT_TIMEZONE,
      dateStyle: "full",
      timeStyle: "short",
    }) + " (Melbourne time)"
  );
}

/**
 * Concise Australia/Melbourne calendar date, e.g. "14 January 2027".
 * The timezone is explicit so server and client render identical markup before
 * hydration; an implicit default would use each runtime's own timezone.
 */
export function ballotDeadlineDateLabel(
  value: Date | string,
  timeZone: string = BALLOT_TIMEZONE,
): string {
  return inclusiveDisplayInstant(value).toLocaleDateString("en-AU", {
    timeZone,
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/**
 * Short Australia/Melbourne date for compact admin tables, e.g. "14 Jan 2027".
 */
export function ballotDeadlineShortLabel(value: Date | string): string {
  return inclusiveDisplayInstant(value).toLocaleDateString("en-AU", {
    timeZone: BALLOT_TIMEZONE,
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function closesWithinSevenDays(
  ballot: { ballotClosesAt?: Date | string | null },
  now = new Date(),
): boolean {
  if (!ballot.ballotClosesAt || ballotExpired(ballot, now)) return false;
  return new Date(ballot.ballotClosesAt).getTime() <= now.getTime() + 7 * 86400000;
}

/**
 * Relative deadline string, e.g. "in 2 months", "in 3 days", "2 hours ago".
 */
export function formatRelativeDeadline(
  value: Date | string,
  now = new Date(),
): string {
  const target = new Date(value).getTime();
  if (!Number.isFinite(target)) {
    throw new RangeError(`Invalid ballot deadline: ${String(value)}`);
  }
  const diffSec = Math.round((target - now.getTime()) / 1000);
  const absSec = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat("en-AU", { numeric: "auto" });

  if (absSec < 60) {
    return diffSec >= 0 ? "in less than a minute" : "just now";
  }
  const diffMin = Math.round(diffSec / 60);
  if (Math.abs(diffMin) < 60) {
    return rtf.format(diffMin, "minute");
  }
  const diffHours = Math.round(diffSec / 3600);
  if (Math.abs(diffHours) < 24) {
    return rtf.format(diffHours, "hour");
  }
  const diffDays = Math.round(diffSec / 86400);
  if (Math.abs(diffDays) < 30) {
    return rtf.format(diffDays, "day");
  }
  const diffMonths = Math.round(diffDays / 30);
  if (Math.abs(diffMonths) < 12) {
    return rtf.format(diffMonths, "month");
  }
  return rtf.format(Math.round(diffDays / 365), "year");
}

/**
 * Full deadline formatted in the caller's local timezone (or explicit `timeZone`)
 * with short timezone abbreviation, e.g. "Thursday, 14 January 2027 at 8:59 pm AWST".
 */
export function formatLocalDeadline(
  value: Date | string,
  timeZone?: string,
): string {
  return new Intl.DateTimeFormat("en-AU", {
    ...(timeZone ? { timeZone } : {}),
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(inclusiveDisplayInstant(value));
}
