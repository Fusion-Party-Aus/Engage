import type { Db } from "mongodb";
import {
  VALID_STANCES,
  canViewProposal,
  normalizeProposalDoc,
} from "./proposal-helpers.ts";
import { hasPermission } from "./rbac.ts";
import { logOperationalEvent } from "./resilience.ts";
import type {
  CommentRecord,
  CommentStance,
  ProposalRecord,
  SessionUser,
} from "./types.ts";

/**
 * Hard ceiling on stored reply nesting. The interface caps visual indentation
 * far earlier; this only stops a corrupted or scripted chain from growing
 * without bound.
 */
export const MAX_COMMENT_DEPTH = 20;

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

  // Replies are bound to a parent comment in the same proposal. The parent is
  // verified server-side so a client cannot attach a reply to another thread
  // or to a comment it cannot see.
  const parentCommentIdInput =
    typeof body.parentCommentId === "string"
      ? body.parentCommentId.trim()
      : "";
  let parentCommentId: string | null = null;
  let depth = 0;
  if (parentCommentIdInput) {
    const parent = await db
      .collection<CommentRecord>("comments")
      .findOne({ commentId: parentCommentIdInput });
    if (!parent || parent.proposalId !== proposal.proposalId) {
      throw new Error(
        "The comment you are replying to is no longer available.",
      );
    }
    if (parent.deletedAt) {
      throw new Error("You cannot reply to a deleted contribution.");
    }
    const parentDepth = Number.isFinite(parent.depth)
      ? Number(parent.depth)
      : 0;
    if (parentDepth + 1 > MAX_COMMENT_DEPTH) {
      throw new Error(
        "This conversation is nested too deeply to reply here. Reply to an earlier comment instead.",
      );
    }
    parentCommentId = parent.commentId;
    depth = parentDepth + 1;
  }

  const record: CommentRecord = {
    commentId: `cmt-${crypto.randomUUID()}`,
    proposalId: proposal.proposalId,
    memberId: user.memberId,
    authorName: user.name || "Verified Member",
    stance,
    body: text,
    ...(parentCommentId ? { parentCommentId } : {}),
    depth,
    upvotes: [],
    downvotes: [],
    voteVersion: 0,
    createdAt: new Date(),
  };

  await db.collection<CommentRecord>("comments").insertOne(record);
  return record;
}

export interface CommentVoteResult {
  /** Net score (upvotes minus downvotes). */
  count: number;
  score: number;
  upvoteCount: number;
  downvoteCount: number;
  upvotePercent: number;
  upvoted: boolean;
  downvoted: boolean;
  hasUpvoted: boolean;
  hasDownvoted: boolean;
}

const COMMENT_VOTE_ACTIONS = ["upvote", "downvote"] as const;
export type CommentVoteAction = (typeof COMMENT_VOTE_ACTIONS)[number];

/**
 * How long a vote may keep retrying after losing a compare-and-swap race.
 * A cold replica set can take hundreds of milliseconds per write, so the
 * retry loop is bounded by time rather than a fixed attempt count.
 */
const COMMENT_VOTE_RETRY_BUDGET_MS = 5_000;
const COMMENT_VOTE_RETRY_BUDGET_MIN_MS = 250;
const COMMENT_VOTE_RETRY_BUDGET_MAX_MS = 60_000;
const COMMENT_VOTE_RETRY_INITIAL_DELAY_MS = 4;
const COMMENT_VOTE_RETRY_MAX_DELAY_MS = 250;

/**
 * Normalise the optional test injection point. Production callers use the
 * module default; invalid values fall back to it and explicit values are
 * clamped so the retry loop always stays bounded.
 */
function commentVoteRetryBudgetMs(override?: number): number {
  if (override === undefined) return COMMENT_VOTE_RETRY_BUDGET_MS;
  if (!Number.isFinite(override) || override <= 0) {
    return COMMENT_VOTE_RETRY_BUDGET_MS;
  }
  return Math.min(
    Math.max(Math.round(override), COMMENT_VOTE_RETRY_BUDGET_MIN_MS),
    COMMENT_VOTE_RETRY_BUDGET_MAX_MS,
  );
}

