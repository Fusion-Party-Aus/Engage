import { BSON, type Db, type Document } from "mongodb";
import {
  computeVoterBlindIndex,
  decryptVotePayload,
  encryptVotePayload,
  type BallotCryptoConfig,
  type VoteEnvelope,
} from "./ballot-crypto.ts";
import type { VoteChoice } from "./types.ts";

// Current CRUD decisions are one ballot per proposal. Legacy formal/consultation
// ballots remain in votes, with their original identities and uniqueness index.
export const PROPOSAL_VOTES = "proposal_votes";
export const VOTE_MIGRATION = "proposal-votes-v1";
export const VOTE_INDEX = "one_current_proposal_vote_per_member_ballot";
export const VOTE_BLIND_INDEX = "one_current_encrypted_vote_per_member_ballot";
export const proposalBallotId = (proposalId: string) =>
  `proposal:${proposalId}`;

export async function ensureProposalVoteIndex(db: Db): Promise<void> {
  const col = db.collection(PROPOSAL_VOTES);
  const existing =
    typeof col.indexes === "function"
      ? await col.indexes().catch(() => [])
      : [];
  const legacyMemberIdx = existing.find((idx) => idx.name === VOTE_INDEX);
  // Upgrade legacy unique index on { ballotId: 1, memberId: 1 } to a partial
  // unique index so encrypted votes (which omit plaintext memberId) do not collide.
  if (
    legacyMemberIdx &&
    legacyMemberIdx.unique === true &&
    !legacyMemberIdx.partialFilterExpression &&
    legacyMemberIdx.key?.ballotId === 1 &&
    legacyMemberIdx.key?.memberId === 1
  ) {
    await col.dropIndex(VOTE_INDEX);
  }
  await col.createIndex(
    { ballotId: 1, memberId: 1 },
    {
      unique: true,
      name: VOTE_INDEX,
      partialFilterExpression: { memberId: { $type: "string" } },
    },
  );
  await col.createIndex(
    { ballotId: 1, voterBlindIndex: 1 },
    {
      unique: true,
      name: VOTE_BLIND_INDEX,
      partialFilterExpression: { voterBlindIndex: { $type: "string" } },
    },
  );
}

export interface DecodedVoteRecord {
  ballotId: string;
  proposalId: string;
  revisionId?: string;
  amendmentId?: string;
  amendmentRevisionId?: string;
  memberId?: string;
  authorName?: string;
  voterBlindIndex?: string;
  choice: VoteChoice;
  reason: string;
  updatedAt: Date;
  encrypted: boolean;
}

export function decodeStoredVote(
  doc: Record<string, any>,
  cryptoConfig: BallotCryptoConfig | null,
): DecodedVoteRecord {
  const ballotId = String(doc.ballotId ?? "");
  const proposalId = String(doc.proposalId ?? doc.policyId ?? "");
  const revisionId =
    typeof doc.revisionId === "string" ? doc.revisionId : undefined;
  const amendmentId =
    typeof doc.amendmentId === "string" ? doc.amendmentId : undefined;
  const amendmentRevisionId =
    typeof doc.amendmentRevisionId === "string"
      ? doc.amendmentRevisionId
      : undefined;

  if (doc.voteEnvelope) {
    if (!cryptoConfig) {
      throw new Error(
        "Encrypted ballot records exist, but ballot decryption keys are not configured.",
      );
    }
    const voterBlindIndex = String(doc.voterBlindIndex ?? "");
    const payload = decryptVotePayload(
      cryptoConfig,
      doc.voteEnvelope as VoteEnvelope,
      {
        ballotId,
        proposalId,
        revisionId: revisionId ?? "",
        ...(amendmentRevisionId ? { amendmentRevisionId } : {}),
        voterBlindIndex,
      },
    );
    return {
      ballotId,
      proposalId,
      ...(revisionId ? { revisionId } : {}),
      ...(amendmentId ? { amendmentId } : {}),
      ...(amendmentRevisionId ? { amendmentRevisionId } : {}),
      ...(typeof doc.memberId === "string" ? { memberId: doc.memberId } : {}),
      ...(typeof doc.authorName === "string"
        ? { authorName: doc.authorName }
        : {}),
      voterBlindIndex,
      choice: payload.choice,
      reason: payload.reason,
      updatedAt:
        doc.updatedAt instanceof Date
          ? doc.updatedAt
          : new Date(doc.updatedAt ?? Date.now()),
      encrypted: true,
    };
  }

  return {
    ballotId,
    proposalId,
    ...(revisionId ? { revisionId } : {}),
    ...(amendmentId ? { amendmentId } : {}),
    ...(amendmentRevisionId ? { amendmentRevisionId } : {}),
    ...(typeof doc.memberId === "string" ? { memberId: doc.memberId } : {}),
    ...(typeof doc.authorName === "string"
      ? { authorName: doc.authorName }
      : {}),
    choice: doc.choice as VoteChoice,
    reason: typeof doc.reason === "string" ? doc.reason : "",
    updatedAt:
      doc.updatedAt instanceof Date
        ? doc.updatedAt
        : new Date(doc.updatedAt ?? Date.now()),
    encrypted: false,
  };
}

