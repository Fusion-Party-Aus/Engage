import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDb, getDatabase } from "./db.ts";
import {
  addComment,
  castVote,
  deleteComment,
  deleteProposal,
  getProposalDetail,
  listMembers,
  listProposals,
  listUserActivity,
  saveMember,
  saveProposal,
  toggleUpvoteComment,
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

describe("Engage Decidim/Loomio Lifecycle & CRUD Store", () => {
  it("automatically seeds baseline proposals and filters across the 4 lifecycle stages", async () => {
    const db = await getDatabase({ APP_MODE: "development" });
    const all = await listProposals(db);
    assert.equal(all.length, 78);

    const deliberate = await listProposals(db, { stage: "deliberate" });
    assert.equal(deliberate.length, 40);

    const decide = await listProposals(db, { stage: "decide" });
    assert.equal(decide.length, 38);

    // Verify policy provenance was restored
    const pol1 = all.find((p) => p.proposalId === "POL-001");
    assert.ok(pol1?.provenance, "POL-001 must have provenance");
    assert.equal(pol1.provenance.category, "unverified");

    const pol10 = all.find((p) => p.proposalId === "POL-010");
    assert.ok(pol10?.provenance, "POL-010 must have provenance");
    assert.equal(pol10.provenance.category, "existing-repackaged");
    assert.ok(pol10.provenance.lineage && pol10.provenance.lineage.length > 0);
    assert.ok(pol10.provenance.valuesAlignment && pol10.provenance.valuesAlignment.length > 0);
  });

  it("supports verified members proposing ideas into Stage 1, while pending members are blocked", async () => {
    const db = createMemoryDb();

    // Block pending members
    await assert.rejects(
      () =>
        saveProposal(db, pendingUser, {
          title: "Unauthorized Proposal",
          space: "General",
          summary: "Should not be allowed by a pending member.",
        }),
      /verified before you can submit/,
    );

    // Allow verified members to submit
    const memberProposal = await saveProposal(db, memberUser, {
      title: "Direct Democracy Working Group Charter",
      space: "Party Governance",
      summary: "Charter to establish participatory decision making across all working groups.",
      outcomes: ["Open deliberation on motions", "Monthly voting rounds"],
      details: "Full details on delegate responsibilities and platform standards.",
    });

    assert.equal(memberProposal.stage, "propose");
    assert.equal(memberProposal.authorId, memberUser.memberId);
    assert.ok(memberProposal.proposalId.startsWith("PROP-"));

    // Staff can advance it to Deliberate or Decide, and add provenance
    const advanced = await saveProposal(db, adminUser, {
      proposalId: memberProposal.proposalId,
      stage: "deliberate",
      provenance: {
        category: "party-governance",
        label: "Party Governance Review",
        summary: "Internal working group charter review.",
        lineage: [
          { label: "Constitution Section 4", url: "/constitution", description: "Direct democracy principles" }
        ],
        valuesAlignment: ["Principle: Participatory Democracy"],
      },
    });
    assert.equal(advanced.stage, "deliberate");
    assert.ok(advanced.provenance);
    assert.equal(advanced.provenance.category, "party-governance");
    assert.equal(advanced.provenance.label, "Party Governance Review");
    assert.equal(advanced.provenance.lineage?.length, 1);
    assert.equal(advanced.provenance.lineage[0]?.label, "Constitution Section 4");
  });

  it("supports structured deliberation stances (support, concern, amendment, comment) and endorsements", async () => {
    const db = createMemoryDb();
    const proposal = await saveProposal(db, adminUser, {
      title: "Universal Dental Care in Medicare",
      space: "Healthcare",
      summary: "Incorporate essential preventive and emergency dental procedures into Medicare.",
      stage: "deliberate",
    });

    // Deliberation stances
    const contribution1 = await addComment(db, memberUser, {
      proposalId: proposal.proposalId,
      stance: "amendment",
      body: "Specify a phased rollout beginning with concession card holders and young Australians.",
    });
    assert.equal(contribution1.stance, "amendment");

    const contribution2 = await addComment(db, adminUser, {
      proposalId: proposal.proposalId,
      stance: "support",
      body: "Fully funded under the Parliamentary Budget Office costing.",
    });
    assert.equal(contribution2.stance, "support");

    // Endorsements (+1 upvotes)
    const endorseResult = await toggleUpvoteComment(db, memberUser, contribution2.commentId);
    assert.equal(endorseResult.hasUpvoted, true);
    assert.equal(endorseResult.upvotes.length, 1);

    // Detail check
    const detail = await getProposalDetail(db, proposal.slug, memberUser);
    assert.ok(detail);
    assert.equal(detail.comments.length, 2);

    // Deleting a comment
    await deleteComment(db, memberUser, contribution1.commentId);
    const detailAfterDelete = await getProposalDetail(db, proposal.slug, memberUser);
    assert.equal(detailAfterDelete?.comments.length, 1);
  });

  it("supports decision voting (approve, abstain, reject) with reasons and tracks implementation", async () => {
    const db = createMemoryDb();
    const decision = await saveProposal(db, adminUser, {
      title: "Adopt Horizon Visual Identity",
      space: "Branding & Platform",
      summary: "Adopt the modern Horizon design tokens and colourway across all official digital assets.",
      stage: "decide",
    });

    // Cast vote with reason
    const voteResult = await castVote(db, memberUser, {
      proposalId: decision.proposalId,
      choice: "approve",
      reason: "High contrast and legible on modern displays.",
    });
    assert.equal(voteResult.choice, "approve");
    assert.equal(voteResult.votes.approve, 1);
    assert.equal(voteResult.votes.abstain, 0);
    assert.equal(voteResult.votes.reject, 0);

    // Member activity reflects vote and reason
    const activity = await listUserActivity(db, memberUser.memberId);
    assert.equal(activity.votes.length, 1);
    assert.equal(activity.votes[0]?.choice, "approve");
    assert.equal(activity.votes[0]?.reason, "High contrast and legible on modern displays.");

    // Advance to Stage 4: Implement with officer tracking note
    const implemented = await saveProposal(db, adminUser, {
      proposalId: decision.proposalId,
      stage: "implement",
      implementationNote: "Design pack exported to /public assets and merged to production repository.",
    });
    assert.equal(implemented.stage, "implement");
    assert.ok(implemented.implementationNote?.includes("Design pack"));

    // Cleanup test
    await deleteProposal(db, adminUser, decision.proposalId);
    const detail = await getProposalDetail(db, decision.proposalId, adminUser);
    assert.equal(detail, null);
  });

  it("supports member administration, role assignment, and self-lockout protection", async () => {
    const db = createMemoryDb();
    const { ObjectId } = await import("mongodb");
    await db.collection("user").insertOne({
      _id: new ObjectId(adminUser.memberId),
      name: adminUser.name,
      email: adminUser.email,
    });

    const { memberId: _memberId } = await saveMember(
      db,
      adminUser,
      {
        name: "Jordan Lee",
        email: "jordan@example.org",
        role: "moderator",
        status: "verified",
      },
      true,
    );

    const members = await listMembers(db, "jordan");
    assert.equal(members.length, 1);
    assert.equal(members[0]?.role, "moderator");
    assert.equal(members[0]?.status, "verified");

    // Self-lockout protection
    await assert.rejects(
      () =>
        saveMember(
          db,
          adminUser,
          {
            memberId: adminUser.memberId,
            role: "member",
          },
          false,
        ),
      /cannot remove your own administrator access/,
    );
  });
});
