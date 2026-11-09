/** Deadline is exclusive: at this instant no further votes can be accepted. */
export const CURRENT_BALLOT_CLOSES_AT = "2026-12-24T13:00:00.000Z"; // 25 Dec 00:00 AEDT
export function ballotExpired(ballot: { ballotClosesAt?: Date | string | null }, now = new Date()): boolean {
  if (!ballot.ballotClosesAt) return false;
  const end = new Date(ballot.ballotClosesAt).getTime();
  return !Number.isFinite(end) || end <= now.getTime();
}
export function ballotDeadlineLabel(value: Date | string): string {
  // Show the last voting minute, rather than the exclusive next-day boundary.
  return new Date(new Date(value).getTime() - 1).toLocaleString("en-AU", {timeZone: "Australia/Melbourne", dateStyle: "full", timeStyle: "short"}) + " (Melbourne time)";
}
export function closesWithinSevenDays(ballot: { ballotClosesAt?: Date | string | null }, now = new Date()) {
  if (!ballot.ballotClosesAt || ballotExpired(ballot, now)) return false;
  return new Date(ballot.ballotClosesAt).getTime() <= now.getTime() + 7 * 86400000;
}
