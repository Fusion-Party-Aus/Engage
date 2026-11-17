import type { Db } from "mongodb";
import type { BallotCryptoConfig } from "./ballot-crypto.ts";
import {
  BALLOTS_COLLECTION,
  FORMAL_DECISIONS_COLLECTION,
  ballotOutcomeLabel,
  proposalBallotResultFilter,
  readBoundBallotTallies,
  resolveBallotClosure,
  type BallotClosure,
  type BoundBallotTallySummary,
  type ComputedBallotOutcome,
  type FormalDecisionRecord,
} from "./ballots.ts";
import { normalizeProposalDoc } from "./proposal-helpers.ts";
import {
  BALLOT_QUORUM_RULE_VERSION,
  QUORUM_RULE_EFFECTIVE_AT,
  buildQuorumPreview,
  getQuorumElectoratePreview,
  quorumRuleLabel,
  quorumVerdictLabel,
  readBallotQuorumRecord,
  type BallotQuorumRecord,
  type QuorumPreview,
} from "./quorum.ts";
import { proposalBallotId } from "./vote-storage.ts";
import type { VoteTally } from "./types.ts";

/**
 * One authoritative reading of a ballot's state: is it open, can its votes be
 * counted, what does quorum say, and what was recorded?
 *
 * This module composes the functions that own each rule — closure, bound tally,
 * quorum record and formal result. It does not recompute them, and it does not
 * decide authority or eligibility.
 */
export interface BallotOutcomeOptions {
  proposalId: string;
  /** Defaults to the matter's primary ballot. */
  ballotId?: string;
  now?: Date;
  cryptoConfig?: BallotCryptoConfig | null;
}

export type BallotOutcomeState = "unbound" | "open" | "closed" | "cancelled";

export interface BallotClosureView extends BallotClosure {
  status?: string;
  certified: boolean;
}

/**
 * A safe view of the bound tally. `tally` is present only when the votes can be
 * counted; an unbound, unreadable or undecryptable ballot has no numeric tally,
 * so it can never be presented as a zero-vote ballot.
 */
export interface BallotTallyView {
  state: BoundBallotTallySummary["state"];
  tally?: VoteTally;
  unboundVoteCount: number;
  unreadableVoteCount: number;
  computedResult?: ComputedBallotOutcome;
  computedLabel?: string;
}

export type BallotQuorumView =
  | {
      status: "recorded";
      record: BallotQuorumRecord;
      ruleLabel: string;
      verdictLabel: string;
    }
  | {
      status: "preview";
      preview: QuorumPreview;
      ruleLabel: string;
      verdictLabel: null;
    }
  | {
      status: "missing";
      ruleLabel: string;
      reason: string;
    };

export interface RecordedBallotOutcome {
  record: FormalDecisionRecord;
  resultLabel: string;
  computedLabel?: string;
}

export interface BallotOutcome {
  proposalId: string;
  ballotId: string;
  ballotRevisionId?: string;
  state: BallotOutcomeState;
  closure: BallotClosureView;
  tally: BallotTallyView | null;
  quorum: BallotQuorumView | null;
  recorded: RecordedBallotOutcome | null;
}

function asDate(value: unknown): Date | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function safeTally(summary: BoundBallotTallySummary | null): BallotTallyView | null {  if (!summary) return null;
  const computable =
    summary.state === "computed" || summary.state === "no-votes";
  return {
    state: summary.state,
    ...(computable ? { tally: summary.tally } : {}),
    unboundVoteCount: summary.unboundVoteCount,
    unreadableVoteCount: summary.unreadableVoteCount,
    ...(summary.computedResult
      ? {
          computedResult: summary.computedResult,
          computedLabel: ballotOutcomeLabel(summary.computedResult),
        }
      : {}),
  };
}

function recordedView(
  record: FormalDecisionRecord | null,
): RecordedBallotOutcome | null {
  if (!record) return null;
  return {
    record,
    resultLabel: ballotOutcomeLabel(record.result),
    ...(record.computedResult
      ? { computedLabel: ballotOutcomeLabel(record.computedResult) }
      : {}),
  };
}

function missingQuorumReason(): string {
  return "No quorum closure record exists for a ballot that closed after the two-tier rule took effect. Review the closure before certifying a result.";
}

/**
 * Read one ballot's authoritative outcome.
 *
 * Returns `null` only when the proposal does not exist. An existing proposal
 * with no bound ballot still returns a record, with `state: "unbound"`.
 */
