import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDb } from "./db.ts";
import {
  MAX_COMMENT_DEPTH,
  addComment,
  deleteComment,
  getProposalDetail,
  saveProposal,
  voteOnComment,
} from "./store.ts";
import { toCommentDto } from "./api-contracts.ts";
import type { SessionUser } from "./types.ts";

const author: SessionUser = {
  memberId: "reply-author-1",
  name: "Alex Author",
  email: "alex@example.org",
  role: "member",
  status: "verified",
  canParticipate: true,
  isStaff: false,
  isAdmin: false,
};

const responder: SessionUser = {
  memberId: "reply-member-2",
  name: "Bailey Member",
  email: "bailey@example.org",
  role: "member",
  status: "verified",
  canParticipate: true,
  isStaff: false,
  isAdmin: false,
};

const outsider: SessionUser = {
  memberId: "reply-outsider-3",
  name: "Casey Outsider",
  email: "casey@example.org",
  role: "member",
  status: "verified",
  canParticipate: true,
  isStaff: false,
  isAdmin: false,
};

const pending: SessionUser = {
  ...responder,
  memberId: "reply-pending-4",
  status: "pending",
  canParticipate: false,
};

const moderator: SessionUser = {
  ...responder,
  memberId: "reply-moderator-5",
  role: "moderator",
  isStaff: true,
};

const admin: SessionUser = {
  ...author,
  memberId: "reply-admin-0",
  name: "Admin User",
  email: "admin@example.org",
  role: "administrator",
  isStaff: true,
  isAdmin: true,
};

async function createProposal(db: ReturnType<typeof createMemoryDb>, title: string) {
  return saveProposal(db, admin, {
    title,
    space: "Governance",
    summary: "Threaded discussion test proposal.",
    stage: "deliberate",
  });
}

