import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryDb } from "./db.ts";
import {
  openMatterBallots,
  outstandingBallots,
  outstandingMatterBallots,
} from "./electorate.ts";
import { PROPOSAL_VOTES, proposalBallotId } from "./vote-storage.ts";
import type { ProposalSummaryView, SessionUser } from "./types.ts";

const now = new Date("2026-11-17T00:00:00Z");
const future = new Date("2026-12-01T00:00:00Z");
const past = new Date("2026-11-01T00:00:00Z");

function viewer(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    memberId: "member-1",
    name: "Member One",
    email: "member@example.test",
    role: "member",
    status: "verified",
    canParticipate: true,
    isStaff: false,
    isAdmin: false,
    activeBranchIds: ["branch-vic"],
    ...overrides,
  };
}

function proposal(
  proposalId: string,
  overrides: Partial<ProposalSummaryView> = {},
): ProposalSummaryView {
  return {
    proposalId,
    slug: proposalId.toLowerCase(),
    title: `Proposal ${proposalId}`,
    space: "Governance",
    kind: "policy",
    stage: "decide",
    summary: "Summary",
    outcomes: [],
    details: "Details",
    ballotRevisionId: `rev-${proposalId}`,
    jurisdictionBranchId: "branch-vic",
    createdAt: now,
    updatedAt: now,
    commentCount: 0,
    votes: { approve: 0, abstain: 0, reject: 0, total: 0 },
    ...overrides,
  } as ProposalSummaryView;
}

async function insertAll(collection: any, docs: any[]) {
  await Promise.all(docs.map((doc) => collection.insertOne(doc)));
}

async function seeded() {
  const db = createMemoryDb();
  await insertAll(db.collection("branches"), [
    { branchId: "branch-nat", name: "Fusion National", kind: "national", recognised: true },
    { branchId: "branch-vic", name: "Victoria", kind: "state", recognised: true },
    { branchId: "branch-unrecognised", name: "Unrecognised", kind: "state", recognised: false },
  ]);
  await insertAll(db.collection("branch_memberships"), [
    { memberId: "member-1", branchId: "branch-vic", status: "active" },
  ]);
  await insertAll(db.collection("branch_subscriptions"), [
    { memberId: "follower-1", branchId: "branch-vic", status: "following" },
  ]);
  await db.collection(PROPOSAL_VOTES).insertOne({
    ballotId: proposalBallotId("POL-VOTED"),
    proposalId: "POL-VOTED",
    revisionId: "rev-POL-VOTED",
    memberId: "member-1",
    choice: "approve",
    reason: "",
    updatedAt: now,
    encrypted: false,
  });
  await insertAll(db.collection("amendments"), [
    {
      amendmentId: "AMD-1",
      proposalId: "POL-VIC",
      title: "Change the wording",
      status: "voting",
      ballotRevisionId: "rev-POL-VIC",
      ballotAmendmentRevisionId: "amd-rev-1",
      currentRevisionId: "amd-rev-1",
      baseRevisionId: "rev-POL-VIC",
      ballotClosesAt: future,
    },
    {
      amendmentId: "AMD-CLOSED",
      proposalId: "POL-CLOSED",
      title: "Closed amendment",
      status: "voting",
      ballotRevisionId: "rev-POL-CLOSED",
      ballotAmendmentRevisionId: "amd-rev-2",
      currentRevisionId: "amd-rev-2",
      baseRevisionId: "rev-POL-CLOSED",
      ballotClosesAt: future,
    },
  ]);

  const proposals = [
    proposal("POL-NATIONAL", { jurisdictionBranchId: "branch-nat" }),
    proposal("POL-VIC", { ballotClosesAt: future }),
    proposal("POL-CLOSED", { ballotClosesAt: past }),
    proposal("POL-UNBOUND", { ballotRevisionId: undefined }),
    proposal("POL-UNRECOGNISED", { jurisdictionBranchId: "branch-unrecognised" }),
    proposal("POL-VOTED", { ballotClosesAt: future }),
    proposal("POL-PRIVATE", {
      publicationScope: "private",
      originatingBranchId: "branch-nsw",
      ballotClosesAt: future,
    }),
  ];
  return { db, proposals };
}

const ids = (ballots: Array<{ proposalId: string; kind: string }>) =>
  ballots.map((ballot) => `${ballot.kind}:${ballot.proposalId}`).sort();

