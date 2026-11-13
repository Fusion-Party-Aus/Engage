import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDb, getDatabase } from "./db.ts";
import {
  saveProposal,
  deleteProposal,
  deleteComment,
  listProposals,
} from "./store.ts";
import { listSense, reviewSense } from "./sense-box.ts";
import { GET as getBranches } from "../pages/api/admin/branches.ts";
import { POST as postReferrals } from "../pages/api/admin/branches/referrals.ts";
import { POST as openAmendmentBallot } from "../pages/api/admin/amendments/open-ballot.ts";
import { POST as resolveAmendment } from "../pages/api/admin/amendments/resolve.ts";
import { POST as applyAmendment } from "../pages/api/admin/amendments/apply.ts";
import { POST as ratifyPolicy } from "../pages/api/admin/policies/ratify.ts";
import type { SessionUser } from "./types.ts";
import type { PermissionKey } from "./rbac.ts";

const futureClose = () => new Date(Date.now() + 7 * 86400_000).toISOString();

function delegatedUser(
  overrides: Partial<SessionUser> & {
    national?: PermissionKey[];
    branches?: Record<string, PermissionKey[]>;
  } = {},
): SessionUser {
  const { national = [], branches = {}, ...rest } = overrides;
  return {
    memberId: overrides.memberId ?? `member-${crypto.randomUUID()}`,
    name: overrides.name ?? "Delegated User",
    email: overrides.email ?? "delegated@fusionparty.org.au",
    role: overrides.role ?? "member",
    status: "verified",
    canParticipate: true,
    isStaff: overrides.isStaff ?? false,
    isAdmin: overrides.isAdmin ?? false,
    isBranchAdmin: overrides.isBranchAdmin ?? false,
    branchAdminIds: overrides.branchAdminIds ?? [],
    permissions: {
      national,
      branches,
      grants: [],
    },
    ...rest,
  };
}

