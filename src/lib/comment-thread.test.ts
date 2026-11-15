import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_VISUAL_DEPTH,
  buildCommentThread,
  commentConfidence,
  commentScore,
  commentUpvotePercent,
  commentVoteTotal,
  compareComments,
  countStances,
  countThreadNodes,
  findThreadNode,
  flattenCommentThread,
  visualDepth,
  type DiscussionComment,
} from "./comment-thread.ts";

let sequence = 0;
function comment(
  commentId: string,
  overrides: Partial<DiscussionComment> = {},
): DiscussionComment {
  sequence += 1;
  const upvoteCount = overrides.upvoteCount ?? 0;
  const downvoteCount = overrides.downvoteCount ?? 0;
  return {
    commentId,
    parentCommentId: null,
    authorName: "Member",
    body: `Body for ${commentId}`,
    stance: "comment",
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
    upvoteCount,
    downvoteCount,
    score: upvoteCount - downvoteCount,
    upvotedByMe: false,
    downvotedByMe: false,
    isMine: false,
    deleted: false,
    ...overrides,
  };
}

describe("comment confidence", () => {
  it("does not reward a perfect ratio with no evidence", () => {
    assert.equal(commentConfidence(comment("none")), 0);
    assert.equal(
      commentConfidence(comment("down", { downvoteCount: 5 })),
      0,
    );

    const single = commentConfidence(comment("single", { upvoteCount: 1 }));
    const broad = commentConfidence(
      comment("broad", { upvoteCount: 100, downvoteCount: 50 }),
    );
    assert.ok(single > 0, "a single upvote has a small positive lower bound");
    assert.ok(
      broad > single,
      "broad support must outrank a single perfect upvote",
    );
  });

  it("rises with support at a constant level of dissent", () => {
    const low = commentConfidence(
      comment("low", { upvoteCount: 3, downvoteCount: 1 }),
    );
    const high = commentConfidence(
      comment("high", { upvoteCount: 30, downvoteCount: 1 }),
    );
    assert.ok(high > low);
  });

  it("derives score, total and upvote percentage without exposing a tally", () => {
    const sample = comment("sample", { upvoteCount: 3, downvoteCount: 1 });
    assert.equal(commentScore(sample), 2);
    assert.equal(commentVoteTotal(sample), 4);
    assert.equal(commentUpvotePercent(sample), 75);
    assert.equal(commentUpvotePercent(comment("empty")), 0);
  });
});

