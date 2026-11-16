import { ObjectId, type ClientSession, type Db } from "mongodb";
import type { VoteTally } from "./types.ts";

/**
 * Two-tier quorum for Engage policy ballots.
 *
 * This is an adaptation of Fusion's constitutional quorum principles, not a
 * direct application of Constitution rule 36. Rule 36 governs general meetings.
 * Engage ballots are online member decisions, so the platform and ballot
 * requirements are defined here, recorded in the governance decision register
 * and enforced by `recordFormalDecision`.
 *
 * - Platform quorum: at least 30 eligible registered members exist at closure.
 * - Ballot quorum: Q = max(ceil(sqrt(N)), min(30, ceil(N / 2))), where N is the
 *   number of eligible members active on Engage in the previous 90 days.
 *
 * Both tests use one membership snapshot taken when the ballot closes. Results
 * are persisted and never recalculated from later membership data.
 */

export const BALLOT_QUORUM_RULE_VERSION = "two-tier-quorum-v1";
export const BALLOT_QUORUM_COLLECTION = "ballot_quorum_records";
export const QUORUM_RULE_EFFECTIVE_AT = new Date("2026-11-16T00:00:00.000Z");
export const PLATFORM_QUORUM_MINIMUM = 30;
export const ACTIVE_MEMBER_WINDOW_DAYS = 90;
export const ACTIVE_MEMBER_WINDOW_MS =
  ACTIVE_MEMBER_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Ballot quorum for an active electorate. Zero active members yields zero, as
 * specified. The platform quorum remains a separate, independent test.
 */
export function calculateBallotQuorum(activeEligibleMembers: number): number {
  if (!Number.isFinite(activeEligibleMembers) || activeEligibleMembers <= 0) {
    return 0;
  }
  return Math.max(
    Math.ceil(Math.sqrt(activeEligibleMembers)),
    Math.min(30, Math.ceil(activeEligibleMembers / 2)),
  );
}

export type QuorumVerdict = "adopted" | "rejected" | "inconclusive";

export interface QuorumCalculation {
  eligibleRegisteredMembers: number;
  activeEligibleMembers: number;
  platformQuorumRequired: number;
  platformQuorumMet: boolean;
  ballotQuorumRequired: number;
  ballotQuorumMet: boolean;
  participationCount: number;
  quorumMet: boolean;
  approvalSatisfied: boolean;
  verdict: QuorumVerdict;
}

/**
 * Evaluate both quorum tests and, separately, the existing approval test.
 * Quorum does not imply adoption: approval is decided only by Yes versus No.
 */
export function evaluateQuorum(input: {
  eligibleRegisteredMembers: number;
  activeEligibleMembers: number;
  participationCount: number;
  approve: number;
  reject: number;
}): QuorumCalculation {
  const eligibleRegisteredMembers = Math.max(
    0,
    Math.floor(input.eligibleRegisteredMembers),
  );
  const activeEligibleMembers = Math.max(0, Math.floor(input.activeEligibleMembers));
  const participationCount = Math.max(0, Math.floor(input.participationCount));
  const platformQuorumRequired = PLATFORM_QUORUM_MINIMUM;
  const platformQuorumMet = eligibleRegisteredMembers >= platformQuorumRequired;
  const ballotQuorumRequired = calculateBallotQuorum(activeEligibleMembers);
  const ballotQuorumMet = participationCount >= ballotQuorumRequired;
  const quorumMet = platformQuorumMet && ballotQuorumMet;
  const approvalSatisfied = input.approve > input.reject;
  return {
    eligibleRegisteredMembers,
    activeEligibleMembers,
    platformQuorumRequired,
    platformQuorumMet,
    ballotQuorumRequired,
    ballotQuorumMet,
    participationCount,
    quorumMet,
    approvalSatisfied,
    verdict: !quorumMet
      ? "inconclusive"
      : approvalSatisfied
        ? "adopted"
        : "rejected",
  };
}

export function quorumVerdictLabel(verdict: QuorumVerdict): string {
  return verdict === "adopted"
    ? "Adopted"
    : verdict === "rejected"
      ? "Rejected"
      : "Inconclusive";
}

