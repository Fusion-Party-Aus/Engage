import type { ClientSession, Db } from "mongodb";
import {
  loadBallotCryptoConfig,
  loadBallotCryptoConfigForRead,
  type BallotCryptoConfig,
} from "./ballot-crypto.ts";
import { ballotDeadlineLabel } from "./ballot-deadline.ts";
import { runInTransaction } from "./db.ts";
import { recordGovernanceEvent } from "./governance-relationships.ts";
import { normalizeMatterType, type MatterTypeId } from "./matters.ts";
import {
  QUORUM_RULE_EFFECTIVE_AT,
  buildBallotQuorumRecord,
  buildLegacyQuorumRecord,
  buildUnavailableQuorumRecord,
  insertBallotQuorumRecord,
  readBallotQuorumRecord,
  readQuorumElectorate,
  type BallotQuorumRecord,
  type QuorumVerdict,
} from "./quorum.ts";
import type { VoteChoice, VoteTally } from "./types.ts";
import {
  PROPOSAL_VOTES,
  decodeStoredVote,
  proposalBallotId,
} from "./vote-storage.ts";

export const BALLOT_SCHEMA_VERSION = 1;
export const BALLOTS_COLLECTION = "ballots";
export const FORMAL_DECISIONS_COLLECTION = "ballot_results";
export { BALLOT_QUORUM_COLLECTION } from "./quorum.ts";

/**
 * Versioned basis for a computed ballot outcome.
 *
 * - D9: an ordinary Yes/No ballot is approved only when approve is greater than
 *   reject. A tie does not approve.
 * - D10 / O1: abstentions may be recorded, but their effect on a denominator is
 *   undefined. Abstentions are therefore recorded and excluded from the
 *   comparison instead of being added to, or removed from, any denominator.
 * - D37 / D38: a ballot is also tested against the two-tier platform and ballot
 *   quorum. Failure makes it inconclusive, never rejected.
 *
 * Changing the comparison or the quorum rule requires a new basis identifier;
 * recorded results keep the identifier they were certified under.
 */
export const BALLOT_OUTCOME_RULE_BASIS = "two-tier-quorum-simple-majority-v1";
export const LEGACY_BALLOT_OUTCOME_RULE_BASIS = "simple-majority-d9-v1";

export type ComputedBallotOutcome = "successful" | "unsuccessful";

/**
 * Compare Yes against No only (D9, D10/O1). Zero votes and ties are not
 * successful. Quorum is a separate test applied by `recordFormalDecision`.
 */
export function computeBallotOutcome(tally: {
  approve: number;
  reject: number;
}): ComputedBallotOutcome {
  return tally.approve > tally.reject ? "successful" : "unsuccessful";
}

/** Map the quorum verdict onto the persisted result vocabulary. */
export function ballotResultForVerdict(
  verdict: QuorumVerdict,
): "successful" | "unsuccessful" | "inconclusive" {
  return verdict === "adopted"
    ? "successful"
    : verdict === "rejected"
      ? "unsuccessful"
      : "inconclusive";
}

/** Title-case label for a stored result or computed outcome. */
export function ballotOutcomeLabel(value: string | null | undefined): string {
  return value === "successful"
    ? "Successful"
    : value === "unsuccessful"
      ? "Unsuccessful"
      : value === "inconclusive"
        ? "Inconclusive"
        : "Not recorded";
}

/**
 * Filter for the formal result attached to a matter's primary ballot.
 *
 * Results are keyed by `ballotId`: a matter may have more than one ballot, and a
 * result on one must not hide the recording state of another. Legacy results
 * recorded before ballot records existed have no `ballotId`.
 */
export function proposalBallotResultFilter(matterId: string) {
  return {
    $or: [
      { ballotId: proposalBallotId(matterId) },
      { proposalId: matterId, ballotId: { $exists: false } },
    ],
  };
}

/**
 * Where the closure state of a ballot comes from. The addressed ballot's own
 * record wins; the matter is only a fallback for legacy ballots with no row.
 */
export interface BallotClosure {
  closed: boolean;
  /** Close time that decided the state, when one was recorded. */
  closesAt?: Date;
  basis: "ballot" | "matter" | "none";
}

function asValidDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * Resolve whether the addressed ballot may be certified.
 *
 * Shared by the server gate and the admin pages so the offered form and the
 * accepted request cannot disagree.
 */
export function resolveBallotClosure(input: {
  ballot?: { status?: string | null; closesAt?: Date | string | null } | null;
  matter?: {
    ballotClosedAt?: Date | string | null;
    ballotClosesAt?: Date | string | null;
  } | null;
  now?: Date;
}): BallotClosure {
  const now = input.now ?? new Date();
  if (input.ballot?.status === "closed") {
    return { closed: true, basis: "ballot" };
  }
  const ballotClosesAt = asValidDate(input.ballot?.closesAt);
  if (ballotClosesAt) {
    return {
      closed: ballotClosesAt.getTime() <= now.getTime(),
      closesAt: ballotClosesAt,
      basis: "ballot",
    };
  }
  if (input.matter?.ballotClosedAt) {
    return { closed: true, basis: "matter" };
  }
  const matterClosesAt = asValidDate(input.matter?.ballotClosesAt);
  if (matterClosesAt) {
    return {
      closed: matterClosesAt.getTime() <= now.getTime(),
      closesAt: matterClosesAt,
      basis: "matter",
    };
  }
  return { closed: false, basis: "none" };
}

