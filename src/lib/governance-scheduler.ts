import type { Db } from "mongodb";
import { BALLOTS_COLLECTION } from "./ballots.ts";
import { runInTransaction } from "./db.ts";
import { recordGovernanceEventOnce } from "./governance-relationships.ts";
import {
  LIFECYCLE_SYSTEM_ACTOR,
  amendmentBlocksScheduledAdvancement,
  advancementEventId,
  ballotClosedEventId,
  scheduledBallotClosesAtFrom,
} from "./lifecycle-schedule.ts";
import type { ProposalRecord } from "./types.ts";
import { PROPOSAL_VOTES, proposalBallotId } from "./vote-storage.ts";

/**
 * Scheduled governance transitions — RFC 0001 Phase 1.
 *
 * The scheduler is a **system actor**, not an officer. It advances a matter at
 * the deliberation deadline (D4) and records the closure of a ballot at its
 * deadline (D6). It deliberately does not:
 *
 * - require or grant `ballots.bind` — that gate applies to humans advancing
 *   early (D5) and is enforced by `saveProposal`;
 * - record a ballot result, certify a ballot or change the lifecycle stage when
 *   a ballot closes;
 * - close a ballot early because the outcome looks irreversible (D12);
 * - close amendment ballots, which have their own explicit close action.
 *
 * Every operation is a conditional update plus a deterministic governance event
 * inside one transaction, so concurrent or replayed runs do nothing twice and a
 * crash cannot leave a transition without its audit record.
 */

export type SchedulerSkipReason =
  | "already_advanced"
  | "stage_changed"
  | "no_current_revision"
  | "missing_proposal_id"
  | "invalid_deadline";

export type AdvancementBlockerReason =
  | "blocking_amendments"
  | "ballot_revision_conflict"
  | "scheduled_ballot_deadline_passed"
  | "missing_schedule_anchor";

export interface ScheduledAdvancement {
  proposalId: string;
  revisionId: string;
  previousRevisionId?: string;
  deliberationEndsAt: string;
  ballotClosesAt: string;
  eventId: string;
}

export interface AdvancementBlocker {
  proposalId: string;
  reason: AdvancementBlockerReason;
  detail: string;
  amendmentIds?: string[];
}

export interface SchedulerSkip {
  proposalId: string;
  reason: SchedulerSkipReason;
  detail?: string;
}

export interface ScheduledClosure {
  proposalId: string;
  ballotId: string;
  ballotClosesAt: string;
  closedAt: string;
  eventId: string;
}

export interface SchedulerError {
  proposalId?: string;
  stage: "advance" | "close";
  message: string;
}

export interface AdvancementReport {
  advanced: ScheduledAdvancement[];
  skipped: SchedulerSkip[];
  blockers: AdvancementBlocker[];
  errors: SchedulerError[];
}

export interface ClosureReport {
  closed: ScheduledClosure[];
  skipped: SchedulerSkip[];
  errors: SchedulerError[];
}

export interface GovernanceSchedulerReport {
  mode: "dry-run" | "apply";
  actorId: string;
  now: string;
  counts: {
    advanced: number;
    skipped: number;
    closed: number;
    blockers: number;
    errors: number;
  };
  advanced: ScheduledAdvancement[];
  skipped: SchedulerSkip[];
  closed: ScheduledClosure[];
  blockers: AdvancementBlocker[];
  errors: SchedulerError[];
}

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

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

type AdvancementDecision =
  | { action: "advance"; plan: Omit<ScheduledAdvancement, "eventId"> }
  | { action: "skip"; reason: SchedulerSkipReason; detail?: string }
  | {
      action: "block";
      reason: AdvancementBlockerReason;
      detail: string;
      amendmentIds?: string[];
    };

/**
 * Read-only evaluation of one candidate. All refusal reasons are returned as
 * data so a run reports what it deliberately did not do.
 */
