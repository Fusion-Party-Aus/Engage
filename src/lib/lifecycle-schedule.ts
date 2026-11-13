/**
 * The approved proposal lifecycle schedule — RFC 0001 Phase 1.
 *
 * Decision register (canonical):
 * - **D3** a proposal requires a seconder before it enters Deliberate;
 * - **D4** deliberation ordinarily lasts 30 days from seconding, then the system
 *   advances the proposal to Decide automatically;
 * - **D5** an authorised officer may advance early; that path requires
 *   `ballots.bind` and is not this scheduler;
 * - **D6** the ordinary ballot period is 30 days and ballots close automatically
 *   at their deadline;
 * - **D7** the maximum scheduled time from seconding to ballot closure is
 *   60 days. It is a ceiling on the scheduled process, not a guarantee about
 *   downstream administrative acts.
 *
 * These constants and helpers are the single source of truth for the schedule.
 * Routes, scripts and UI copy must import them rather than restating durations.
 *
 * Durations are elapsed 24-hour periods, not calendar months. A 30-day deadline
 * therefore lands on the same local clock time 30 days later (plus the effect of
 * any daylight-saving transition).
 */

export const DELIBERATION_PERIOD_DAYS = 30;
export const BALLOT_PERIOD_DAYS = 30;
export const MAXIMUM_SCHEDULE_DAYS = 60;

/** Governance actor identity for scheduled transitions. Never an officer. */
export const LIFECYCLE_SYSTEM_ACTOR = "system:lifecycle-scheduler";

const MS_PER_DAY = 86_400_000;

export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * MS_PER_DAY);
}

/** D4: deliberation ends 30 days after seconding. */
export function deliberationEndsAtFrom(secondedAt: Date): Date {
  return addDays(secondedAt, DELIBERATION_PERIOD_DAYS);
}

/**
 * D6/D7: a ballot opened by the schedule closes 60 days after seconding. When
 * the scheduler advances on time this leaves the full 30-day ballot period; a
 * late run leaves less, and a run after the ceiling is refused rather than
 * opening a ballot nobody can vote in.
 */
export function scheduledBallotClosesAtFrom(secondedAt: Date): Date {
  return addDays(secondedAt, MAXIMUM_SCHEDULE_DAYS);
}

/**
 * D6: default deadline when an officer opens a ballot early. An explicit
 * `ballotClosesAt` supplied through the operator path always wins over this
 * default.
 */
export function defaultBallotClosesAtFrom(now: Date): Date {
  return addDays(now, BALLOT_PERIOD_DAYS);
}

/**
 * Amendment statuses that cannot change the ballot wording any further and so
 * do not block scheduled advancement.
 *
 * The blocking set is defined by exclusion and fails closed: any status not
 * listed here — including `proposed`, `stale`, `conflict`, `ready`, `voting`,
 * `endorsed`, `accepted` and any unknown value — blocks the schedule.
 *
 * Rationale: `proposed`/`stale`/`conflict` are explicitly unresolved;
 * `ready` and `accepted` have been approved for application but not yet applied;
 * `voting` and `endorsed` await a ballot outcome or formal acceptance. Advancing
 * to a ballot over wording that an in-flight amendment may still change would
 * bind a revision the members did not deliberate on.
 */
export const NON_BLOCKING_AMENDMENT_STATUSES = [
  "rejected",
  "withdrawn",
  "applied",
  "not-endorsed",
  "inconclusive",
] as const;

export function amendmentBlocksScheduledAdvancement(status: unknown): boolean {
  const normalized = typeof status === "string" ? status.trim().toLowerCase() : "";
  return !(NON_BLOCKING_AMENDMENT_STATUSES as readonly string[]).includes(
    normalized,
  );
}

/**
 * Deterministic event IDs make a replayed scheduler run a no-op instead of a
 * duplicate audit entry. The deadline is part of the identity, so a proposal
 * that is legitimately rescheduled produces a new event rather than colliding.
 */
export function advancementEventId(
  proposalId: string,
  deliberationEndsAt: Date | string,
): string {
  return `sched:advance:${proposalId}:${new Date(deliberationEndsAt).toISOString()}`;
}

export function ballotClosedEventId(
  proposalId: string,
  ballotClosesAt: Date | string,
): string {
  return `sched:close:${proposalId}:${new Date(ballotClosesAt).toISOString()}`;
}
