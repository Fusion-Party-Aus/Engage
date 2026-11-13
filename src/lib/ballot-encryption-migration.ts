import type { Db, Document } from "mongodb";
import {
  computeVoterBlindIndex,
  decryptVotePayload,
  encryptVotePayload,
  type BallotCryptoConfig,
  type VoteEnvelope,
} from "./ballot-crypto.ts";
import {
  PROPOSAL_VOTES,
  buildEncryptedVoteFields,
  decodeStoredVote,
  ensureProposalVoteIndex,
} from "./vote-storage.ts";
import type { VoteChoice, VoteTally } from "./types.ts";

export const ENCRYPTED_VOTE_MIGRATION_ID = "encrypted-votes-v1";

export interface EncryptedMigrationPlan {
  totalCount: number;
  plaintextCount: number;
  encryptedCount: number;
  encryptedWithLegacyFieldsCount: number;
  rotationCandidateCount: number;
  tallies: Record<string, VoteTally>;
  errors: string[];
  plaintextDocs: Document[];
  legacyFieldDocs: Document[];
  rotationDocs: Document[];
}

export interface EncryptedMigrationResult {
  applied: boolean;
  rotated: boolean;
  migratedCount: number;
  cleanedCount: number;
  rotatedCount: number;
  concurrentSkips: number;
  before: Omit<EncryptedMigrationPlan, "plaintextDocs" | "legacyFieldDocs" | "rotationDocs">;
  after: Omit<EncryptedMigrationPlan, "plaintextDocs" | "legacyFieldDocs" | "rotationDocs">;
}

function addToTally(
  tallies: Record<string, VoteTally>,
  ballotId: string,
  choice: VoteChoice,
) {
  const t = tallies[ballotId] ?? { approve: 0, abstain: 0, reject: 0, total: 0 };
  t[choice] += 1;
  t.total += 1;
  tallies[ballotId] = t;
}

function summarizePlan(plan: EncryptedMigrationPlan) {
  const {
    plaintextDocs: _p,
    legacyFieldDocs: _l,
    rotationDocs: _r,
    ...summary
  } = plan;
  return summary;
}

