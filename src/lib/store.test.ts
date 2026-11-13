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
  listOutstandingDecisions,
  listProposals,
  listUserActivity,
  normalizeKind,
  promotePendingVotePreferences,
  saveMember,
  savePendingVotePreference,
  saveProposal,
  toggleUpvoteComment,
} from "./store.ts";
import type { SessionUser } from "./types.ts";
import { PATCH } from "../pages/api/proposals/[proposalId].ts";
import { PROPOSAL_VOTES } from "./vote-storage.ts";

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
    assert.ok(
      pol10.provenance.valuesAlignment &&
        pol10.provenance.valuesAlignment.length > 0,
    );
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
      summary:
        "Charter to establish participatory decision making across all working groups.",
      outcomes: ["Open deliberation on motions", "Monthly voting rounds"],
      details:
        "Full details on delegate responsibilities and platform standards.",
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
          {
            label: "Constitution Section 4",
            url: "/constitution",
            description: "Direct democracy principles",
          },
        ],
        valuesAlignment: ["Principle: Participatory Democracy"],
      },
    });
    assert.equal(advanced.stage, "deliberate");
    assert.ok(advanced.provenance);
    assert.equal(advanced.provenance.category, "party-governance");
    assert.equal(advanced.provenance.label, "Party Governance Review");
    assert.equal(advanced.provenance.lineage?.length, 1);
    assert.equal(
      advanced.provenance.lineage[0]?.label,
      "Constitution Section 4",
    );
  });

  it("supports structured deliberation stances (support, concern, amendment, comment) and endorsements", async () => {
    const db = createMemoryDb();
    const proposal = await saveProposal(db, adminUser, {
      title: "Universal Dental Care in Medicare",
      space: "Healthcare",
      summary:
        "Incorporate essential preventive and emergency dental procedures into Medicare.",
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
    const endorseResult = await toggleUpvoteComment(
      db,
      memberUser,
      contribution2.commentId,
    );
    assert.equal(endorseResult.hasUpvoted, true);
    assert.equal(endorseResult.upvotes.length, 1);

    // Detail check
    const detail = await getProposalDetail(db, proposal.slug, memberUser);
    assert.ok(detail);
    assert.equal(detail.comments.length, 2);

    // Deleting a comment
    await deleteComment(db, memberUser, contribution1.commentId);
    const detailAfterDelete = await getProposalDetail(
      db,
      proposal.slug,
      memberUser,
    );
    assert.equal(detailAfterDelete?.comments.length, 1);
  });

  it("lists open decisions the member has not voted on", async () => {
    const db = createMemoryDb();
    for (const [proposalId, stage] of [
      ["open-unvoted", "decide"],
      ["open-voted", "decide"],
      ["closed", "implement"],
      ["archived", "archived"],
    ]) {
      await db
        .collection("proposals")
        .insertOne({
          proposalId,
          slug: proposalId,
          title: proposalId,
          stage,
          ballotRevisionId: "r1",
          space: "General",
        });
    }
    await db
      .collection("proposal_votes")
      .insertOne({
        proposalId: "open-voted",
        ballotId: "proposal:open-voted",
        revisionId: "r1",
        memberId: memberUser.memberId,
        choice: "approve",
      });
    assert.deepEqual(
      (await listOutstandingDecisions(db, memberUser.memberId)).map(
        (item) => item.proposalId,
      ),
      ["open-unvoted"],
    );
  });

  it("shows branch ballots only to verified members of the recognised electorate", async () => {
    const db = createMemoryDb();
    for (const proposal of [
      { proposalId: "national", jurisdictionBranchId: undefined },
      { proposalId: "my-branch", jurisdictionBranchId: "branch-a" },
      { proposalId: "other-branch", jurisdictionBranchId: "branch-b" },
      { proposalId: "unrecognised", jurisdictionBranchId: "branch-c" },
    ]) {
      await db.collection("proposals").insertOne({
        ...proposal,
        slug: proposal.proposalId,
        title: proposal.proposalId,
        stage: "decide",
        ballotRevisionId: "r1",
        space: "General",
      });
    }
    for (const branch of [
      { branchId: "branch-a", recognised: true },
      { branchId: "branch-b", recognised: true },
      { branchId: "branch-c", recognised: false },
    ]) await db.collection("branches").insertOne(branch);
    for (const membership of [
      { memberId: memberUser.memberId, branchId: "branch-a", status: "active" },
      { memberId: memberUser.memberId, branchId: "branch-b", status: "inactive" },
      { memberId: memberUser.memberId, branchId: "branch-c", status: "active" },
    ]) await db.collection("branch_memberships").insertOne(membership);

    assert.deepEqual(
      (await listOutstandingDecisions(db, memberUser.memberId, memberUser))
        .map((item) => item.proposalId)
        .sort(),
      ["my-branch", "national"],
    );
  });

  it("supports decision voting (approve, abstain, reject) with reasons and tracks implementation", async () => {
    const db = createMemoryDb();
    const decision = await saveProposal(db, adminUser, {
      title: "Adopt Horizon Visual Identity",
      space: "Branding & Platform",
      summary:
        "Adopt the modern Horizon design tokens and colourway across all official digital assets.",
      stage: "decide",
      ballotClosesAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
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
    assert.equal(
      activity.votes[0]?.reason,
      "High contrast and legible on modern displays.",
    );

    // Advance to Stage 4: Implement with officer tracking note
    await db
      .collection("ballot_results")
      .insertOne({
        proposalId: decision.proposalId,
        revisionId: decision.ballotRevisionId,
        result: "successful",
        decisionEventId: "decision-event-test",
      });
    const implemented = await saveProposal(db, adminUser, {
      proposalId: decision.proposalId,
      stage: "implement",
      implementationNote:
        "Design pack exported to /public assets and merged to production repository.",
    });
    assert.equal(implemented.stage, "implement");
    assert.ok(implemented.implementationNote?.includes("Design pack"));

    // Matters with votes/decisions cannot be hard-deleted
    await assert.rejects(
      deleteProposal(db, adminUser, decision.proposalId),
      /cannot be deleted/i,
    );
    const detail = await getProposalDetail(db, decision.proposalId, adminUser);
    assert.ok(detail);
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
        uncertaintyNote:
          "Reporting threshold numbers are still undergoing drafting.",
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
    assert.equal(
      withProv.provenance.lineage[0]?.url,
      "https://example.org/nacc",
    );
    assert.equal(
      withProv.provenance.uncertaintyNote,
      "Reporting threshold numbers are still undergoing drafting.",
    );

    // Retrieve and verify
    const fetched = await getProposalDetail(db, proposal.proposalId, adminUser);
    assert.equal(
      fetched?.proposal.provenance?.label,
      "Direct Predecessor · Revised",
    );

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
      outcomes: [
        "Phase 1 Sydney-Melbourne corridor",
        "Statutory corridor protection",
      ],
      details:
        "Updated rationale incorporating state transit authority submissions.",
      attachmentUrl: "/rail_corridor_map.svg",
      attachmentDescription:
        "Map of proposed eastern seaboard high-speed alignment.",
    });

    assert.equal(
      modified.title,
      "National High-Speed Rail Corridor Investment",
    );
    assert.equal(modified.outcomes.length, 2);
    assert.equal(modified.attachmentUrl, "/rail_corridor_map.svg");
    assert.equal(
      modified.attachmentDescription,
      "Map of proposed eastern seaboard high-speed alignment.",
    );
  });

  it("strictly locks substantive content once voting begins while permitting non-substantive administrative updates", async () => {
    const db = createMemoryDb();
    const ballot = await saveProposal(db, adminUser, {
      title: "Constitutional Reform on Fixed Terms",
      space: "Governance",
      summary:
        "Proposal to establish 4-year fixed terms for the federal parliament.",
      outcomes: ["Four-year fixed terms", "Synchronised Senate elections"],
      details:
        "Comparative electoral analysis and constitutional amendment mechanism.",
      attachmentUrl: "/referendum_wording.pdf",
      attachmentDescription: "Draft constitutional amendment questions.",
      stage: "deliberate",
    });

    // Advance to Decide (voting begins)
    await saveProposal(db, adminUser, {
      proposalId: ballot.proposalId,
      stage: "decide",
      ballotClosesAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
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
    assert.equal(
      adminUpdate.implementationNote,
      "Ballot open until Sunday midnight.",
    );

    // Cast a member vote
    await castVote(db, memberUser, {
      proposalId: ballot.proposalId,
      choice: "approve",
      reason: "Predictability and stability in legislative cycles.",
    });

    // Now advance to Stage 4: Implement
    const frozen = await db
      .collection("proposals")
      .findOne({ proposalId: ballot.proposalId });
    await db
      .collection("ballot_results")
      .insertOne({
        proposalId: ballot.proposalId,
        revisionId: frozen?.ballotRevisionId,
        result: "successful",
        decisionEventId: "decision-event-lock-test",
      });
    await saveProposal(db, adminUser, {
      proposalId: ballot.proposalId,
      stage: "implement",
      implementationNote:
        "Adopted by membership vote. Referral to platform committee.",
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
      summary:
        "Legislate 90% renewable electricity by 2035 with national storage target.",
      stage: "deliberate",
    });

    // Move to Decide and cast votes
    await saveProposal(db, adminUser, {
      proposalId: proposal.proposalId,
      stage: "decide",
      ballotClosesAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    });
    await castVote(db, memberUser, {
      proposalId: proposal.proposalId,
      choice: "approve",
      reason: "Critical for emissions trajectory.",
    });
    const boundProposal = await db
      .collection("proposals")
      .findOne({ proposalId: proposal.proposalId });
    await db
      .collection("ballot_results")
      .insertOne({
        proposalId: proposal.proposalId,
        revisionId: boundProposal?.ballotRevisionId,
        result: "successful",
        decisionEventId: "decision-event-lifecycle-test",
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
    assert.equal(
      detail?.proposal.votes.total,
      1,
      "Votes must be preserved when moving back to deliberate",
    );

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
      summary:
        "Draft proposal proposing universal regional fibre and low-orbit satellite backhaul.",
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
    const unauthReq = new Request(
      "http://localhost:4321/api/proposals/POL-001",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage: "decide" }),
      },
    );
    const unauthRes = await PATCH({
      params: { proposalId: "POL-001" },
      request: unauthReq,
      locals: { runtime: { env: { APP_MODE: "development" } } },
    } as any);
    assert.equal(unauthRes.status, 401);

    // Staff attempting invalid stage transition on POL-001 (POL-001 is in deliberate in baseline)
    const invalidTransReq = new Request(
      "http://localhost:4321/api/proposals/POL-001",
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: "engage_dev_user=administrator",
        },
        body: JSON.stringify({ stage: "implement" }), // Jumping straight from deliberate to implement
      },
    );
    const invalidTransRes = await PATCH({
      params: { proposalId: "POL-001" },
      request: invalidTransReq,
      locals: { runtime: { env: { APP_MODE: "development" } } },
    } as any);
    assert.equal(invalidTransRes.status, 400);
    const errPayload = await invalidTransRes.json();
    assert.ok(
      errPayload.error.includes("must be voted on in the Decide stage"),
    );

    // Staff attempting substantive change on POL-010 (POL-010 is in decide / voting stage in baseline)
    const lockedReq = new Request(
      "http://localhost:4321/api/proposals/POL-010",
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: "engage_dev_user=administrator",
        },
        body: JSON.stringify({
          title: "Illegitimately Modified Title After Voting",
        }),
      },
    );
    const lockedRes = await PATCH({
      params: { proposalId: "POL-010" },
      request: lockedReq,
      locals: { runtime: { env: { APP_MODE: "development" } } },
    } as any);
    assert.equal(lockedRes.status, 400);
    const lockedPayload = await lockedRes.json();
    assert.ok(
      lockedPayload.error.includes(
        "Cannot modify substantive proposal content",
      ),
    );
  });

  it("binds a vote to an immutable proposal revision and rejects member branch authority edits", async () => {
    const db = createMemoryDb();
    const proposal = await saveProposal(db, adminUser, {
      title: "Branch scoped proposal",
      space: "Governance",
      summary: "A proposal with text frozen when its ballot opens.",
      stage: "decide",
      ballotClosesAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    });
    const revision = await db
      .collection("proposal_revisions")
      .findOne({ proposalId: proposal.proposalId });
    assert.ok(revision?.revisionId);
    await castVote(db, memberUser, {
      proposalId: proposal.proposalId,
      choice: "approve",
    });
    const vote = await db
      .collection("proposal_votes")
      .findOne({
        proposalId: proposal.proposalId,
        memberId: memberUser.memberId,
      });
    assert.equal(vote?.revisionId, revision.revisionId);
    assert.equal(
      await db
        .collection("proposal_revisions")
        .countDocuments({ proposalId: proposal.proposalId }),
      1,
    );
    await assert.rejects(
      saveProposal(db, memberUser, {
        proposalId: proposal.proposalId,
        originatingBranchId: "branch-1",
      }),
      /Moderator or Administrator access is required|Only an administrator may assign/,
    );
  });

  it("freezes the exact wording revision as soon as an administrator opens Decide", async () => {
    const db = createMemoryDb();
    const proposal = await saveProposal(db, adminUser, {
      title: "Proposal before ballot",
      space: "Governance",
      summary: "Original wording before the ballot opens.",
      stage: "deliberate",
    });
    const opened = await saveProposal(db, adminUser, {
      proposalId: proposal.proposalId,
      title: "Proposal at ballot",
      summary: "Updated wording frozen at the moment voting opens.",
      stage: "decide",
      ballotClosesAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    });
    assert.equal(opened.stage, "decide");
    assert.ok(opened.ballotRevisionId);
    const frozen = await db
      .collection("proposal_revisions")
      .findOne({
        proposalId: proposal.proposalId,
        revisionId: opened.ballotRevisionId,
      });
    assert.equal(
      frozen?.snapshot.summary,
      "Updated wording frozen at the moment voting opens.",
    );
    await castVote(db, memberUser, {
      proposalId: proposal.proposalId,
      choice: "approve",
    });
    const vote = await db
      .collection("proposal_votes")
      .findOne({
        proposalId: proposal.proposalId,
        memberId: memberUser.memberId,
      });
    assert.equal(vote?.revisionId, opened.ballotRevisionId);
  });

  it("blocks further votes on an unbound legacy ballot with unversioned votes", async () => {
    const db = createMemoryDb();
    const proposalId = `legacy-ballot-${crypto.randomUUID()}`;
    const revisionId = `legacy-revision-${crypto.randomUUID()}`;
    await db
      .collection("proposals")
      .insertOne({ proposalId, stage: "decide", title: "Legacy ballot" });
    await db
      .collection("proposal_revisions")
      .insertOne({
        proposalId,
        revisionId,
        snapshot: { title: "Legacy ballot wording" },
      });
    await db
      .collection("proposal_votes")
      .insertOne({
        ballotId: `proposal:${proposalId}`,
        proposalId,
        memberId: "earlier-voter",
        choice: "approve",
      });
    await assert.rejects(
      castVote(db, memberUser, { proposalId, choice: "approve" }),
      /without one consistent revision reference/,
    );
    assert.equal(
      (await db.collection("proposals").findOne({ proposalId }))
        ?.ballotRevisionId,
      undefined,
    );
  });

  it("accepts explicit admin branch scope only for existing branches", async () => {
    const db = createMemoryDb();
    await db
      .collection("branches")
      .insertOne({ branchId: "branch-1", name: "State Branch", kind: "state" });
    const proposal = await saveProposal(db, adminUser, {
      title: "State policy proposal",
      space: "Governance",
      summary: "A proposal scoped to a recognised branch.",
      originatingBranchId: "branch-1",
      jurisdictionBranchId: "branch-1",
      publicationScope: "branch",
    });
    assert.equal(proposal.originatingBranchId, "branch-1");
    await assert.rejects(
      saveProposal(db, adminUser, {
        title: "Invalid scope proposal",
        space: "Governance",
        summary: "This scope points at no branch.",
        originatingBranchId: "missing-branch",
      }),
      /does not exist/,
    );
  });

  it("scopes delegated branch administrators to originating proposals and requires matching ballot authority", async () => {
    const db = createMemoryDb();
    const branchId = `delegated-${crypto.randomUUID()}`;
    await db
      .collection("branches")
      .insertOne({
        branchId,
        name: "State Branch",
        kind: "state",
        recognised: true,
        createdAt: new Date(),
      });
    const branchAdmin: SessionUser = {
      ...memberUser,
      branchAdminIds: [branchId],
      isBranchAdmin: true,
    };
    const proposal = await saveProposal(db, branchAdmin, {
      title: "Branch proposal",
      space: "Local",
      summary: "A branch proposal summary with enough detail.",
      details: "Draft text",
      originatingBranchId: branchId,
      stage: "deliberate",
    });
    assert.equal(
      proposal.stage,
      "propose",
      "delegated branch administration does not create proposals directly in a later stage",
    );
    assert.equal(proposal.originatingBranchId, branchId);
    assert.equal(
      proposal.publicationScope,
      "branch",
      "branch-admin proposals are not made nationally visible by default",
    );
    assert.equal(
      (await listProposals(db, { user: null })).some(
        (item) => item.proposalId === proposal.proposalId,
      ),
      false,
    );
    assert.equal(
      (await listProposals(db, { user: branchAdmin })).some(
        (item) => item.proposalId === proposal.proposalId,
      ),
      true,
    );
    await saveProposal(db, branchAdmin, {
      proposalId: proposal.proposalId,
      stage: "deliberate",
    });
    // A delegated branch administrator's own branch supplies governance
    // authority and jurisdiction at creation, so its local ballot can open
    // straight away without a national administrator pre-assigning it.
    const ballot = await saveProposal(db, branchAdmin, {
      proposalId: proposal.proposalId,
      stage: "decide",
      ballotClosesAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    });
    assert.equal(ballot.governanceAuthorityBranchId, branchId);
    assert.equal(ballot.jurisdictionBranchId, branchId);
    assert.ok(ballot.ballotRevisionId);
    await assert.rejects(
      () =>
        saveProposal(db, branchAdmin, {
          proposalId: proposal.proposalId,
          summary:
            "Change after voting started in a way that must be prevented.",
        }),
      /Cannot modify substantive proposal content/,
    );
    await assert.rejects(
      () =>
        saveProposal(db, branchAdmin, {
          proposalId: proposal.proposalId,
          governanceAuthorityBranchId: "another-branch",
        }),
      /Only a national administrator/,
    );
  });

  it("filters private proposal content from public lists and detail routes", async () => {
    const db = createMemoryDb();
    const proposal = await saveProposal(db, adminUser, {
      title: "Private draft",
      space: "Governance",
      summary: "A private proposal summary for authorised review.",
      details: "Sensitive draft",
      publicationScope: "private",
    });
    assert.equal(
      (await listProposals(db, { user: null })).some(
        (item) => item.proposalId === proposal.proposalId,
      ),
      false,
    );
    assert.equal(await getProposalDetail(db, proposal.slug, null), null);
    assert.equal(
      (await listProposals(db, { user: adminUser })).some(
        (item) => item.proposalId === proposal.proposalId,
      ),
      true,
    );
  });

  it("locks branch authority and publication scope after a ballot begins", async () => {
    const db = createMemoryDb();
    await db
      .collection("branches")
      .insertOne({ branchId: "scope-a", name: "Scope A", kind: "state" });
    await db
      .collection("branches")
      .insertOne({ branchId: "scope-b", name: "Scope B", kind: "state" });
    const proposal = await saveProposal(db, adminUser, {
      title: "Locked branch scope",
      space: "Governance",
      summary: "A proposal with a fixed ballot jurisdiction.",
      stage: "decide",
      ballotClosesAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
      jurisdictionBranchId: "scope-a",
      publicationScope: "branch",
    });
    await assert.rejects(
      saveProposal(db, adminUser, {
        proposalId: proposal.proposalId,
        jurisdictionBranchId: "scope-b",
      }),
      /locked once a ballot begins/,
    );
  });

  it("isolates branch ballot eligibility to explicitly active branch members", async () => {
    const db = createMemoryDb();
    await db
      .collection("branches")
      .insertOne({
        branchId: "state-x",
        name: "State X",
        kind: "state",
        recognised: true,
      });
    const proposal = await saveProposal(db, adminUser, {
      title: "State X ballot proposal",
      space: "Governance",
      summary: "A branch scoped ballot for members.",
      stage: "decide",
      ballotClosesAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
      jurisdictionBranchId: "state-x",
      publicationScope: "branch",
    });
    const branchSession = {
      ...memberUser,
      activeBranchIds: ["state-x"],
    };
    await assert.rejects(
      castVote(db, memberUser, {
        proposalId: proposal.proposalId,
        choice: "approve",
      }),
      /Proposal not found/,
    );
    await assert.rejects(
      castVote(db, branchSession, {
        proposalId: proposal.proposalId,
        choice: "approve",
      }),
      /Voting is limited to verified State X members/,
    );
    await db
      .collection("branch_memberships")
      .insertOne({
        branchId: "state-x",
        memberId: memberUser.memberId,
        status: "active",
      });
    const vote = await castVote(db, branchSession, {
      proposalId: proposal.proposalId,
      choice: "approve",
    });
    assert.equal(vote.choice, "approve");
  });

  it("rejects a concurrent stale proposal edit instead of overwriting the winner", async () => {
    const db = createMemoryDb();
    const proposal = await saveProposal(db, adminUser, {
      title: "Concurrent edit proposal",
      space: "Governance",
      summary: "A proposal to exercise optimistic concurrency control.",
    });
    const outcomes = await Promise.allSettled([
      saveProposal(db, adminUser, {
        proposalId: proposal.proposalId,
        summary: "First concurrent edit with a valid summary.",
      }),
      saveProposal(db, adminUser, {
        proposalId: proposal.proposalId,
        summary: "Second concurrent edit with a valid summary.",
      }),
    ]);
    assert.equal(
      outcomes.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      outcomes.filter((result) => result.status === "rejected").length,
      1,
    );
    const persisted = await db
      .collection("proposals")
      .findOne({ proposalId: proposal.proposalId });
    assert.ok(
      persisted?.summary === "First concurrent edit with a valid summary." ||
        persisted?.summary === "Second concurrent edit with a valid summary.",
    );
    assert.equal(
      await db
        .collection("proposal_revisions")
        .countDocuments({ proposalId: proposal.proposalId }),
      2,
    );
  });

  it("keeps amendment ballot votes separate from the original proposal ballot", async () => {
    const db = createMemoryDb();
    const proposal = await saveProposal(db, adminUser, {
      title: "Proposal with amendment ballot",
      space: "Governance",
      summary: "Original ballot totals must not include amendment votes.",
      stage: "decide",
      ballotClosesAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    });
    const original = await castVote(db, memberUser, {
      proposalId: proposal.proposalId,
      choice: "reject",
    });
    const frozenRevisionId = (
      await db
        .collection("proposals")
        .findOne({ proposalId: proposal.proposalId })
    )?.ballotRevisionId;
    const amendmentId = "amendment-1";
    const amendmentRevisionId = "amendment-revision-1";
    await db
      .collection("amendment_revisions")
      .insertOne({
        amendmentId,
        revisionId: amendmentRevisionId,
        snapshot: { summary: "Proposed alternative wording." },
      });
    await db
      .collection("amendments")
      .insertOne({
        amendmentId,
        proposalId: proposal.proposalId,
        status: "voting",
        baseRevisionId: frozenRevisionId,
        ballotRevisionId: frozenRevisionId,
        currentRevisionId: amendmentRevisionId,
        ballotAmendmentRevisionId: amendmentRevisionId,
      });
    const amendment = await castVote(db, adminUser, {
      proposalId: proposal.proposalId,
      amendmentId,
      choice: "approve",
    });
    assert.equal(
      (
        await db
          .collection(PROPOSAL_VOTES)
          .findOne({ ballotId: `amendment:${amendmentId}` })
      )?.amendmentRevisionId,
      amendmentRevisionId,
    );
    assert.deepEqual(original.votes, {
      approve: 0,
      abstain: 0,
      reject: 1,
      total: 1,
    });
    assert.deepEqual(amendment.votes, {
      approve: 1,
      abstain: 0,
      reject: 0,
      total: 1,
    });
    const detail = await getProposalDetail(db, proposal.proposalId, memberUser);
    assert.deepEqual(detail?.proposal.votes, original.votes);
    assert.equal(detail?.votesList.length, 1);
  });

  it("stores pending-verification ballot preferences without altering official vote totals, and promotes them upon admin verification", async () => {
    const db = createMemoryDb();
    const { ObjectId } = await import("mongodb");
    await db.collection("user").insertOne({
      _id: new ObjectId(adminUser.memberId),
      name: adminUser.name,
      email: adminUser.email,
    });
    await db.collection("user").insertOne({
      _id: new ObjectId(pendingUser.memberId),
      name: pendingUser.name,
      email: pendingUser.email,
      status: "pending",
      role: "member",
    });

    const proposal = await saveProposal(db, adminUser, {
      title: "High-Speed Rail Electrification Standard",
      space: "Transport & Infrastructure",
      summary: "Adopt 25kV AC overhead electrification across intercity rail corridors.",
      stage: "decide",
      ballotClosesAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    });

    // Pending member cannot cast a formal ballot directly
    await assert.rejects(
      () =>
        castVote(db, pendingUser, {
          proposalId: proposal.proposalId,
          choice: "approve",
        }),
      /verified before you can participate in decisions/,
    );

    // Pending member can save a pending vote preference bound to the current ballot revision
    const queued = await savePendingVotePreference(db, pendingUser, {
      proposalId: proposal.proposalId,
      choice: "approve",
      reason: "Essential for freight and passenger interoperability.",
    });
    assert.equal(queued.pendingVerification, true);
    assert.equal(queued.choice, "approve");
    assert.equal(queued.revisionId, proposal.ballotRevisionId);

    // Official ballot totals remain 0 before verification, while pendingUser sees their queued preference
    const beforeVerifyDetail = await getProposalDetail(
      db,
      proposal.proposalId,
      pendingUser,
    );
    assert.equal(beforeVerifyDetail?.proposal.votes.total, 0);
    assert.equal(beforeVerifyDetail?.proposal.votes.approve, 0);
    assert.equal(beforeVerifyDetail?.myVote, null);
    assert.equal(beforeVerifyDetail?.myPendingVote, "approve");
    assert.equal(
      beforeVerifyDetail?.myPendingReason,
      "Essential for freight and passenger interoperability.",
    );

    // Admin verifies the member -> pending vote preference is automatically promoted into proposal_votes
    await saveMember(
      db,
      adminUser,
      {
        memberId: pendingUser.memberId,
        name: pendingUser.name,
        email: pendingUser.email,
        role: "member",
        status: "verified",
      },
      false,
    );

    const verifiedSession: SessionUser = {
      ...pendingUser,
      status: "verified",
      canParticipate: true,
    };
    const afterVerifyDetail = await getProposalDetail(
      db,
      proposal.proposalId,
      verifiedSession,
    );
    assert.equal(afterVerifyDetail?.proposal.votes.total, 1);
    assert.equal(afterVerifyDetail?.proposal.votes.approve, 1);
    assert.equal(afterVerifyDetail?.myVote, "approve");
    assert.equal(
      afterVerifyDetail?.myReason,
      "Essential for freight and passenger interoperability.",
    );
    assert.equal(afterVerifyDetail?.myPendingVote, null);

    // Calling promotePendingVotePreferences again is a safe no-op
    const secondPromoteCount = await promotePendingVotePreferences(
      db,
      pendingUser.memberId,
    );
    assert.equal(secondPromoteCount, 0);
  });
});
