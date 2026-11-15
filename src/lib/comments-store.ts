import type { Db } from "mongodb";
import {
  VALID_STANCES,
  canViewProposal,
  normalizeProposalDoc,
} from "./proposal-helpers.ts";
import { hasPermission } from "./rbac.ts";
import type {
  CommentRecord,
  CommentStance,
  ProposalRecord,
  SessionUser,
} from "./types.ts";

export async function addComment(
  db: Db,
  user: SessionUser,
  body: Record<string, unknown>,
): Promise<CommentRecord> {
  if (!user.canParticipate) {
    throw new Error(
      "Your membership must be verified before you can contribute to deliberation.",
    );
  }

  const proposalId =
    typeof body.proposalId === "string"
      ? body.proposalId.trim()
      : typeof body.policyId === "string"
        ? body.policyId.trim()
        : "";
  const proposal = await db
    .collection<ProposalRecord>("proposals")
    .findOne({ proposalId });
  if (
    !proposal ||
    !canViewProposal(normalizeProposalDoc(proposal), user) ||
    proposal.stage === "archived"
  ) {
    throw new Error("This proposal is not open for deliberation.");
  }

  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (text.length < 5 || text.length > 5000) {
    throw new Error("Contribution must be between 5 and 5,000 characters.");
  }

  const rawStance = String(body.stance || body.kind || "comment");
  const stance: CommentStance = VALID_STANCES.includes(
    rawStance as CommentStance,
  )
    ? (rawStance as CommentStance)
    : "comment";

  const record: CommentRecord = {
    commentId: `cmt-${crypto.randomUUID()}`,
    proposalId: proposal.proposalId,
    memberId: user.memberId,
    authorName: user.name || "Verified Member",
    stance,
    body: text,
    upvotes: [],
    createdAt: new Date(),
  };

  await db.collection<CommentRecord>("comments").insertOne(record);
  return record;
}

export async function toggleUpvoteComment(
  db: Db,
  user: SessionUser,
  commentId: string,
): Promise<{
  upvotes: string[];
  count: number;
  endorsed: boolean;
  hasUpvoted: boolean;
}> {
  if (!user.canParticipate) {
    throw new Error(
      "Your membership must be verified to endorse deliberation points.",
    );
  }
  const id = commentId.trim();
  const col = db.collection<CommentRecord>("comments");
  const existing = await col.findOne({ commentId: id });
  if (!existing) throw new Error("Comment not found.");

  const proposal = await db
    .collection<ProposalRecord>("proposals")
    .findOne({ proposalId: existing.proposalId });
  if (!proposal || !canViewProposal(normalizeProposalDoc(proposal), user)) {
    throw new Error("Comment not found.");
  }

  const current = Array.isArray(existing.upvotes) ? existing.upvotes : [];
  const hasEndorsed = current.includes(user.memberId);
  const updated = hasEndorsed
    ? current.filter((m) => m !== user.memberId)
    : [...current, user.memberId];
  const currentEvents = Array.isArray(existing.upvoteEvents)
    ? existing.upvoteEvents
    : [];
  const updatedEvents = hasEndorsed
    ? currentEvents.filter((event) => event.memberId !== user.memberId)
    : [...currentEvents, { memberId: user.memberId, at: new Date() }];

  await col.updateOne(
    { commentId: id },
    { $set: { upvotes: updated, upvoteEvents: updatedEvents } },
  );
  return {
    upvotes: updated,
    count: updated.length,
    endorsed: !hasEndorsed,
    hasUpvoted: !hasEndorsed,
  };
}

export async function deleteComment(
  db: Db,
  user: SessionUser,
  commentId: string,
): Promise<void> {
  const id = commentId.trim();
  if (!id) throw new Error("Comment ID is required.");
  const col = db.collection<CommentRecord>("comments");
  const existing = await col.findOne({ commentId: id });
  if (!existing) throw new Error("Comment not found.");
  const proposal = await db
    .collection<ProposalRecord>("proposals")
    .findOne({ proposalId: existing.proposalId });
  if (!proposal || !canViewProposal(normalizeProposalDoc(proposal), user)) {
    throw new Error("Comment not found.");
  }
  if (
    existing.memberId !== user.memberId &&
    !user.isStaff &&
    !hasPermission(user, "comments.moderate", proposal.originatingBranchId)
  ) {
    throw new Error("You can only delete your own contributions.");
  }
  await col.deleteOne({ commentId: id });
}