export function quorumRuleLabel(record: {
  ruleVersion?: string | null;
  status?: string | null;
}): string {
  if (record.status === "legacy-not-applied") return "Pre-quorum ballot";
  if (record.status === "unavailable") return "Quorum not recorded";
  return record.ruleVersion === BALLOT_QUORUM_RULE_VERSION
    ? "Two-tier quorum, version 1"
    : "Quorum rule not recorded";
}

export interface QuorumElectorate {
  eligibleMemberIds: string[];
  eligibleRegisteredMembers: number;
  activeEligibleMembers: number;
  activeSince: Date;
  duplicateAccountsExcluded: number;
  disabledAccountsExcluded: number;
  missingAccountsExcluded: number;
}

export interface QuorumElectorateOptions {
  now?: Date;
  session?: ClientSession;
}

/** First day of the rolling activity window, inclusive. */
export function activeSince(now: Date): Date {
  return new Date(now.getTime() - ACTIVE_MEMBER_WINDOW_MS);
}

const ACTIVITY_EVENT_TYPES = [
  "activity_day",
  "participation_day",
  "my_engage_viewed",
  "first_eligible_ballot_viewed",
] as const;

function uniqueStrings(values: Iterable<unknown>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const text = typeof value === "string" ? value.trim() : "";
    if (text) seen.add(text);
  }
  return [...seen];
}

/**
 * Read the eligible registered electorate and the active subset in one pass.
 *
 * "Eligible registered" means a verified Engage membership whose account still
 * exists and is not disabled. Suspended and pending memberships are excluded.
 * Duplicate CRM identities are counted once so two accounts linked to the same
 * person cannot inflate the platform electorate.
 *
 * Activity is genuine authenticated use: a recorded Engage activity day, a vote,
 * a comment, an authored proposal or amendment, a viewed My Engage page, or a
 * viewed eligible ballot, within the rolling window. It does not depend on
 * participation in the ballot being evaluated.
 */