export function computeAllBlindIndexesForMember(
  cryptoConfig: BallotCryptoConfig,
  ballotId: string,
  memberId: string,
): string[] {
  const indexes: string[] = [];
  for (const key of cryptoConfig.blindIndexKeys.values()) {
    indexes.push(computeVoterBlindIndex(key, ballotId, memberId));
  }
  return indexes;
}

export async function findMemberVotes(
  db: Db,
  memberId: string,
  ballotIds: string[],
  cryptoConfig: BallotCryptoConfig | null,
): Promise<DecodedVoteRecord[]> {
  const blindIndexes =
    cryptoConfig && ballotIds.length > 0
      ? ballotIds.flatMap((ballotId) =>
          computeAllBlindIndexesForMember(cryptoConfig, ballotId, memberId),
        )
      : [];
  const filter =
    blindIndexes.length > 0
      ? { $or: [{ memberId }, { voterBlindIndex: { $in: blindIndexes } }] }
      : { memberId };
  const rows = await db
    .collection(PROPOSAL_VOTES)
    .find(filter)
    .sort({ updatedAt: -1 })
    .toArray();
  return rows.map((row) =>
    decodeStoredVote(row as Record<string, any>, cryptoConfig),
  );
}

export function buildEncryptedVoteFields(
  cryptoConfig: BallotCryptoConfig,
  input: {
    ballotId: string;
    proposalId: string;
    revisionId: string;
    amendmentId?: string;
    amendmentRevisionId?: string;
    memberId: string;
    choice: VoteChoice;
    reason: string;
    updatedAt?: Date;
  },
) {
  const biKey = cryptoConfig.blindIndexKeys.get(
    cryptoConfig.activeBlindIndexKeyId,
  );
  if (!biKey) {
    throw new Error("Active ballot blind-index key is unavailable.");
  }
  const voterBlindIndex = computeVoterBlindIndex(
    biKey,
    input.ballotId,
    input.memberId,
  );
  const voteEnvelope = encryptVotePayload(
    cryptoConfig,
    { choice: input.choice, reason: input.reason },
    {
      ballotId: input.ballotId,
      proposalId: input.proposalId,
      revisionId: input.revisionId,
      ...(input.amendmentRevisionId
        ? { amendmentRevisionId: input.amendmentRevisionId }
        : {}),
      voterBlindIndex,
    },
  );
  return {
    ballotId: input.ballotId,
    proposalId: input.proposalId,
    revisionId: input.revisionId,
    ...(input.amendmentId ? { amendmentId: input.amendmentId } : {}),
    ...(input.amendmentRevisionId
      ? { amendmentRevisionId: input.amendmentRevisionId }
      : {}),
    voterBlindIndex,
    blindIndexKeyId: cryptoConfig.activeBlindIndexKeyId,
    voteEnvelope,
    updatedAt: input.updatedAt ?? new Date(),
  };
}

