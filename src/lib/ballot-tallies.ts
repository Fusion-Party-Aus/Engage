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
 *
 * Writes are atomic and race-safe:
 *
 * - a normal vote is one `$inc` upsert, so a first vote creates and counts its
 *   row in a single operation; there is no read-then-rebuild for a missing row;
 * - a revision move is two transactional deltas, so no row is ever half-moved;
 * - the only recount path (an unreadable prior vote, or the repair CLI) is
 *   compare-and-set guarded against a concurrent increment, bounded by a
 *   watermark, and abandoned at its deadline rather than writing a stale count.
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
 * projection. Work that cannot finish inside the deadline is abandoned rather
 * than left writing a stale absolute count; the repair CLI picks the row up.
 */
export const BALLOT_TALLY_WRITE_DEADLINE_MS = 500;

/** Bounded retries when a rebuild races a concurrent increment. */
export const BALLOT_TALLY_MAX_REBUILD_ATTEMPTS = 3;

/**
 * Internal field on a projection row, never displayed: `version` is a
 * compare-and-set token. Every increment adds to it, and a rebuild may only
 * write absolute counts when the token is unchanged since it was read.
 */
export const BALLOT_TALLY_VERSION_FIELD = "version";

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

/**
 * A row is only shown when its counts are internally consistent. An increment
 * applied to a missing row (projection drift, not a vote fault) can leave a
 * negative or non-summing row; that must read as "tally pending", never as a
 * number.
 */