/** Sum recorded choices into the three recognised outcomes. */
export function sumVoteTally(choices: Iterable<VoteChoice>): VoteTally {
  const tally: VoteTally = { approve: 0, abstain: 0, reject: 0, total: 0 };
  for (const choice of choices) {
    if (choice === "approve") tally.approve += 1;
    else if (choice === "abstain") tally.abstain += 1;
    else if (choice === "reject") tally.reject += 1;
    else
      throw new BallotDomainError(
        "A recorded vote could not be read, so the ballot outcome cannot be computed.",
        409,
        "BALLOT_TALLY_MALFORMED",
      );
    tally.total += 1;
  }
  return tally;
}

/**
 * Tally the votes bound to one ballot and immutable revision.
 *
 * Votes are read through the same storage and decryption path as every other
 * vote read, so encrypted ballots certify from their real choices. Eligibility
 * was already decided when each vote was cast (D2) and is never snapshotted here.
 *
 * The tally is the whole ballot's truth: a vote on the ballot that is missing a
 * revision reference or names another revision makes the outcome uncomputable
 * (`BALLOT_TALLY_UNBOUND_VOTES`) instead of being silently dropped. Missing
 * decryption configuration is a server fault (`BALLOT_DECRYPTION_UNAVAILABLE`);
 * votes that cannot be decrypted are a ballot fault (`BALLOT_TALLY_UNREADABLE`).
 */
export async function readBoundBallotTally(
  db: Db,
  input: {
    ballotId: string;
    revisionId: string;
    cryptoConfig?: BallotCryptoConfig | null;
    session?: ClientSession;
  },
): Promise<VoteTally> {
  const scan = await scanBallotVotes(db, input);
  if (scan.unboundVoteCount > 0) {
    throw new BallotDomainError(
      "Some recorded votes are not bound to this ballot's frozen wording, so the outcome cannot be computed. Review the ballot binding first.",
      409,
      "BALLOT_TALLY_UNBOUND_VOTES",
    );
  }
  if (scan.decryptionUnavailable) {
    throw new BallotDomainError(
      "Encrypted ballot votes are present but this server cannot decrypt them, so the outcome cannot be computed.",
      503,
      "BALLOT_DECRYPTION_UNAVAILABLE",
    );
  }
  if (scan.unreadableVoteCount > 0) {
    throw new BallotDomainError(
      "Some recorded votes could not be read, so the outcome cannot be computed.",
      409,
      "BALLOT_TALLY_UNREADABLE",
    );
  }
  return sumVoteTally(scan.choices);
}

export type BallotTallyState =
  | "computed"
  | "no-votes"
  | "unbound"
  | "decryption-unavailable"
  | "unreadable";

/** Display-safe tally for one ballot, computed from the same bound set. */
export interface BoundBallotTallySummary {
  tally: VoteTally;
  unboundVoteCount: number;
  unreadableVoteCount: number;
  state: BallotTallyState;
  /** Present whenever the tally is computable, including a zero-vote ballot. */
  computedResult?: ComputedBallotOutcome;
}

interface BallotVoteScan {
  choices: VoteChoice[];
  unboundVoteCount: number;
  unreadableVoteCount: number;
  decryptionUnavailable: boolean;
}

const BALLOT_VOTE_SCAN_PROJECTION = {
  ballotId: 1,
  proposalId: 1,
  policyId: 1,
  revisionId: 1,
  amendmentRevisionId: 1,
  voterBlindIndex: 1,
  voteEnvelope: 1,
  choice: 1,
} as const;

function resolveTallyCryptoConfig(
  supplied: BallotCryptoConfig | null | undefined,
): BallotCryptoConfig | null {
  if (supplied !== undefined) return supplied;
  try {
    return loadBallotCryptoConfig(process.env);
  } catch {
    // Invalid or incomplete key configuration is a server fault, not a voter's.
    throw new BallotDomainError(
      "Ballot decryption keys are not configured correctly on this server, so the outcome cannot be computed.",
      503,
      "BALLOT_DECRYPTION_UNAVAILABLE",
    );
  }
}

/**
 * Load ballot decryption keys for a display-only tally. A misconfigured server
 * returns `null` so admin pages can render an operational message instead of
 * failing the whole page; the tally then reports `decryption-unavailable` when
 * encrypted votes are actually present.
 */
export function loadBallotTallyCryptoConfig(
  env: Partial<import("./types.ts").PlatformEnv> | Record<string, string | undefined>,
): BallotCryptoConfig | null {
  return loadBallotCryptoConfigForRead(env);
}

async function scanBallotVotes(
  db: Db,
  input: {
    ballotId: string;
    revisionId: string;
    cryptoConfig?: BallotCryptoConfig | null;
    session?: ClientSession;
  },
): Promise<BallotVoteScan> {
  const cryptoConfig = resolveTallyCryptoConfig(input.cryptoConfig);
  const rows = await db
    .collection(PROPOSAL_VOTES)
    .find(
      { ballotId: input.ballotId },
      {
        projection: BALLOT_VOTE_SCAN_PROJECTION,
        ...(input.session ? { session: input.session } : {}),
      },
    )
    .toArray();
  return classifyBallotVotes(
    rows as Array<Record<string, any>>,
    input.revisionId,
    cryptoConfig,
  );
}

