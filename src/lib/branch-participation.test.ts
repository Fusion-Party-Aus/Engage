import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "mongodb";
import { createMemoryDb } from "./db.ts";
import {
  BRANCH_MEMBERSHIPS,
  BRANCH_SUBSCRIPTIONS,
  applyExternalMembership,
  ensureNationalBranchAssignment,
  getMemberBranchProfile,
  getProposalEligibility,
  isFollowingBranch,
  listBranchPeople,
  migrateBranchParticipation,
  revokeBranchMember,
  saveBranchFollowing,
  setBranchFollowing,
  verifyBranchMember,
} from "./branch-participation.ts";
import { castVote, listOutstandingDecisions, listProposals, saveProposal } from "./store.ts";
import { PROPOSAL_VOTES } from "./vote-storage.ts";
import type { SessionUser } from "./types.ts";

const national: SessionUser = {
  memberId: "national-admin",
  name: "National Admin",
  email: "national@example.org",
  role: "administrator",
  status: "verified",
  canParticipate: true,
  isStaff: true,
  isAdmin: true,
};

function branchAdmin(branchId: string): SessionUser {
  return {
    memberId: `admin-${branchId}`,
    name: "Branch Admin",
    email: `admin-${branchId}@example.org`,
    role: "member",
    status: "verified",
    canParticipate: true,
    isStaff: false,
    isAdmin: false,
    isBranchAdmin: true,
    branchAdminIds: [branchId],
  };
}

function verifiedMember(memberId = "member-1"): SessionUser {
  return {
    memberId,
    name: "Verified Member",
    email: `${memberId}@example.org`,
    role: "member",
    status: "verified",
    canParticipate: true,
    isStaff: false,
    isAdmin: false,
  };
}

async function seededDb(): Promise<Db> {
  const db = createMemoryDb();
  await db.collection("branches").insertOne({
    branchId: "nat",
    name: "Fusion National",
    kind: "national",
    recognised: true,
  });
  await db.collection("branches").insertOne({
    branchId: "vic",
    name: "Fusion Victoria",
    kind: "state",
    parentBranchId: "nat",
    recognised: true,
  });
  await db.collection("branches").insertOne({
    branchId: "tas",
    name: "Fusion Tasmania",
    kind: "state",
    parentBranchId: "nat",
    recognised: true,
  });
  await db.collection("branches").insertOne({
    branchId: "vic-local",
    name: "Fusion Melbourne",
    kind: "constituent",
    parentBranchId: "vic",
    recognised: true,
  });
  return db;
}

async function verifiedPlatformMember(db: Db, memberId: string) {
  await db.collection("memberships").insertOne({ memberId, status: "verified" });
  await db.collection("user").insertOne({
    _id: memberId as any,
    name: `Person ${memberId}`,
    email: `${memberId}@example.org`,
    emailVerified: true,
  });
  return verifiedMember(memberId);
}

