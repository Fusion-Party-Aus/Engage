import type {
  CommentStance,
  ContributionFeedbackStatus,
} from "./types.ts";

/**
 * Thread model for proposal deliberation.
 *
 * A comment's place in a thread is stored as `parentCommentId`. This module
 * turns a flat collection into parent-first, recursively nested nodes so the
 * renderer never has to infer relationships from timestamps or `@mention`
 * text. The selected sort applies to each sibling group independently, so a
 * thread is never flattened into an unrelated global list.
 *
 * "Best" is a confidence-weighted rank inspired by Reddit's comment sort. It
 * uses the Wilson score lower bound over upvotes and downvotes, which stops a
 * comment with one upvote and no downvotes from outranking a comment with
 * broad support. It is display ranking only: comment votes are not ballots.
 */

/** Full indents shown before additional nesting stops adding visual depth. */
export const MAX_VISUAL_DEPTH = 4;

export type TopLevelSort = "best" | "top" | "newest" | "oldest";
export type StanceFilter = "all" | CommentStance;

export interface ThreadComment {
  commentId: string;
  parentCommentId?: string | null;
  stance: CommentStance;
  createdAt: Date | string;
  upvoteCount: number;
  downvoteCount: number;
}

export interface CommentThreadNode<T extends ThreadComment = ThreadComment> {
  comment: T;
  /** True nesting depth. May exceed MAX_VISUAL_DEPTH. */
  depth: number;
  /** Total descendants, including descendants hidden by a stance filter. */
  replyCount: number;
  children: CommentThreadNode<T>[];
}

export interface DiscussionEvidence {
  label: string;
  href?: string;
}

export interface DiscussionFeedback {
  status: ContributionFeedbackStatus;
  note?: string;
  updatedByName: string;
  updatedAt: string;
  /** `kind:recordId` used to preselect the evidence control when editing. */
  evidenceRef?: string;
  evidence?: DiscussionEvidence;
}

export interface DiscussionFeedbackEntry {
  action: ContributionFeedbackStatus | "cleared";
  note?: string;
  updatedByName: string;
  updatedAt: string;
  evidence?: DiscussionEvidence;
}

/** Serialisable comment shape passed from the proposal page to the island. */
export interface DiscussionComment extends ThreadComment {
  authorName: string;
  /** Public profile path when the author's account can be established. */
  authorProfileHref?: string | null;
  body: string;
  score: number;
  upvotedByMe: boolean;
  downvotedByMe: boolean;
  isMine: boolean;
  deleted: boolean;
  feedback?: DiscussionFeedback;
  feedbackHistory?: DiscussionFeedbackEntry[];
}