describe("threaded deliberation comments", () => {
  it("stores a reply against its parent and returns it in the detail view", async () => {
    const db = createMemoryDb();
    const proposal = await createProposal(db, "Threaded data model");

    const parent = await addComment(db, author, {
      proposalId: proposal.proposalId,
      stance: "support",
      body: "This is the parent contribution.",
    });
    const reply = await addComment(db, responder, {
      proposalId: proposal.proposalId,
      parentCommentId: parent.commentId,
      stance: "concern",
      body: "This is a direct reply to the parent.",
    });
    const nested = await addComment(db, author, {
      proposalId: proposal.proposalId,
      parentCommentId: reply.commentId,
      body: "This replies to the reply.",
    });

    assert.equal(parent.parentCommentId ?? null, null);
    assert.equal(parent.depth, 0);
    assert.equal(reply.parentCommentId, parent.commentId);
    assert.equal(reply.depth, 1);
    assert.equal(nested.parentCommentId, reply.commentId);
    assert.equal(nested.depth, 2);

    const detail = await getProposalDetail(db, proposal.slug, responder);
    assert.ok(detail);
    const storedReply = detail.comments.find(
      (comment) => comment.commentId === reply.commentId,
    );
    assert.equal(storedReply?.parentCommentId, parent.commentId);
    assert.equal(storedReply?.depth, 1);
    assert.equal(storedReply?.memberId, responder.memberId);

    const dto = toCommentDto(storedReply!, responder);
    assert.equal(dto.parentCommentId, parent.commentId);
    assert.equal(dto.isMine, true);
    assert.equal("memberId" in dto, false, "the public DTO never exposes memberId");
  });

  it("refuses a reply whose parent is in another proposal or no longer exists", async () => {
    const db = createMemoryDb();
    const proposal = await createProposal(db, "Reply scope");
    const other = await createProposal(db, "Other scope");
    const foreignParent = await addComment(db, author, {
      proposalId: other.proposalId,
      body: "Parent in a different proposal.",
    });

    await assert.rejects(
      () =>
        addComment(db, responder, {
          proposalId: proposal.proposalId,
          parentCommentId: foreignParent.commentId,
          body: "Trying to cross threads.",
        }),
      /no longer available/i,
    );

    await assert.rejects(
      () =>
        addComment(db, responder, {
          proposalId: proposal.proposalId,
          parentCommentId: "cmt-does-not-exist",
          body: "Trying to reply to nothing.",
        }),
      /no longer available/i,
    );
  });

  it("requires participation to reply, exactly as for a top-level comment", async () => {
    const db = createMemoryDb();
    const proposal = await createProposal(db, "Reply permission");
    const parent = await addComment(db, author, {
      proposalId: proposal.proposalId,
      body: "Parent contribution.",
    });

    await assert.rejects(
      () =>
        addComment(db, pending, {
          proposalId: proposal.proposalId,
          parentCommentId: parent.commentId,
          body: "Unverified reply.",
        }),
      /membership must be verified/i,
    );
  });

  it("stops a reply chain at the stored depth ceiling", async () => {
    const db = createMemoryDb();
    const proposal = await createProposal(db, "Reply depth ceiling");
    let parentId: string | undefined;
    for (let depth = 0; depth <= MAX_COMMENT_DEPTH; depth += 1) {
      const created = await addComment(db, author, {
        proposalId: proposal.proposalId,
        ...(parentId ? { parentCommentId: parentId } : {}),
        body: `Contribution at depth ${depth}.`,
      });
      assert.equal(created.depth, depth);
      parentId = created.commentId;
    }

    await assert.rejects(
      () =>
        addComment(db, responder, {
          proposalId: proposal.proposalId,
          parentCommentId: parentId,
          body: "One level too far.",
        }),
      /nested too deeply/i,
    );
  });

  it("removes a leaf but keeps a deleted placeholder when replies depend on it", async () => {
    const db = createMemoryDb();
    const proposal = await createProposal(db, "Reply deletion");
    const parent = await addComment(db, author, {
      proposalId: proposal.proposalId,
      body: "Parent text that may be moderated.",
    });
    const reply = await addComment(db, responder, {
      proposalId: proposal.proposalId,
      parentCommentId: parent.commentId,
      body: "Reply that must remain readable.",
    });

    const tombstone = await deleteComment(db, author, parent.commentId);
    assert.deepEqual(tombstone, {
      deleted: false,
      tombstoned: true,
      replyCount: 1,
      prunedIds: [],
    });

    await assert.rejects(
      () => voteOnComment(db, responder, parent.commentId, "upvote"),
      /deleted contributions cannot be voted on/i,
    );
    await assert.rejects(
      () =>
        addComment(db, responder, {
          proposalId: proposal.proposalId,
          parentCommentId: parent.commentId,
          body: "Should not attach to deleted placeholder.",
        }),
      /cannot reply to a deleted contribution/i,
    );

    const detail = await getProposalDetail(db, proposal.slug, responder);
    assert.ok(detail);
    const retainedParent = detail.comments.find(
      (comment) => comment.commentId === parent.commentId,
    );
    assert.ok(retainedParent);
    assert.equal(retainedParent.body, "", "moderated text is not sent to readers");
    assert.ok(retainedParent.deletedAt);
    assert.ok(
      detail.comments.some((comment) => comment.commentId === reply.commentId),
      "the reply keeps its parent for context",
    );
    assert.equal(
      toCommentDto(retainedParent, responder).deleted,
      true,
    );

    const removed = await deleteComment(db, responder, reply.commentId);
    assert.deepEqual(removed, {
      deleted: true,
      tombstoned: false,
      replyCount: 0,
      prunedIds: [reply.commentId, parent.commentId],
    });
    const after = await getProposalDetail(db, proposal.slug, responder);
    assert.ok(
      !after?.comments.some((comment) => comment.commentId === reply.commentId),
    );
  });

  it("preserves author and moderation deletion authority", async () => {
    const db = createMemoryDb();
    const proposal = await createProposal(db, "Reply moderation");
    const parent = await addComment(db, author, {
      proposalId: proposal.proposalId,
      body: "Another member's contribution.",
    });
    await addComment(db, responder, {
      proposalId: proposal.proposalId,
      parentCommentId: parent.commentId,
      body: "A reply that keeps the parent visible.",
    });

    await assert.rejects(
      () => deleteComment(db, outsider, parent.commentId),
      /only delete your own contributions/i,
    );

    await deleteComment(db, moderator, parent.commentId);
    const detail = await getProposalDetail(db, proposal.slug, outsider);
    const retained = detail?.comments.find(
      (comment) => comment.commentId === parent.commentId,
    );
    assert.ok(retained?.deletedAt, "a moderator can tombstone, not erase the thread");
  });

  it("supports upvotes, downvotes and switching without exposing voter identities", async () => {
    const db = createMemoryDb();
    const proposal = await createProposal(db, "Comment voting");
    const parent = await addComment(db, author, {
      proposalId: proposal.proposalId,
      body: "A contribution with a contested score.",
    });

    const upvote = await voteOnComment(db, responder, parent.commentId, "upvote");
    assert.equal(upvote.score, 1);
    assert.equal(upvote.upvoteCount, 1);
    assert.equal(upvote.downvoteCount, 0);
    assert.equal(upvote.upvotePercent, 100);
    assert.equal(upvote.hasUpvoted, true);
    assert.equal(upvote.hasDownvoted, false);

    const downvote = await voteOnComment(
      db,
      responder,
      parent.commentId,
      "downvote",
    );
    assert.equal(downvote.score, -1);
    assert.equal(downvote.upvoteCount, 0);
    assert.equal(downvote.downvoteCount, 1);
    assert.equal(downvote.upvotePercent, 0);
    assert.equal(downvote.hasUpvoted, false);
    assert.equal(downvote.hasDownvoted, true);

    const clearDownvote = await voteOnComment(
      db,
      responder,
      parent.commentId,
      "downvote",
    );
    assert.equal(clearDownvote.score, 0);
    assert.equal(clearDownvote.downvoteCount, 0);
    assert.equal(clearDownvote.hasDownvoted, false);

    const again = await voteOnComment(
      db,
      responder,
      parent.commentId,
      "upvote",
    );
    assert.equal(again.score, 1);

    const mine = await getProposalDetail(db, proposal.slug, responder);
    const myComment = mine?.comments.find(
      (comment) => comment.commentId === parent.commentId,
    )!;
    const myDto = toCommentDto(myComment, responder);
    assert.equal(myDto.score, 1);
    assert.equal(myDto.upvoteCount, 1);
    assert.equal(myDto.downvoteCount, 0);
    assert.equal(myDto.upvotedByMe, true);
    assert.equal(myDto.downvotedByMe, false);
    assert.equal("upvotes" in myDto, false);
    assert.equal("downvotes" in myDto, false);
    assert.equal("memberId" in myDto, false);

    const anonymous = await getProposalDetail(db, proposal.slug, outsider);
    const anonDto = toCommentDto(
      anonymous!.comments.find(
        (comment) => comment.commentId === parent.commentId,
      )!,
      outsider,
    );
    assert.equal(anonDto.upvotedByMe, false);
    assert.equal(anonDto.downvotedByMe, false);
    assert.equal(anonDto.score, 1);
  });

  it("applies concurrent votes without losing any", async () => {
    const db = createMemoryDb();
    const proposal = await createProposal(db, "Concurrent comment votes");
    const parent = await addComment(db, author, {
      proposalId: proposal.proposalId,
      body: "A contribution with many simultaneous voters.",
    });
    const voters: SessionUser[] = Array.from({ length: 12 }, (_, index) => ({
      ...responder,
      memberId: `concurrent-voter-${index}`,
      email: `concurrent-${index}@example.org`,
    }));

    await Promise.all(
      voters.map((voter) =>
        voteOnComment(db, voter, parent.commentId, "upvote"),
      ),
    );

    const detail = await getProposalDetail(db, proposal.slug, responder);
    const stored = detail?.comments.find(
      (comment) => comment.commentId === parent.commentId,
    )!;
    assert.equal(stored.upvotes.length, 12);
    assert.equal(stored.downvotes?.length, 0);
    assert.equal(
      toCommentDto(stored, responder).score,
      12,
      "no concurrent vote is lost",
    );

    // Two simultaneous clicks from the same member are two toggles: add then
    // remove. The CAS must not leave a phantom or duplicate vote.
    await Promise.all([
      voteOnComment(db, responder, parent.commentId, "upvote"),
      voteOnComment(db, responder, parent.commentId, "upvote"),
    ]);
    const afterDoubleClick = await getProposalDetail(
      db,
      proposal.slug,
      responder,
    );
    const afterStored = afterDoubleClick?.comments.find(
      (comment) => comment.commentId === parent.commentId,
    )!;
    assert.equal(
      afterStored.upvotes.filter((id) => id === responder.memberId).length,
      0,
      "the same member cannot hold two votes after two clicks",
    );
  });
});