function classifyBallotVotes(
  rows: Array<Record<string, any>>,
  revisionId: string,
  cryptoConfig: BallotCryptoConfig | null,
): BallotVoteScan {
  const scan: BallotVoteScan = {
    choices: [],
    unboundVoteCount: 0,
    unreadableVoteCount: 0,
    decryptionUnavailable: false,
  };
  for (const row of rows) {
    if (row.revisionId !== revisionId) {
      scan.unboundVoteCount += 1;
      continue;
    }
    if (row.voteEnvelope && !cryptoConfig) {
      scan.decryptionUnavailable = true;
      continue;
    }
    try {
      const choice = decodeStoredVote(
        row as Record<string, any>,
        cryptoConfig,
      ).choice;
      if (
        choice !== "approve" &&
        choice !== "abstain" &&
        choice !== "reject"
      ) {
        scan.unreadableVoteCount += 1;
        continue;
      }
      scan.choices.push(choice);
    } catch {
      scan.unreadableVoteCount += 1;
    }
  }
  return scan;
}

function summariseScan(scan: BallotVoteScan): BoundBallotTallySummary {
  const tally = sumVoteTally(scan.choices);
  // State the cause the officer can act on first. Unbound votes are a binding
  // fault they can resolve; unavailable keys are a server configuration fault;
  // unreadable votes are a ballot integrity fault. A zero-vote tally is still
  // computable (D9 computes unsuccessful), so the UI can require an override.
  const state: BallotTallyState =
    scan.unboundVoteCount > 0
      ? "unbound"
      : scan.decryptionUnavailable
        ? "decryption-unavailable"
        : scan.unreadableVoteCount > 0
          ? "unreadable"
          : tally.total === 0
            ? "no-votes"
            : "computed";
  const computable = state === "computed" || state === "no-votes";
  return {
    tally,
    unboundVoteCount: scan.unboundVoteCount,
    unreadableVoteCount: scan.unreadableVoteCount,
    state,
    ...(computable ? { computedResult: computeBallotOutcome(tally) } : {}),
  };
}

/**
 * Read the display tally for several matter ballots in one query. Admin surfaces
 * use this so the tally they show and the tally certification enforces come from
 * the same bound set and cannot disagree.
 */
export async function readBoundBallotTallies(
  db: Db,
  input: {
    ballots: Array<{ matterId: string; revisionId: string }>;
    cryptoConfig?: BallotCryptoConfig | null;
    session?: ClientSession;
  },
): Promise<Map<string, BoundBallotTallySummary>> {
  const summaries = new Map<string, BoundBallotTallySummary>();
  if (input.ballots.length === 0) return summaries;
  const cryptoConfig = resolveTallyCryptoConfig(input.cryptoConfig);
  const ballotIds = input.ballots.map((ballot) =>
    proposalBallotId(ballot.matterId),
  );
  const rows = (await db
    .collection(PROPOSAL_VOTES)
    .find(
      { ballotId: { $in: ballotIds } },
      {
        projection: BALLOT_VOTE_SCAN_PROJECTION,
        ...(input.session ? { session: input.session } : {}),
      },
    )
    .toArray()) as Array<Record<string, any>>;

  const rowsByBallot = new Map<string, Array<Record<string, any>>>();
  for (const row of rows) {
    const ballotId = String(row.ballotId);
    const existing = rowsByBallot.get(ballotId);
    if (existing) existing.push(row);
    else rowsByBallot.set(ballotId, [row]);
  }

  for (const ballot of input.ballots) {
    summaries.set(
      ballot.matterId,
      summariseScan(
        classifyBallotVotes(
          rowsByBallot.get(proposalBallotId(ballot.matterId)) ?? [],
          ballot.revisionId,
          cryptoConfig,
        ),
      ),
    );
  }
  return summaries;
}

/**
 * Refuse certification unless the addressed ballot is closed.
 *
 * The ballot's own row is authoritative first: a `closed` status or a close time
 * that has passed allows certification, and a future close time refuses it even
 * when another ballot for the same matter is closed. Only when the ballot row is
 * neither closed nor carries a close time does the matter's closure
 * (`ballotClosedAt` / `ballotClosesAt`) apply, which keeps legacy records
 * certifiable once the matter is closed.
 *
 * A ballot with no recorded close is deliberately refused rather than assumed
 * closed. Legacy ballots without a deadline already need an operator to schedule
 * or close them (see the lifecycle gaps); certifying one would let a result be
 * contradicted by later votes.
 */
export async function assertBallotClosedForCertification(
  db: Db,
  input: { matterId: string; ballotId: string; now: Date },
  session?: ClientSession,
): Promise<void> {
  const sessionOpts = session ? { session } : undefined;
  const ballot = await db.collection(BALLOTS_COLLECTION).findOne(
    { ballotId: input.ballotId },
    { projection: { status: 1, closesAt: 1 }, ...(sessionOpts ?? {}) },
  );
  const proposal = await db.collection("proposals").findOne(
    { proposalId: input.matterId },
    {
      projection: { ballotClosedAt: 1, ballotClosesAt: 1 },
      ...(sessionOpts ?? {}),
    },
  );
  const closure = resolveBallotClosure({
    ballot: ballot as { status?: string; closesAt?: Date } | null,
    matter: proposal as { ballotClosedAt?: Date; ballotClosesAt?: Date } | null,
    now: input.now,
  });
  if (closure.closed) return;
  if (closure.closesAt) {
    throw new BallotDomainError(
      `This ballot can still accept votes until ${ballotDeadlineLabel(closure.closesAt)}. Record the outcome after it closes.`,
      409,
      "BALLOT_NOT_CLOSED",
    );
  }
  throw new BallotDomainError(
    "This ballot has no recorded close, so its outcome cannot be certified. Close the ballot or set a close date first.",
    409,
    "BALLOT_NOT_CLOSED",
  );
}