describe("electorate", () => {
  it("lists only eligible, bound, open matter ballots", async () => {
    const { db, proposals } = await seeded();
    const ballots = await outstandingMatterBallots(db, viewer(), {
      proposals,
      now,
    });
    assert.deepEqual(ids(ballots), [
      "matter:POL-NATIONAL",
      "matter:POL-VIC",
    ]);
  });

  it("keeps a voted ballot in the eligible set but out of the outstanding set", async () => {
    const { db, proposals } = await seeded();
    const eligible = await openMatterBallots(db, viewer(), { proposals, now });
    const voted = eligible.find((ballot) => ballot.proposalId === "POL-VOTED");
    assert.ok(voted);
    assert.equal(voted.voted, true);
    assert.deepEqual(
      (await outstandingMatterBallots(db, viewer(), { proposals, now })).map(
        (ballot) => ballot.proposalId,
      ),
      ["POL-NATIONAL", "POL-VIC"],
    );
  });

  it("includes a matching amendment ballot only in the digest list", async () => {
    const { db, proposals } = await seeded();
    const matters = await outstandingMatterBallots(db, viewer(), {
      proposals,
      now,
    });
    assert.equal(
      matters.some((ballot) => ballot.kind === "amendment"),
      false,
    );

    const all = await outstandingBallots(db, viewer(), { proposals, now });
    assert.deepEqual(ids(all), [
      "amendment:POL-VIC",
      "matter:POL-NATIONAL",
      "matter:POL-VIC",
    ]);
    const amendment = all.find((ballot) => ballot.kind === "amendment");
    assert.equal(amendment?.amendmentId, "AMD-1");
    assert.equal(amendment?.amendmentRevisionId, "amd-rev-1");
    assert.equal(amendment?.title, "Amendment: Change the wording");
  });

  it("uses the same eligibility rule as the ballot page", async () => {
    const { db, proposals } = await seeded();
    assert.deepEqual(
      await outstandingMatterBallots(
        db,
        viewer({ canParticipate: false }),
        { proposals, now },
      ),
      [],
      "pending membership has no ballot",
    );
    assert.deepEqual(
      ids(
        await outstandingMatterBallots(
          db,
          viewer({ memberId: "follower-1", activeBranchIds: ["branch-vic"] }),
          { proposals, now },
        ),
      ),
      ["matter:POL-NATIONAL"],
      "a follower can read but not vote in the branch ballot",
    );
    assert.deepEqual(
      await outstandingMatterBallots(db, viewer({ memberId: "outsider-1" }), {
        proposals: [proposals[1]],
        now,
      }),
      [],
      "a verified member without the branch membership gets no branch ballot",
    );
  });

  it("does not expose a private matter outside the viewer's branch", async () => {
    const { db, proposals } = await seeded();
    const privateMatter = await outstandingMatterBallots(db, viewer(), {
      proposals: proposals.filter((item) => item.proposalId === "POL-PRIVATE"),
      now,
    });
    assert.deepEqual(privateMatter, []);
  });

  it("orders the digest by the soonest close", async () => {
    const { db, proposals } = await seeded();
    const soon = new Date("2026-11-20T00:00:00Z");
    const ballots = await outstandingMatterBallots(db, viewer(), {
      proposals: [
        proposal("POL-LATER", { ballotClosesAt: future }),
        proposal("POL-SOON", { ballotClosesAt: soon }),
      ],
      now,
    });
    const digest = await outstandingBallots(db, viewer(), {
      proposals: [
        proposal("POL-LATER", { ballotClosesAt: future }),
        proposal("POL-SOON", { ballotClosesAt: soon }),
      ],
      now,
    });
    assert.deepEqual(
      ballots.map((ballot) => ballot.proposalId),
      ["POL-LATER", "POL-SOON"],
      "matter lists keep proposal order",
    );
    assert.deepEqual(
      digest.map((ballot) => ballot.proposalId),
      ["POL-SOON", "POL-LATER"],
      "the digest is ordered by close time",
    );
  });

  it("accepts pre-loaded votes without reading them twice", async () => {
    const { db, proposals } = await seeded();
    const preloaded = [
      {
        ballotId: proposalBallotId("POL-VIC"),
        proposalId: "POL-VIC",
        revisionId: "rev-POL-VIC",
        choice: "reject" as const,
        reason: "",
        updatedAt: now,
        encrypted: false,
      },
      {
        ballotId: proposalBallotId("POL-VOTED"),
        proposalId: "POL-VOTED",
        revisionId: "rev-POL-VOTED",
        choice: "approve" as const,
        reason: "",
        updatedAt: now,
        encrypted: false,
      },
    ];
    const ballots = await outstandingMatterBallots(db, viewer(), {
      proposals,
      now,
      votes: preloaded,
    });
    assert.deepEqual(
      ballots.map((ballot) => ballot.proposalId),
      ["POL-NATIONAL"],
      "the pre-loaded votes remove both ballots",
    );
  });
});