export async function readQuorumElectorate(
  db: Db,
  options: QuorumElectorateOptions = {},
): Promise<QuorumElectorate> {
  const now = options.now ?? new Date();
  const since = activeSince(now);
  const sessionOpts = options.session ? { session: options.session } : undefined;

  const verifiedRows = await db
    .collection("memberships")
    .find({ status: "verified" }, { projection: { memberId: 1 }, ...(sessionOpts ?? {}) })
    .toArray();
  const verifiedMemberIds = uniqueStrings(verifiedRows.map((row) => row.memberId));

  if (verifiedMemberIds.length === 0) {
    return {
      eligibleMemberIds: [],
      eligibleRegisteredMembers: 0,
      activeEligibleMembers: 0,
      activeSince: since,
      duplicateAccountsExcluded: 0,
      disabledAccountsExcluded: 0,
      missingAccountsExcluded: 0,
    };
  }

  // Better Auth stores `user._id` as an ObjectId while `memberships.memberId`
  // is its string form. Match both so a production account is never treated as
  // missing, and string-keyed fixtures still work.
  const accountKeys: Array<string | ObjectId> = [...verifiedMemberIds];
  for (const memberId of verifiedMemberIds) {
    if (/^[a-f0-9]{24}$/i.test(memberId)) {
      accountKeys.push(new ObjectId(memberId));
    }
  }
  const accountRows = await db
    .collection("user")
    .find(
      { _id: { $in: accountKeys } } as any,
      { projection: { _id: 1, disabled: 1 }, ...(sessionOpts ?? {}) },
    )
    .toArray();
  const existingAccounts = new Map(
    accountRows.map((row) => [String(row._id), row.disabled === true]),
  );
  let missingAccountsExcluded = 0;
  let disabledAccountsExcluded = 0;
  const accountBackedIds = verifiedMemberIds.filter((memberId) => {
    const disabled = existingAccounts.get(memberId);
    if (disabled === undefined) {
      missingAccountsExcluded += 1;
      return false;
    }
    if (disabled) {
      disabledAccountsExcluded += 1;
      return false;
    }
    return true;
  });

  const links = await db
    .collection("crm_identity_links")
    .find(
      {
        application: "underground-crm",
        memberId: { $in: accountBackedIds },
        crmPersonId: { $type: "string" },
      },
      { projection: { memberId: 1, crmPersonId: 1 }, ...(sessionOpts ?? {}) },
    )
    .toArray();
  const byPerson = new Map<string, string[]>();
  for (const link of links) {
    const personId = String(link.crmPersonId ?? "").trim();
    const memberId = String(link.memberId ?? "").trim();
    if (!personId || !memberId) continue;
    const members = byPerson.get(personId);
    if (members) members.push(memberId);
    else byPerson.set(personId, [memberId]);
  }
  const duplicateIds = new Set<string>();
  for (const members of byPerson.values()) {
    const ordered = [...new Set(members)].sort();
    for (const duplicate of ordered.slice(1)) duplicateIds.add(duplicate);
  }
  const eligibleMemberIds = accountBackedIds.filter((id) => !duplicateIds.has(id));

  const [lifecycleRows, voteRows, commentRows, proposalRows, amendmentRows] =
    await Promise.all([
      db
        .collection("engagement_lifecycle_events")
        .find(
          {
            memberId: { $in: eligibleMemberIds },
            event: { $in: ACTIVITY_EVENT_TYPES },
            at: { $gte: since, $lte: now },
          },
          { projection: { memberId: 1 }, ...(sessionOpts ?? {}) },
        )
        .toArray(),
      db
        .collection("proposal_votes")
        .find(
          {
            memberId: { $in: eligibleMemberIds },
            updatedAt: { $gte: since, $lte: now },
          },
          { projection: { memberId: 1 }, ...(sessionOpts ?? {}) },
        )
        .toArray(),
      db
        .collection("comments")
        .find(
          {
            memberId: { $in: eligibleMemberIds },
            createdAt: { $gte: since, $lte: now },
          },
          { projection: { memberId: 1 }, ...(sessionOpts ?? {}) },
        )
        .toArray(),
      db
        .collection("proposals")
        .find(
          {
            authorId: { $in: eligibleMemberIds },
            createdAt: { $gte: since, $lte: now },
          },
          { projection: { authorId: 1 }, ...(sessionOpts ?? {}) },
        )
        .toArray(),
      db
        .collection("amendments")
        .find(
          {
            authorId: { $in: eligibleMemberIds },
            createdAt: { $gte: since, $lte: now },
          },
          { projection: { authorId: 1 }, ...(sessionOpts ?? {}) },
        )
        .toArray(),
    ]);

  const eligibleSet = new Set(eligibleMemberIds);
  const active = new Set<string>();
  for (const row of lifecycleRows) {
    if (eligibleSet.has(String(row.memberId))) active.add(String(row.memberId));
  }
  for (const row of voteRows) {
    if (eligibleSet.has(String(row.memberId))) active.add(String(row.memberId));
  }
  for (const row of commentRows) {
    if (eligibleSet.has(String(row.memberId))) active.add(String(row.memberId));
  }
  for (const row of proposalRows) {
    if (eligibleSet.has(String(row.authorId))) active.add(String(row.authorId));
  }
  for (const row of amendmentRows) {
    if (eligibleSet.has(String(row.authorId))) active.add(String(row.authorId));
  }

  return {
    eligibleMemberIds,
    eligibleRegisteredMembers: eligibleMemberIds.length,
    activeEligibleMembers: active.size,
    activeSince: since,
    duplicateAccountsExcluded: duplicateIds.size,
    disabledAccountsExcluded,
    missingAccountsExcluded,
  };
}

const PREVIEW_TTL_MS = 60_000;
const previewCache = new WeakMap<
  Db,
  { expiresAt: number; promise: Promise<QuorumElectorate> }
>();

/**
 * Short-lived current electorate for open-ballot displays. The binding
 * calculation never uses this cache; it reads a fresh snapshot at closure.
 */
export function getQuorumElectoratePreview(
  db: Db,
  now = new Date(),
): Promise<QuorumElectorate> {
  const cached = previewCache.get(db);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const promise = readQuorumElectorate(db, { now });
  previewCache.set(db, { expiresAt: Date.now() + PREVIEW_TTL_MS, promise });
  return promise;
}

export interface QuorumPreview {
  ruleVersion: string;
  ruleEffectiveAt: Date;
  activeWindowDays: number;
  eligibleRegisteredMembers: number;
  activeEligibleMembers: number;
  activeSince: Date;
  platformQuorumRequired: number;
  platformQuorumMet: boolean;
  ballotQuorumRequired: number;
  participationCount: number;
  ballotQuorumMet: boolean;
  quorumMet: boolean;
}