export async function ensureVoteStorage(db: Db): Promise<void> {
  if (
    (await db.collection("votes").countDocuments()) &&
    !(await db
      .collection("schema_migrations")
      .findOne({ _id: VOTE_MIGRATION } as Document))
  ) {
    throw new Error(
      "Vote storage migration required. Run scripts/migrate-proposal-votes.mjs in dry-run mode first.",
    );
  }
  // Never swallow failures of a voting uniqueness protection.
  await ensureProposalVoteIndex(db);
}

const nonempty = (s: unknown): s is string =>
  typeof s === "string" && s.length > 0 && s.trim() === s;
const same = (a: Document, b: Document) => {
  const sorted = (d: Document) =>
    Object.fromEntries(
      Object.entries(d).sort(([a], [b]) => a.localeCompare(b)),
    );
  return BSON.EJSON.stringify(sorted(a)) === BSON.EJSON.stringify(sorted(b));
};

export async function inspectVoteMigration(db: Db) {
  const source = await db.collection("votes").find({}).toArray();
  const destination = await db.collection(PROPOSAL_VOTES).find({}).toArray();
  const proposals = new Set(
    (await db.collection("proposals").find({}).toArray()).map(
      (p) => p.proposalId,
    ),
  );
  const completed = Boolean(
    await db
      .collection("schema_migrations")
      .findOne({ _id: VOTE_MIGRATION } as Document),
  );
  const errors: string[] = [];
  const copies: Document[] = [];
  const seen = new Set<string>();
  let legacyBallots = 0;
  for (const v of source) {
    if (nonempty(v.ballotId)) {
      legacyBallots++;
      continue;
    }
    if (
      v.ballotId != null ||
      !nonempty(v.proposalId) ||
      !nonempty(v.memberId) ||
      !["approve", "abstain", "reject"].includes(v.choice) ||
      !(v.updatedAt instanceof Date) ||
      (v.policyId != null && v.policyId !== v.proposalId) ||
      !proposals.has(v.proposalId)
    ) {
      errors.push(
        "Unrecognised or orphaned source vote; manual review required.",
      );
      continue;
    }
    const key = JSON.stringify([v.proposalId, v.memberId]);
    if (seen.has(key))
      errors.push(
        "Duplicate source proposal/member vote; no winner selected automatically.",
      );
    seen.add(key);
    copies.push({ ...v, ballotId: proposalBallotId(v.proposalId) });
  }
  for (const v of destination) {
    if (
      !nonempty(v.proposalId) ||
      v.ballotId !== proposalBallotId(v.proposalId) ||
      !nonempty(v.memberId) ||
      !["approve", "abstain", "reject"].includes(v.choice)
    ) {
      errors.push("Unrecognised destination vote; manual review required.");
    }
    if (!completed) {
      const expected = copies.find((c) => String(c._id) === String(v._id));
      if (!expected || !same(expected, v))
        errors.push(
          "Destination differs from source; migration will not overwrite it.",
        );
    }
  }
  return {
    sourceCount: source.length,
    legacyBallots,
    currentVotes: copies.length,
    destinationCount: destination.length,
    completed,
    errors,
    copies,
  };
}

export async function migrateProposalVotes(db: Db, apply = false) {
  const plan = await inspectVoteMigration(db);
  if (plan.errors.length) throw new Error(plan.errors.join("\n"));
  if (!apply) return plan;
  await ensureProposalVoteIndex(db); // Build replacement protection BEFORE copying.
  if (plan.completed) return plan;
  for (const record of plan.copies) {
    await db
      .collection(PROPOSAL_VOTES)
      .updateOne(
        { _id: record._id },
        { $setOnInsert: record },
        { upsert: true },
      );
  }
  const verified = await inspectVoteMigration(db);
  if (
    verified.errors.length ||
    verified.destinationCount !== verified.currentVotes
  ) {
    throw new Error(
      "Migration verification failed; completion marker not written.",
    );
  }
  await db
    .collection("schema_migrations")
    .updateOne(
      { _id: VOTE_MIGRATION } as Document,
      {
        $setOnInsert: {
          completedAt: new Date(),
          sourceCount: plan.sourceCount,
          copiedCount: plan.currentVotes,
        },
      },
      { upsert: true },
    );
  return { ...verified, completed: true };
}