export function isTallyCredible(tally: VoteTally): boolean {
  const counts = [tally.approve, tally.abstain, tally.reject, tally.total];
  if (!counts.every((value) => Number.isInteger(value) && value >= 0)) {
    return false;
  }
  return tally.total === tally.approve + tally.abstain + tally.reject;
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
      fresh:
        isProjectionFresh(row, now, options.windowMs) &&
        isTallyCredible(projectionToTally(row)),
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
    maxTimeMS?: number;
  },
): Promise<VoteScanResult> {
  const rows = await db
    .collection(PROPOSAL_VOTES)
    .find(
      { ballotId: input.ballotId, revisionId: input.revisionId },
      {
        projection: VOTE_SCAN_PROJECTION,
        ...(input.session ? { session: input.session } : {}),
        ...(input.maxTimeMS
          ? { maxTimeMS: Math.max(1, Math.floor(input.maxTimeMS)) }
          : {}),
      } as Record<string, unknown>,
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

function assertProjectionTime(deadlineAt: number | undefined): void {
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
    throw new BallotTallyProjectionError(
      "The display projection did not finish inside its write deadline.",
      "BALLOT_TALLY_PROJECTION_DEADLINE",
    );
  }
}

/**
 * Recount one ballot/revision pair from its votes and write the row.
 *
 * Rebuilds are only used when a delta cannot be derived (an unreadable prior
 * vote) and by the repair CLI. They are absolute and compare-and-set only:
 *
 * 1. read the row's `version` (0 when the row or field is missing);
 * 2. recount all votes bound to the ballot and revision;
 * 3. write absolute counts with the observed version in the filter and
 *    `version + 1` in the write;
 * 4. if the filter does not match, recount and retry (bounded).
 *
 * A concurrent increment either lands before the recount (it is included and
 * the absolute write is correct) or after the compare-and-set (it adds on top).
 * If it lands between the version read and the write the filter fails and the
 * recount runs again. There is no watermark and no skipped increment.
 *
 * If the deadline passes, nothing is written and the row is left for the repair
 * CLI rather than written from a stale count.
 */
export async function rebuildBallotTallyProjection(
  db: Db,
  input: BallotTallyKey & {
    cryptoConfig?: BallotCryptoConfig | null;
    now?: Date;
    session?: ClientSession;
    deadlineAt?: number;
    attempts?: number;
  },
): Promise<BallotTallyProjection> {
  const attempts = input.attempts ?? BALLOT_TALLY_MAX_REBUILD_ATTEMPTS;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    assertProjectionTime(input.deadlineAt);
    const existing = await db
      .collection(BALLOT_TALLIES)
      .findOne(
        { ballotId: input.ballotId, revisionId: input.revisionId },
        {
          projection: {
            _id: 0,
            [BALLOT_TALLY_VERSION_FIELD]: 1,
          },
          ...(input.session ? { session: input.session } : {}),
        },
      );
    const observedVersion =
      existing &&
      typeof existing[BALLOT_TALLY_VERSION_FIELD] === "number" &&
      Number.isInteger(existing[BALLOT_TALLY_VERSION_FIELD])
        ? (existing[BALLOT_TALLY_VERSION_FIELD] as number)
        : 0;
    const remaining = input.deadlineAt
      ? input.deadlineAt - Date.now()
      : undefined;
    const scan = await scanRevisionVotes(db, {
      ballotId: input.ballotId,
      revisionId: input.revisionId,
      cryptoConfig: input.cryptoConfig,
      session: input.session,
      ...(remaining !== undefined ? { maxTimeMS: remaining } : {}),
    });
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
    assertProjectionTime(input.deadlineAt);

    const row: BallotTallyProjection = {
      ballotId: input.ballotId,
      revisionId: input.revisionId,
      ...scan.tally,
      updatedAt: input.now ?? new Date(),
    };
    const versionFilter =
      observedVersion > 0
        ? { [BALLOT_TALLY_VERSION_FIELD]: observedVersion }
        : {
            $or: [
              { [BALLOT_TALLY_VERSION_FIELD]: 0 },
              { [BALLOT_TALLY_VERSION_FIELD]: { $exists: false } },
            ],
          };
    const filter = {
      ballotId: input.ballotId,
      revisionId: input.revisionId,
      ...versionFilter,
    };
    try {
      const result = await db.collection(BALLOT_TALLIES).updateOne(
        filter,
        {
          $set: {
            approve: row.approve,
            abstain: row.abstain,
            reject: row.reject,
            total: row.total,
            updatedAt: row.updatedAt,
            [BALLOT_TALLY_VERSION_FIELD]: observedVersion + 1,
          },
        },
        {
          ...(existing ? {} : { upsert: true }),
          ...(input.session ? { session: input.session } : {}),
        },
      );
      if ((result.matchedCount ?? 0) > 0 || result.upsertedId) return row;
    } catch (error) {
      // A concurrent first write may have created the row between the read and
      // the insert. Retry the whole read/recount/write.
      if ((error as { code?: number }).code !== 11000) throw error;
    }
  }
  throw new BallotTallyProjectionError(
    "The display projection changed while it was being rebuilt.",
    "BALLOT_TALLY_PROJECTION_CONFLICT",
  );
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

function tallyIncrements(delta: VoteTally): Record<string, number> {
  const increments: Record<string, number> = {};
  if (delta.approve !== 0) increments.approve = delta.approve;
  if (delta.abstain !== 0) increments.abstain = delta.abstain;
  if (delta.reject !== 0) increments.reject = delta.reject;
  if (delta.total !== 0) increments.total = delta.total;
  return increments;
}

/**
 * Apply a committed vote to the display projection. Called only after the vote
 * transaction commits, so no projection write can be rolled into the vote.
 *
 * The normal path is one atomic upsert increment, so a first vote creates and
 * counts its row in a single operation and no read-then-rebuild is involved.
 * Increments always apply; nothing is skipped. The revision move is
 * transactional, not a recount.
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
    deadlineAt?: number;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  const deadlineAt =
    input.deadlineAt ?? now.getTime() + BALLOT_TALLY_WRITE_DEADLINE_MS;
  assertProjectionTime(deadlineAt);

  if (
    input.hadPreviousVote &&
    input.previousChoice &&
    input.previousRevisionId &&
    input.previousRevisionId !== input.revisionId
  ) {
    // An amendment ballot can be re-bound to a newer revision. The member's old
    // count belongs to the old row, so move it with transactional deltas on
    // both rows instead of recounting and racing other increments.
    await moveBallotTallyToRevision(db, {
      ballotId: input.ballotId,
      previousRevisionId: input.previousRevisionId,
      previousChoice: input.previousChoice,
      revisionId: input.revisionId,
      choice: input.choice,
      now,
    });
    return;
  }

  const delta = voteTallyDelta(input);
  if (!delta) {
    // A genuinely unreadable prior vote cannot be turned into a delta. Rebuild
    // under the compare-and-set guard; if it cannot finish in time, leave the
    // row for the repair CLI rather than writing a stale absolute count.
    await rebuildBallotTallyProjection(db, {
      ballotId: input.ballotId,
      revisionId: input.revisionId,
      cryptoConfig: input.cryptoConfig,
      deadlineAt,
    });
    return;
  }

  const increments = tallyIncrements(delta);
  // `$inc` only creates the fields it increments, so seed the untouched ones on
  // insert. Setting them with `$set` would race the increment; `$setOnInsert`
  // applies once, atomically with it.
  const setOnInsert: Record<string, number> = {};
  for (const field of ["approve", "abstain", "reject", "total"] as const) {
    if (!(field in increments)) setOnInsert[field] = 0;
  }
  const filter: Record<string, unknown> = {
    ballotId: input.ballotId,
    revisionId: input.revisionId,
  };
  const update: Record<string, unknown> = {
    $set: { updatedAt: now },
    $inc: {
      ...increments,
      [BALLOT_TALLY_VERSION_FIELD]: 1,
    },
    ...(Object.keys(setOnInsert).length ? { $setOnInsert: setOnInsert } : {}),
  };
  const applyIncrement = async () => {
    try {
      const result = await db
        .collection(BALLOT_TALLIES)
        .updateOne(filter, update, {
          // A same-choice re-cast has no counts to add. If its row is missing,
          // leave it missing for the repair CLI rather than creating a false
          // zero row.
          upsert: Object.keys(increments).length > 0,
        });
      return (result.matchedCount ?? 0) > 0 || Boolean(result.upsertedId);
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      // Another first vote created the row between the filter and the upsert.
      // Retrying without upsert applies this vote on top of it.
      const retry = await db
        .collection(BALLOT_TALLIES)
        .updateOne(filter, update, { upsert: false });
      // Zero matches here means a rebuild counted this vote meanwhile.
      return (retry.matchedCount ?? 0) > 0;
    }
  };
  for (let attempt = 0; ; attempt += 1) {
    try {
      await applyIncrement();
      return;
    } catch (error) {
      // A transactional revision move can hold this row briefly. Retry a
      // write conflict within the deadline; otherwise leave it to repair.
      if (
        (error as { code?: number }).code === 112 &&
        attempt < 2 &&
        Date.now() < deadlineAt
      ) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 5 * (attempt + 1));
          timer.unref?.();
        });
        continue;
      }
      throw error;
    }
  }
}

/**
 * Move a member's count from the previous revision's row to the current one.
 * Both deltas commit in one transaction, so a concurrent increment cannot see
 * half a move. The old row is never created; the new row is.
 */
async function moveBallotTallyToRevision(
  db: Db,
  input: {
    ballotId: string;
    previousRevisionId: string;
    previousChoice: VoteChoice;
    revisionId: string;
    choice: VoteChoice;
    now: Date;
  },
): Promise<void> {
  // Imported lazily: db.ts owns the tally index setup, so a static import would
  // create a module cycle.
  const { runInTransaction } = await import("./db.ts");
  await runInTransaction(db, async (session) => {
    const sessionOpts = session ? { session } : undefined;
    await db.collection(BALLOT_TALLIES).updateOne(
      { ballotId: input.ballotId, revisionId: input.previousRevisionId },
      {
        $inc: {
          [input.previousChoice]: -1,
          total: -1,
          [BALLOT_TALLY_VERSION_FIELD]: 1,
        },
        $set: { updatedAt: input.now },
      },
      sessionOpts,
    );
    await db.collection(BALLOT_TALLIES).updateOne(
      { ballotId: input.ballotId, revisionId: input.revisionId },
      {
        $inc: {
          [input.choice]: 1,
          total: 1,
          [BALLOT_TALLY_VERSION_FIELD]: 1,
        },
        $set: { updatedAt: input.now },
      },
      { upsert: true, ...(sessionOpts ?? {}) },
    );
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
 * It never throws and never holds the response past `deadlineMs`. The work is
 * also bounded internally: a rebuild checks the deadline before every write and
 * uses `maxTimeMS` for its recount, so a timeout leaves the row for the repair
 * CLI instead of writing a stale absolute count. Failures and timeouts are
 * operational events; they do not change the vote, the ballot binding,
 * eligibility or the certified result.
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
  // The default 500 ms keeps the vote response responsive. A test harness or a
  // deliberately slow deployment can raise it; an expired deadline still writes
  // nothing and leaves the row for the repair CLI.
  const configuredDeadline = Number.parseInt(
    process.env.ENGAGE_BALLOT_TALLY_DEADLINE_MS ?? "",
    10,
  );
  const deadlineMs =
    input.deadlineMs ??
    (Number.isFinite(configuredDeadline) && configuredDeadline > 0
      ? configuredDeadline
      : BALLOT_TALLY_WRITE_DEADLINE_MS);
  const deadlineAt = Date.now() + deadlineMs;
  let timedOut = false;
  const work = updateBallotTallyProjection(db, { ...input, deadlineAt }).catch(
    (error: unknown) => {
      if (timedOut) return;
      if (
        error instanceof BallotTallyProjectionError &&
        error.code === "BALLOT_TALLY_PROJECTION_DEADLINE"
      ) {
        logOperationalEvent("warn", "ballot_tally_projection_timeout", {
          ballotId: input.ballotId,
          revisionId: input.revisionId,
          deadlineMs,
        });
        return;
      }
      if (
        error instanceof BallotTallyProjectionError &&
        error.code === "BALLOT_TALLY_PROJECTION_CONFLICT"
      ) {
        logOperationalEvent("warn", "ballot_tally_projection_conflict", {
          ballotId: input.ballotId,
          revisionId: input.revisionId,
        });
        return;
      }
      logOperationalEvent("error", "ballot_tally_projection_failed", {
        ballotId: input.ballotId,
        revisionId: input.revisionId,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
  await settleWithin(work, deadlineMs, () => {
    timedOut = true;
    logOperationalEvent("warn", "ballot_tally_projection_timeout", {
      ballotId: input.ballotId,
      revisionId: input.revisionId,
      deadlineMs,
    });
  });
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
    try {
      // Reuse the guarded rebuild so a repair running against a live database
      // cannot overwrite a concurrent increment with a stale recount.
      await rebuildBallotTallyProjection(db, {
        ballotId: row.ballotId,
        revisionId: row.revisionId,
        cryptoConfig: options.cryptoConfig,
      });
      written += 1;
    } catch (error) {
      if (error instanceof BallotTallyProjectionError) {
        skipped += 1;
        continue;
      }
      throw error;
    }
  }
  if (report.orphanRows > 0) {
    const orphans = await db
      .collection(BALLOT_TALLIES)
      .find(
        {},
        {
          projection: {
            _id: 0,
            ballotId: 1,
            revisionId: 1,
            [BALLOT_TALLY_VERSION_FIELD]: 1,
          },
        },
      )
      .toArray();
    const groups = new Set(
      report.rows.map((row) => ballotTallyKey(row.ballotId, row.revisionId)),
    );
    for (const raw of orphans as Array<Record<string, any>>) {
      const ballotId = String(raw.ballotId ?? "");
      const revisionId = String(raw.revisionId ?? "");
      if (!ballotId || !revisionId) continue;
      if (groups.has(ballotTallyKey(ballotId, revisionId))) continue;
      const version =
        typeof raw[BALLOT_TALLY_VERSION_FIELD] === "number"
          ? (raw[BALLOT_TALLY_VERSION_FIELD] as number)
          : null;
      const filter =
        version === null
          ? {
              ballotId,
              revisionId,
              [BALLOT_TALLY_VERSION_FIELD]: { $exists: false },
            }
          : { ballotId, revisionId, [BALLOT_TALLY_VERSION_FIELD]: version };
      const result = await db.collection(BALLOT_TALLIES).updateOne(filter, {
        $set: {
          approve: 0,
          abstain: 0,
          reject: 0,
          total: 0,
          updatedAt: now,
        },
        $inc: { [BALLOT_TALLY_VERSION_FIELD]: 1 },
      });
      if ((result.matchedCount ?? 0) > 0) zeroed += 1;
      else skipped += 1;
    }
  }
  return { report: { ...report, dryRun: false }, written, zeroed, skipped };
}