/**
 * Current, provisional view for an open ballot. The binding calculation is the
 * snapshot taken at closure; this preview exists so members can see how close a
 * ballot is and why the requirement can move.
 */
export function buildQuorumPreview(
  electorate: Pick<
    QuorumElectorate,
    "eligibleRegisteredMembers" | "activeEligibleMembers" | "activeSince"
  >,
  participationCount: number,
): QuorumPreview {
  const calculation = evaluateQuorum({
    eligibleRegisteredMembers: electorate.eligibleRegisteredMembers,
    activeEligibleMembers: electorate.activeEligibleMembers,
    participationCount,
    approve: 0,
    reject: 0,
  });
  return {
    ruleVersion: BALLOT_QUORUM_RULE_VERSION,
    ruleEffectiveAt: QUORUM_RULE_EFFECTIVE_AT,
    activeWindowDays: ACTIVE_MEMBER_WINDOW_DAYS,
    eligibleRegisteredMembers: calculation.eligibleRegisteredMembers,
    activeEligibleMembers: calculation.activeEligibleMembers,
    activeSince: electorate.activeSince,
    platformQuorumRequired: calculation.platformQuorumRequired,
    platformQuorumMet: calculation.platformQuorumMet,
    ballotQuorumRequired: calculation.ballotQuorumRequired,
    participationCount: calculation.participationCount,
    ballotQuorumMet: calculation.ballotQuorumMet,
    quorumMet: calculation.quorumMet,
  };
}

export type BallotQuorumStatus = "evaluated" | "legacy-not-applied" | "unavailable";

export interface BallotQuorumRecord {
  schemaVersion: 1;
  recordId: string;
  ballotId: string;
  matterId: string;
  revisionId: string;
  ruleVersion: string;
  ruleEffectiveAt: Date;
  status: BallotQuorumStatus;
  closedAt: Date;
  recordedAt: Date;
  activeWindowDays: number;
  activeSince?: Date;
  eligibleRegisteredMembers?: number;
  activeEligibleMembers?: number;
  duplicateAccountsExcluded?: number;
  disabledAccountsExcluded?: number;
  missingAccountsExcluded?: number;
  platformQuorumRequired?: number;
  platformQuorumMet?: boolean;
  ballotQuorumRequired?: number;
  ballotQuorumMet?: boolean;
  participatingMembers?: number;
  tally?: VoteTally;
  quorumMet?: boolean;
  approvalSatisfied?: boolean;
  verdict: QuorumVerdict;
  approvalRule: "simple-majority-d9-v1";
  anomalies?: string[];
}

export async function readBallotQuorumRecord(
  db: Db,
  ballotId: string,
  session?: ClientSession,
): Promise<BallotQuorumRecord | null> {
  const row = await db
    .collection(BALLOT_QUORUM_COLLECTION)
    .findOne(
      { ballotId },
      session ? { session } : undefined,
    );
  if (!row) return null;
  return normalizeQuorumRecord(row as Record<string, any>);
}

function asDate(value: unknown, fallback: Date): Date {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  return Number.isFinite(date.getTime()) ? date : fallback;
}