/**
 * Evaluate and persist the binding quorum record at ballot closure.
 *
 * One immutable record is written per ballot. Membership counts and the final
 * tally are read inside the caller's transaction, so a concurrent membership
 * update either belongs to this closure or falls outside it; the two cannot be
 * mixed. If the votes cannot be read, the electorate is still recorded and the
 * record is marked unavailable rather than silently omitting participation.
 */
export async function recordBallotQuorumAtClosure(
  db: Db,
  input: {
    ballotId: string;
    matterId: string;
    revisionId: string;
    closedAt: Date;
    now?: Date;
    cryptoConfig?: BallotCryptoConfig | null;
    session?: ClientSession;
  },
): Promise<BallotQuorumRecord> {
  const existing = await readBallotQuorumRecord(
    db,
    input.ballotId,
    input.session,
  );
  if (existing) return existing;

  const electorate = await readQuorumElectorate(db, {
    now: input.closedAt,
    session: input.session,
  });
  if (!input.revisionId.trim()) {
    return insertBallotQuorumRecord(
      db,
      buildUnavailableQuorumRecord({
        ballotId: input.ballotId,
        matterId: input.matterId,
        revisionId: "",
        closedAt: input.closedAt,
        recordedAt: input.now ?? input.closedAt,
        electorate,
        reason:
          "The ballot has no bound wording revision, so participation and quorum could not be calculated.",
      }),
      input.session,
    );
  }
  let tally: VoteTally;
  try {
    tally = await readBoundBallotTally(db, {
      ballotId: input.ballotId,
      revisionId: input.revisionId,
      cryptoConfig: input.cryptoConfig,
      session: input.session,
    });
  } catch (error) {
    const reason =
      error instanceof BallotDomainError
        ? error.message
        : "Some recorded votes could not be read when the ballot closed, so participation and quorum could not be calculated.";
    return insertBallotQuorumRecord(
      db,
      buildUnavailableQuorumRecord({
        ballotId: input.ballotId,
        matterId: input.matterId,
        revisionId: input.revisionId,
        closedAt: input.closedAt,
        recordedAt: input.now ?? input.closedAt,
        electorate,
        reason,
      }),
      input.session,
    );
  }

  return insertBallotQuorumRecord(
    db,
    buildBallotQuorumRecord({
      ballotId: input.ballotId,
      matterId: input.matterId,
      revisionId: input.revisionId,
      closedAt: input.closedAt,
      recordedAt: input.now ?? input.closedAt,
      electorate,
      tally,
    }),
    input.session,
  );
}

/**
 * Load the recorded quorum for certification.
 *
 * A ballot that closed before the rule took effect is recorded as
 * `legacy-not-applied` and keeps the old approval-only test. A ballot that
 * closed after adoption but has no closure record is refused: reconstructing it
 * from today's membership would silently invent a historical result. The
 * scheduler writes the record atomically with closure; a missing record is an
 * operational fault that must be reviewed.
 */
export async function ensureBallotQuorumRecordForCertification(
  db: Db,
  input: {
    ballotId: string;
    matterId: string;
    revisionId: string;
    now: Date;
    cryptoConfig?: BallotCryptoConfig | null;
    session?: ClientSession;
  },
): Promise<BallotQuorumRecord> {
  const existing = await readBallotQuorumRecord(
    db,
    input.ballotId,
    input.session,
  );
  if (existing) return existing;

  const sessionOpts = input.session ? { session: input.session } : undefined;
  const [ballot, proposal] = await Promise.all([
    db
      .collection(BALLOTS_COLLECTION)
      .findOne(
        { ballotId: input.ballotId },
        { projection: { status: 1, closesAt: 1 }, ...(sessionOpts ?? {}) },
      ),
    db
      .collection("proposals")
      .findOne(
        { proposalId: input.matterId },
        {
          projection: { ballotClosedAt: 1, ballotClosesAt: 1 },
          ...(sessionOpts ?? {}),
        },
      ),
  ]);
  const closure = resolveBallotClosure({
    ballot: ballot as { status?: string; closesAt?: Date } | null,
    matter: proposal as
      | { ballotClosedAt?: Date; ballotClosesAt?: Date }
      | null,
    now: input.now,
  });
  if (!closure.closed) {
    throw new BallotDomainError(
      "This ballot has not closed, so its quorum cannot be recorded.",
      409,
      "BALLOT_NOT_CLOSED",
    );
  }
  const closedAt =
    closure.closesAt ??
    (proposal?.ballotClosedAt
      ? new Date(proposal.ballotClosedAt as Date)
      : input.now);
  if (closedAt.getTime() < QUORUM_RULE_EFFECTIVE_AT.getTime()) {
    const tally = await readBoundBallotTally(db, {
      ballotId: input.ballotId,
      revisionId: input.revisionId,
      cryptoConfig: input.cryptoConfig,
      session: input.session,
    });
    return insertBallotQuorumRecord(
      db,
      buildLegacyQuorumRecord({
        ballotId: input.ballotId,
        matterId: input.matterId,
        revisionId: input.revisionId,
        closedAt,
        recordedAt: input.now,
        tally,
      }),
      input.session,
    );
  }
  throw new BallotDomainError(
    "This ballot closed after the two-tier quorum rule took effect, but no quorum record exists. An authorised officer must review the closure before a result can be certified.",
    409,
    "BALLOT_QUORUM_SNAPSHOT_MISSING",
  );
}