describe("comment thread", () => {
  it("renders a parent before its replies even when the flat list is out of order", () => {
    const parent = comment("parent", {
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const reply = comment("reply", {
      parentCommentId: "parent",
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    const earlierRoot = comment("earlier-root", {
      createdAt: "2025-12-31T00:00:00.000Z",
    });

    const nodes = buildCommentThread([reply, earlierRoot, parent], {
      sort: "oldest",
    });
    const flat = flattenCommentThread(nodes);

    assert.deepEqual(
      flat.map((node) => node.commentId),
      ["earlier-root", "parent", "reply"],
      "a reply must be nested under its parent, never hoisted beside it",
    );
    assert.deepEqual(
      flat.map((node) => node.depth),
      [0, 0, 1],
    );
  });

  it("applies the selected sort to every sibling group without flattening", () => {
    const olderRoot = comment("older-root", {
      createdAt: "2026-01-01T00:00:00.000Z",
      upvoteCount: 2,
    });
    const newerRoot = comment("newer-root", {
      createdAt: "2026-01-03T00:00:00.000Z",
      upvoteCount: 1,
    });
    const earlyReply = comment("early-reply", {
      parentCommentId: "older-root",
      createdAt: "2026-01-04T00:00:00.000Z",
      upvoteCount: 1,
    });
    const lateReply = comment("late-reply", {
      parentCommentId: "older-root",
      createdAt: "2026-01-05T00:00:00.000Z",
      upvoteCount: 9,
    });

    const comments = [lateReply, newerRoot, earlyReply, olderRoot];

    const oldest = buildCommentThread(comments, { sort: "oldest" });
    assert.deepEqual(
      oldest.map((node) => node.comment.commentId),
      ["older-root", "newer-root"],
    );
    assert.deepEqual(
      oldest[0]!.children.map((node) => node.comment.commentId),
      ["early-reply", "late-reply"],
    );

    const newest = buildCommentThread(comments, { sort: "newest" });
    assert.deepEqual(
      newest.map((node) => node.comment.commentId),
      ["newer-root", "older-root"],
    );
    assert.deepEqual(
      newest[1]!.children.map((node) => node.comment.commentId),
      ["late-reply", "early-reply"],
    );

    const top = buildCommentThread(comments, { sort: "top" });
    assert.deepEqual(
      top.map((node) => node.comment.commentId),
      ["older-root", "newer-root"],
    );
    assert.deepEqual(
      top[0]!.children.map((node) => node.comment.commentId),
      ["late-reply", "early-reply"],
    );

    for (const sort of ["oldest", "newest", "top", "best"] as const) {
      const roots = buildCommentThread(comments, { sort });
      const parent = roots.find(
        (node) => node.comment.commentId === "older-root",
      )!;
      assert.equal(parent.children.length, 2, `${sort}: replies stay nested`);
    }
  });

  it("uses confidence for Best and net score for Top", () => {
    const perfectSmall = comment("perfect-small", {
      upvoteCount: 1,
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    const broad = comment("broad", {
      upvoteCount: 100,
      downvoteCount: 50,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const downvoted = comment("downvoted", {
      downvoteCount: 4,
      createdAt: "2026-01-03T00:00:00.000Z",
    });
    const unvoted = comment("unvoted", {
      createdAt: "2026-01-04T00:00:00.000Z",
    });

    const best = buildCommentThread(
      [downvoted, perfectSmall, broad, unvoted],
      { sort: "best" },
    );
    assert.deepEqual(
      best.map((node) => node.comment.commentId),
      ["broad", "perfect-small", "unvoted", "downvoted"],
      "Best rewards evidence, then protects against downvoted comments",
    );

    const top = buildCommentThread(
      [downvoted, perfectSmall, broad, unvoted],
      { sort: "top" },
    );
    assert.deepEqual(
      top.map((node) => node.comment.commentId),
      ["broad", "perfect-small", "unvoted", "downvoted"],
    );
  });

  it("nests multiple levels and reports total descendant counts", () => {
    const comments = [
      comment("a", { createdAt: "2026-01-01T00:00:00.000Z" }),
      comment("b", {
        parentCommentId: "a",
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
      comment("c", {
        parentCommentId: "b",
        createdAt: "2026-01-03T00:00:00.000Z",
      }),
      comment("d", {
        parentCommentId: "c",
        createdAt: "2026-01-04T00:00:00.000Z",
      }),
      comment("b-sibling", {
        parentCommentId: "a",
        createdAt: "2026-01-02T12:00:00.000Z",
      }),
    ];

    const [root] = buildCommentThread(comments, { sort: "oldest" });
    assert.equal(root!.comment.commentId, "a");
    assert.equal(root!.depth, 0);
    assert.equal(root!.replyCount, 4);
    assert.equal(root!.children.length, 2);
    assert.equal(root!.children[0]!.comment.commentId, "b");
    assert.equal(root!.children[0]!.children[0]!.depth, 2);
    assert.equal(root!.children[0]!.children[0]!.children[0]!.depth, 3);
    assert.equal(countThreadNodes([root!]), 5);
  });

  it("promotes orphaned replies to roots instead of dropping them", () => {
    const nodes = buildCommentThread(
      [
        comment("orphan", {
          parentCommentId: "missing-parent",
          createdAt: "2026-01-02T00:00:00.000Z",
        }),
        comment("root", { createdAt: "2026-01-01T00:00:00.000Z" }),
      ],
      { sort: "oldest" },
    );
    assert.deepEqual(
      nodes.map((node) => node.comment.commentId),
      ["root", "orphan"],
    );
    assert.equal(nodes[1]!.depth, 0);
  });

  it("breaks cycles and self-parenting without losing comments", () => {
    const nodes = buildCommentThread(
      [
        comment("cycle-a", { parentCommentId: "cycle-b" }),
        comment("cycle-b", { parentCommentId: "cycle-a" }),
        comment("self", { parentCommentId: "self" }),
      ],
      { sort: "oldest" },
    );
    const flat = flattenCommentThread(nodes);
    assert.equal(flat.length, 3);
    assert.equal(new Set(flat.map((entry) => entry.commentId)).size, 3);
    assert.ok(flat.every((entry) => entry.depth <= 2));
  });

  it("breaks ties deterministically for every sort", () => {
    const a = comment("a", {
      upvoteCount: 2,
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    const b = comment("b", {
      upvoteCount: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const c = comment("c", {
      upvoteCount: 5,
      createdAt: "2026-01-03T00:00:00.000Z",
    });

    for (const sort of ["best", "top", "newest", "oldest"] as const) {
      assert.ok(compareComments(a, b, sort) !== 0, `${sort}: tie is broken`);
      assert.ok(compareComments(a, a, sort) === 0);
    }
    assert.deepEqual(
      buildCommentThread([a, b, c], { sort: "top" }).map(
        (node) => node.comment.commentId,
      ),
      ["c", "b", "a"],
    );
  });

  it("keeps ancestors when filtering by stance and leaves unrelated threads out", () => {
    const comments = [
      comment("support-root", { stance: "support" }),
      comment("concern-reply", {
        parentCommentId: "support-root",
        stance: "concern",
      }),
      comment("comment-grandchild", {
        parentCommentId: "concern-reply",
        stance: "comment",
      }),
      comment("support-sibling", {
        parentCommentId: "support-root",
        stance: "support",
      }),
      comment("unrelated", { stance: "comment" }),
    ];

    const concern = buildCommentThread(comments, {
      sort: "oldest",
      stance: "concern",
    });
    assert.deepEqual(
      concern.map((node) => node.comment.commentId),
      ["support-root"],
      "the parent stays as context for a matching reply",
    );
    assert.equal(concern[0]!.children.length, 1);
    assert.equal(concern[0]!.children[0]!.comment.commentId, "concern-reply");
    assert.equal(
      concern[0]!.replyCount,
      1,
      "hidden non-matching children are not counted",
    );

    const support = buildCommentThread(comments, {
      sort: "oldest",
      stance: "support",
    });
    assert.deepEqual(
      support.map((node) => node.comment.commentId),
      ["support-root"],
    );
    assert.deepEqual(
      support[0]!.children.map((node) => node.comment.commentId),
      ["support-sibling"],
    );
  });

  it("ignores duplicate identifiers and exposes lookup helpers", () => {
    const nodes = buildCommentThread(
      [
        comment("one"),
        comment("one", { body: "duplicate" }),
        comment("two", { parentCommentId: "one" }),
      ],
      { sort: "oldest" },
    );
    assert.equal(countThreadNodes(nodes), 2);
    assert.equal(findThreadNode(nodes, "two")!.depth, 1);
    assert.equal(findThreadNode(nodes, "missing"), null);
  });

  it("caps visual indentation while preserving true depth", () => {
    assert.equal(visualDepth(0), 0);
    assert.equal(visualDepth(MAX_VISUAL_DEPTH), MAX_VISUAL_DEPTH);
    assert.equal(visualDepth(MAX_VISUAL_DEPTH + 6), MAX_VISUAL_DEPTH);
  });

  it("counts stances including replies", () => {
    const counts = countStances([
      comment("a", { stance: "support" }),
      comment("b", { stance: "support", parentCommentId: "a" }),
      comment("c", { stance: "concern" }),
      comment("d", { stance: "amendment" }),
      comment("e", { stance: "comment" }),
    ]);
    assert.deepEqual(counts, {
      all: 5,
      support: 2,
      concern: 1,
      amendment: 1,
      comment: 1,
    });
  });
});