/**
 * Apply one member's upvote or downvote to a comment.
 *
 * A member can have at most one active vote per comment: the opposite vote is
 * removed when they switch, and a second click on the same vote clears it.
 * Only aggregate counts and the caller's own choice are ever returned. Voter
 * identities stay in the record and are never serialised to a client.
 *
 * `retryBudgetMs` is an explicit test injection point for exercising the
 * bounded retry loop; production callers omit it and use the 5 s default.
 */
export async function voteOnComment(
  db: Db,
  user: SessionUser,
  commentId: string,
  action: CommentVoteAction,
  retryBudgetMs?: number,
): Promise<CommentVoteResult> {
  if (!user.canParticipate) {
    throw new Error(
      "Your membership must be verified to vote on deliberation points.",
    );
  }
  if (!COMMENT_VOTE_ACTIONS.includes(action)) {
    throw new Error("Choose upvote or downvote.");
  }
  const id = commentId.trim();
  if (!id) throw new Error("Comment ID is required.");
  const col = db.collection<CommentRecord>("comments");
  const visible = await col.findOne({ commentId: id });
  if (!visible) throw new Error("Comment not found.");
  if (visible.deletedAt) {
    throw new Error("Deleted contributions cannot be voted on.");
  }

  const proposal = await db
    .collection<ProposalRecord>("proposals")
    .findOne({ proposalId: visible.proposalId });
  if (!proposal || !canViewProposal(normalizeProposalDoc(proposal), user))
    throw new Error("Comment not found.");

  // The vote is a single-document compare-and-swap. A concurrent vote bumps
  // `voteVersion`, so this write misses and retries against the new state
  // instead of overwriting another member's vote. Retries stop when the time
  // budget expires, so contention converges without a stuck writer hanging.
  const budgetMs = commentVoteRetryBudgetMs(retryBudgetMs);
  const deadline = Date.now() + budgetMs;
  let attempt = 0;
  for (;;) {
    const existing = await col.findOne({ commentId: id });
    if (!existing) throw new Error("Comment not found.");
    if (existing.deletedAt) {
      throw new Error("Deleted contributions cannot be voted on.");
    }
    const upvotes = Array.isArray(existing.upvotes) ? [...existing.upvotes] : [];
    const downvotes = Array.isArray(existing.downvotes)
      ? [...existing.downvotes]
      : [];
    const upvoteEvents = Array.isArray(existing.upvoteEvents)
      ? [...existing.upvoteEvents]
      : [];
    const hasUpvoted = upvotes.includes(user.memberId);
    const hasDownvoted = downvotes.includes(user.memberId);
    let upvoted = false;
    let downvoted = false;

    const removeUpvote = () => {
      const index = upvotes.indexOf(user.memberId);
      if (index >= 0) upvotes.splice(index, 1);
      for (let i = upvoteEvents.length - 1; i >= 0; i -= 1) {
        if (upvoteEvents[i]!.memberId === user.memberId) upvoteEvents.splice(i, 1);
      }
    };
    const removeDownvote = () => {
      const index = downvotes.indexOf(user.memberId);
      if (index >= 0) downvotes.splice(index, 1);
    };

    if (action === "upvote") {
      removeDownvote();
      if (hasUpvoted) {
        removeUpvote();
      } else {
        upvotes.push(user.memberId);
        upvoteEvents.push({ memberId: user.memberId, at: new Date() });
        upvoted = true;
      }
    } else {
      removeUpvote();
      if (hasDownvoted) {
        removeDownvote();
      } else {
        downvotes.push(user.memberId);
        downvoted = true;
      }
    }

    const storedVersion = existing.voteVersion;
    const version =
      typeof storedVersion === "number" && Number.isFinite(storedVersion)
        ? storedVersion
        : 0;
    const versionFilter =
      storedVersion === undefined
        ? { voteVersion: { $exists: false } }
        : { voteVersion: storedVersion };
    const result = await col.updateOne(
      { commentId: id, ...versionFilter },
      {
        $set: {
          upvotes,
          downvotes,
          upvoteEvents,
          voteVersion: version + 1,
        },
      },
    );
    if (result.matchedCount === 1) {
      const score = upvotes.length - downvotes.length;
      const total = upvotes.length + downvotes.length;
      return {
        count: score,
        score,
        upvoteCount: upvotes.length,
        downvoteCount: downvotes.length,
        upvotePercent:
          total > 0 ? Math.round((upvotes.length / total) * 100) : 0,
        upvoted,
        downvoted,
        hasUpvoted: upvoted,
        hasDownvoted: downvoted,
      };
    }
    // Exponential backoff with jitter: heavy contention spreads out instead
    // of every writer retrying in lockstep, and a slow first write gets time
    // to settle before the next compare-and-swap.
    attempt += 1;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const backoff = Math.min(
      COMMENT_VOTE_RETRY_INITIAL_DELAY_MS * 2 ** Math.min(attempt - 1, 6),
      COMMENT_VOTE_RETRY_MAX_DELAY_MS,
    );
    const jittered = Math.max(
      1,
      Math.round(backoff * (0.5 + Math.random() * 0.5)),
    );
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(jittered, remaining)),
    );
  }

  // Comment ID only: voter identities and choices never reach operational logs.
  logOperationalEvent("warn", "comment_vote_retry_budget_exhausted", {
    commentId: id,
    attempts: attempt,
    budgetMs,
  });
  throw new Error("Comment votes changed at the same time. Try again.");
}