describe("branch participation: following and verified membership", () => {
  it("includes Fusion National by default and never lets branch preferences remove it", async () => {
    const db = await seededDb();
    const profile = await getMemberBranchProfile(db, "new-member");
    assert.equal(profile.national.name, "Fusion National");
    assert.equal(profile.national.included, true);
    assert.equal(profile.hasSelection, false);

    await saveBranchFollowing(db, "new-member", []);
    const after = await getMemberBranchProfile(db, "new-member");
    assert.equal(after.national.included, true);
    assert.equal(after.following.length, 0);

    await assert.rejects(
      setBranchFollowing(db, "new-member", "nat", false),
      /included for every Engage account/,
    );
  });

  it("follows and unfollows idempotently, including duplicate concurrent requests", async () => {
    const db = await seededDb();
    await Promise.all(
      Array.from({ length: 6 }, () => setBranchFollowing(db, "member-1", "vic", true)),
    );
    const rows = await db
      .collection(BRANCH_SUBSCRIPTIONS)
      .find({ memberId: "member-1", branchId: "vic" })
      .toArray();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, "following");
    assert.equal(await isFollowingBranch(db, "member-1", "vic"), true);

    await Promise.all([
      setBranchFollowing(db, "member-1", "vic", false),
      setBranchFollowing(db, "member-1", "vic", false),
    ]);
    const after = await db
      .collection(BRANCH_SUBSCRIPTIONS)
      .findOne({ memberId: "member-1", branchId: "vic" });
    assert.equal(after?.status, "unfollowed");
    assert.equal(await isFollowingBranch(db, "member-1", "vic"), false);
  });

  it("keeps following and verified membership separate when a member stops following", async () => {
    const db = await seededDb();
    const user = verifiedMember();
    await db.collection(BRANCH_MEMBERSHIPS).insertOne({
      branchId: "vic",
      memberId: user.memberId,
      status: "active",
      branchRole: "member",
      source: "engage-local",
    });
    await setBranchFollowing(db, user.memberId, "vic", true);
    await setBranchFollowing(db, user.memberId, "vic", false);

    const profile = await getMemberBranchProfile(db, user.memberId);
    assert.equal(profile.verified.length, 1);
    assert.equal(profile.following.length, 0);
    assert.equal(
      profile.connected.some((branch) => branch.branchId === "vic"),
      true,
      "a verified member remains connected even after unfollowing",
    );

    const proposal = {
      proposalId: "p-vic",
      jurisdictionBranchId: "vic",
    };
    const eligibility = await getProposalEligibility(db, proposal, user);
    assert.equal(eligibility.eligible, true);
    assert.equal(eligibility.level, "eligible");
  });

  it("lets a follower discover branch activity but never vote", async () => {
    const db = await seededDb();
    const user = { ...verifiedMember(), activeBranchIds: ["vic"] };
    await setBranchFollowing(db, user.memberId, "vic", true);
    const proposal = {
      proposalId: "p-vic",
      jurisdictionBranchId: "vic",
    };
    const eligibility = await getProposalEligibility(db, proposal, user);
    assert.equal(eligibility.eligible, false);
    assert.equal(eligibility.level, "follower");
    assert.match(eligibility.reason, /following does not grant formal voting rights/);

    await db.collection("proposals").insertOne({
      proposalId: "p-vic",
      slug: "p-vic",
      title: "Victoria test",
      space: "Governance",
      summary: "Summary with enough words.",
      details: "Details",
      stage: "decide",
      ballotClosesAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
      jurisdictionBranchId: "vic",
      governanceAuthorityBranchId: "vic",
      publicationScope: "branch",
      ballotRevisionId: "rev-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection("proposal_revisions").insertOne({
      revisionId: "rev-1",
      proposalId: "p-vic",
      snapshot: { title: "Victoria test", summary: "Summary", outcomes: [], details: "Details" },
      contentHash: "hash",
      createdAt: new Date(),
    });
    await assert.rejects(
      castVote(db, user, { proposalId: "p-vic", choice: "approve" }),
      /following does not grant formal voting rights/,
    );
  });

  it("treats national jurisdiction as default governance for verified Engage accounts", async () => {
    const db = await seededDb();
    const user = verifiedMember();
    const eligibility = await getProposalEligibility(
      db,
      { jurisdictionBranchId: "nat" },
      user,
    );
    assert.equal(eligibility.eligible, true);
    assert.match(eligibility.reason, /national governance/i);
    assert.equal(
      await db
        .collection(BRANCH_MEMBERSHIPS)
        .countDocuments({ memberId: user.memberId, branchId: "nat" }),
      0,
      "national access must not create a verified branch membership fact",
    );

    await db.collection("proposals").insertOne({
      proposalId: "national-ballot",
      slug: "national-ballot",
      title: "National ballot",
      space: "Governance",
      summary: "A national ballot for verified members.",
      details: "Details",
      stage: "decide",
      ballotClosesAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
      jurisdictionBranchId: "nat",
      governanceAuthorityBranchId: "nat",
      publicationScope: "national",
      ballotRevisionId: "rev-national",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const outstanding = await listOutstandingDecisions(
      db,
      user.memberId,
      user,
    );
    const reused = await listOutstandingDecisions(db, user.memberId, user, await listProposals(db, { user }));
    assert.deepEqual(reused.map((item) => item.proposalId), outstanding.map((item) => item.proposalId), 'reusing discovery data preserves electorate filtering');
    assert.equal(
      outstanding.some((item) => item.proposalId === "national-ballot"),
      true,
      "national ballots use the same default national eligibility rule",
    );
  });

  it("silently records national scope for existing members without creating membership", async () => {
    const db = await seededDb();
    const assigned = await ensureNationalBranchAssignment(db, "existing-member");
    assert.equal(assigned, true);
    assert.equal(
      await db
        .collection(BRANCH_SUBSCRIPTIONS)
        .countDocuments({ memberId: "existing-member", branchId: "nat" }),
      1,
    );
    assert.equal(
      await db
        .collection(BRANCH_MEMBERSHIPS)
        .countDocuments({ memberId: "existing-member" }),
      0,
    );
    assert.equal(
      await ensureNationalBranchAssignment(db, "existing-member"),
      false,
      "the assignment is idempotent",
    );
  });
});

describe("branch participation: verification authority and source integrity", () => {
  it("allows a branch administrator to verify only inside their own branch", async () => {
    const db = await seededDb();
    await verifiedPlatformMember(db, "person-1");
    await setBranchFollowing(db, "person-1", "vic", true);
    const vicAdmin = branchAdmin("vic");

    await assert.rejects(
      verifyBranchMember(db, vicAdmin, { branchId: "tas", memberId: "person-1" }),
      /not authorised to manage membership/,
    );
    await assert.rejects(
      verifyBranchMember(db, verifiedMember("person-1"), {
        branchId: "vic",
        memberId: "person-1",
      }),
      /not authorised to manage membership/,
      "a follower cannot grant themselves membership",
    );

    const record = await verifyBranchMember(db, vicAdmin, {
      branchId: "vic",
      memberId: "person-1",
      reason: "Matched the branch roll.",
    });
    assert.equal(record.status, "active");
    assert.equal(record.source, "engage-local");
    assert.equal(record.verifiedBy, vicAdmin.memberId);
    assert.equal(
      await db
        .collection("branch_membership_events")
        .countDocuments({ memberId: "person-1", branchId: "vic", action: "assigned" }),
      1,
    );
    assert.equal(
      await db
        .collection(BRANCH_SUBSCRIPTIONS)
        .countDocuments({ memberId: "person-1", branchId: "vic", status: "following" }),
      1,
      "verification never removes the person's own subscription",
    );
  });

  it("requires a reason to revoke and preserves historical votes", async () => {
    const db = await seededDb();
    const user = {
      ...(await verifiedPlatformMember(db, "person-2")),
      activeBranchIds: ["vic"],
    };
    await db.collection(BRANCH_MEMBERSHIPS).insertOne({
      branchId: "vic",
      memberId: user.memberId,
      status: "active",
      source: "engage-local",
      version: 1,
    });
    const admin = branchAdmin("vic");
    await assert.rejects(
      revokeBranchMember(db, admin, { branchId: "vic", memberId: user.memberId, reason: "" }),
      /short reason/,
    );

    const proposal = await saveProposal(db, national, {
      title: "Victoria ballot",
      space: "Governance",
      summary: "A member ballot with a frozen revision.",
      stage: "decide",
      ballotClosesAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
      jurisdictionBranchId: "vic",
      governanceAuthorityBranchId: "vic",
      publicationScope: "branch",
    });
    const vote = await castVote(db, user, {
      proposalId: proposal.proposalId,
      choice: "approve",
    });
    assert.equal(vote.choice, "approve");

    await revokeBranchMember(db, admin, {
      branchId: "vic",
      memberId: user.memberId,
      reason: "Membership ended.",
    });
    const membership = await db
      .collection(BRANCH_MEMBERSHIPS)
      .findOne({ branchId: "vic", memberId: user.memberId });
    assert.equal(membership?.status, "revoked");
    assert.equal(membership?.revocationReason, "Membership ended.");
    assert.equal(
      await db.collection(PROPOSAL_VOTES).countDocuments({ memberId: user.memberId }),
      1,
      "recorded votes remain and are never silently removed",
    );
    assert.equal(
      (await db.collection("proposals").findOne({ proposalId: proposal.proposalId }))
        ?.ballotRevisionId,
      proposal.ballotRevisionId,
    );
  });

  it("does not let a local administrator silently override external membership", async () => {
    const db = await seededDb();
    await verifiedPlatformMember(db, "person-3");
    await setBranchFollowing(db, "person-3", "vic", true);
    await applyExternalMembership(db, {
      memberId: "person-3",
      branchId: "vic",
      status: "active",
      branchRole: "member",
      externalId: "crm-1",
    });
    assert.equal(
      await db
        .collection(BRANCH_SUBSCRIPTIONS)
        .countDocuments({ memberId: "person-3", branchId: "vic", status: "following" }),
      1,
      "external membership must not overwrite the personal subscription",
    );
    await assert.rejects(
      verifyBranchMember(db, branchAdmin("vic"), {
        branchId: "vic",
        memberId: "person-3",
      }),
      /managed by the party's membership system/,
    );
    await assert.rejects(
      revokeBranchMember(db, branchAdmin("vic"), {
        branchId: "vic",
        memberId: "person-3",
        reason: "Local removal attempt.",
      }),
      /managed by the party's membership system/,
    );

    await applyExternalMembership(db, {
      memberId: "person-3",
      branchId: "vic",
      status: "revoked",
      reason: "CRM membership ended.",
    });
    assert.equal(
      await db
        .collection(BRANCH_SUBSCRIPTIONS)
        .countDocuments({ memberId: "person-3", branchId: "vic", status: "following" }),
      1,
    );
  });

  it("lists followers and verified members together for administration", async () => {
    const db = await seededDb();
    await verifiedPlatformMember(db, "person-4");
    await setBranchFollowing(db, "person-4", "vic", true);
    await db.collection(BRANCH_MEMBERSHIPS).insertOne({
      branchId: "vic",
      memberId: "person-4",
      status: "active",
      branchRole: "member",
      source: "engage-local",
      verifiedAt: new Date(),
    });
    const rows = await listBranchPeople(db, ["vic"]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.following, true);
    assert.equal(rows[0]?.verified, true);
    const filtered = await listBranchPeople(db, ["vic"], "person-4");
    assert.equal(filtered.length, 1);
    const none = await listBranchPeople(db, ["vic"], "nobody");
    assert.equal(none.length, 0);
  });
});

describe("branch participation: migration and new proposal defaults", () => {
  it("preserves verified facts, adds subscriptions idempotently and assigns national scope", async () => {
    const db = await seededDb();
    await db.collection(BRANCH_MEMBERSHIPS).insertOne({
      branchId: "vic",
      memberId: "legacy-member",
      status: "active",
      branchRole: "member",
      assignedAt: new Date("2024-01-02T00:00:00Z"),
    });
    await db.collection("proposals").insertOne({
      proposalId: "open-national",
      stage: "deliberate",
      title: "Open proposal",
      slug: "open-national",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection("proposals").insertOne({
      proposalId: "open-vic",
      stage: "deliberate",
      title: "Branch proposal",
      slug: "open-vic",
      originatingBranchId: "vic",
      governanceAuthorityBranchId: "vic",
      jurisdictionBranchId: "vic",
      publicationScope: "branch",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection("proposals").insertOne({
      proposalId: "archived-national",
      stage: "archived",
      title: "Old decision",
      slug: "archived-national",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const dryRun = await migrateBranchParticipation(db, { apply: false });
    assert.equal(dryRun.annotatedMemberships, 1);
    assert.equal(dryRun.createdSubscriptions, 1);
    assert.equal(dryRun.assignedProposals, 1);
    assert.equal(
      await db.collection(BRANCH_SUBSCRIPTIONS).countDocuments({ memberId: "legacy-member" }),
      0,
      "a dry run performs no writes",
    );

    const first = await migrateBranchParticipation(db);
    assert.equal(first.annotatedMemberships, 1);
    assert.equal(first.createdSubscriptions, 1);
    assert.equal(first.assignedProposals, 1);

    const legacy = await db
      .collection(BRANCH_MEMBERSHIPS)
      .findOne({ branchId: "vic", memberId: "legacy-member" });
    assert.equal(legacy?.status, "active", "verification meaning is preserved");
    assert.equal(legacy?.branchRole, "member");
    assert.equal(legacy?.source, "engage-legacy");
    assert.equal(legacy?.verification.method, "legacy-record");
    assert.equal(
      await db
        .collection(BRANCH_SUBSCRIPTIONS)
        .countDocuments({ memberId: "legacy-member", branchId: "vic" }),
      1,
    );

    const nationalProposal = await db
      .collection("proposals")
      .findOne({ proposalId: "open-national" });
    assert.equal(nationalProposal?.governanceAuthorityBranchId, "nat");
    assert.equal(nationalProposal?.jurisdictionBranchId, "nat");
    assert.equal(nationalProposal?.publicationScope, "national");

    const branchProposal = await db
      .collection("proposals")
      .findOne({ proposalId: "open-vic" });
    assert.equal(branchProposal?.jurisdictionBranchId, "vic");
    const archived = await db
      .collection("proposals")
      .findOne({ proposalId: "archived-national" });
    assert.equal(archived?.jurisdictionBranchId, undefined);

    const second = await migrateBranchParticipation(db);
    assert.equal(second.annotatedMemberships, 0);
    assert.equal(second.createdSubscriptions, 0);
    assert.equal(second.assignedProposals, 0);
    assert.equal(
      await db
        .collection(BRANCH_SUBSCRIPTIONS)
        .countDocuments({ memberId: "legacy-member", branchId: "vic" }),
      1,
      "re-running never duplicates a subscription",
    );
  });

  it("lets a branch proposal open straight away while ordinary ideas default to national", async () => {
    const db = await seededDb();
    const branch = branchAdmin("vic");
    const branchProposal = await saveProposal(db, branch, {
      title: "Local transport idea",
      space: "Transport",
      summary: "A local proposal summary with enough detail.",
      originatingBranchId: "vic",
    });
    assert.equal(branchProposal.governanceAuthorityBranchId, "vic");
    assert.equal(branchProposal.jurisdictionBranchId, "vic");
    assert.equal(branchProposal.publicationScope, "branch");
    // D3 fixture: this test is about branch scope, not seconding.
    await db
      .collection("proposals")
      .updateOne(
        { proposalId: branchProposal.proposalId },
        { $set: { secondedAt: new Date() } },
      );
    await saveProposal(db, branch, {
      proposalId: branchProposal.proposalId,
      stage: "deliberate",
    });
    const ballot = await saveProposal(db, branch, {
      proposalId: branchProposal.proposalId,
      stage: "decide",
      ballotClosesAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    });
    assert.equal(ballot.stage, "decide");
    assert.ok(ballot.ballotRevisionId);

    const idea = await saveProposal(db, verifiedMember("ordinary-member"), {
      title: "National idea",
      space: "Governance",
      summary: "A national proposal summary with enough detail.",
    });
    assert.equal(idea.originatingBranchId, "nat");
    assert.equal(idea.governanceAuthorityBranchId, "nat");
    assert.equal(idea.jurisdictionBranchId, "nat");
    assert.equal(idea.publicationScope, "national");
  });

  it("does not inherit verified membership from a parent branch", async () => {
    const db = await seededDb();
    const user = verifiedMember();
    await db.collection(BRANCH_MEMBERSHIPS).insertOne({
      branchId: "vic",
      memberId: user.memberId,
      status: "active",
      source: "engage-local",
    });
    const childEligibility = await getProposalEligibility(
      db,
      { jurisdictionBranchId: "vic-local" },
      user,
    );
    assert.equal(childEligibility.eligible, false);
    assert.equal(childEligibility.level, "not-connected");

    await setBranchFollowing(db, user.memberId, "vic-local", true);
    const follower = await getProposalEligibility(
      db,
      { jurisdictionBranchId: "vic-local" },
      user,
    );
    assert.equal(follower.eligible, false);
    assert.equal(follower.level, "follower");
  });
});
