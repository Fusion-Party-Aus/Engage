import type { ClientSession, Db } from "mongodb";
import {
  loadBallotCryptoConfigForRead,
  type BallotCryptoConfig,
} from "./ballot-crypto.ts";
import { logOperationalEvent } from "./resilience.ts";
import type { VoteChoice, VoteTally } from "./types.ts";
import { PROPOSAL_VOTES, decodeStoredVote } from "./vote-storage.ts";

/**
 * Display-only ballot tally projection.
 *
 * Public list pages (`/` and `/proposals/`) need approve/abstain/reject totals.
 * Reading those from `proposal_votes` means scanning every vote and decrypting
 * every ballot envelope on a list read, which is the cost this projection
 * removes. `ballot_tallies` holds one aggregate row per `(ballotId, revisionId)`.
 *
 * The projection is **not authoritative**:
 *
 * - `recordFormalDecision` keeps recomputing the outcome from the votes bound
 *   to the ballot and revision, and never reads this collection.
 * - Eligibility, ballot binding, deadlines and result semantics are unchanged.
 * - A row carries counts and a timestamp only. It never stores a member id, a
 *   choice, an envelope, a reason or any record that identifies a voter.
 * - A write failure after a committed vote is logged as an operational event
 *   and never fails, delays or alters that vote.
 * - A missing or stale row is displayed as a neutral "tally updating" state, not
 *   as a number. `npm run ballots:tally-projection` rebuilds and verifies rows.
 */

export const BALLOT_TALLIES = "ballot_tallies";

/**
 * A projection older than this is not trusted for display. Ten minutes is long
 * enough that a voter never sees a flicker after their own vote, and short
 * enough that a stopped projection writer surfaces as an operational state.
 */
export const BALLOT_TALLY_STALENESS_MS = 10 * 60_000;

/**
 * A committed vote is never held open longer than this waiting for its display
 * projection. The write continues in the background; the response does not.
 */
export const BALLOT_TALLY_WRITE_DEADLINE_MS = 500;

export const BALLOT_TALLY_INDEX = "one_tally_projection_per_ballot_revision";

export interface BallotTallyProjection {
  ballotId: string;
  revisionId: string;
  approve: number;
  abstain: number;
  reject: number;
  total: number;
  /** When this row was last written. Display staleness is measured from here. */
  updatedAt: Date;
}

export interface BallotTallyKey {
  ballotId: string;
  revisionId: string;
}

export interface ProjectedBallotTally {
  row: BallotTallyProjection;
  tally: VoteTally;
  fresh: boolean;
}

const TALLY_PROJECTION = {
  _id: 0,
  ballotId: 1,
  revisionId: 1,
  approve: 1,
  abstain: 1,
  reject: 1,
  total: 1,
  updatedAt: 1,
} as const;

const VOTE_SCAN_PROJECTION = {
  ballotId: 1,
  proposalId: 1,
  revisionId: 1,
  amendmentRevisionId: 1,
  choice: 1,
  voterBlindIndex: 1,
  voteEnvelope: 1,
} as const;

export function ballotTallyKey(ballotId: string, revisionId: string): string {
  return `${ballotId}\u0000${revisionId}`;
}

export function emptyVoteTally(): VoteTally {
  return { approve: 0, abstain: 0, reject: 0, total: 0 };
}

export function projectionToTally(
  row: Pick<
    BallotTallyProjection,
    "approve" | "abstain" | "reject" | "total"
  >,
): VoteTally {
  return {
    approve: Number(row.approve ?? 0),
    abstain: Number(row.abstain ?? 0),
    reject: Number(row.reject ?? 0),
    total: Number(row.total ?? 0),
  };
}

export function isProjectionFresh(
  row: Pick<BallotTallyProjection, "updatedAt">,
  now: Date = new Date(),
  windowMs: number = BALLOT_TALLY_STALENESS_MS,
): boolean {
  const updatedAt =
    row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt);
  if (!Number.isFinite(updatedAt.getTime())) return false;
  return now.getTime() - updatedAt.getTime() <= windowMs;
}

function asProjection(raw: Record<string, any>): BallotTallyProjection {
  return {
    ballotId: String(raw.ballotId ?? ""),
    revisionId: String(raw.revisionId ?? ""),
    approve: Number(raw.approve ?? 0),
    abstain: Number(raw.abstain ?? 0),
    reject: Number(raw.reject ?? 0),
    total: Number(raw.total ?? 0),
    updatedAt:
      raw.updatedAt instanceof Date
        ? raw.updatedAt
        : new Date(raw.updatedAt ?? 0),
  };
}

