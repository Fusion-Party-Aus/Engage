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
 */
export function ballotDeadlineDateLabel(value: Date | string): string {
  return inclusiveDisplayInstant(value).toLocaleDateString("en-AU", {
    timeZone: BALLOT_TIMEZONE,
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