export interface BallotElectorate {
  scope: "national" | "branch";
  branchId: string;
}

export interface BallotRecord {
  schemaVersion: number;
  ballotId: string;
  matterId: string;
  matterType: MatterTypeId;
  purpose: "matter_adoption" | "amendment" | "consultation" | string;
  revisionId: string;
  amendmentId?: string;
  electorate: BallotElectorate;
  governanceAuthorityBranchId: string;
  jurisdictionBranchId: string;
  status: "open" | "closed" | "certified" | "cancelled";
  closesAt?: Date;
  openedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface FormalDecisionOverride {
  reason: string;
  by: string;
  at: Date;
}

export interface FormalDecisionQuorum {
  ruleVersion: string;
  status: BallotQuorumRecord["status"];
  applied: boolean;
  eligibleRegisteredMembers?: number;
  activeEligibleMembers?: number;
  platformQuorumRequired?: number;
  platformQuorumMet?: boolean;
  ballotQuorumRequired?: number;
  ballotQuorumMet?: boolean;
  participatingMembers?: number;
  quorumMet?: boolean;
  verdict: QuorumVerdict;
}

export interface FormalDecisionRecord {
  decisionEventId: string;
  ballotId: string;
  proposalId: string;
  matterId: string;
  revisionId: string;
  result: "successful" | "unsuccessful" | "inconclusive";
  /** Votes bound to the ballot and revision at the moment of certification. */
  tally?: VoteTally;
  /** Versioned rule the computed outcome was derived from. */
  ruleBasis?: string;
  /**
   * The result the votes and quorum compute. `inconclusive` is possible when a
   * quorum test fails, even though a Yes/No comparison exists.
   */
  computedResult?: "successful" | "unsuccessful" | "inconclusive";
  /** The closure quorum evidence the result was certified against. */
  quorum?: FormalDecisionQuorum;
  /** Present only when the recorded result contradicts the computed outcome. */
  override?: FormalDecisionOverride;
  authorityBranchId?: string;
  recordedBy: string;
  recordedAt: Date;
}

export class BallotDomainError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 409, code = "BALLOT_DOMAIN_ERROR") {
    super(message);
    this.name = "BallotDomainError";
    this.status = status;
    this.code = code;
  }
}

export function resolveBallotElectorate(matter: Record<string, unknown>): BallotElectorate {
  const branchId = String(
    matter.jurisdictionBranchId ||
      matter.governanceAuthorityBranchId ||
      matter.originatingBranchId ||
      "branch-nat",
  );
  const scope =
    branchId === "branch-nat" || matter.publicationScope === "national"
      ? "national"
      : "branch";
  return { scope, branchId };
}

/**
 * Create or update a distinct ballot record for a matter and immutable revision.
 * Supports a 1-to-many matter -> ballots relationship while preserving legacy
 * `proposal:<proposalId>` ballot identities.
 */
export async function upsertMatterBallot(
  db: Db,
  input: {
    ballotId?: string;
    matterId: string;
    matterType?: string;
    purpose?: string;
    revisionId: string;
    amendmentId?: string;
    electorate?: BallotElectorate;
    governanceAuthorityBranchId?: string;
    jurisdictionBranchId?: string;
    status?: BallotRecord["status"];
    closesAt?: Date | null;
    now?: Date;
  },
  session?: ClientSession,
): Promise<BallotRecord> {
  const sessionOpts = session ? { session } : undefined;
  const matterId = input.matterId.trim();
  const revisionId = input.revisionId.trim();
  if (!matterId || !revisionId) {
    throw new BallotDomainError(
      "Matter ID and immutable revision ID are required for a ballot.",
      400,
      "MISSING_BALLOT_BINDING",
    );
  }

  const ballotId = (input.ballotId ?? proposalBallotId(matterId)).trim();
  const matterType = normalizeMatterType(input.matterType, matterId);
  const now = input.now ?? new Date();

  const existing = await db
    .collection(BALLOTS_COLLECTION)
    .findOne({ ballotId }, sessionOpts);

  if (existing && existing.revisionId && existing.revisionId !== revisionId) {
    throw new BallotDomainError(
      "Ballot is already bound to a different immutable wording revision.",
      409,
      "BALLOT_REVISION_CONFLICT",
    );
  }

  const electorate = input.electorate ?? {
    scope:
      !input.jurisdictionBranchId || input.jurisdictionBranchId === "branch-nat"
        ? "national"
        : "branch",
    branchId: input.jurisdictionBranchId || "branch-nat",
  };

  const record: BallotRecord = {
    schemaVersion: BALLOT_SCHEMA_VERSION,
    ballotId,
    matterId,
    matterType,
    purpose: input.purpose ?? (input.amendmentId ? "amendment" : "matter_adoption"),
    revisionId,
    ...(input.amendmentId ? { amendmentId: input.amendmentId } : {}),
    electorate,
    governanceAuthorityBranchId:
      input.governanceAuthorityBranchId ?? electorate.branchId,
    jurisdictionBranchId: input.jurisdictionBranchId ?? electorate.branchId,
    status: input.status ?? (existing?.status as BallotRecord["status"]) ?? "open",
    ...(input.closesAt ? { closesAt: input.closesAt } : {}),
    openedAt: existing?.openedAt ? new Date(existing.openedAt) : now,
    createdAt: existing?.createdAt ? new Date(existing.createdAt) : now,
    updatedAt: now,
  };

  await db.collection(BALLOTS_COLLECTION).updateOne(
    { ballotId },
    {
      $set: {
        schemaVersion: record.schemaVersion,
        matterId: record.matterId,
        matterType: record.matterType,
        purpose: record.purpose,
        revisionId: record.revisionId,
        ...(record.amendmentId ? { amendmentId: record.amendmentId } : {}),
        electorate: record.electorate,
        governanceAuthorityBranchId: record.governanceAuthorityBranchId,
        jurisdictionBranchId: record.jurisdictionBranchId,
        status: record.status,
        ...(record.closesAt ? { closesAt: record.closesAt } : {}),
        updatedAt: record.updatedAt,
      },
      $setOnInsert: {
        ballotId: record.ballotId,
        openedAt: record.openedAt,
        createdAt: record.createdAt,
      },
    },
    { upsert: true, ...(sessionOpts ?? {}) },
  );

  return record;
}