export async function inspectEncryptedVoteMigration(
  db: Db,
  cryptoConfig: BallotCryptoConfig,
): Promise<EncryptedMigrationPlan> {
  const docs = await db.collection(PROPOSAL_VOTES).find({}).toArray();
  const biKey = cryptoConfig.blindIndexKeys.get(
    cryptoConfig.activeBlindIndexKeyId,
  );
  if (!biKey) {
    throw new Error("Active blind-index key is unavailable.");
  }

  const errors: string[] = [];
  const tallies: Record<string, VoteTally> = {};
  const plaintextDocs: Document[] = [];
  const legacyFieldDocs: Document[] = [];
  const rotationDocs: Document[] = [];

  const seenMemberBallot = new Set<string>();
  const seenBlindBallot = new Set<string>();

  let encryptedCount = 0;
  let encryptedWithLegacyFieldsCount = 0;
  let rotationCandidateCount = 0;

  for (const doc of docs) {
    const ballotId = typeof doc.ballotId === "string" ? doc.ballotId.trim() : "";
    const proposalId =
      typeof doc.proposalId === "string" ? doc.proposalId.trim() : "";
    if (!ballotId || !proposalId) {
      errors.push(`Vote ${String(doc._id)} is missing ballotId or proposalId.`);
      continue;
    }

    const hasLegacyFields =
      doc.memberId !== undefined ||
      doc.authorName !== undefined ||
      doc.choice !== undefined ||
      doc.reason !== undefined;

    if (doc.voteEnvelope) {
      try {
        const decoded = decodeStoredVote(doc, cryptoConfig);
        const blindKey = `${ballotId}\0${decoded.voterBlindIndex ?? ""}`;
        if (!decoded.voterBlindIndex) {
          errors.push(`Encrypted vote ${String(doc._id)} is missing voterBlindIndex.`);
          continue;
        }
        if (seenBlindBallot.has(blindKey)) {
          errors.push(
            `Duplicate blind-indexed vote for ballot '${ballotId}'.`,
          );
          continue;
        }
        seenBlindBallot.add(blindKey);
        addToTally(tallies, ballotId, decoded.choice);
        encryptedCount++;

        if (hasLegacyFields) {
          encryptedWithLegacyFieldsCount++;
          legacyFieldDocs.push(doc);
        }
        if ((doc.voteEnvelope as VoteEnvelope).kid !== cryptoConfig.activeEncryptionKeyId) {
          rotationCandidateCount++;
          rotationDocs.push(doc);
        }
      } catch (err) {
        errors.push(
          `Encrypted vote ${String(doc._id)} failed verification: ${
            err instanceof Error ? err.message : "unknown error"
          }`,
        );
      }
      continue;
    }

    // Plaintext vote
    const memberId = typeof doc.memberId === "string" ? doc.memberId.trim() : "";
    const choice = doc.choice;
    if (
      !memberId ||
      !["approve", "abstain", "reject"].includes(String(choice))
    ) {
      errors.push(`Malformed plaintext vote ${String(doc._id)}.`);
      continue;
    }
    const memberKey = `${ballotId}\0${memberId}`;
    if (seenMemberBallot.has(memberKey)) {
      errors.push(
        `Duplicate plaintext vote for ballot '${ballotId}' and member '${memberId}'.`,
      );
      continue;
    }
    seenMemberBallot.add(memberKey);

    const expectedBlind = computeVoterBlindIndex(biKey, ballotId, memberId);
    const blindKey = `${ballotId}\0${expectedBlind}`;
    if (seenBlindBallot.has(blindKey)) {
      errors.push(
        `Plaintext vote ${String(doc._id)} conflicts with an existing encrypted vote for the same member and ballot.`,
      );
      continue;
    }
    seenBlindBallot.add(blindKey);

    addToTally(tallies, ballotId, choice as VoteChoice);
    plaintextDocs.push(doc);
  }

  return {
    totalCount: docs.length,
    plaintextCount: plaintextDocs.length,
    encryptedCount,
    encryptedWithLegacyFieldsCount,
    rotationCandidateCount,
    tallies,
    errors,
    plaintextDocs,
    legacyFieldDocs,
    rotationDocs,
  };
}

export function talliesMatch(
  a: Record<string, VoteTally>,
  b: Record<string, VoteTally>,
): boolean {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    const k = keysA[i]!;
    if (k !== keysB[i]) return false;
    const ta = a[k]!;
    const tb = b[k]!;
    if (
      ta.approve !== tb.approve ||
      ta.abstain !== tb.abstain ||
      ta.reject !== tb.reject ||
      ta.total !== tb.total
    ) {
      return false;
    }
  }
  return true;
}