/**
 * Read projection rows for a set of ballot/revision pairs. Never touches
 * `proposal_votes`. Freshness is reported rather than hidden so a caller cannot
 * show a stale number by accident.
 */
export async function readBallotTallyProjections(
  db: Db,
  keys: BallotTallyKey[],
  options: { now?: Date; windowMs?: number; session?: ClientSession } = {},
): Promise<Map<string, ProjectedBallotTally>> {
  const unique = new Map<string, BallotTallyKey>();
  for (const key of keys) {
    if (!key.ballotId || !key.revisionId) continue;
    unique.set(ballotTallyKey(key.ballotId, key.revisionId), key);
  }
  const result = new Map<string, ProjectedBallotTally>();
  if (unique.size === 0) return result;
  const now = options.now ?? new Date();
  const rows = await db
    .collection(BALLOT_TALLIES)
    .find(
      {
        $or: [...unique.values()].map((key) => ({
          ballotId: key.ballotId,
          revisionId: key.revisionId,
        })),
      },
      {
        projection: TALLY_PROJECTION,
        ...(options.session ? { session: options.session } : {}),
      },
    )
    .toArray();
  for (const raw of rows as Array<Record<string, any>>) {
    const row = asProjection(raw);
    const key = ballotTallyKey(row.ballotId, row.revisionId);
    if (!unique.has(key)) continue;
    result.set(key, {
      row,
      tally: projectionToTally(row),
      fresh: isProjectionFresh(row, now, options.windowMs),
    });
  }
  return result;
}

export async function ensureBallotTallyIndexes(db: Db): Promise<void> {
  await db
    .collection(BALLOT_TALLIES)
    .createIndex(
      { ballotId: 1, revisionId: 1 },
      { unique: true, name: BALLOT_TALLY_INDEX },
    )
    .catch(() => {});
}

interface VoteScanResult {
  tally: VoteTally;
  /** Votes in this ballot/revision whose choice could not be read. */
  unreadable: number;
  encryptedWithoutKeys: number;
}

async function scanRevisionVotes(
  db: Db,
  input: BallotTallyKey & {
    cryptoConfig?: BallotCryptoConfig | null;
    session?: ClientSession;
  },
): Promise<VoteScanResult> {
  const rows = await db
    .collection(PROPOSAL_VOTES)
    .find(
      { ballotId: input.ballotId, revisionId: input.revisionId },
      {
        projection: VOTE_SCAN_PROJECTION,
        ...(input.session ? { session: input.session } : {}),
      },
    )
    .toArray();
  const outcome: VoteScanResult = {
    tally: emptyVoteTally(),
    unreadable: 0,
    encryptedWithoutKeys: 0,
  };
  for (const raw of rows as Array<Record<string, any>>) {
    const row = raw as Record<string, any>;
    if (row.voteEnvelope && !input.cryptoConfig) {
      outcome.encryptedWithoutKeys += 1;
      continue;
    }
    let choice: VoteChoice;
    try {
      choice = decodeStoredVote(row, input.cryptoConfig ?? null).choice;
    } catch {
      outcome.unreadable += 1;
      continue;
    }
    if (
      choice !== "approve" &&
      choice !== "abstain" &&
      choice !== "reject"
    ) {
      outcome.unreadable += 1;
      continue;
    }
    outcome.tally[choice] += 1;
    outcome.tally.total += 1;
  }
  return outcome;
}

export class BallotTallyProjectionError extends Error {
  code: string;
  constructor(message: string, code = "BALLOT_TALLY_PROJECTION_ERROR") {
    super(message);
    this.name = "BallotTallyProjectionError";
    this.code = code;
  }
}

/**
 * Recount one ballot/revision pair from its votes and write the row. This is the
 * repair path: it is used when a delta cannot be derived (no prior row, an
 * unreadable prior vote) and by the CLI. It refuses to write a partial count
 * when a vote cannot be read.
 */
