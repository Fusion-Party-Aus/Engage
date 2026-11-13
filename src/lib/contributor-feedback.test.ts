import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getDatabase } from "./db.ts";
import { addComment, getProposalDetail, listProposals, saveProposal, setCommentFeedback } from "./store.ts";
import { buildMemberCatchUp, listMemberActivityStream } from "./member-activity.ts";
import type { SessionUser } from "./types.ts";

const adminUser: SessionUser = {
  memberId: "admin-fb-1",
  name: "Admin User",
  email: "admin-fb@example.org",
  role: "administrator",
  status: "verified",
  canParticipate: true,
  isStaff: true,
  isAdmin: true,
};

const authorUser: SessionUser = {
  memberId: "author-fb-1",
  name: "Proposal Author",
  email: "author-fb@example.org",
  role: "member",
  status: "verified",
  canParticipate: true,
  isStaff: false,
  isAdmin: false,
};

const otherMember: SessionUser = {
  memberId: "member-fb-2",
  name: "Other Member",
  email: "other-fb@example.org",
  role: "member",
  status: "verified",
  canParticipate: true,
  isStaff: false,
  isAdmin: false,
};

describe("contributor feedback and proposal supersession", () => {
  it("allows proposal authors and administrators to record contribution outcomes, while blocking unrelated members", async () => {
    const env = { APP_MODE: "development" };
    const db = await getDatabase(env);

    const proposal = await saveProposal(db, authorUser, {
      title: "Feedback Test Proposal",
      space: "Governance",
      summary: "Testing contributor feedback workflows.",
      outcomes: ["Outcome A"],
      details: "Proposal details.",
    });

    const comment = await addComment(db, otherMember, {
      proposalId: proposal.proposalId,
      stance: "amendment",
      body: "Suggest clarifying Outcome A.",
    });

    // Unrelated member cannot record feedback
    await assert.rejects(
      () =>
        setCommentFeedback(db, otherMember, {
          commentId: comment.commentId,
          status: "incorporated",
          note: "Self-approving",
        }),
      /administrators, branch moderators.*or the proposal author/i,
    );

    // Proposal author can record feedback
    const authorResult = await setCommentFeedback(db, authorUser, {
      commentId: comment.commentId,
      status: "incorporated",
      note: "Updated Outcome A in revision 2.",
    });
    assert.equal(authorResult.feedback?.status, "incorporated");
    assert.equal(
      authorResult.feedback?.note,
      "Updated Outcome A in revision 2.",
    );

    // Administrator can update and clear feedback
    const adminResult = await setCommentFeedback(db, adminUser, {
      commentId: comment.commentId,
      status: "deferred",
      note: "Deferred to next review cycle.",
    });
    assert.equal(adminResult.feedback?.status, "deferred");

    const cleared = await setCommentFeedback(db, adminUser, {
      commentId: comment.commentId,
      status: "clear",
      note: "Superseded by revision 3.",
    });
    assert.equal(cleared.feedback, null);
    assert.equal(cleared.feedbackHistory.length, 3);
    assert.equal(cleared.feedbackHistory[0]?.action, "incorporated");
    assert.equal(cleared.feedbackHistory[1]?.action, "deferred");
    assert.equal(cleared.feedbackHistory[2]?.action, "cleared");

    const storedComment = await db
      .collection("comments")
      .findOne({ commentId: comment.commentId });
    assert.equal(storedComment?.feedbackHistory?.length, 3);

    // Non-cleared responses appear in the contributor's activity stream and catch-up notifications
    const stream = await listMemberActivityStream(db, otherMember.memberId);
    assert.ok(
      stream.some((event) => event.action === "responded to your contribution on"),
    );
    const catchUp = await buildMemberCatchUp(
      db,
      otherMember.memberId,
      new Date(Date.now() - 60_000),
      otherMember,
    );
    assert.ok(
      catchUp.some((group) =>
        group.items.some(
          (item) => item.action === "responded to your contribution",
        ),
      ),
    );
  });

  it("enforces proposal visibility on supersession targets when fetched for public/unauthorised viewers", async () => {
    const env = { APP_MODE: "development" };
    const db = await getDatabase(env);

    const publicProposal = await saveProposal(db, adminUser, {
      title: "Public Proposal With Private Successor",
      space: "Governance",
      summary: "Publicly visible proposal.",
      outcomes: ["Outcome 1"],
      details: "Public details.",
    });

    const privateSuccessor = await saveProposal(db, adminUser, {
      title: "Confidential Draft Successor",
      space: "Governance",
      summary: "Private successor draft.",
      outcomes: ["Outcome 2"],
      details: "Private details.",
      publicationScope: "private",
    });

    await saveProposal(db, adminUser, {
      proposalId: publicProposal.proposalId,
      supersededByProposalId: privateSuccessor.proposalId,
    });

    const publicViewOfSuccessor = await getProposalDetail(
      db,
      privateSuccessor.proposalId,
      otherMember,
    );
    assert.equal(publicViewOfSuccessor, null);

    const adminViewOfSuccessor = await getProposalDetail(
      db,
      privateSuccessor.proposalId,
      adminUser,
    );
    assert.equal(adminViewOfSuccessor?.proposal.title, "Confidential Draft Successor");
  });

  it("allows recording supersession metadata on a locked proposal without altering substantive wording", async () => {
    const env = { APP_MODE: "development" };
    const db = await getDatabase(env);

    const oldProposal = await saveProposal(db, adminUser, {
      title: "Older Governance Motion",
      kind: "resolution",
      space: "Governance",
      summary: "Original motion summary.",
      outcomes: ["Establish committee"],
      details: "Original details.",
      stage: "decide",
    });

    const newProposal = await saveProposal(db, adminUser, {
      title: "Updated Governance Motion",
      kind: "resolution",
      space: "Governance",
      summary: "Updated motion summary.",
      outcomes: ["Establish updated committee"],
      details: "Updated details.",
    });

    await assert.rejects(
      () =>
        saveProposal(db, adminUser, {
          proposalId: oldProposal.proposalId,
          supersededByProposalId: oldProposal.proposalId,
        }),
      /cannot supersede itself/i,
    );

    const updated = await saveProposal(db, adminUser, {
      proposalId: oldProposal.proposalId,
      stage: "archived",
      implementationNote: "Closed and replaced by updated motion.",
      supersededByProposalId: newProposal.proposalId,
      supersededByNote: "Replaced at November meeting.",
    });

    assert.equal(updated.stage, "archived");
    assert.equal(updated.supersededByProposalId, newProposal.proposalId);
    assert.equal(updated.supersededByNote, "Replaced at November meeting.");

    // Round-trip read-back via getProposalDetail and listProposals (verifies normalizeProposalDoc)
    const detail = await getProposalDetail(db, oldProposal.proposalId, adminUser);
    assert.equal(detail?.proposal.supersededByProposalId, newProposal.proposalId);
    assert.equal(detail?.proposal.supersededByNote, "Replaced at November meeting.");

    const listed = await listProposals(db, { includeArchived: true, user: adminUser });
    const listedOld = listed.find((p) => p.proposalId === oldProposal.proposalId);
    assert.equal(listedOld?.supersededByProposalId, newProposal.proposalId);
    assert.equal(listedOld?.supersededByNote, "Replaced at November meeting.");

    // Clearing successor ID without explicitly passing supersededByNote clears both
    const cleared = await saveProposal(db, adminUser, {
      proposalId: oldProposal.proposalId,
      supersededByProposalId: "",
    });
    assert.equal(cleared.supersededByProposalId, undefined);
    assert.equal(cleared.supersededByNote, undefined);

    const detailAfterClear = await getProposalDetail(db, oldProposal.proposalId, adminUser);
    assert.equal(detailAfterClear?.proposal.supersededByProposalId, undefined);
    assert.equal(detailAfterClear?.proposal.supersededByNote, undefined);
  });
});