async function evaluateAdvancement(
  db: Db,
  raw: Record<string, any>,
  now: Date,
): Promise<AdvancementDecision> {
  const proposalId = stringField(raw.proposalId);
  if (!proposalId) {
    return {
      action: "skip",
      reason: "missing_proposal_id",
      detail: "Document has no proposalId; it cannot be advanced or audited.",
    };
  }

  const deliberationEndsAt = asDate(raw.deliberationEndsAt);
  const secondedAt = asDate(raw.secondedAt);
  if (!deliberationEndsAt || !secondedAt) {
    return {
      action: "block",
      reason: "missing_schedule_anchor",
      detail:
        "The deliberation deadline or seconding time is missing or malformed, so the 60-day ballot ceiling (D7) cannot be derived. An authorised officer must advance the matter explicitly.",
    };
  }

  const amendments = await db.collection("amendments").find({ proposalId }).toArray();
  const blocking = amendments.filter((amendment) =>
    amendmentBlocksScheduledAdvancement(amendment.status),
  );
  if (blocking.length > 0) {
    const amendmentIds = blocking.map((amendment) =>
      String(amendment.amendmentId ?? amendment._id ?? "unknown"),
    );
    const statuses = [
      ...new Set(
        blocking.map((amendment) => String(amendment.status ?? "unknown")),
      ),
    ].join(", ");
    return {
      action: "block",
      reason: "blocking_amendments",
      detail: `${blocking.length} amendment(s) are not resolved (${statuses}). Resolve or withdraw them before the scheduled ballot opens.`,
      amendmentIds,
    };
  }

  const latest = await db
    .collection("proposal_revisions")
    .find({ proposalId })
    .sort({ createdAt: -1, _id: -1 })
    .limit(1)
    .toArray();
  const latestRevisionId = stringField(latest[0]?.revisionId);
  if (!latestRevisionId) {
    return {
      action: "skip",
      reason: "no_current_revision",
      detail: "The matter has no immutable wording revision to bind.",
    };
  }

  const existingRevisionId = stringField(raw.ballotRevisionId);
  const votes = await db
    .collection(PROPOSAL_VOTES)
    .find({ proposalId, ballotId: proposalBallotId(proposalId) })
    .toArray();
  if (votes.length > 0) {
    const votedRevisionIds = new Set(
      votes.map((vote) => stringField(vote.revisionId)),
    );
    const votesOnCurrentWording =
      votedRevisionIds.size === 1 && votedRevisionIds.has(latestRevisionId);
    if (
      !votesOnCurrentWording ||
      (existingRevisionId && existingRevisionId !== latestRevisionId)
    ) {
      return {
        action: "block",
        reason: "ballot_revision_conflict",
        detail:
          "This matter already has votes that are not bound to the current wording revision. An authorised officer must review the binding before it returns to a ballot.",
      };
    }
  }

  const ballotClosesAt = scheduledBallotClosesAtFrom(secondedAt);
  if (ballotClosesAt.getTime() <= now.getTime()) {
    return {
      action: "block",
      reason: "scheduled_ballot_deadline_passed",
      detail: `The 60-day ceiling from seconding (${ballotClosesAt.toISOString()}) has already passed, so a scheduled ballot would accept no votes. An authorised officer must re-open the ballot with an explicit closing date.`,
    };
  }

  return {
    action: "advance",
    plan: {
      proposalId,
      revisionId: latestRevisionId,
      ...(existingRevisionId && existingRevisionId !== latestRevisionId
        ? { previousRevisionId: existingRevisionId }
        : {}),
      deliberationEndsAt: deliberationEndsAt.toISOString(),
      ballotClosesAt: ballotClosesAt.toISOString(),
    },
  };
}

/**
 * Move every seconded matter whose deliberation deadline has arrived to Decide.
 *
 * The candidate query is `{stage: "deliberate", deliberationEndsAt: {$lte: now}}`
 * and the write repeats that filter, so a concurrent run or an officer acting at
 * the same instant wins exactly once.
 */