export async function rebuildBallotTallyProjection(
  db: Db,
  input: BallotTallyKey & {
    cryptoConfig?: BallotCryptoConfig | null;
    now?: Date;
    session?: ClientSession;
  },
): Promise<BallotTallyProjection> {
  const scan = await scanRevisionVotes(db, input);
  if (scan.encryptedWithoutKeys > 0) {
    throw new BallotTallyProjectionError(
      "Encrypted votes exist but ballot decryption keys are not configured.",
      "BALLOT_TALLY_KEYS_UNAVAILABLE",
    );
  }
  if (scan.unreadable > 0) {
    throw new BallotTallyProjectionError(
      "Some votes bound to this revision could not be read.",
      "BALLOT_TALLY_UNREADABLE",
    );
  }
  const now = input.now ?? new Date();
  const row: BallotTallyProjection = {
    ballotId: input.ballotId,
    revisionId: input.revisionId,
    ...scan.tally,
    updatedAt: now,
  };
  await db.collection(BALLOT_TALLIES).updateOne(
    { ballotId: input.ballotId, revisionId: input.revisionId },
    {
      $set: {
        approve: row.approve,
        abstain: row.abstain,
        reject: row.reject,
        total: row.total,
        updatedAt: row.updatedAt,
      },
    },
    { upsert: true, ...(input.session ? { session: input.session } : {}) },
  );
  return row;
}

/**
 * Counts to add after a committed vote. `null` means the delta cannot be
 * derived and the row must be rebuilt from votes instead.
 */
export function voteTallyDelta(input: {
  choice: VoteChoice;
  hadPreviousVote: boolean;
  previousChoice?: VoteChoice | null;
}): VoteTally | null {
  if (!input.hadPreviousVote) {
    const tally = emptyVoteTally();
    tally[input.choice] = 1;
    tally.total = 1;
    return tally;
  }
  if (!input.previousChoice) return null;
  if (input.previousChoice === input.choice) return emptyVoteTally();
  const tally = emptyVoteTally();
  tally[input.previousChoice] = -1;
  tally[input.choice] = 1;
  return tally;
}

/**
 * Apply a committed vote to the display projection. Called only after the vote
 * transaction commits, so no projection write can be rolled into the vote.
 */
export async function updateBallotTallyProjection(
  db: Db,
  input: BallotTallyKey & {
    choice: VoteChoice;
    hadPreviousVote: boolean;
    previousChoice?: VoteChoice | null;
    /** Revision the member's previous vote was bound to, when it changed. */
    previousRevisionId?: string | null;
    cryptoConfig?: BallotCryptoConfig | null;
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  if (
    input.hadPreviousVote &&
    input.previousChoice &&
    input.previousRevisionId &&
    input.previousRevisionId !== input.revisionId
  ) {
    // An amendment ballot can be re-bound to a newer revision. The member's
    // old count belongs to the old row, so recount both rows from their votes
    // instead of moving a count inside the new revision.
    await rebuildBallotTallyProjection(db, {
      ballotId: input.ballotId,
      revisionId: input.previousRevisionId,
      cryptoConfig: input.cryptoConfig,
      now,
    });
    await rebuildBallotTallyProjection(db, {
      ballotId: input.ballotId,
      revisionId: input.revisionId,
      cryptoConfig: input.cryptoConfig,
      now,
    });
    return;
  }
  const delta = voteTallyDelta(input);
  if (delta) {
    const increments: Record<string, number> = {};
    if (delta.approve !== 0) increments.approve = delta.approve;
    if (delta.abstain !== 0) increments.abstain = delta.abstain;
    if (delta.reject !== 0) increments.reject = delta.reject;
    if (delta.total !== 0) increments.total = delta.total;
    try {
      const result = await db.collection(BALLOT_TALLIES).updateOne(
        { ballotId: input.ballotId, revisionId: input.revisionId },
        {
          ...(Object.keys(increments).length ? { $inc: increments } : {}),
          $set: { updatedAt: now },
        },
        { upsert: false },
      );
      if ((result.matchedCount ?? 0) > 0) return;
    } catch (error) {
      // A concurrent first vote may have created the row between the read and
      // the upsert. Falling through to the rebuild produces the correct row.
      if ((error as { code?: number }).code !== 11000) throw error;
    }
  }
  await rebuildBallotTallyProjection(db, {
    ballotId: input.ballotId,
    revisionId: input.revisionId,
    cryptoConfig: input.cryptoConfig,
    now,
  });
}

function settleWithin(
  work: Promise<void>,
  deadlineMs: number,
  onTimeout: () => void,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(() => {
      if (!settled) onTimeout();
      finish();
    }, Math.max(0, deadlineMs));
    timer.unref?.();
    work.then(
      () => {
        clearTimeout(timer);
        finish();
      },
      () => {
        clearTimeout(timer);
        finish();
      },
    );
  });
}

/**
 * Best-effort projection update for a vote that has already committed.
 *
 * It never throws and never holds the response past `deadlineMs`. Failures and
 * timeouts are operational events; they do not change the vote, the ballot
 * binding, eligibility or the certified result. The repair CLI reports and
 * rebuilds any row this leaves behind.
 */