export function normalizeQuorumRecord(
  row: Record<string, any>,
): BallotQuorumRecord {
  const now = new Date();
  return {
    schemaVersion: 1,
    recordId: String(row.recordId ?? `quorum:${String(row.ballotId ?? "")}`),
    ballotId: String(row.ballotId ?? ""),
    matterId: String(row.matterId ?? row.proposalId ?? ""),
    revisionId: String(row.revisionId ?? ""),
    ruleVersion: String(row.ruleVersion ?? ""),
    ruleEffectiveAt: asDate(row.ruleEffectiveAt, QUORUM_RULE_EFFECTIVE_AT),
    status:
      row.status === "legacy-not-applied" || row.status === "unavailable"
        ? row.status
        : "evaluated",
    closedAt: asDate(row.closedAt, now),
    recordedAt: asDate(row.recordedAt, now),
    activeWindowDays: Number(row.activeWindowDays ?? ACTIVE_MEMBER_WINDOW_DAYS),
    ...(row.activeSince ? { activeSince: asDate(row.activeSince, now) } : {}),
    ...(row.eligibleRegisteredMembers !== undefined
      ? { eligibleRegisteredMembers: Number(row.eligibleRegisteredMembers) }
      : {}),
    ...(row.activeEligibleMembers !== undefined
      ? { activeEligibleMembers: Number(row.activeEligibleMembers) }
      : {}),
    ...(row.duplicateAccountsExcluded !== undefined
      ? { duplicateAccountsExcluded: Number(row.duplicateAccountsExcluded) }
      : {}),
    ...(row.disabledAccountsExcluded !== undefined
      ? { disabledAccountsExcluded: Number(row.disabledAccountsExcluded) }
      : {}),
    ...(row.missingAccountsExcluded !== undefined
      ? { missingAccountsExcluded: Number(row.missingAccountsExcluded) }
      : {}),
    ...(row.platformQuorumRequired !== undefined
      ? { platformQuorumRequired: Number(row.platformQuorumRequired) }
      : {}),
    ...(row.platformQuorumMet !== undefined
      ? { platformQuorumMet: row.platformQuorumMet === true }
      : {}),
    ...(row.ballotQuorumRequired !== undefined
      ? { ballotQuorumRequired: Number(row.ballotQuorumRequired) }
      : {}),
    ...(row.ballotQuorumMet !== undefined
      ? { ballotQuorumMet: row.ballotQuorumMet === true }
      : {}),
    ...(row.participatingMembers !== undefined
      ? { participatingMembers: Number(row.participatingMembers) }
      : {}),
    ...(row.tally
      ? {
          tally: {
            approve: Number(row.tally.approve ?? 0),
            abstain: Number(row.tally.abstain ?? 0),
            reject: Number(row.tally.reject ?? 0),
            total: Number(row.tally.total ?? 0),
          },
        }
      : {}),
    ...(row.quorumMet !== undefined ? { quorumMet: row.quorumMet === true } : {}),
    ...(row.approvalSatisfied !== undefined
      ? { approvalSatisfied: row.approvalSatisfied === true }
      : {}),
    verdict:
      row.verdict === "adopted" || row.verdict === "rejected"
        ? row.verdict
        : "inconclusive",
    approvalRule: "simple-majority-d9-v1",
    ...(Array.isArray(row.anomalies) && row.anomalies.length
      ? { anomalies: row.anomalies.map(String) }
      : {}),
  };
}

/**
 * Insert one immutable record per ballot. A retry returns the existing record
 * instead of replacing it; no code path updates a stored quorum record.
 */
export async function insertBallotQuorumRecord(
  db: Db,
  record: BallotQuorumRecord,
  session?: ClientSession,
): Promise<BallotQuorumRecord> {
  const sessionOpts = session ? { session } : undefined;
  try {
    await db
      .collection(BALLOT_QUORUM_COLLECTION)
      .insertOne({ _id: record.ballotId as any, ...record }, sessionOpts);
    return record;
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      const existing = await readBallotQuorumRecord(db, record.ballotId, session);
      if (existing) return existing;
    }
    throw error;
  }
}

/** Build the immutable closure record from counts and a final tally. */
export function buildBallotQuorumRecord(input: {
  ballotId: string;
  matterId: string;
  revisionId: string;
  closedAt: Date;
  recordedAt?: Date;
  electorate: QuorumElectorate;
  tally: VoteTally;
}): BallotQuorumRecord {
  const calculation = evaluateQuorum({
    eligibleRegisteredMembers: input.electorate.eligibleRegisteredMembers,
    activeEligibleMembers: input.electorate.activeEligibleMembers,
    participationCount: input.tally.total,
    approve: input.tally.approve,
    reject: input.tally.reject,
  });
  return {
    schemaVersion: 1,
    recordId: `quorum:${input.ballotId}`,
    ballotId: input.ballotId,
    matterId: input.matterId,
    revisionId: input.revisionId,
    ruleVersion: BALLOT_QUORUM_RULE_VERSION,
    ruleEffectiveAt: QUORUM_RULE_EFFECTIVE_AT,
    status: "evaluated",
    closedAt: input.closedAt,
    recordedAt: input.recordedAt ?? input.closedAt,
    activeWindowDays: ACTIVE_MEMBER_WINDOW_DAYS,
    activeSince: input.electorate.activeSince,
    eligibleRegisteredMembers: calculation.eligibleRegisteredMembers,
    activeEligibleMembers: calculation.activeEligibleMembers,
    duplicateAccountsExcluded: input.electorate.duplicateAccountsExcluded,
    disabledAccountsExcluded: input.electorate.disabledAccountsExcluded,
    missingAccountsExcluded: input.electorate.missingAccountsExcluded,
    platformQuorumRequired: calculation.platformQuorumRequired,
    platformQuorumMet: calculation.platformQuorumMet,
    ballotQuorumRequired: calculation.ballotQuorumRequired,
    ballotQuorumMet: calculation.ballotQuorumMet,
    participatingMembers: calculation.participationCount,
    tally: input.tally,
    quorumMet: calculation.quorumMet,
    approvalSatisfied: calculation.approvalSatisfied,
    verdict: calculation.verdict,
    approvalRule: "simple-majority-d9-v1",
  };
}

