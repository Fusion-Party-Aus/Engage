import { createHash } from "node:crypto";
import type { ClientSession, Db } from "mongodb";

export interface ProposalWordingSnapshot {
  title: string;
  summary: string;
  outcomes: string[];
  details: string;
}

/**
 * The canonical wording snapshot used for immutable proposal revisions.
 * Keep the key order stable: legacy revision identifiers and hashes depend on it.
 */
export function proposalWordingSnapshot(
  proposal: Record<string, any>,
): ProposalWordingSnapshot {
  return {
    title: String(proposal.title ?? ""),
    summary: String(proposal.summary ?? ""),
    outcomes: Array.isArray(proposal.outcomes)
      ? proposal.outcomes.map(String)
      : [],
    details: String(proposal.details ?? ""),
  };
}

export function wordingContentHash(snapshot: ProposalWordingSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export function wordingSnapshotHash(
  proposal: Record<string, any>,
): string {
  return wordingContentHash(proposalWordingSnapshot(proposal));
}

/** Deterministic identifier used by the startup backfill for pre-revision records. */
export function legacyRevisionId(proposalId: string): string {
  return `legacy-${createHash("sha256").update(proposalId).digest("hex")}`;
}

export function wordingSnapshotsMatch(
  left: ProposalWordingSnapshot,
  right: ProposalWordingSnapshot,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Ensure the deterministic immutable revision for a pre-revision proposal
 * exists. This is the same operation used by startup backfill and by the
 * retrospective ballot migration, so repeated runs cannot create a duplicate
 * or a different wording record.
 */
export async function ensureLegacyProposalRevision(
  db: Db,
  proposal: Record<string, any>,
  options: { session?: ClientSession } = {},
): Promise<Record<string, any> | null> {
  const proposalId = String(proposal.proposalId);
  const existing = await db
    .collection("proposal_revisions")
    .findOne(
      { proposalId },
      options.session ? { session: options.session } : undefined,
    );
  if (existing) return existing;

  const snapshot = proposalWordingSnapshot(proposal);
  const revisionId = legacyRevisionId(proposalId);
  await db.collection("proposal_revisions").updateOne(
    { revisionId },
    {
      $setOnInsert: {
        revisionId,
        proposalId,
        parentRevisionId: null,
        authorId: proposal.authorId ?? "system:migration",
        createdAt: proposal.createdAt ?? new Date(),
        snapshot,
        contentHash: wordingContentHash(snapshot),
        provenance: "legacy-backfill",
      },
    },
    {
      upsert: true,
      ...(options.session ? { session: options.session } : {}),
    },
  );
  return db
    .collection("proposal_revisions")
    .findOne(
      { revisionId },
      options.session ? { session: options.session } : undefined,
    );
}