/**
 * Backwards-compatible single-direction vote used by older callers and tests.
 * New code should call `voteOnComment` so downvotes and switching are explicit.
 */
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
  const result = await voteOnComment(db, user, commentId, "upvote");
  const stored = await db
    .collection<CommentRecord>("comments")
    .findOne({ commentId: commentId.trim() });
  return {
    upvotes: Array.isArray(stored?.upvotes) ? stored.upvotes : [],
    count: result.score,
    endorsed: result.hasUpvoted,
    hasUpvoted: result.hasUpvoted,
  };
}

export async function deleteComment(
  db: Db,
  user: SessionUser,
  commentId: string,
): Promise<{
  deleted: boolean;
  tombstoned: boolean;
  replyCount: number;
  prunedIds: string[];
}> {
  const id = commentId.trim();
  if (!id) throw new Error("Comment ID is required.");
  const col = db.collection<CommentRecord>("comments");
  const existing = await col.findOne({ commentId: id });
  if (!existing) throw new Error("Comment not found.");
  const proposal = await db
    .collection<ProposalRecord>("proposals")
    .findOne({ proposalId: existing.proposalId });
  if (!proposal || !canViewProposal(normalizeProposalDoc(proposal), user))
    throw new Error("Comment not found.");
  if (
    existing.memberId !== user.memberId &&
    !user.isStaff &&
    !hasPermission(user, "comments.moderate", proposal.originatingBranchId)
  ) {
    throw new Error("You can only delete your own contributions.");
  }

  const replyCount = await col.countDocuments({ parentCommentId: id });
  if (replyCount > 0) {
    // Replies depend on this comment for context. Remove the text but keep a
    // placeholder so the surviving conversation is not silently re-parented
    // or reordered.
    await col.updateOne(
      { commentId: id },
      {
        $set: {
          body: "",
          deletedAt: new Date(),
          deletedBy: user.memberId,
        },
      },
    );
    return { deleted: false, tombstoned: true, replyCount, prunedIds: [] };
  }

  await col.deleteOne({ commentId: id });
  const prunedIds = [id];

  // Remove any chain of empty placeholders that no longer has replies to
  // preserve. A placeholder is only kept while a surviving reply depends on it.
  let parentId =
    typeof existing.parentCommentId === "string"
      ? existing.parentCommentId
      : "";
  while (parentId) {
    const parent = await col.findOne({ commentId: parentId });
    if (!parent?.deletedAt) break;
    const remainingReplies = await col.countDocuments({
      parentCommentId: parent.commentId,
    });
    if (remainingReplies > 0) break;
    await col.deleteOne({ commentId: parent.commentId });
    prunedIds.push(parent.commentId);
    parentId =
      typeof parent.parentCommentId === "string"
        ? parent.parentCommentId
        : "";
  }

  return { deleted: true, tombstoned: false, replyCount: 0, prunedIds };
}