/** A closure record that preserves the electorate even when votes cannot be read. */
export function buildUnavailableQuorumRecord(input: {
  ballotId: string;
  matterId: string;
  revisionId: string;
  closedAt: Date;
  recordedAt?: Date;
  electorate: QuorumElectorate;
  reason: string;
}): BallotQuorumRecord {
  return {
    schemaVersion: 1,
    recordId: `quorum:${input.ballotId}`,
    ballotId: input.ballotId,
    matterId: input.matterId,
    revisionId: input.revisionId,
    ruleVersion: BALLOT_QUORUM_RULE_VERSION,
    ruleEffectiveAt: QUORUM_RULE_EFFECTIVE_AT,
    status: "unavailable",
    closedAt: input.closedAt,
    recordedAt: input.recordedAt ?? new Date(),
    activeWindowDays: ACTIVE_MEMBER_WINDOW_DAYS,
    activeSince: input.electorate.activeSince,
    eligibleRegisteredMembers: input.electorate.eligibleRegisteredMembers,
    activeEligibleMembers: input.electorate.activeEligibleMembers,
    duplicateAccountsExcluded: input.electorate.duplicateAccountsExcluded,
    disabledAccountsExcluded: input.electorate.disabledAccountsExcluded,
    missingAccountsExcluded: input.electorate.missingAccountsExcluded,
    platformQuorumRequired: PLATFORM_QUORUM_MINIMUM,
    platformQuorumMet:
      input.electorate.eligibleRegisteredMembers >= PLATFORM_QUORUM_MINIMUM,
    ballotQuorumRequired: calculateBallotQuorum(
      input.electorate.activeEligibleMembers,
    ),
    ballotQuorumMet: false,
    quorumMet: false,
    approvalSatisfied: false,
    verdict: "inconclusive",
    approvalRule: "simple-majority-d9-v1",
    anomalies: [input.reason],
  };
}

/**
 * Record for a ballot that closed before the quorum rule took effect. It is
 * deliberately marked not applied, so certification uses the old approval-only
 * test and the historical gap is visible in the audit record.
 */
export function buildLegacyQuorumRecord(input: {
  ballotId: string;
  matterId: string;
  revisionId: string;
  closedAt: Date;
  recordedAt?: Date;
  tally: VoteTally;
}): BallotQuorumRecord {
  return {
    schemaVersion: 1,
    recordId: `quorum:${input.ballotId}`,
    ballotId: input.ballotId,
    matterId: input.matterId,
    revisionId: input.revisionId,
    ruleVersion: "pre-quorum-legacy",
    ruleEffectiveAt: QUORUM_RULE_EFFECTIVE_AT,
    status: "legacy-not-applied",
    closedAt: input.closedAt,
    recordedAt: input.recordedAt ?? new Date(),
    activeWindowDays: ACTIVE_MEMBER_WINDOW_DAYS,
    tally: input.tally,
    approvalSatisfied: input.tally.approve > input.tally.reject,
    verdict: input.tally.approve > input.tally.reject ? "adopted" : "rejected",
    approvalRule: "simple-majority-d9-v1",
    anomalies: [
      "This ballot closed before the two-tier quorum rule took effect. Quorum is not applied retrospectively.",
    ],
  };
}
