import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDb, getDatabase } from "./db.ts";
import {
  addComment,
  castVote,
  deleteComment,
  deleteProposal,
  getDefaultProvenanceLabel,
  getProposalDetail,
  listMembers,
  listProposals,
  listUserActivity,
  normalizeKind,
  saveMember,
  saveProposal,
  toggleUpvoteComment,
} from "./store.ts";
import type { SessionUser } from "./types.ts";
import { PATCH } from "../pages/api/proposals/[proposalId].ts";

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

  it("preserves baseline policy provenance, general resolutions, and attachment descriptions", async () => {
    const db = await getDatabase({ APP_MODE: "development" });
    const all = await listProposals(db);

    // Verify policy records
    const pol1 = all.find((p) => p.proposalId === "POL-001");
    assert.ok(pol1);
    assert.equal(pol1.kind, "policy");
    assert.ok(pol1.provenance);

    // Verify governance resolutions
    const gov1 = all.find((p) => p.proposalId === "GOV-001");
    assert.ok(gov1);
    assert.equal(gov1.kind, "resolution");
    assert.equal(gov1.provenance?.category, "party-governance");

    const gov2 = all.find((p) => p.proposalId === "GOV-002");
    assert.ok(gov2);
    assert.equal(gov2.kind, "resolution");
    assert.equal(gov2.attachmentUrl, "/fusion_horizon_logo_light.svg");
    assert.ok(
      gov2.attachmentDescription?.includes("Official Horizon identity emblem"),
      "GOV-002 must have its specific attachment description",
    );
  });

  it("distinguishes policy proposals and general resolutions with appropriate labels and helpers", () => {
    assert.equal(normalizeKind("resolution"), "resolution");
    assert.equal(normalizeKind("policy"), "policy");
    assert.equal(normalizeKind(undefined, "GOV-001"), "resolution");
    assert.equal(normalizeKind(undefined, "POL-001"), "policy");

    // Resolution provenance labels
    assert.equal(
      getDefaultProvenanceLabel("existing-repackaged", "resolution"),
      "Preceding resolution · Equivalence unverified",
    );
    assert.equal(
      getDefaultProvenanceLabel("materially-revised", "resolution"),
      "Preceding resolution · Materially revised",
    );
    assert.equal(
      getDefaultProvenanceLabel("new-proposal", "resolution"),
      "New resolution · No prior authority identified",
    );

    // Policy provenance labels
    assert.equal(
      getDefaultProvenanceLabel("existing-repackaged", "policy"),
      "Approved policy predecessor · Equivalence unverified",
    );
    assert.equal(
      getDefaultProvenanceLabel("materially-revised", "policy"),
      "Approved policy predecessor · Materially revised",
    );
    assert.equal(
      getDefaultProvenanceLabel("new-proposal", "policy"),
      "New proposal · No prior policy identified",
    );
  });

  it("persists, modifies, and clears admin provenance metadata", async () => {
    const db = createMemoryDb();
    const proposal = await saveProposal(db, adminUser, {
      title: "Integrity Commission Oversight Motion",
      space: "Governance",
      summary: "Motion to expand public hearings for federal inquiries.",
      stage: "deliberate",
    });

    // Add full provenance
    const withProv = await saveProposal(db, adminUser, {
      proposalId: proposal.proposalId,
      provenance: {
        category: "materially-revised",
        label: "Direct Predecessor · Revised",
        summary: "Updated based on parliamentary review recommendations.",
        uncertaintyNote: "Reporting threshold numbers are still undergoing drafting.",
        lineage: [
          {
            label: "NACC Standard 2026",
            url: "https://example.org/nacc",
            description: "Substantive predecessor clause 4",
          },
        ],
        valuesAlignment: ["Principle: Open Governance"],
      },
    });

    assert.ok(withProv.provenance);
    assert.equal(withProv.provenance.category, "materially-revised");
    assert.equal(withProv.provenance.label, "Direct Predecessor · Revised");
    assert.equal(withProv.provenance.lineage?.length, 1);
    assert.equal(withProv.provenance.lineage[0]?.url, "https://example.org/nacc");
    assert.equal(withProv.provenance.uncertaintyNote, "Reporting threshold numbers are still undergoing drafting.");

    // Retrieve and verify
    const fetched = await getProposalDetail(db, proposal.proposalId, adminUser);
    assert.equal(fetched?.proposal.provenance?.label, "Direct Predecessor · Revised");

    // Clear provenance
    const cleared = await saveProposal(db, adminUser, {
      proposalId: proposal.proposalId,
      provenance: null,
    });
    assert.equal(cleared.provenance, undefined);
  });

  it("allows substantive changes before voting begins in propose and deliberate stages", async () => {
    const db = createMemoryDb();
    const proposal = await saveProposal(db, adminUser, {
      title: "Draft Motion on Transit Expansion",
      space: "Infrastructure",
      summary: "Initial draft summary outlining high-speed rail corridors.",
      outcomes: ["Corridor study by Q3"],
      details: "Full background and initial route options.",
      stage: "deliberate",
    });

    // Substantive modifications while in deliberate with 0 votes
    const modified = await saveProposal(db, adminUser, {
      proposalId: proposal.proposalId,
      title: "National High-Speed Rail Corridor Investment",
      summary: "Substantively refined summary committing Commonwealth funding.",
      outcomes: ["Phase 1 Sydney-Melbourne corridor", "Statutory corridor protection"],
      details: "Updated rationale incorporating state transit authority submissions.",
      attachmentUrl: "/rail_corridor_map.svg",
      attachmentDescription: "Map of proposed eastern seaboard high-speed alignment.",
    });

    assert.equal(modified.title, "National High-Speed Rail Corridor Investment");
    assert.equal(modified.outcomes.length, 2);
    assert.equal(modified.attachmentUrl, "/rail_corridor_map.svg");
    assert.equal(modified.attachmentDescription, "Map of proposed eastern seaboard high-speed alignment.");
  });

  it("strictly locks substantive content once voting begins while permitting non-substantive administrative updates", async () => {
    const db = createMemoryDb();
    const ballot = await saveProposal(db, adminUser, {
      title: "Constitutional Reform on Fixed Terms",
      space: "Governance",
      summary: "Proposal to establish 4-year fixed terms for the federal parliament.",
      outcomes: ["Four-year fixed terms", "Synchronised Senate elections"],
      details: "Comparative electoral analysis and constitutional amendment mechanism.",
      attachmentUrl: "/referendum_wording.pdf",
      attachmentDescription: "Draft constitutional amendment questions.",
      stage: "deliberate",
    });

    // Advance to Decide (voting begins)
    await saveProposal(db, adminUser, {
      proposalId: ballot.proposalId,
      stage: "decide",
    });

    // Attempting substantive modifications while in Decide (even before votes) must be rejected
    await assert.rejects(
      () =>
        saveProposal(db, adminUser, {
          proposalId: ballot.proposalId,
          title: "Subtly Altered Title For Voting",
        }),
      /Cannot modify substantive proposal content \(title\)/,
    );

    await assert.rejects(
      () =>
        saveProposal(db, adminUser, {
          proposalId: ballot.proposalId,
          summary: "Materially altered proposition statement for voters.",
        }),
      /Cannot modify substantive proposal content \(summary\)/,
    );

    await assert.rejects(
      () =>
        saveProposal(db, adminUser, {
          proposalId: ballot.proposalId,
          outcomes: ["Altered outcome"],
        }),
      /Cannot modify substantive proposal content \(outcomes\)/,
    );

    await assert.rejects(
      () =>
        saveProposal(db, adminUser, {
          proposalId: ballot.proposalId,
          attachmentUrl: "/different_wording.pdf",
        }),
      /Cannot modify substantive proposal content \(attachmentUrl\)/,
    );

    // Non-substantive updates (space, provenance, implementation note) MUST succeed
    const adminUpdate = await saveProposal(db, adminUser, {
      proposalId: ballot.proposalId,
      space: "Electoral Reform",
      implementationNote: "Ballot open until Sunday midnight.",
    });
    assert.equal(adminUpdate.space, "Electoral Reform");
    assert.equal(adminUpdate.implementationNote, "Ballot open until Sunday midnight.");

    // Cast a member vote
    await castVote(db, memberUser, {
      proposalId: ballot.proposalId,
      choice: "approve",
      reason: "Predictability and stability in legislative cycles.",
    });

    // Now advance to Stage 4: Implement
    await saveProposal(db, adminUser, {
      proposalId: ballot.proposalId,
      stage: "implement",
      implementationNote: "Adopted by membership vote. Referral to platform committee.",
    });

    // Substantive modifications must remain locked in Stage 4 because votes exist
    await assert.rejects(
      () =>
        saveProposal(db, adminUser, {
          proposalId: ballot.proposalId,
          details: "Quietly rewritten details after adoption.",
        }),
      /Cannot modify substantive proposal content \(details\) because voting has already begun/,
    );
  });

  it("preserves existing votes and member data across lifecycle stage transitions", async () => {
    const db = createMemoryDb();
    const proposal = await saveProposal(db, adminUser, {
      title: "Renewable Energy Transition Target",
      space: "Climate & Energy",
      summary: "Legislate 90% renewable electricity by 2035 with national storage target.",
      stage: "deliberate",
    });

    // Move to Decide and cast votes
    await saveProposal(db, adminUser, { proposalId: proposal.proposalId, stage: "decide" });
    await castVote(db, memberUser, {
      proposalId: proposal.proposalId,
      choice: "approve",
      reason: "Critical for emissions trajectory.",
    });

    let detail = await getProposalDetail(db, proposal.proposalId, memberUser);
    assert.equal(detail?.proposal.votes.total, 1);
    assert.equal(detail?.proposal.votes.approve, 1);
    assert.equal(detail?.myVote, "approve");

    // Move to Implement
    await saveProposal(db, adminUser, {
      proposalId: proposal.proposalId,
      stage: "implement",
      implementationNote: "Formally endorsed as party policy.",
    });

    detail = await getProposalDetail(db, proposal.proposalId, memberUser);
    assert.equal(detail?.proposal.stage, "implement");
    assert.equal(detail?.proposal.votes.total, 1);
    assert.equal(detail?.proposal.votes.approve, 1);

    // Pause/move back to deliberate for additional review
    await saveProposal(db, adminUser, {
      proposalId: proposal.proposalId,
      stage: "deliberate",
    });

    detail = await getProposalDetail(db, proposal.proposalId, memberUser);
    assert.equal(detail?.proposal.stage, "deliberate");
    assert.equal(detail?.proposal.votes.total, 1, "Votes must be preserved when moving back to deliberate");

    // Voting is blocked while in deliberate
    await assert.rejects(
      () =>
        castVote(db, memberUser, {
          proposalId: proposal.proposalId,
          choice: "reject",
        }),
      /not currently in the Decide stage/,
    );

    // Member activity reflects the preserved vote
    const activity = await listUserActivity(db, memberUser.memberId);
    assert.equal(activity.votes.length, 1);
    assert.equal(activity.votes[0]?.choice, "approve");
  });

  it("validates lifecycle stages and blocks invalid stage transitions", async () => {
    const db = createMemoryDb();
    const proposal = await saveProposal(db, adminUser, {
      title: "Draft Strategy on Regional Connectivity",
      space: "Communications",
      summary: "Draft proposal proposing universal regional fibre and low-orbit satellite backhaul.",
      stage: "propose",
    });

    // Invalid stage name
    await assert.rejects(
      () =>
        saveProposal(db, adminUser, {
          proposalId: proposal.proposalId,
          stage: "banana" as any,
        }),
      /Invalid lifecycle stage: 'banana'/,
    );

    // Bypassing deliberation directly to decide
    await assert.rejects(
      () =>
        saveProposal(db, adminUser, {
          proposalId: proposal.proposalId,
          stage: "decide",
        }),
      /must undergo member deliberation before entering Decide/,
    );

    // Bypassing deliberation and voting directly to implement
    await assert.rejects(
      () =>
        saveProposal(db, adminUser, {
          proposalId: proposal.proposalId,
          stage: "implement",
        }),
      /must undergo member deliberation before entering Decide or Implement/,
    );

    // Advance to deliberate
    await saveProposal(db, adminUser, {
      proposalId: proposal.proposalId,
      stage: "deliberate",
    });

    // Skipping decide to jump straight from deliberate to implement
    await assert.rejects(
      () =>
        saveProposal(db, adminUser, {
          proposalId: proposal.proposalId,
          stage: "implement",
        }),
      /must be voted on in the Decide stage before entering Implement/,
    );
  });

  it("surfaces server errors through API route when ballot is locked or transition is invalid", async () => {
    // Unauthenticated request
    const unauthReq = new Request("http://localhost:4321/api/proposals/POL-001", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: "decide" }),
    });
    const unauthRes = await PATCH({
      params: { proposalId: "POL-001" },
      request: unauthReq,
      locals: {},
    } as any);
    assert.equal(unauthRes.status, 401);

    // Staff attempting invalid stage transition on POL-001 (POL-001 is in deliberate in baseline)
    const invalidTransReq = new Request("http://localhost:4321/api/proposals/POL-001", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: "engage_dev_user=administrator",
      },
      body: JSON.stringify({ stage: "implement" }), // Jumping straight from deliberate to implement
    });
    const invalidTransRes = await PATCH({
      params: { proposalId: "POL-001" },
      request: invalidTransReq,
      locals: {},
    } as any);
    assert.equal(invalidTransRes.status, 400);
    const errPayload = await invalidTransRes.json();
    assert.ok(errPayload.error.includes("must be voted on in the Decide stage"));

    // Staff attempting substantive change on POL-010 (POL-010 is in decide / voting stage in baseline)
    const lockedReq = new Request("http://localhost:4321/api/proposals/POL-010", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: "engage_dev_user=administrator",
      },
      body: JSON.stringify({ title: "Illegitimately Modified Title After Voting" }),
    });
    const lockedRes = await PATCH({
      params: { proposalId: "POL-010" },
      request: lockedReq,
      locals: {},
    } as any);
    assert.equal(lockedRes.status, 400);
    const lockedPayload = await lockedRes.json();
    assert.ok(lockedPayload.error.includes("Cannot modify substantive proposal content"));
  });
});
