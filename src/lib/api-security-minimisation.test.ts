import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDevSessionCookie } from "./auth.ts";
import { getDatabase } from "./db.ts";
import { saveProposal, addComment, castVote, toggleUpvoteComment } from "./store.ts";
import { createInAppNotification } from "./notifications.ts";
import { assignRoleToMember, revokeRoleAssignment, saveRoleDefinition } from "./roles-store.ts";
import { GET as getSession } from "../pages/api/session.ts";
import { GET as listProposalsApi, POST as createProposalApi } from "../pages/api/proposals/index.ts";
import { GET as getProposalDetailApi } from "../pages/api/proposals/[proposalId].ts";
import { POST as postCommentApi, PATCH as patchCommentApi } from "../pages/api/comments.ts";
import { GET as getAmendmentsApi, POST as postAmendmentApi } from "../pages/api/amendments.ts";
import { GET as getNotificationsInboxApi } from "../pages/api/notifications/inbox.ts";
import { GET as listAdminBranchesApi, POST as createAdminBranchApi } from "../pages/api/admin/branches.ts";
import { GET as listAdminMembersApi } from "../pages/api/admin/members.ts";
import { GET as listAdminRolesApi } from "../pages/api/admin/roles/index.ts";
import type { SessionUser } from "./types.ts";

const env = { APP_MODE: "development" };
const locals = { runtime: { env } };
const unique = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

const adminCookie = createDevSessionCookie("administrator");
const memberCookie = createDevSessionCookie("member");

const adminUser: SessionUser = {
  memberId: "dev-admin-01",
  name: "Engage Admin",
  email: "admin@engage.local",
  role: "administrator",
  status: "verified",
  canParticipate: true,
  isStaff: true,
  isAdmin: true,
};

const memberUser: SessionUser = {
  memberId: "dev-member-01",
  name: "Verified Member",
  email: "member@engage.local",
  role: "member",
  status: "verified",
  canParticipate: true,
  isStaff: false,
  isAdmin: false,
};

const otherVoter: SessionUser = {
  memberId: "other-voter-02",
  name: "Other Voter",
  email: "other@engage.local",
  role: "member",
  status: "verified",
  canParticipate: true,
  isStaff: false,
  isAdmin: false,
};

function req(path: string, init: RequestInit = {}, cookie?: string) {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  const url = new URL(path, "http://localhost");
  return {
    request: new Request(url, { ...init, headers }),
    url,
    locals,
  };
}