export async function readBallotOutcome(
  db: Db,
  options: BallotOutcomeOptions,
): Promise<BallotOutcome | null> {
  const proposalId = options.proposalId.trim();
  if (!proposalId) return null;
  const now = options.now ?? new Date();

  const raw = await db
    .collection("proposals")
    .findOne({ $or: [{ proposalId }, { policyId: proposalId }] });
  if (!raw) return null;
  const proposal = normalizeProposalDoc(raw as Record<string, any>);

  const ballotId = options.ballotId ?? proposalBallotId(proposal.proposalId);
  const ballot = (await db
    .collection(BALLOTS_COLLECTION)
    .findOne(
      { ballotId },
      { projection: { status: 1, closesAt: 1 } },
    )) as { status?: string; closesAt?: Date } | null;

  const resolvedClosure = resolveBallotClosure({
    ballot,
    matter: proposal,
    now,
  });
  const recordedRow = await readRecordedResult(
    db,
    proposal.proposalId,
    ballotId,
  );
  const certified =
    ballot?.status === "certified" || Boolean(recordedRow);
  const closed =
    resolvedClosure.closed ||
    certified ||
    ballot?.status === "cancelled";
  const closure: BallotClosureView = {
    ...resolvedClosure,
    closed,
    ...(ballot?.status ? { status: ballot.status } : {}),
    certified,
  };
  const state: BallotOutcomeState =
    !proposal.ballotRevisionId
      ? "unbound"
      : ballot?.status === "cancelled"
        ? "cancelled"
        : closed
          ? "closed"
          : "open";

  const ballotRevisionId =
    typeof proposal.ballotRevisionId === "string"
      ? proposal.ballotRevisionId
      : undefined;

  const [summary, quorumRecord] = await Promise.all([
    ballotRevisionId
      ? readBoundBallotTallies(db, {
          ballots: [
            {
              matterId: proposal.proposalId,
              revisionId: ballotRevisionId,
            },
          ],
          ...(options.cryptoConfig !== undefined
            ? { cryptoConfig: options.cryptoConfig }
            : {}),
        }).then((tallies) => tallies.get(proposal.proposalId) ?? null)
      : Promise.resolve(null),
    readBallotQuorumRecord(db, ballotId),
  ]);
  const closeTime =
    resolvedClosure.closesAt ??
    asDate(ballot?.closesAt) ??
    asDate(proposal.ballotClosedAt) ??
    asDate(proposal.ballotClosesAt);
  const tally = safeTally(summary);
  const recorded = recordedView(recordedRow);
  const quorum = await readQuorum(
    db,
    {
      ballotId,
      record: quorumRecord,
      state,
      closeTime,
      participation: summary?.tally.total ?? 0,
      now,
    },
  );

  return {
    proposalId: proposal.proposalId,
    ballotId,
    ...(ballotRevisionId ? { ballotRevisionId } : {}),
    state,
    closure,
    tally,
    quorum,
    recorded,
  };
}

async function readRecordedResult(
  db: Db,
  proposalId: string,
  ballotId: string,
): Promise<FormalDecisionRecord | null> {
  const filter =
    ballotId === proposalBallotId(proposalId)
      ? proposalBallotResultFilter(proposalId)
      : { ballotId };
  const row = await db
    .collection<FormalDecisionRecord>(FORMAL_DECISIONS_COLLECTION)
    .findOne(filter);
  return row ? (row as unknown as FormalDecisionRecord) : null;
}

async function readQuorum(
  db: Db,
  input: {
    ballotId: string;
    record: BallotQuorumRecord | null;
    state: BallotOutcomeState;
    closeTime?: Date;
    participation: number;
    now: Date;
  },
): Promise<BallotQuorumView | null> {
  if (input.record) {
    return {
      status: "recorded",
      record: input.record,
      ruleLabel: quorumRuleLabel(input.record),
      verdictLabel: quorumVerdictLabel(input.record.verdict),
    };
  }
  if (input.state === "open") {
    const preview = buildQuorumPreview(
      await getQuorumElectoratePreview(db, input.now),
      input.participation,
    );
    return {
      status: "preview",
      preview,
      ruleLabel: quorumRuleLabel({ ruleVersion: preview.ruleVersion }),
      verdictLabel: null,
    };
  }
  if (
    input.state === "closed" &&
    input.closeTime &&
    input.closeTime.getTime() >= QUORUM_RULE_EFFECTIVE_AT.getTime()
  ) {
    return {
      status: "missing",
      ruleLabel: quorumRuleLabel({
        ruleVersion: BALLOT_QUORUM_RULE_VERSION,
      }),
      reason: missingQuorumReason(),
    };
  }
  return null;
}