export async function projectCommittedVoteTally(
  db: Db,
  input: BallotTallyKey & {
    choice: VoteChoice;
    hadPreviousVote: boolean;
    previousChoice?: VoteChoice | null;
    previousRevisionId?: string | null;
    cryptoConfig?: BallotCryptoConfig | null;
    now?: Date;
    deadlineMs?: number;
  },
): Promise<void> {
  const work = updateBallotTallyProjection(db, input).catch((error: unknown) => {
    logOperationalEvent("error", "ballot_tally_projection_failed", {
      ballotId: input.ballotId,
      revisionId: input.revisionId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  await settleWithin(
    work,
    input.deadlineMs ?? BALLOT_TALLY_WRITE_DEADLINE_MS,
    () =>
      logOperationalEvent("warn", "ballot_tally_projection_timeout", {
        ballotId: input.ballotId,
        revisionId: input.revisionId,
        deadlineMs: input.deadlineMs ?? BALLOT_TALLY_WRITE_DEADLINE_MS,
      }),
  );
}

export interface BallotTallyRepairRow {
  ballotId: string;
  revisionId: string;
  votes: number;
  expected: VoteTally;
  current?: VoteTally;
  status: "match" | "missing" | "mismatch" | "orphan";
  unreadableVotes: number;
}

export interface BallotTallyRepairReport {
  dryRun: boolean;
  scannedVotes: number;
  groups: number;
  rows: BallotTallyRepairRow[];
  unreadableVotes: number;
  encryptedWithoutKeys: number;
  /** Projection rows with no votes behind them. Never a vote record. */
  orphanRows: number;
  needsRepair: boolean;
}

/**
 * Compare the projection with the votes it should represent. Reads votes, never
 * writes them. A group whose votes cannot be read is reported, not counted.
 */
export async function inspectBallotTallyProjection(
  db: Db,
  options: {
    cryptoConfig?: BallotCryptoConfig | null;
    now?: Date;
  } = {},
): Promise<BallotTallyRepairReport> {
  const cryptoConfig =
    options.cryptoConfig === undefined
      ? loadBallotCryptoConfigForRead(process.env)
      : options.cryptoConfig;
  const voteRows = await db
    .collection(PROPOSAL_VOTES)
    .find({}, { projection: VOTE_SCAN_PROJECTION })
    .toArray();

  const groups = new Map<
    string,
    { ballotId: string; revisionId: string; tally: VoteTally; unreadable: number; noKeys: number }
  >();
  for (const raw of voteRows as Array<Record<string, any>>) {
    const ballotId = String(raw.ballotId ?? "");
    const revisionId = String(raw.revisionId ?? "");
    if (!ballotId || !revisionId) {
      // A vote outside a bound revision is not a tally group; certification
      // reports it separately as an unbound vote.
      continue;
    }
    const key = ballotTallyKey(ballotId, revisionId);
    let group = groups.get(key);
    if (!group) {
      group = {
        ballotId,
        revisionId,
        tally: emptyVoteTally(),
        unreadable: 0,
        noKeys: 0,
      };
      groups.set(key, group);
    }
    if (raw.voteEnvelope && !cryptoConfig) {
      group.noKeys += 1;
      continue;
    }
    let choice: VoteChoice;
    try {
      choice = decodeStoredVote(raw, cryptoConfig ?? null).choice;
    } catch {
      group.unreadable += 1;
      continue;
    }
    if (choice !== "approve" && choice !== "abstain" && choice !== "reject") {
      group.unreadable += 1;
      continue;
    }
    group.tally[choice] += 1;
    group.tally.total += 1;
  }

  const existingRows = await db
    .collection(BALLOT_TALLIES)
    .find({}, { projection: TALLY_PROJECTION })
    .toArray();
  const existing = new Map<string, BallotTallyProjection>();
  for (const raw of existingRows as Array<Record<string, any>>) {
    const row = asProjection(raw);
    existing.set(ballotTallyKey(row.ballotId, row.revisionId), row);
  }

  const rows: BallotTallyRepairRow[] = [];
  let unreadableVotes = 0;
  let encryptedWithoutKeys = 0;
  for (const [key, group] of [...groups.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    unreadableVotes += group.unreadable;
    encryptedWithoutKeys += group.noKeys;
    const current = existing.get(key);
    const currentTally = current ? projectionToTally(current) : undefined;
    const blocked = group.unreadable > 0 || group.noKeys > 0;
    const matches =
      currentTally !== undefined &&
      currentTally.approve === group.tally.approve &&
      currentTally.abstain === group.tally.abstain &&
      currentTally.reject === group.tally.reject &&
      currentTally.total === group.tally.total;
    rows.push({
      ballotId: group.ballotId,
      revisionId: group.revisionId,
      votes: group.tally.total + group.unreadable + group.noKeys,
      expected: group.tally,
      ...(currentTally ? { current: currentTally } : {}),
      status: blocked ? "mismatch" : matches ? "match" : current ? "mismatch" : "missing",
      unreadableVotes: group.unreadable + group.noKeys,
    });
    existing.delete(key);
  }

  const orphanRows: BallotTallyRepairRow[] = [...existing.values()]
    .sort((a, b) =>
      ballotTallyKey(a.ballotId, a.revisionId).localeCompare(
        ballotTallyKey(b.ballotId, b.revisionId),
      ),
    )
    .map((row) => ({
      ballotId: row.ballotId,
      revisionId: row.revisionId,
      votes: 0,
      expected: emptyVoteTally(),
      current: projectionToTally(row),
      status: "orphan" as const,
      unreadableVotes: 0,
    }));

  return {
    dryRun: true,
    scannedVotes: voteRows.length,
    groups: groups.size,
    rows,
    unreadableVotes,
    encryptedWithoutKeys,
    orphanRows: orphanRows.length,
    // An orphan row already holding zero counts is truthful and needs no write;
    // it stays reported so an operator can see the shape of the collection.
    needsRepair:
      rows.some((row) => row.status !== "match") ||
      orphanRows.some((row) => row.current && !isZeroTally(row.current)),
  };
}

function isZeroTally(tally: VoteTally): boolean {
  return tally.approve === 0 && tally.abstain === 0 && tally.reject === 0 && tally.total === 0;
}

/**
 * Rebuild projection rows from the votes they represent. Never deletes a vote.
 * Orphan rows are set to zero because the votes are the only source of truth.
 */
export async function repairBallotTallyProjection(
  db: Db,
  options: {
    cryptoConfig?: BallotCryptoConfig | null;
    now?: Date;
    apply: boolean;
  },
): Promise<{
  report: BallotTallyRepairReport;
  written: number;
  zeroed: number;
  skipped: number;
}> {
  const report = await inspectBallotTallyProjection(db, options);
  if (!options.apply) {
    return { report, written: 0, zeroed: 0, skipped: 0 };
  }
  if (report.encryptedWithoutKeys > 0) {
    throw new BallotTallyProjectionError(
      "Encrypted votes exist but ballot decryption keys are not configured; refusing to write partial tallies.",
      "BALLOT_TALLY_KEYS_UNAVAILABLE",
    );
  }
  const now = options.now ?? new Date();
  let written = 0;
  let zeroed = 0;
  let skipped = 0;
  for (const row of report.rows) {
    if (row.unreadableVotes > 0) {
      skipped += 1;
      continue;
    }
    if (row.status === "match") continue;
    await db.collection(BALLOT_TALLIES).updateOne(
      { ballotId: row.ballotId, revisionId: row.revisionId },
      {
        $set: {
          approve: row.expected.approve,
          abstain: row.expected.abstain,
          reject: row.expected.reject,
          total: row.expected.total,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
    written += 1;
  }
  if (report.orphanRows > 0) {
    const orphans = await db
      .collection(BALLOT_TALLIES)
      .find({}, { projection: { ballotId: 1, revisionId: 1 } })
      .toArray();
    const groups = new Set(report.rows.map((row) => ballotTallyKey(row.ballotId, row.revisionId)));
    for (const raw of orphans as Array<Record<string, any>>) {
      const ballotId = String(raw.ballotId ?? "");
      const revisionId = String(raw.revisionId ?? "");
      if (!ballotId || !revisionId) continue;
      if (groups.has(ballotTallyKey(ballotId, revisionId))) continue;
      const current = (await db
        .collection(BALLOT_TALLIES)
        .findOne({ ballotId, revisionId })) as Record<string, any> | null;
      if (!current) continue;
      if (
        isZeroTally({
          approve: Number(current.approve ?? 0),
          abstain: Number(current.abstain ?? 0),
          reject: Number(current.reject ?? 0),
          total: Number(current.total ?? 0),
        })
      ) {
        continue;
      }
      await db.collection(BALLOT_TALLIES).updateOne(
        { ballotId, revisionId },
        {
          $set: {
            approve: 0,
            abstain: 0,
            reject: 0,
            total: 0,
            updatedAt: now,
          },
        },
      );
      zeroed += 1;
    }
  }
  return { report: { ...report, dryRun: false }, written, zeroed, skipped };
}