export async function migrateEncryptedVotes(
  db: Db,
  cryptoConfig: BallotCryptoConfig,
  options: { apply?: boolean; rotate?: boolean } = {},
): Promise<EncryptedMigrationResult> {
  const apply = Boolean(options.apply);
  const rotate = Boolean(options.rotate);

  const before = await inspectEncryptedVoteMigration(db, cryptoConfig);
  if (before.errors.length > 0) {
    throw new Error(
      `Encrypted vote migration aborted due to pre-flight errors:\n${before.errors.join("\n")}`,
    );
  }

  if (!apply) {
    const summary = summarizePlan(before);
    return {
      applied: false,
      rotated: rotate,
      migratedCount: 0,
      cleanedCount: 0,
      rotatedCount: 0,
      concurrentSkips: 0,
      before: summary,
      after: summary,
    };
  }

  await ensureProposalVoteIndex(db);
  const col = db.collection(PROPOSAL_VOTES);

  let migratedCount = 0;
  let cleanedCount = 0;
  let rotatedCount = 0;
  let concurrentSkips = 0;

  for (const doc of before.plaintextDocs) {
    const encryptedFields = buildEncryptedVoteFields(cryptoConfig, {
      ballotId: String(doc.ballotId),
      proposalId: String(doc.proposalId),
      revisionId: typeof doc.revisionId === "string" ? doc.revisionId : "",
      ...(typeof doc.amendmentId === "string"
        ? { amendmentId: doc.amendmentId }
        : {}),
      ...(typeof doc.amendmentRevisionId === "string"
        ? { amendmentRevisionId: doc.amendmentRevisionId }
        : {}),
      memberId: String(doc.memberId),
      choice: doc.choice as VoteChoice,
      reason: typeof doc.reason === "string" ? doc.reason : "",
      updatedAt:
        doc.updatedAt instanceof Date
          ? doc.updatedAt
          : new Date(doc.updatedAt ?? Date.now()),
    });

    const res = await col.updateOne(
      { _id: doc._id, memberId: doc.memberId, updatedAt: doc.updatedAt },
      {
        $set: encryptedFields,
        $unset: { memberId: "", authorName: "", choice: "", reason: "" },
      },
    );
    if (res.matchedCount === 1) migratedCount++;
    else concurrentSkips++;
  }

  for (const doc of before.legacyFieldDocs) {
    const res = await col.updateOne(
      { _id: doc._id, voteEnvelope: { $exists: true } },
      { $unset: { memberId: "", authorName: "", choice: "", reason: "" } },
    );
    if (res.modifiedCount === 1) cleanedCount++;
  }

  if (rotate) {
    for (const doc of before.rotationDocs) {
      const voterBlindIndex = String(doc.voterBlindIndex);
      const ballotId = String(doc.ballotId);
      const proposalId = String(doc.proposalId);
      const revisionId =
        typeof doc.revisionId === "string" ? doc.revisionId : "";
      const amendmentRevisionId =
        typeof doc.amendmentRevisionId === "string"
          ? doc.amendmentRevisionId
          : undefined;
      const ctx = {
        ballotId,
        proposalId,
        revisionId,
        ...(amendmentRevisionId ? { amendmentRevisionId } : {}),
        voterBlindIndex,
      };
      const payload = decryptVotePayload(
        cryptoConfig,
        doc.voteEnvelope as VoteEnvelope,
        ctx,
      );
      const nextEnvelope = encryptVotePayload(cryptoConfig, payload, ctx);
      const res = await col.updateOne(
        { _id: doc._id, updatedAt: doc.updatedAt },
        { $set: { voteEnvelope: nextEnvelope } },
      );
      if (res.matchedCount === 1) rotatedCount++;
      else concurrentSkips++;
    }
  }

  const after = await inspectEncryptedVoteMigration(db, cryptoConfig);
  if (after.errors.length > 0) {
    throw new Error(
      `Post-migration verification failed:\n${after.errors.join("\n")}`,
    );
  }
  if (!talliesMatch(before.tallies, after.tallies) && concurrentSkips === 0) {
    throw new Error(
      "Post-migration tally reconciliation mismatch! Inspect proposal_votes immediately.",
    );
  }

  if (after.plaintextCount === 0 && after.encryptedWithLegacyFieldsCount === 0) {
    await db.collection("schema_migrations").updateOne(
      { _id: ENCRYPTED_VOTE_MIGRATION_ID } as Document,
      {
        $set: {
          completedAt: new Date(),
          totalCount: after.totalCount,
          encryptedCount: after.encryptedCount,
          activeEncryptionKeyId: cryptoConfig.activeEncryptionKeyId,
          activeBlindIndexKeyId: cryptoConfig.activeBlindIndexKeyId,
        },
      },
      { upsert: true },
    );
  }

  return {
    applied: true,
    rotated: rotate,
    migratedCount,
    cleanedCount,
    rotatedCount,
    concurrentSkips,
    before: summarizePlan(before),
    after: summarizePlan(after),
  };
}