/**
 * List all ballots associated with a matter (1-to-many).
 * Seamlessly synthesises a compatible view for legacy proposals that do not
 * yet have a row in `ballots`.
 */
export async function listMatterBallots(
  db: Db,
  matterId: string,
): Promise<BallotRecord[]> {
  const [stored, proposal, amendments] = await Promise.all([
    db
      .collection(BALLOTS_COLLECTION)
      .find({ matterId })
      .sort({ createdAt: 1 })
      .toArray(),
    db.collection("proposals").findOne({ proposalId: matterId }),
    db.collection("amendments").find({ proposalId: matterId }).toArray(),
  ]);

  const byId = new Map<string, BallotRecord>();
  for (const row of stored) {
    byId.set(String(row.ballotId), {
      schemaVersion: Number(row.schemaVersion ?? BALLOT_SCHEMA_VERSION),
      ballotId: String(row.ballotId),
      matterId: String(row.matterId),
      matterType: normalizeMatterType(row.matterType, matterId),
      purpose: String(row.purpose ?? "matter_adoption"),
      revisionId: String(row.revisionId),
      ...(row.amendmentId ? { amendmentId: String(row.amendmentId) } : {}),
      electorate: row.electorate ?? {
        scope: "national",
        branchId: String(row.jurisdictionBranchId ?? "branch-nat"),
      },
      governanceAuthorityBranchId: String(
        row.governanceAuthorityBranchId ?? "branch-nat",
      ),
      jurisdictionBranchId: String(row.jurisdictionBranchId ?? "branch-nat"),
      status: (row.status as BallotRecord["status"]) ?? "open",
      ...(row.closesAt ? { closesAt: new Date(row.closesAt) } : {}),
      openedAt: row.openedAt ? new Date(row.openedAt) : new Date(),
      createdAt: row.createdAt ? new Date(row.createdAt) : new Date(),
      updatedAt: row.updatedAt ? new Date(row.updatedAt) : new Date(),
    });
  }

  const primaryBallotId = proposalBallotId(matterId);
  if (proposal?.ballotRevisionId && !byId.has(primaryBallotId)) {
    const electorate = resolveBallotElectorate(proposal);
    byId.set(primaryBallotId, {
      schemaVersion: BALLOT_SCHEMA_VERSION,
      ballotId: primaryBallotId,
      matterId,
      matterType: normalizeMatterType(proposal.kind, matterId),
      purpose: "matter_adoption",
      revisionId: String(proposal.ballotRevisionId),
      electorate,
      governanceAuthorityBranchId: String(
        proposal.governanceAuthorityBranchId ?? electorate.branchId,
      ),
      jurisdictionBranchId: String(
        proposal.jurisdictionBranchId ?? electorate.branchId,
      ),
      status: proposal.stage === "decide" ? "open" : "closed",
      ...(proposal.ballotClosesAt
        ? { closesAt: new Date(proposal.ballotClosesAt) }
        : {}),
      openedAt: proposal.updatedAt
        ? new Date(proposal.updatedAt)
        : new Date(),
      createdAt: proposal.createdAt
        ? new Date(proposal.createdAt)
        : new Date(),
      updatedAt: proposal.updatedAt
        ? new Date(proposal.updatedAt)
        : new Date(),
    });
  }

  for (const amendment of amendments) {
    if (!amendment.ballotAmendmentRevisionId) continue;
    const amdBallotId = `amendment:${amendment.amendmentId}`;
    if (byId.has(amdBallotId)) continue;
    const electorate = proposal
      ? resolveBallotElectorate(proposal)
      : { scope: "national" as const, branchId: "branch-nat" };
    byId.set(amdBallotId, {
      schemaVersion: BALLOT_SCHEMA_VERSION,
      ballotId: amdBallotId,
      matterId,
      matterType: proposal
        ? normalizeMatterType(proposal.kind, matterId)
        : "policy",
      purpose: "amendment",
      revisionId: String(
        amendment.ballotRevisionId ?? amendment.baseRevisionId ?? "",
      ),
      amendmentId: String(amendment.amendmentId),
      electorate,
      governanceAuthorityBranchId: electorate.branchId,
      jurisdictionBranchId: electorate.branchId,
      status: amendment.status === "voting" ? "open" : "closed",
      ...(amendment.ballotClosesAt
        ? { closesAt: new Date(amendment.ballotClosesAt) }
        : {}),
      openedAt: amendment.updatedAt
        ? new Date(amendment.updatedAt)
        : new Date(),
      createdAt: amendment.createdAt
        ? new Date(amendment.createdAt)
        : new Date(),
      updatedAt: amendment.updatedAt
        ? new Date(amendment.updatedAt)
        : new Date(),
    });
  }

  return [...byId.values()];
}

