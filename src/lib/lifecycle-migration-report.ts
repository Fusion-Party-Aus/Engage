import type { Db } from "mongodb";

/**
 * Read-only reporting for governance records created before the approved
 * lifecycle schedule (D3–D7) existed.
 *
 * This module never writes. It exists so an operator can see exactly which
 * matters cannot be scheduled automatically and choose a recovery path
 * knowingly, instead of the scheduler inventing a deadline or a seconder.
 *
 * The two populations it reports:
 *
 * 1. **Open ballots with no usable deadline.** The scheduler only closes a
 *    ballot whose `ballotClosesAt` it can read. These records keep accepting
 *    votes exactly as they did before this change.
 * 2. **Proposals in Deliberate with no `deliberationEndsAt`.** They were never
 *    seconded, so they have no approved deliberation clock and the scheduler
 *    will never advance them.
 */

export interface BallotDeadlineGap {
  collection: "proposals" | "amendments" | "ballots";
  id: string;
  title: string;
  stage: string;
  deadlineState: "missing" | "malformed";
  rawDeadline?: string;
  ballotRevisionId?: string;
  ballotClosedAt?: string;
}

export interface DeliberationDeadlineGap {
  proposalId: string;
  title: string;
  stage: string;
  secondedBy?: string;
  secondedAt?: string;
  rawDeliberationEndsAt?: string;
  deadlineState: "missing" | "malformed";
}

export interface LifecycleMigrationReport {
  reportId: "lifecycle-deadline-migration";
  readOnly: true;
  generatedAt: string;
  counts: {
    openBallotsWithoutDeadline: number;
    deliberateWithoutDeliberationDeadline: number;
  };
  openBallotsWithoutDeadline: BallotDeadlineGap[];
  deliberateWithoutDeliberationDeadline: DeliberationDeadlineGap[];
  recoveryOptions: string[];
}

const RECOVERY_OPTIONS = [
  "No recovery is automatic. This report changes nothing and the scheduler skips every record it lists.",
  "Open proposal ballot without a deadline: an authorised officer sets an explicit future closing date through the proposal administration path, then the scheduler records `ballot.closed` at that deadline. Historical records may alternatively be carried to a formal result and advanced by the existing officer workflow; the scheduler will not close a ballot it cannot date.",
  "Open amendment ballot without a deadline: close it with the amendment ballot close action, which records the endorsement outcome. The scheduler never closes amendment ballots.",
  "Proposal in Deliberate without `deliberationEndsAt`: it was never seconded, so no approved deliberation clock exists and it will never advance automatically. An officer holding `ballots.bind` may advance it explicitly with a closing date. Backfilling a seconder or a deadline would fabricate a governance act and requires a separate maintainer-approved migration.",
  "`ballots` projection rows without `closesAt` mirror the proposal or amendment they describe; resolving the source record resolves the projection.",
  "After any manual recovery, re-run `npm run governance:scheduler -- --dry-run` to confirm the scheduler sees the expected deadlines before applying.",
];

function asDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  return null;
}

function describeDeadline(value: unknown): {
  state: "ok" | "missing" | "malformed";
  raw?: string;
} {
  if (value === undefined || value === null || value === "") {
    return { state: "missing" };
  }
  // MongoDB `$lte: now` queries only match BSON Date values; string dates would
  // be silently skipped by the scheduler and require manual recovery.
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return { state: "ok" };
  }
  return { state: "malformed", raw: String(value) };
}

export async function buildLifecycleMigrationReport(
  db: Db,
  options: { now?: Date } = {},
): Promise<LifecycleMigrationReport> {
  const now = options.now ?? new Date();
  const [proposals, amendments, ballots] = await Promise.all([
    db.collection("proposals").find({}).toArray(),
    db.collection("amendments").find({ status: "voting" }).toArray(),
    db.collection("ballots").find({ status: "open" }).toArray(),
  ]);

  const openBallotsWithoutDeadline: BallotDeadlineGap[] = [];
  const deliberateWithoutDeliberationDeadline: DeliberationDeadlineGap[] = [];

  for (const row of proposals) {
    const proposalId = String(row.proposalId ?? "").trim();
    if (!proposalId) continue;
    const title = String(row.title ?? proposalId);

    if (row.stage === "decide") {
      const deadline = describeDeadline(row.ballotClosesAt);
      if (deadline.state !== "ok") {
        openBallotsWithoutDeadline.push({
          collection: "proposals",
          id: proposalId,
          title,
          stage: String(row.stage),
          deadlineState: deadline.state,
          ...(deadline.raw ? { rawDeadline: deadline.raw } : {}),
          ...(row.ballotRevisionId
            ? { ballotRevisionId: String(row.ballotRevisionId) }
            : {}),
          ...(asDate(row.ballotClosedAt)
            ? { ballotClosedAt: asDate(row.ballotClosedAt)!.toISOString() }
            : {}),
        });
      }
    }

    if (row.stage === "deliberate") {
      const deadline = describeDeadline(row.deliberationEndsAt);
      if (deadline.state !== "ok") {
        deliberateWithoutDeliberationDeadline.push({
          proposalId,
          title,
          stage: String(row.stage),
          ...(row.secondedBy ? { secondedBy: String(row.secondedBy) } : {}),
          ...(asDate(row.secondedAt)
            ? { secondedAt: asDate(row.secondedAt)!.toISOString() }
            : {}),
          ...(deadline.raw ? { rawDeliberationEndsAt: deadline.raw } : {}),
          deadlineState: deadline.state,
        });
      }
    }
  }

  for (const row of amendments) {
    const amendmentId = String(row.amendmentId ?? "").trim();
    if (!amendmentId) continue;
    const deadline = describeDeadline(row.ballotClosesAt);
    if (deadline.state === "ok") continue;
    openBallotsWithoutDeadline.push({
      collection: "amendments",
      id: amendmentId,
      title: String(row.title ?? amendmentId),
      stage: String(row.status ?? "voting"),
      deadlineState: deadline.state,
      ...(deadline.raw ? { rawDeadline: deadline.raw } : {}),
    });
  }

  for (const row of ballots) {
    const ballotId = String(row.ballotId ?? "").trim();
    if (!ballotId) continue;
    const deadline = describeDeadline(row.closesAt ?? row.ballotClosesAt);
    if (deadline.state === "ok") continue;
    openBallotsWithoutDeadline.push({
      collection: "ballots",
      id: ballotId,
      title: String(row.matterId ?? ballotId),
      stage: String(row.status ?? "open"),
      deadlineState: deadline.state,
      ...(deadline.raw ? { rawDeadline: deadline.raw } : {}),
    });
  }

  return {
    reportId: "lifecycle-deadline-migration",
    readOnly: true,
    generatedAt: now.toISOString(),
    counts: {
      openBallotsWithoutDeadline: openBallotsWithoutDeadline.length,
      deliberateWithoutDeliberationDeadline:
        deliberateWithoutDeliberationDeadline.length,
    },
    openBallotsWithoutDeadline,
    deliberateWithoutDeliberationDeadline,
    recoveryOptions: RECOVERY_OPTIONS,
  };
}