export async function advanceDueDeliberations(
  db: Db,
  options: { now?: Date; dryRun?: boolean } = {},
): Promise<AdvancementReport> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;
  const report: AdvancementReport = {
    advanced: [],
    skipped: [],
    blockers: [],
    errors: [],
  };

  const candidates = await db
    .collection<ProposalRecord>("proposals")
    .find({ stage: "deliberate", deliberationEndsAt: { $lte: now } })
    .toArray();

  for (const raw of candidates as Record<string, any>[]) {
    try {
      const decision = await evaluateAdvancement(db, raw, now);
      if (decision.action === "skip") {
        report.skipped.push({
          proposalId: stringField(raw.proposalId),
          reason: decision.reason,
          ...(decision.detail ? { detail: decision.detail } : {}),
        });
        continue;
      }
      if (decision.action === "block") {
        report.blockers.push({
          proposalId: stringField(raw.proposalId),
          reason: decision.reason,
          detail: decision.detail,
          ...(decision.amendmentIds ? { amendmentIds: decision.amendmentIds } : {}),
        });
        continue;
      }

      const { plan } = decision;
      const eventId = advancementEventId(
        plan.proposalId,
        plan.deliberationEndsAt,
      );
      if (dryRun) {
        report.advanced.push({ ...plan, eventId });
        continue;
      }

      const applied = await runInTransaction(db, async (session) => {
        const sessionOpts = session ? { session } : undefined;
        const txAmendments = await db
          .collection("amendments")
          .find({ proposalId: plan.proposalId }, sessionOpts)
          .toArray();
        if (
          txAmendments.some((amendment) =>
            amendmentBlocksScheduledAdvancement(amendment.status),
          )
        ) {
          return null;
        }
        const txLatest = await db
          .collection("proposal_revisions")
          .find({ proposalId: plan.proposalId }, sessionOpts)
          .sort({ createdAt: -1, _id: -1 })
          .limit(1)
          .toArray();
        if (stringField(txLatest[0]?.revisionId) !== plan.revisionId) {
          return null;
        }
        const filter: Record<string, unknown> = {
          proposalId: plan.proposalId,
          stage: "deliberate",
          deliberationEndsAt: { $lte: now },
        };
        if (raw.updatedAt !== undefined) {
          filter.updatedAt = raw.updatedAt;
        }
        const write = await db.collection<ProposalRecord>("proposals").updateOne(
          filter,
          {
            $set: {
              stage: "decide",
              ballotRevisionId: plan.revisionId,
              ballotRevisionBoundAt: now,
              ballotRevisionBoundBy: LIFECYCLE_SYSTEM_ACTOR,
              ballotClosesAt: new Date(plan.ballotClosesAt),
              updatedAt: now,
            },
          },
          sessionOpts,
        );
        if (write.matchedCount !== 1) return null;
        await recordGovernanceEventOnce(
          db,
          {
            eventId,
            eventType: "proposal.stage_transition",
            matterId: plan.proposalId,
            revisionId: plan.revisionId,
            actorId: LIFECYCLE_SYSTEM_ACTOR,
            ...(stringField(raw.governanceAuthorityBranchId)
              ? { authorityBranchId: stringField(raw.governanceAuthorityBranchId) }
              : {}),
            metadata: {
              fromStage: "deliberate",
              toStage: "decide",
              trigger: "scheduled_deliberation_deadline",
              secondedAt: asDate(raw.secondedAt)?.toISOString(),
              deliberationEndsAt: plan.deliberationEndsAt,
              ballotClosesAt: plan.ballotClosesAt,
              ...(plan.previousRevisionId
                ? { previousRevisionId: plan.previousRevisionId }
                : {}),
            },
            createdAt: now,
          },
          session,
        );
        return true;
      });

      if (applied) {
        report.advanced.push({ ...plan, eventId });
        continue;
      }

      const current = await db
        .collection<ProposalRecord>("proposals")
        .findOne({ proposalId: plan.proposalId });
      report.skipped.push({
        proposalId: plan.proposalId,
        reason: current?.stage === "decide" ? "already_advanced" : "stage_changed",
        detail:
          current?.stage === "decide"
            ? "Another scheduler run advanced this matter first."
            : `The matter left Deliberate (now '${String(current?.stage ?? "missing")}') before the scheduled transition.`,
      });
    } catch (error) {
      report.errors.push({
        proposalId: stringField(raw.proposalId) || undefined,
        stage: "advance",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return report;
}

/**
 * Record `ballot.closed` once for every proposal ballot whose deadline has
 * passed. The stage is not changed and no result is recorded: members can no
 * longer vote because `ballotExpired` refuses the act, and the outcome remains a
 * separate governance decision (D9–D20).
 */
export async function closeDueBallots(
  db: Db,
  options: { now?: Date; dryRun?: boolean } = {},
): Promise<ClosureReport> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;
  const report: ClosureReport = { closed: [], skipped: [], errors: [] };

  const candidates = await db
    .collection<ProposalRecord>("proposals")
    .find({
      stage: "decide",
      ballotClosesAt: { $lte: now },
      ballotClosedAt: { $exists: false },
    })
    .toArray();

  for (const raw of candidates as Record<string, any>[]) {
    const proposalId = stringField(raw.proposalId);
    try {
      if (!proposalId) {
        report.skipped.push({
          proposalId: "",
          reason: "missing_proposal_id",
          detail: "Document has no proposalId; it cannot be closed or audited.",
        });
        continue;
      }
      const ballotClosesAt = asDate(raw.ballotClosesAt);
      if (!ballotClosesAt) {
        report.skipped.push({
          proposalId,
          reason: "invalid_deadline",
          detail:
            "ballotClosesAt is not a usable date; the closure deadline needs manual review.",
        });
        continue;
      }
      const ballotId = proposalBallotId(proposalId);
      const eventId = ballotClosedEventId(proposalId, ballotClosesAt);
      if (dryRun) {
        report.closed.push({
          proposalId,
          ballotId,
          ballotClosesAt: ballotClosesAt.toISOString(),
          closedAt: now.toISOString(),
          eventId,
        });
        continue;
      }

      const applied = await runInTransaction(db, async (session) => {
        const sessionOpts = session ? { session } : undefined;
        const write = await db.collection<ProposalRecord>("proposals").updateOne(
          {
            proposalId,
            stage: "decide",
            ballotClosesAt: { $lte: now },
            ballotClosedAt: { $exists: false },
          },
          { $set: { ballotClosedAt: now } },
          sessionOpts,
        );
        if (write.matchedCount !== 1) return false;
        // Keep the distinct ballot projection consistent when a row exists.
        // Amendment ballots are not touched: they have their own close action.
        await db.collection(BALLOTS_COLLECTION).updateOne(
          { ballotId, status: "open" },
          { $set: { status: "closed", updatedAt: now } },
          sessionOpts,
        );
        await recordGovernanceEventOnce(
          db,
          {
            eventId,
            eventType: "ballot.closed",
            matterId: proposalId,
            ballotId,
            ...(stringField(raw.ballotRevisionId)
              ? { revisionId: stringField(raw.ballotRevisionId) }
              : {}),
            actorId: LIFECYCLE_SYSTEM_ACTOR,
            ...(stringField(raw.governanceAuthorityBranchId)
              ? { authorityBranchId: stringField(raw.governanceAuthorityBranchId) }
              : {}),
            metadata: {
              trigger: "scheduled_ballot_deadline",
              ballotClosesAt: ballotClosesAt.toISOString(),
              closedAt: now.toISOString(),
            },
            createdAt: now,
          },
          session,
        );
        return true;
      });

      if (applied) {
        report.closed.push({
          proposalId,
          ballotId,
          ballotClosesAt: ballotClosesAt.toISOString(),
          closedAt: now.toISOString(),
          eventId,
        });
        continue;
      }

      const current = await db
        .collection<ProposalRecord>("proposals")
        .findOne({ proposalId });
      report.skipped.push({
        proposalId,
        reason: "stage_changed",
        detail:
          current?.stage === "decide"
            ? "Another scheduler run recorded this closure first."
            : `The matter left Decide (now '${String(current?.stage ?? "missing")}') before the closure ran.`,
      });
    } catch (error) {
      report.errors.push({
        proposalId: proposalId || undefined,
        stage: "close",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return report;
}

/**
 * One scheduler run: advance due deliberations, then record due ballot closures.
 * Pass `dryRun` to compute the same report without writing anything.
 */
export async function runGovernanceScheduler(
  db: Db,
  options: { now?: Date; dryRun?: boolean } = {},
): Promise<GovernanceSchedulerReport> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;
  const advancement = await advanceDueDeliberations(db, { now, dryRun });
  const closure = await closeDueBallots(db, { now, dryRun });
  const skipped = [...advancement.skipped, ...closure.skipped];
  const errors = [...advancement.errors, ...closure.errors];
  return {
    mode: dryRun ? "dry-run" : "apply",
    actorId: LIFECYCLE_SYSTEM_ACTOR,
    now: now.toISOString(),
    counts: {
      advanced: advancement.advanced.length,
      skipped: skipped.length,
      closed: closure.closed.length,
      blockers: advancement.blockers.length,
      errors: errors.length,
    },
    advanced: advancement.advanced,
    skipped,
    closed: closure.closed,
    blockers: advancement.blockers,
    errors,
  };
}