/**
 * Record an immutable formal decision for a specific ballot and wording revision.
 * Runs atomically with ballot certification and the `decision.recorded` governance event,
 * and is idempotent when retried with the same `decisionEventId` and payload.
 *
 * Certification requires a closed ballot. The result is checked against the
 * outcome computed from the votes bound to the ballot and revision. Approval is
 * D9 (abstentions excluded per D10/O1); ballots closing on or after the quorum
 * effective date also require the two-tier quorum and can only be recorded as
 * inconclusive when either test fails. A contradicting approval result is
 * accepted only as an explicit override with a written reason, and the override
 * is recorded on the result and in the audit event. Existing results are returned
 * unchanged and are never rewritten.
 */
export async function recordFormalDecision(
  db: Db,
  input: {
    ballotId?: string;
    matterId: string;
    revisionId: string;
    result: "successful" | "unsuccessful" | "inconclusive";
    decisionEventId: string;
    authorityBranchId?: string;
    recordedBy: string;
    overrideReason?: string;
    cryptoConfig?: BallotCryptoConfig | null;
    now?: Date;
  },
): Promise<FormalDecisionRecord> {
  const ballotId = (input.ballotId ?? proposalBallotId(input.matterId)).trim();
  const now = input.now ?? new Date();
  const overrideReason = (input.overrideReason ?? "").trim();
  if (overrideReason.length > 1000) {
    throw new BallotDomainError(
      "The override reason must be 1000 characters or fewer.",
      400,
      "RESULT_OVERRIDE_REASON_TOO_LONG",
    );
  }
  const matchesPayload = (existing: Record<string, any>) =>
    existing.decisionEventId === input.decisionEventId &&
    (existing.ballotId ?? proposalBallotId(input.matterId)) === ballotId &&
    existing.revisionId === input.revisionId &&
    existing.result === input.result &&
    (existing.authorityBranchId ?? undefined) ===
      (input.authorityBranchId ?? undefined) &&
    // A retry that rewrites the recorded override reason is a different act,
    // not an identical retry. It must conflict rather than report success.
    (existing.override?.reason ?? "") === overrideReason;

  try {
    return await runInTransaction(db, async (session) => {
      const sessionOpts = session ? { session } : undefined;
      const existing = await db.collection(FORMAL_DECISIONS_COLLECTION).findOne(
        {
          $or: [
            { decisionEventId: input.decisionEventId },
            { ballotId },
            { proposalId: input.matterId, ballotId: { $exists: false } },
          ],
        },
        sessionOpts,
      );

      if (existing) {
        // Identical retries return the recorded evidence as it stands, including
        // historical results recorded before outcomes were computed.
        if (matchesPayload(existing)) {
          return existing as unknown as FormalDecisionRecord;
        }
        throw new BallotDomainError(
          "Ballot result is already recorded and cannot be replaced.",
          409,
          "DECISION_ALREADY_RECORDED",
        );
      }

      await assertBallotClosedForCertification(
        db,
        { matterId: input.matterId, ballotId, now },
        session,
      );

      const quorum = await ensureBallotQuorumRecordForCertification(db, {
        ballotId,
        matterId: input.matterId,
        revisionId: input.revisionId,
        now,
        cryptoConfig: input.cryptoConfig,
        session,
      });
      if (quorum.status === "unavailable") {
        throw new BallotDomainError(
          "This ballot's quorum could not be calculated when it closed. The closure record must be reviewed before a result can be certified.",
          409,
          "BALLOT_QUORUM_UNAVAILABLE",
        );
      }

      const tally = await readBoundBallotTally(db, {
        ballotId,
        revisionId: input.revisionId,
        cryptoConfig: input.cryptoConfig,
        session,
      });
      if (
        quorum.status === "evaluated" &&
        ((quorum.participatingMembers !== undefined &&
          quorum.participatingMembers !== tally.total) ||
          (quorum.tally !== undefined &&
            (quorum.tally.approve !== tally.approve ||
              quorum.tally.abstain !== tally.abstain ||
              quorum.tally.reject !== tally.reject)))
      ) {
        throw new BallotDomainError(
          "The recorded votes no longer match the votes bound to this ballot at closure. Review the ballot before recording a result.",
          409,
          "BALLOT_QUORUM_PARTICIPATION_MISMATCH",
        );
      }
      // Quorum is a gate, not an officer discretion. A ballot that failed
      // either test can only be recorded as inconclusive.
      if (
        quorum.status === "evaluated" &&
        quorum.quorumMet !== true &&
        input.result !== "inconclusive"
      ) {
        throw new BallotDomainError(
          "This ballot did not meet quorum. It can only be recorded as inconclusive; it cannot be treated as approved or rejected.",
          409,
          "BALLOT_QUORUM_NOT_MET",
        );
      }
      const computedVerdict: QuorumVerdict =
        quorum.status === "evaluated"
          ? quorum.verdict
          : computeBallotOutcome(tally) === "successful"
            ? "adopted"
            : "rejected";
      const computedResult = ballotResultForVerdict(computedVerdict);
      const isOverride = input.result !== computedResult;
      if (isOverride && !overrideReason) {
        throw new BallotDomainError(
          `The ballot's recorded votes compute the outcome "${computedResult}" (${tally.approve} approve, ${tally.reject} reject). Recording any other result, including inconclusive, requires a written reason.`,
          409,
          "RESULT_OVERRIDE_REASON_REQUIRED",
        );
      }
      if (!isOverride && overrideReason) {
        // Never silently drop a written reason: the caller is describing an
        // override that this result does not need, so the intent is ambiguous.
        throw new BallotDomainError(
          `The recorded votes already compute the outcome "${computedResult}". Remove the override reason, or choose a different result.`,
          400,
          "RESULT_OVERRIDE_REASON_UNEXPECTED",
        );
      }

      const quorumEvidence: FormalDecisionQuorum = {
        ruleVersion: quorum.ruleVersion,
        status: quorum.status,
        applied: quorum.status === "evaluated",
        ...(quorum.eligibleRegisteredMembers !== undefined
          ? { eligibleRegisteredMembers: quorum.eligibleRegisteredMembers }
          : {}),
        ...(quorum.activeEligibleMembers !== undefined
          ? { activeEligibleMembers: quorum.activeEligibleMembers }
          : {}),
        ...(quorum.platformQuorumRequired !== undefined
          ? { platformQuorumRequired: quorum.platformQuorumRequired }
          : {}),
        ...(quorum.platformQuorumMet !== undefined
          ? { platformQuorumMet: quorum.platformQuorumMet }
          : {}),
        ...(quorum.ballotQuorumRequired !== undefined
          ? { ballotQuorumRequired: quorum.ballotQuorumRequired }
          : {}),
        ...(quorum.ballotQuorumMet !== undefined
          ? { ballotQuorumMet: quorum.ballotQuorumMet }
          : {}),
        ...(quorum.participatingMembers !== undefined
          ? { participatingMembers: quorum.participatingMembers }
          : {}),
        ...(quorum.quorumMet !== undefined
          ? { quorumMet: quorum.quorumMet }
          : {}),
        verdict: computedVerdict,
      };
      const record: FormalDecisionRecord = {
        decisionEventId: input.decisionEventId,
        ballotId,
        proposalId: input.matterId,
        matterId: input.matterId,
        revisionId: input.revisionId,
        result: input.result,
        tally,
        ruleBasis:
          quorum.status === "legacy-not-applied"
            ? LEGACY_BALLOT_OUTCOME_RULE_BASIS
            : BALLOT_OUTCOME_RULE_BASIS,
        computedResult,
        quorum: quorumEvidence,
        ...(isOverride
          ? {
              override: {
                reason: overrideReason,
                by: input.recordedBy,
                at: now,
              },
            }
          : {}),
        ...(input.authorityBranchId
          ? { authorityBranchId: input.authorityBranchId }
          : {}),
        recordedBy: input.recordedBy,
        recordedAt: now,
      };

      await db
        .collection(FORMAL_DECISIONS_COLLECTION)
        .insertOne(record, sessionOpts);
      await db
        .collection(BALLOTS_COLLECTION)
        .updateOne(
          { ballotId },
          { $set: { status: "certified", updatedAt: now } },
          sessionOpts,
        );
      await recordGovernanceEvent(
        db,
        {
          eventType: "decision.recorded",
          matterId: input.matterId,
          ballotId,
          revisionId: input.revisionId,
          decisionEventId: input.decisionEventId,
          actorId: input.recordedBy,
          authorityBranchId: input.authorityBranchId,
          ...(isOverride ? { reason: overrideReason } : {}),
          metadata: {
            result: input.result,
            computedResult,
            tally,
            ruleBasis:
              quorum.status === "legacy-not-applied"
                ? LEGACY_BALLOT_OUTCOME_RULE_BASIS
                : BALLOT_OUTCOME_RULE_BASIS,
            quorum: quorumEvidence,
            ...(isOverride
              ? { override: { by: input.recordedBy, reason: overrideReason } }
              : {}),
          },
          createdAt: now,
        },
        session,
      );

      return record;
    });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      const existing = await db
        .collection(FORMAL_DECISIONS_COLLECTION)
        .findOne({
          $or: [
            { decisionEventId: input.decisionEventId },
            { ballotId },
          ],
        });
      if (existing && matchesPayload(existing)) {
        return existing as unknown as FormalDecisionRecord;
      }
      throw new BallotDomainError(
        "Ballot result is already recorded and cannot be replaced.",
        409,
        "DECISION_ALREADY_RECORDED",
      );
    }
    throw error;
  }
}