describe("Sprint 1 RBAC and authority invariants (#27, #31)", () => {
  it("requires ballots.bind to enter decide and blocks moderators without ballots.bind", async () => {
    const db = createMemoryDb();
    await db.collection("branches").insertOne({ branchId: "vic", name: "Victoria", kind: "state", recognised: true });
    await db.collection("branches").insertOne({ branchId: "nsw", name: "New South Wales", kind: "state", recognised: true });

    const admin = delegatedUser({
      memberId: "admin-1",
      role: "administrator",
      isStaff: true,
      isAdmin: true,
    });
    const moderator = delegatedUser({
      memberId: "mod-1",
      role: "moderator",
      isStaff: true,
      isAdmin: false,
      national: [
        "proposals.view_archived",
        "proposals.edit",
        "proposals.manage_supersession",
        "comments.moderate",
        "contributions.respond",
      ],
    });
    const vicEditor = delegatedUser({
      memberId: "vic-editor",
      branches: { vic: ["proposals.edit"] },
    });
    const vicBallotOfficer = delegatedUser({
      memberId: "vic-ballot",
      branches: { vic: ["proposals.edit", "ballots.bind"] },
    });

    const created = await saveProposal(db, admin, {
      title: "Victorian Ballot Authority Test",
      summary: "Testing that moderators and editors without ballots.bind cannot open Decide.",
      space: "Governance",
      stage: "deliberate",
      originatingBranchId: "vic",
      governanceAuthorityBranchId: "vic",
      jurisdictionBranchId: "vic",
    });

    await assert.rejects(
      () =>
        saveProposal(db, moderator, {
          proposalId: created.proposalId,
          stage: "decide",
        }),
      /not authorised to open a ballot/i,
    );

    await assert.rejects(
      () =>
        saveProposal(db, vicEditor, {
          proposalId: created.proposalId,
          stage: "decide",
        }),
      /not authorised to open a ballot/i,
    );

    const nswBallotOfficer = delegatedUser({
      memberId: "nsw-ballot",
      branches: { nsw: ["proposals.edit", "ballots.bind"] },
    });
    await assert.rejects(
      () =>
        saveProposal(db, nswBallotOfficer, {
          proposalId: created.proposalId,
          stage: "decide",
        }),
      /Moderator or Administrator access is required|not authorised/i,
    );

    const opened = await saveProposal(db, vicBallotOfficer, {
      proposalId: created.proposalId,
      stage: "decide",
      ballotClosesAt: futureClose(),
    });
    assert.equal(opened.stage, "decide");
    assert.ok(opened.ballotRevisionId);
  });

  it("enforces proposals.manage_supersession, proposals.delete, proposals.view_archived, and comments.moderate within branch scope", async () => {
    const db = createMemoryDb();
    await db.collection("branches").insertOne({ branchId: "vic", name: "Victoria", kind: "state", recognised: true });
    await db.collection("branches").insertOne({ branchId: "nsw", name: "New South Wales", kind: "state", recognised: true });

    const admin = delegatedUser({
      memberId: "admin-2",
      role: "administrator",
      isStaff: true,
      isAdmin: true,
    });
    const successor = await saveProposal(db, admin, {
      title: "Successor Proposal",
      summary: "Successor proposal used for supersession permission checks.",
      space: "Governance",
      stage: "deliberate",
      originatingBranchId: "vic",
    });
    const target = await saveProposal(db, admin, {
      title: "Target Proposal",
      summary: "Target proposal used for branch-scoped RBAC checks.",
      space: "Governance",
      stage: "deliberate",
      originatingBranchId: "vic",
      publicationScope: "public",
    });

    const editorOnly = delegatedUser({
      memberId: "vic-ed-only",
      branches: { vic: ["proposals.edit"] },
    });
    await assert.rejects(
      () =>
        saveProposal(db, editorOnly, {
          proposalId: target.proposalId,
          supersededByProposalId: successor.proposalId,
        }),
      /supersession/i,
    );

    const supersessionHolder = delegatedUser({
      memberId: "vic-sup",
      branches: { vic: ["proposals.edit", "proposals.manage_supersession"] },
    });
    const superseded = await saveProposal(db, supersessionHolder, {
      proposalId: target.proposalId,
      supersededByProposalId: successor.proposalId,
    });
    assert.equal(superseded.supersededByProposalId, successor.proposalId);

    // Comment moderation scoped to vic
    const commentId = `c-${crypto.randomUUID()}`;
    await db.collection("comments").insertOne({
      commentId,
      proposalId: target.proposalId,
      memberId: "author-1",
      memberName: "Author",
      body: "Deliberation comment",
      stance: "comment",
      createdAt: new Date(),
    });
    const nswMod = delegatedUser({
      memberId: "nsw-mod",
      branches: { nsw: ["comments.moderate"] },
    });
    await assert.rejects(
      () => deleteComment(db, nswMod, commentId),
      /only delete your own|Comment not found/i,
    );
    const vicMod = delegatedUser({
      memberId: "vic-mod",
      activeBranchIds: ["vic"],
      branches: { vic: ["comments.moderate"] },
    });
    await deleteComment(db, vicMod, commentId);
    assert.equal(
      await db.collection("comments").countDocuments({ commentId }),
      0,
    );

    // Archived visibility scoped to vic
    await saveProposal(db, admin, {
      proposalId: target.proposalId,
      stage: "archived",
    });
    const nswViewer = delegatedUser({
      memberId: "nsw-view",
      branches: { nsw: ["proposals.view_archived"] },
    });
    const vicViewer = delegatedUser({
      memberId: "vic-view",
      activeBranchIds: ["vic"],
      branches: { vic: ["proposals.view_archived"] },
    });
    const hiddenList = await listProposals(db, {
      includeArchived: true,
      user: nswViewer,
    });
    assert.equal(
      hiddenList.some((p) => p.proposalId === target.proposalId),
      false,
    );
    const visibleList = await listProposals(db, {
      includeArchived: true,
      user: vicViewer,
    });
    assert.equal(
      visibleList.some((p) => p.proposalId === target.proposalId),
      true,
    );

    // Proposal deletion is national-only in the permission catalogue: a branch
    // grant must not confer destructive authority.
    const branchDeleter = delegatedUser({
      memberId: "vic-del",
      branches: { vic: ["proposals.delete"] },
    });
    const deletable = await saveProposal(db, admin, {
      title: "Deletable Draft",
      summary: "Draft with no governance history used for deletion checks.",
      space: "Governance",
      stage: "deliberate",
      originatingBranchId: "vic",
    });
    await assert.rejects(
      () => deleteProposal(db, branchDeleter, deletable.proposalId),
      /Administrator access is required/i,
    );
    const nationalDeleter = delegatedUser({
      memberId: "nat-del",
      national: ["proposals.delete"],
    });
    await deleteProposal(db, nationalDeleter, deletable.proposalId);
    assert.equal(
      await db
        .collection("proposals")
        .countDocuments({ proposalId: deletable.proposalId }),
      0,
    );
  });

  it("enforces sense_box.review within branch scope", async () => {
    const db = createMemoryDb();
    const vicId = crypto.randomUUID();
    const nswId = crypto.randomUUID();
    await db.collection("sense_submissions").insertOne({
      submissionId: vicId,
      branchId: "vic",
      title: "Vic priority",
      detail: "Detail for Vic",
      topic: "housing",
      status: "new",
      version: 0,
      createdAt: new Date(),
    });
    await db.collection("sense_submissions").insertOne({
      submissionId: nswId,
      branchId: "nsw",
      title: "NSW priority",
      detail: "Detail for NSW",
      topic: "housing",
      status: "new",
      version: 0,
      createdAt: new Date(),
    });

    const vicReviewer = delegatedUser({
      memberId: "vic-sense",
      branches: { vic: ["sense_box.review"] },
    });
    const inbox = await listSense(db, vicReviewer, {});
    assert.equal(inbox.items.length, 1);
    assert.equal(inbox.items[0]?.submissionId, vicId);

    await assert.rejects(
      () =>
        reviewSense(db, vicReviewer, {
          branchId: "nsw",
          submissionId: nswId,
          status: "reviewed",
          version: 0,
        }),
      /do not have access/i,
    );

    await reviewSense(db, vicReviewer, {
      branchId: "vic",
      submissionId: vicId,
      status: "reviewed",
      version: 0,
    });
    const updated = await db
      .collection("sense_submissions")
      .findOne({ submissionId: vicId });
    assert.equal(updated?.status, "reviewed");
  });

  it("enforces open-ballot ready state, ratify authority match, branches.manage, branches.refer_proposals, amendments.resolve and amendments.apply", async () => {
    const env = { APP_MODE: "development" };
    const db = await getDatabase(env);

    const proposalId = `rbac-prop-${crypto.randomUUID()}`;
    const revisionId = `rbac-rev-${crypto.randomUUID()}`;
    const amendmentId = `rbac-amend-${crypto.randomUUID()}`;
    const amendmentRevId = `rbac-arev-${crypto.randomUUID()}`;
    const vicBranchId = `vic-${crypto.randomUUID()}`;
    const nswBranchId = `nsw-${crypto.randomUUID()}`;

    await db.collection("branches").insertOne({ branchId: vicBranchId, name: "Vic", kind: "state", recognised: true });
    await db.collection("branches").insertOne({ branchId: nswBranchId, name: "NSW", kind: "state", recognised: true });
    await db.collection("proposals").insertOne({
      proposalId,
      slug: proposalId,
      title: "RBAC API Test Proposal",
      summary: "Proposal for testing API RBAC and authority checks.",
      space: "Governance",
      stage: "decide",
      originatingBranchId: vicBranchId,
      governanceAuthorityBranchId: vicBranchId,
      jurisdictionBranchId: vicBranchId,
      ballotRevisionId: revisionId,
      ballotClosesAt: new Date(Date.now() + 86_400_000),
    });
    await db.collection("proposal_revisions").insertOne({
      proposalId,
      revisionId,
      parentRevisionId: null,
      createdAt: new Date(),
      snapshot: {
        title: "RBAC API Test Proposal",
        summary: "Proposal for testing API RBAC and authority checks.",
        outcomes: ["Outcome"],
        details: "Details.",
      },
      contentHash: "h1",
    });
    await db.collection("amendment_revisions").insertOne({
      amendmentId,
      revisionId: amendmentRevId,
      snapshot: { summary: "Amended summary." },
    });
    await db.collection("amendments").insertOne({
      amendmentId,
      proposalId,
      baseRevisionId: revisionId,
      currentRevisionId: amendmentRevId,
      status: "proposed",
    });

    // 1. open-ballot rejects proposed amendment (must be ready)
    const openProposed = await openAmendmentBallot({
      request: new Request("http://localhost/api/admin/amendments/open-ballot", {
        method: "POST",
        headers: {
          Cookie: "engage_dev_user=administrator",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ amendmentId }),
      }),
      locals: { runtime: { env } },
    } as never);
    assert.equal(openProposed.status, 404);

    // 2. ratify rejects mismatched authorityBranchId against proposal.governanceAuthorityBranchId
    await db.collection("proposals").updateOne(
      { proposalId },
      { $set: { stage: "implement" } },
    );
    await db.collection("ballot_results").insertOne({
      proposalId,
      revisionId,
      result: "successful",
      decisionEventId: `dec-${proposalId}`,
    });
    const mismatchedRatify = await ratifyPolicy({
      request: new Request("http://localhost/api/admin/policies/ratify", {
        method: "POST",
        headers: {
          Cookie: "engage_dev_user=administrator",
          "Content-Type": "application/json",
          "Idempotency-Key": `ratify-mismatch-${proposalId}`,
        },
        body: JSON.stringify({
          proposalId,
          revisionId,
          decisionEventId: `dec-${proposalId}`,
          authorityBranchId: nswBranchId,
        }),
      }),
      locals: { runtime: { env } },
    } as never);
    assert.equal(mismatchedRatify.status, 409);

    // 3. member without branches.manage is denied on GET /api/admin/branches
    const deniedBranches = await getBranches({
      request: new Request("http://localhost/api/admin/branches", {
        headers: { Cookie: "engage_dev_user=member" },
      }),
      locals: { runtime: { env } },
    } as never);
    assert.equal(deniedBranches.status, 403);

    // 4. member without branches.refer_proposals is denied on POST /api/admin/branches/referrals
    const deniedReferral = await postReferrals({
      request: new Request("http://localhost/api/admin/branches/referrals", {
        method: "POST",
        headers: {
          Cookie: "engage_dev_user=member",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          proposalId,
          sourceBranchId: vicBranchId,
          targetBranchId: nswBranchId,
          reason: "Refer to NSW",
        }),
      }),
      locals: { runtime: { env } },
    } as never);
    assert.equal(deniedReferral.status, 403);

    // 5. member without amendments.resolve / amendments.apply is denied
    const deniedResolve = await resolveAmendment({
      request: new Request("http://localhost/api/admin/amendments/resolve", {
        method: "POST",
        headers: {
          Cookie: "engage_dev_user=member",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amendmentId,
          outcome: "ready",
          reason: "Ready for vote",
        }),
      }),
      locals: { runtime: { env } },
    } as never);
    assert.equal(deniedResolve.status, 403);

    const deniedApply = await applyAmendment({
      request: new Request("http://localhost/api/admin/amendments/apply", {
        method: "POST",
        headers: {
          Cookie: "engage_dev_user=member",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ amendmentId }),
      }),
      locals: { runtime: { env } },
    } as never);
    assert.equal(deniedApply.status, 403);
  });
});