describe("API security and data minimisation", () => {
  it("minimises /api/session and excludes activity, votes, permissions, and branch arrays", async () => {
    await getDatabase(env);

    // Anonymous request
    const anonRes = await getSession(req("/api/session") as any);
    assert.equal(anonRes.status, 200);
    assert.equal(anonRes.headers.get("cache-control"), "private, no-store");
    const anonJson = await anonRes.json();
    assert.equal(anonJson.identity, null);
    assert.equal("activity" in anonJson, false);

    // Authenticated request
    const authRes = await getSession(req("/api/session", {}, memberCookie) as any);
    assert.equal(authRes.status, 200);
    assert.equal(authRes.headers.get("cache-control"), "private, no-store");
    const authJson = await authRes.json();
    assert.equal(authJson.identity.memberId, "dev-member-01");
    assert.equal(authJson.identity.role, "member");
    assert.equal(authJson.identity.status, "verified");
    assert.equal(authJson.identity.canParticipate, true);
    for (const forbidden of [
      "activity",
      "permissions",
      "branchAdminIds",
      "activeBranchIds",
      "followedBranchIds",
      "verifiedBranchIds",
      "email",
      "_id",
    ]) {
      assert.equal(forbidden in authJson, false, `root must not contain ${forbidden}`);
      assert.equal(
        forbidden in authJson.identity,
        false,
        `identity must not contain ${forbidden}`,
      );
    }
  });

  it("enforces ballot confidentiality, strips _id/memberId/upvotes on comments & proposals, and bounds pagination", async () => {
    const db = await getDatabase(env);

    const proposal = await saveProposal(db, adminUser, {
      title: `Privacy Audit Proposal ${unique("p")}`,
      space: "Governance",
      summary: "A summary long enough to pass validation.",
      details: "Detailed proposal text that should not appear in list summaries.",
      outcomes: ["Outcome 1"],
      stage: "decide",
    });

    await castVote(db, memberUser, {
      proposalId: proposal.proposalId,
      choice: "approve",
      reason: "Member private reason",
    });
    await castVote(db, otherVoter, {
      proposalId: proposal.proposalId,
      choice: "reject",
      reason: "Other voter private reason",
    });

    const comment = await addComment(db, memberUser, {
      proposalId: proposal.proposalId,
      stance: "support",
      body: "Strong support for this proposal.",
    });
    await toggleUpvoteComment(db, otherVoter, comment.commentId);

    // 1. Anonymous detail view: no votesList, no comment memberId/_id/upvotes array
    const anonDetailRes = await getProposalDetailApi({
      ...req(`/api/proposals/${proposal.proposalId}`),
      params: { proposalId: proposal.proposalId },
    } as any);
    assert.equal(anonDetailRes.status, 200);
    const anonDetail = await anonDetailRes.json();
    assert.deepEqual(anonDetail.votesList, []);
    assert.equal(anonDetail.myVote, null);
    assert.equal("_id" in anonDetail.proposal, false);
    assert.equal("authorId" in anonDetail.proposal, false);
    assert.equal(anonDetail.comments.length, 1);
    assert.equal("_id" in anonDetail.comments[0], false);
    assert.equal("memberId" in anonDetail.comments[0], false);
    assert.equal("upvotes" in anonDetail.comments[0], false);
    assert.equal(anonDetail.comments[0].upvoteCount, 1);

    // 2. Verified member detail view: sees only own vote without _id/memberId/authorName
    const memberDetailRes = await getProposalDetailApi({
      ...req(`/api/proposals/${proposal.proposalId}`, {}, memberCookie),
      params: { proposalId: proposal.proposalId },
    } as any);
    const memberDetail = await memberDetailRes.json();
    assert.equal(memberDetail.votesList.length, 1);
    assert.equal(memberDetail.votesList[0].choice, "approve");
    assert.equal("_id" in memberDetail.votesList[0], false);
    assert.equal("memberId" in memberDetail.votesList[0], false);
    assert.equal("authorName" in memberDetail.votesList[0], false);

    // 3. National admin detail view: sees identifiable votes without _id
    const adminDetailRes = await getProposalDetailApi({
      ...req(`/api/proposals/${proposal.proposalId}`, {}, adminCookie),
      params: { proposalId: proposal.proposalId },
    } as any);
    const adminDetail = await adminDetailRes.json();
    assert.equal(adminDetail.votesList.length, 2);
    for (const v of adminDetail.votesList) {
      assert.equal("_id" in v, false);
      assert.ok(v.memberId);
    }

    // 4. PATCH /api/comments never returns upvotes array of memberIds
    const upvoteRes = await patchCommentApi(
      req(
        "/api/comments",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ commentId: comment.commentId }),
        },
        memberCookie,
      ) as any,
    );
    assert.equal(upvoteRes.status, 200);
    const upvoteJson = await upvoteRes.json();
    assert.equal("upvotes" in upvoteJson, false);
    assert.equal(upvoteJson.count, 2);
    assert.equal(upvoteJson.endorsed, true);

    // 5. POST /api/comments never returns _id or memberId
    const postCmtRes = await postCommentApi(
      req(
        "/api/comments",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            proposalId: proposal.proposalId,
            stance: "comment",
            body: "Another deliberation point here.",
          }),
        },
        memberCookie,
      ) as any,
    );
    assert.equal(postCmtRes.status, 201);
    const postCmtJson = await postCmtRes.json();
    assert.equal("_id" in postCmtJson.comment, false);
    assert.equal("memberId" in postCmtJson.comment, false);

    // 6. GET /api/proposals clamps excessive limit and omits details/authorId
    const listRes = await listProposalsApi(
      req("/api/proposals?limit=99999", {}, memberCookie) as any,
    );
    assert.equal(listRes.status, 200);
    const listJson = await listRes.json();
    assert.equal(listJson.meta.limit, 100);
    const listed = listJson.proposals.find(
      (p: any) => p.proposalId === proposal.proposalId,
    );
    assert.ok(listed);
    assert.equal("details" in listed, false);
    assert.equal("detailHtml" in listed, false);
    assert.equal("authorId" in listed, false);
    assert.equal("_id" in listed, false);
  });

  it("blocks mass assignment on proposal creation and rejects revoked roles immediately", async () => {
    const db = await getDatabase(env);

    // Attempt mass assignment of authorId / isAdmin / ballotRevisionId
    const createRes = await createProposalApi(
      req(
        "/api/proposals",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: `Mass Assignment Test ${unique("ma")}`,
            space: "Governance",
            summary: "Testing that unexpected fields are not honoured.",
            details: "Full details for testing mass assignment protections.",
            outcomes: ["Safe"],
            authorId: "forged-author",
            isAdmin: true,
            ballotRevisionId: "forged-rev",
          }),
        },
        memberCookie,
      ) as any,
    );
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    assert.equal(created.proposal.ballotRevisionId, undefined);
    const stored = await db
      .collection("proposals")
      .findOne({ proposalId: created.proposal.proposalId });
    assert.equal(stored?.authorId, memberUser.memberId);

    // Unprivileged member cannot access admin endpoints
    const memberAdminRes = await listAdminBranchesApi(
      req("/api/admin/branches", {}, memberCookie) as any,
    );
    assert.equal(memberAdminRes.status, 403);

    // Assign and immediately revoke a configurable role on memberUser
    await db.collection("user").updateOne(
      { memberId: memberUser.memberId },
      {
        $setOnInsert: {
          memberId: memberUser.memberId,
          name: memberUser.name,
          email: memberUser.email,
          emailVerified: true,
        },
      },
      { upsert: true },
    );
    const role = await saveRoleDefinition(db, adminUser, {
      name: `Temp Role ${unique("r")}`,
      description: "Temporary role",
      scope: "national",
      permissions: ["roles.manage"],
    });
    const assignment = await assignRoleToMember(db, adminUser, {
      memberId: memberUser.memberId,
      roleId: role.roleId,
    });
    const whileAssigned = await listAdminRolesApi(
      req("/api/admin/roles", {}, memberCookie) as any,
    );
    assert.equal(whileAssigned.status, 200);

    await revokeRoleAssignment(db, adminUser, {
      assignmentId: assignment.assignmentId,
      reason: "Audit test revocation",
    });
    const afterRevoke = await listAdminRolesApi(
      req("/api/admin/roles", {}, memberCookie) as any,
    );
    assert.equal(afterRevoke.status, 403);
  });

  it("strips _id and internal fields from notifications, amendments, and admin endpoints", async () => {
    const db = await getDatabase(env);

    await createInAppNotification(db, {
      memberId: adminUser.memberId,
      topic: "account_membership",
      title: "Test notification",
      body: "Body text",
      href: "/member/",
    });

    const inboxRes = await getNotificationsInboxApi(
      req("/api/notifications/inbox", {}, adminCookie) as any,
    );
    assert.equal(inboxRes.status, 200);
    assert.equal(inboxRes.headers.get("cache-control"), "private, no-store");
    const inboxJson = await inboxRes.json();
    assert.ok(inboxJson.notifications.length >= 1);
    assert.equal("_id" in inboxJson.notifications[0], false);
    assert.equal("memberId" in inboxJson.notifications[0], false);

    // Admin branches create & list omit _id and updatedBy
    const branchRes = await createAdminBranchApi(
      req(
        "/api/admin/branches",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: `Audit Branch ${unique("br")}`,
            kind: "national",
            recognised: true,
          }),
        },
        adminCookie,
      ) as any,
    );
    assert.equal(branchRes.status, 201);
    const branchJson = await branchRes.json();
    assert.equal("_id" in branchJson.branch, false);
    assert.equal("updatedBy" in branchJson.branch, false);

    // Admin members pagination & DTO
    const membersRes = await listAdminMembersApi(
      req("/api/admin/members?limit=5", {}, adminCookie) as any,
    );
    assert.equal(membersRes.status, 200);
    const membersJson = await membersRes.json();
    assert.equal(membersJson.meta.limit, 5);
    assert.ok(membersJson.accounts.length <= 5);
    if (membersJson.accounts.length > 0) {
      assert.equal("_id" in membersJson.accounts[0], false);
    }

    // Admin roles omit _id
    const rolesRes = await listAdminRolesApi(
      req("/api/admin/roles", {}, adminCookie) as any,
    );
    assert.equal(rolesRes.status, 200);
    const rolesJson = await rolesRes.json();
    for (const r of rolesJson.roles) assert.equal("_id" in r, false);
    for (const a of rolesJson.assignments) assert.equal("_id" in a, false);

    // Amendments omit _id and authorId
    const prop = await saveProposal(db, adminUser, {
      title: `Amend Audit ${unique("am")}`,
      space: "Governance",
      summary: "Summary for amendment audit test.",
      details: "Details for amendment audit test.",
      outcomes: ["Outcome"],
      stage: "deliberate",
    });
    const rev = await db
      .collection("proposal_revisions")
      .findOne({ proposalId: prop.proposalId });
    const postAmRes = await postAmendmentApi(
      req(
        "/api/amendments",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            proposalId: prop.proposalId,
            baseRevisionId: rev?.revisionId,
            changes: { summary: "Updated summary for amendment audit test." },
          }),
        },
        adminCookie,
      ) as any,
    );
    assert.equal(postAmRes.status, 201);
    const postAmJson = await postAmRes.json();
    assert.equal("_id" in postAmJson.amendment, false);
    assert.equal("authorId" in postAmJson.amendment, false);

    const getAmRes = await getAmendmentsApi(
      req(`/api/amendments?proposalId=${prop.proposalId}`, {}, adminCookie) as any,
    );
    assert.equal(getAmRes.status, 200);
    const getAmJson = await getAmRes.json();
    assert.equal("_id" in getAmJson.amendments[0], false);
    assert.equal("authorId" in getAmJson.amendments[0], false);
  });
});