function timestamp(value: Date | string): number {
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function byChronology(a: ThreadComment, b: ThreadComment): number {
  return timestamp(a.createdAt) - timestamp(b.createdAt) ||
    a.commentId.localeCompare(b.commentId);
}

export function commentScore(comment: Pick<ThreadComment, "upvoteCount" | "downvoteCount">): number {
  return comment.upvoteCount - comment.downvoteCount;
}

export function commentVoteTotal(
  comment: Pick<ThreadComment, "upvoteCount" | "downvoteCount">,
): number {
  return comment.upvoteCount + comment.downvoteCount;
}

/** Share of votes that are upvotes, 0–1. A comment with no votes returns 0. */
export function commentUpvoteRatio(
  comment: Pick<ThreadComment, "upvoteCount" | "downvoteCount">,
): number {
  const total = commentVoteTotal(comment);
  return total > 0 ? comment.upvoteCount / total : 0;
}

/** Percentage shown to readers; never exposes an exact downvote tally. */
export function commentUpvotePercent(
  comment: Pick<ThreadComment, "upvoteCount" | "downvoteCount">,
): number {
  const total = commentVoteTotal(comment);
  return total > 0 ? Math.round((comment.upvoteCount / total) * 100) : 0;
}

export const WILSON_Z = 1.281551565545;

/**
 * Wilson score lower bound for a Bernoulli upvote/downvote signal.
 *
 * A comment with one upvote has a perfect ratio but almost no evidence, so its
 * lower bound stays low; a comment with many votes and a modest ratio can rank
 * higher. A comment with no votes, or only downvotes, scores 0.
 */
export function commentConfidence(
  comment: Pick<ThreadComment, "upvoteCount" | "downvoteCount">,
): number {
  const upvotes = Math.max(0, comment.upvoteCount);
  const downvotes = Math.max(0, comment.downvoteCount);
  const total = upvotes + downvotes;
  if (total === 0) return 0;
  const p = upvotes / total;
  const zSquared = WILSON_Z * WILSON_Z;
  const denominator = 1 + zSquared / total;
  const centre = p + zSquared / (2 * total);
  const margin =
    WILSON_Z *
    Math.sqrt((p * (1 - p) + zSquared / (4 * total)) / total);
  const lowerBound = (centre - margin) / denominator;
  return Number.isFinite(lowerBound) ? Math.max(0, lowerBound) : 0;
}

/**
 * Sibling order for every level of a thread.
 *
 * `best` ranks by confidence, then net score, then older first. `top` ranks by
 * net score, then confidence, then older first. `newest` and `oldest` are
 * strictly chronological. `commentId` is the final deterministic tie-break.
 */
export function compareComments(
  a: ThreadComment,
  b: ThreadComment,
  sort: TopLevelSort,
): number {
  if (sort === "newest") {
    return timestamp(b.createdAt) - timestamp(a.createdAt) ||
      b.commentId.localeCompare(a.commentId);
  }
  if (sort === "oldest") return byChronology(a, b);
  if (sort === "top") {
    return commentScore(b) - commentScore(a) ||
      commentConfidence(b) - commentConfidence(a) ||
      byChronology(a, b);
  }
  return commentConfidence(b) - commentConfidence(a) ||
    commentScore(b) - commentScore(a) ||
    byChronology(a, b);
}

function filterThread<T extends ThreadComment>(
  nodes: CommentThreadNode<T>[],
  stance: StanceFilter,
): CommentThreadNode<T>[] {
  if (stance === "all") return nodes;
  const filtered: CommentThreadNode<T>[] = [];
  for (const node of nodes) {
    const children = filterThread(node.children, stance);
    if (node.comment.stance === stance || children.length > 0) {
      filtered.push({
        ...node,
        children,
        replyCount: children.reduce(
          (total, child) => total + 1 + child.replyCount,
          0,
        ),
      });
    }
  }
  return filtered;
}

/**
 * Build nested threads from a flat comment collection.
 *
 * - Roots and every sibling group are ordered deterministically with the same
 *   sort. Replies are never hoisted out of their parent's subtree.
 * - A comment whose parent is missing becomes a root rather than disappearing.
 * - Cycles and self-parenting are broken defensively instead of recursing.
 * - Filtering by stance keeps matching comments and the ancestors needed to
 *   understand them, without flattening the conversation.
 */
export function buildCommentThread<T extends ThreadComment>(
  comments: readonly T[],
  options: { sort?: TopLevelSort; stance?: StanceFilter } = {},
): CommentThreadNode<T>[] {
  const sort = options.sort ?? "best";
  const stance = options.stance ?? "all";

  const unique: T[] = [];
  const seen = new Set<string>();
  for (const comment of comments) {
    if (!comment || typeof comment.commentId !== "string") continue;
    if (!comment.commentId || seen.has(comment.commentId)) continue;
    seen.add(comment.commentId);
    unique.push(comment);
  }

  const byId = new Map(unique.map((comment) => [comment.commentId, comment]));
  const childrenByParent = new Map<string, T[]>();
  const rootCandidates: T[] = [];

  for (const comment of unique) {
    const parentId = comment.parentCommentId ?? null;
    if (parentId && parentId !== comment.commentId && byId.has(parentId)) {
      const siblings = childrenByParent.get(parentId) ?? [];
      siblings.push(comment);
      childrenByParent.set(parentId, siblings);
    } else {
      rootCandidates.push(comment);
    }
  }

  const visited = new Set<string>();
  const build = (
    comment: T,
    depth: number,
    ancestors: ReadonlySet<string>,
  ): CommentThreadNode<T> => {
    visited.add(comment.commentId);
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(comment.commentId);
    const children = (childrenByParent.get(comment.commentId) ?? [])
      .filter((child) => !nextAncestors.has(child.commentId))
      .sort((a, b) => compareComments(a, b, sort))
      .map((child) => build(child, depth + 1, nextAncestors));
    return {
      comment,
      depth,
      replyCount: children.reduce(
        (total, child) => total + 1 + child.replyCount,
        0,
      ),
      children,
    };
  };

  const nodes = rootCandidates
    .sort((a, b) => compareComments(a, b, sort))
    .map((comment) => build(comment, 0, new Set()));

  // A malformed parent chain can leave comments unreachable from any root.
  // Promote them rather than dropping them from the discussion. Re-check
  // `visited` after each promotion: building one member of a cycle visits the
  // rest, so promoting every unvisited id upfront would duplicate them.
  let unvisited = unique
    .filter((candidate) => !visited.has(candidate.commentId))
    .sort((a, b) => compareComments(a, b, sort));
  while (unvisited.length > 0) {
    nodes.push(build(unvisited[0]!, 0, new Set()));
    unvisited = unvisited.filter(
      (candidate) => !visited.has(candidate.commentId),
    );
  }

  return filterThread(nodes, stance).sort((a, b) =>
    compareComments(a.comment, b.comment, sort),
  );
}

/** Depth used for visual indentation, capped for narrow screens. */
export function visualDepth(depth: number): number {
  return Math.max(0, Math.min(depth, MAX_VISUAL_DEPTH));
}

/** Pre-order flattening, mainly for tests and announcements. */
export function flattenCommentThread<T extends ThreadComment>(
  nodes: readonly CommentThreadNode<T>[],
): Array<{ commentId: string; depth: number }> {
  const flat: Array<{ commentId: string; depth: number }> = [];
  const walk = (list: readonly CommentThreadNode<T>[]) => {
    for (const node of list) {
      flat.push({ commentId: node.comment.commentId, depth: node.depth });
      walk(node.children);
    }
  };
  walk(nodes);
  return flat;
}

export function countThreadNodes<T extends ThreadComment>(
  nodes: readonly CommentThreadNode<T>[],
): number {
  let total = 0;
  for (const node of nodes) total += 1 + countThreadNodes(node.children);
  return total;
}

export function countStances<T extends ThreadComment>(
  comments: readonly T[],
): Record<StanceFilter, number> {
  const counts: Record<StanceFilter, number> = {
    all: comments.length,
    support: 0,
    concern: 0,
    amendment: 0,
    comment: 0,
  };
  for (const comment of comments) counts[comment.stance] += 1;
  return counts;
}

export function findThreadNode<T extends ThreadComment>(
  nodes: readonly CommentThreadNode<T>[],
  commentId: string,
): CommentThreadNode<T> | null {
  for (const node of nodes) {
    if (node.comment.commentId === commentId) return node;
    const found = findThreadNode(node.children, commentId);
    if (found) return found;
  }
  return null;
}
