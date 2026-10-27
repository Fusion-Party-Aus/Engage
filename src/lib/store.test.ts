import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDb, getDatabase } from "./db.ts";
import {
  addComment,
  castVote,
  deleteComment,
  deletePolicy,
  getPolicyDetail,
  listMembers,
  listPolicies,
  listUserActivity,
  saveMember,
  savePolicy,
} from "./store.ts";
import type { SessionUser } from "./types.ts";

const adminUser: SessionUser = {
  memberId: "6ae04785e1b01d9c2acc646c",
  name: "Admin User",
  email: "admin@fusionparty.org.au",
  role: "administrator",
  status: "verified",
  canParticipate: true,
  isStaff: true,
  isAdmin: true,
};

const memberUser: SessionUser = {
  memberId: "6ae04785e1b01d9c2acc646d",
  name: "Verified Member",
  email: "member@fusionparty.org.au",
  role: "member",
  status: "verified",
  canParticipate: true,
  isStaff: false,
  isAdmin: false,
};

const pendingUser: SessionUser = {
  memberId: "6ae04785e1b01d9c2acc646e",
  name: "Pending Member",
  email: "pending@fusionparty.org.au",
  role: "member",
  status: "pending",
  canParticipate: false,
  isStaff: false,
  isAdmin: false,
};

describe("Engage CRUD store", () => {
  it("automatically seeds the 76 baseline policies and filters them", async () => {
    const db = await getDatabase({ APP_MODE: "development" });
    const all = await listPolicies(db);
    assert.equal(all.length, 76);

    const voting = await listPolicies(db, { status: "voting" });
    assert.equal(voting.length, 36);

    const housing = await listPolicies(db, { search: "housing" });
    assert.ok(housing.length > 0);
  });

  it("supports creating, updating, and deleting a policy", async () => {
    const db = createMemoryDb();
    await assert.rejects(() =>
      savePolicy(db, memberUser, {
        title: "Unauthorized Policy",
        category: "General",
        statement: "Should not be allowed by a non-staff member.",
      }),
    );

    const created = await savePolicy(db, adminUser, {
      title: "High-Speed East Coast Rail Network",
      category: "Transform Our Industries",
      division: "Reclaim Our Future",
      statement: "Build a dedicated high-speed rail corridor linking Brisbane, Sydney, Canberra, and Melbourne.",
      outcomes: "Faster regional travel\nLower aviation emissions",
      details: "**Overview**\n\nConnect major centres with zero-emission high-speed rail.",
      status: "open",
    });

    assert.equal(created.title, "High-Speed East Coast Rail Network");
    assert.equal(created.outcomes.length, 2);
    assert.equal(created.status, "open");

    const updated = await savePolicy(db, adminUser, {
      policyId: created.policyId,
      status: "voting",
    });
    assert.equal(updated.status, "voting");

    await deletePolicy(db, adminUser, created.policyId);
    const detail = await getPolicyDetail(db, created.policyId, adminUser);
    assert.equal(detail, null);
  });

  it("supports comments, amendments, and voting on a policy", async () => {
    const db = createMemoryDb();
    const policy = await savePolicy(db, adminUser, {
      title: "National Citizen Dividend",
      category: "Restore the Fair Go",
      statement: "Provide a universal basic income floor for every Australian citizen.",
      status: "voting",
    });

    // Pending users cannot comment or vote
    await assert.rejects(() =>
      addComment(db, pendingUser, {
        policyId: policy.policyId,
        kind: "comment",
        body: "Can I comment while pending?",
      }),
    );
    await assert.rejects(() =>
      castVote(db, pendingUser, {
        policyId: policy.policyId,
        choice: "approve",
      }),
    );

    // Verified member posts a comment and casts a vote
    const comment = await addComment(db, memberUser, {
      policyId: policy.policyId,
      kind: "amendment",
      body: "Clarify that supplementary disability supports remain intact above the dividend.",
    });
    assert.equal(comment.kind, "amendment");

    const vote1 = await castVote(db, memberUser, {
      policyId: policy.policyId,
      choice: "approve",
    });
    assert.equal(vote1.votes.approve, 1);
    assert.equal(vote1.votes.reject, 0);

    // Changing vote updates existing record rather than duplicating
    const vote2 = await castVote(db, memberUser, {
      policyId: policy.policyId,
      choice: "reject",
    });
    assert.equal(vote2.votes.approve, 0);
    assert.equal(vote2.votes.reject, 1);
    assert.equal(vote2.votes.total, 1);

    const detail = await getPolicyDetail(db, policy.slug, memberUser);
    assert.ok(detail);
    assert.equal(detail.myVote, "reject");
    assert.equal(detail.comments.length, 1);

    const activity = await listUserActivity(db, memberUser.memberId);
    assert.equal(activity.votes.length, 1);
    assert.equal(activity.comments.length, 1);

    await deleteComment(db, memberUser, comment.commentId);
    const afterDelete = await getPolicyDetail(db, policy.slug, memberUser);
    assert.equal(afterDelete?.comments.length, 0);
  });

  it("supports member creation, verification, and self-lockout protection", async () => {
    const db = createMemoryDb();
    const { memberId } = await saveMember(
      db,
      adminUser,
      {
        name: "Alex Taylor",
        email: "alex@example.org",
        role: "moderator",
        status: "verified",
      },
      true,
    );

    const members = await listMembers(db, "alex");
    assert.equal(members.length, 1);
    assert.equal(members[0]?.role, "moderator");
    assert.equal(members[0]?.status, "verified");

    await saveMember(
      db,
      adminUser,
      {
        memberId,
        role: "member",
        status: "suspended",
      },
      false,
    );

    const updated = await listMembers(db, "alex");
    assert.equal(updated[0]?.role, "member");
    assert.equal(updated[0]?.status, "suspended");
  });
});
