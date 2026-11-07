import { it } from "node:test";
import assert from "node:assert/strict";
import { getDatabase } from "./db.ts";
import {
  addComment,
  canViewProposal,
  castVote,
  listProposalRevisions,
  listProposals,
} from "./store.ts";
import { ballotRecordsForViewer } from "./ballot-privacy.ts";
import { canViewIdentifiableBallots } from "./auth.ts";
import { PROPOSAL_VOTES, proposalBallotId } from "./vote-storage.ts";
import { GET as getRevisions } from "../pages/api/proposals/[proposalId]/revisions.ts";
import {
  GET as getAmendments,
  POST as postAmendment,
} from "../pages/api/amendments.ts";
import { GET as listProposalsApi } from "../pages/api/proposals/index.ts";
import { GET as getProposalDetailApi } from "../pages/api/proposals/[proposalId].ts";
import { POST as postComment } from "../pages/api/comments.ts";
import { POST as postVote } from "../pages/api/votes.ts";
import type { SessionUser, VoteRecord } from "./types.ts";

const env = { APP_MODE: "development" };
const locals = { runtime: { env } };
const unique = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

const admin: SessionUser = {
  memberId: "access-admin",
  name: "Access Admin",
  email: "admin@example.test",
  role: "administrator",
  status: "verified",
  canParticipate: true,
  isStaff: true,
  isAdmin: true,
};

const moderator: SessionUser = {
  memberId: "access-moderator",
  name: "Access Moderator",
  email: "moderator@example.test",
  role: "moderator",
  status: "verified",
  canParticipate: true,
  isStaff: true,
  isAdmin: false,
};

const member: SessionUser = {
  memberId: "access-member",
  name: "Access Member",
  email: "member@example.test",
  role: "member",
  status: "verified",
  canParticipate: true,
  isStaff: false,
  isAdmin: false,
};

const branchMember: SessionUser = {
  ...member,
  memberId: "access-branch-member",
  name: "Access Branch Member",
  activeBranchIds: ["access-branch-a"],
};

function request(path: string, cookie?: string): Request {
  return new Request(`http://localhost${path}`, {
    headers: cookie ? { Cookie: cookie } : {},
  });
}

async function insertProposal(
  db: Awaited<ReturnType<typeof getDatabase>>,
  overrides: Record<string, unknown> = {},
) {
  const proposalId = String(overrides.proposalId ?? unique("access-proposal"));
  const record = {
    proposalId,
    slug: unique("access-slug"),
    title: "Visibility test proposal",
    space: "Governance",
    summary: "Summary used for visibility regression tests.",
    outcomes: [],
    details: "Details used for visibility regression tests.",
    stage: "deliberate",
    authorId: "proposal-author",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  await db.collection("proposals").insertOne(record);
  return record;
}

async function insertRevision(
  db: Awaited<ReturnType<typeof getDatabase>>,
  proposalId: string,
  revisionId = unique("access-revision"),
) {
  await db.collection("proposal_revisions").insertOne({
    revisionId,
    proposalId,
    parentRevisionId: null,
    authorId: "proposal-author",
    createdAt: new Date(),
    snapshot: {
      title: "Revision title",
      summary: "Revision summary",
      outcomes: [],
      details: "Revision details",
    },
    contentHash: "synthetic-hash",
  });
  return revisionId;
}

async function insertAmendment(
  db: Awaited<ReturnType<typeof getDatabase>>,
  proposalId: string,
  baseRevisionId: string,
) {
  const amendmentId = unique("access-amendment");
  await db.collection("amendments").insertOne({
    amendmentId,
    proposalId,
    baseRevisionId,
    authorId: "proposal-author",
    currentRevisionId: unique("access-amendment-revision"),
    changes: { summary: "An amendment summary." },
    fields: ["summary"],
    status: "proposed",
    conflicts: [],
    createdAt: new Date(),
  });
  return amendmentId;
}

it("proposal revision access follows proposal visibility and archived rules", async () => {
  const db = await getDatabase(env);
  const privateProposal = await insertProposal(db, {
    publicationScope: "private",
  });
  const branchProposal = await insertProposal(db, {
    publicationScope: "branch",
    originatingBranchId: "access-branch-a",
    jurisdictionBranchId: "access-branch-a",
  });
  const publicProposal = await insertProposal(db, {
    publicationScope: "national",
  });
  const archivedProposal = await insertProposal(db, {
    publicationScope: "national",
    stage: "archived",
  });
  for (const proposal of [
    privateProposal,
    branchProposal,
    publicProposal,
    archivedProposal,
  ])
    await insertRevision(db, proposal.proposalId);

  assert.equal(
    await listProposalRevisions(db, privateProposal.proposalId, null),
    null,
  );
  assert.equal(
    await listProposalRevisions(db, privateProposal.proposalId, member),
    null,
  );
  assert.equal(
    await listProposalRevisions(db, privateProposal.proposalId, branchMember),
    null,
  );
  assert.ok(
    await listProposalRevisions(db, privateProposal.proposalId, admin),
  );

  assert.equal(
    await listProposalRevisions(db, branchProposal.proposalId, null),
    null,
  );
  assert.equal(
    await listProposalRevisions(db, branchProposal.proposalId, member),
    null,
  );
  assert.ok(
    await listProposalRevisions(db, branchProposal.proposalId, branchMember),
  );
  assert.ok(await listProposalRevisions(db, branchProposal.proposalId, admin));

  assert.ok(await listProposalRevisions(db, publicProposal.proposalId, null));
  assert.ok(await listProposalRevisions(db, publicProposal.proposalId, member));

  assert.equal(
    await listProposalRevisions(db, archivedProposal.proposalId, null),
    null,
  );
  assert.equal(
    await listProposalRevisions(db, archivedProposal.proposalId, member),
    null,
  );
  assert.ok(
    await listProposalRevisions(db, archivedProposal.proposalId, admin),
  );

  const publicRevision = await listProposalRevisions(
    db,
    publicProposal.proposalId,
    null,
  );
  assert.equal(publicRevision?.revisions.length, 1);
  assert.equal("authorId" in publicRevision!.revisions[0]!, false);

  const route = (proposalId: string, cookie?: string) =>
    getRevisions({
      params: { proposalId },
      request: request(`/api/proposals/${proposalId}/revisions`, cookie),
      locals,
    } as never);

  assert.equal((await route(privateProposal.proposalId)).status, 404);
  assert.equal(
    (await route(privateProposal.proposalId, "engage_dev_user=member")).status,
    404,
  );
  assert.equal(
    (
      await route(
        privateProposal.proposalId,
        "engage_dev_user=administrator",
      )
    ).status,
    200,
  );
  assert.equal((await route(publicProposal.proposalId)).status, 200);
  assert.equal((await route(archivedProposal.proposalId)).status, 404);
  assert.equal(
    (await route(archivedProposal.proposalId, "engage_dev_user=member")).status,
    404,
  );

  const directList = await listProposals(db, { user: member });
  assert.equal(
    directList.some((item) => item.proposalId === privateProposal.proposalId),
    false,
  );
  assert.equal(
    directList.some((item) => item.proposalId === branchProposal.proposalId),
    false,
  );
  const branchList = await listProposals(db, { user: branchMember });
  assert.equal(
    branchList.some((item) => item.proposalId === branchProposal.proposalId),
    true,
  );

  const apiList = await listProposalsApi({
    request: request("/api/proposals"),
    url: new URL("http://localhost/api/proposals"),
    locals,
  } as never);
  const apiPayload = (await apiList.json()) as {
    proposals: Array<{ proposalId: string }>;
  };
  assert.equal(
    apiPayload.proposals.some(
      (item) => item.proposalId === privateProposal.proposalId,
    ),
    false,
  );
});

it("amendment listing and submission require proposal visibility", async () => {
  const db = await getDatabase(env);
  const privateProposal = await insertProposal(db, {
    publicationScope: "private",
  });
  const branchProposal = await insertProposal(db, {
    publicationScope: "branch",
    originatingBranchId: "access-branch-a",
    jurisdictionBranchId: "access-branch-a",
  });
  const publicProposal = await insertProposal(db, {
    publicationScope: "national",
  });
  const privateRevision = await insertRevision(
    db,
    privateProposal.proposalId,
  );
  const branchRevision = await insertRevision(db, branchProposal.proposalId);
  const publicRevision = await insertRevision(db, publicProposal.proposalId);
  await insertAmendment(db, privateProposal.proposalId, privateRevision);
  await insertAmendment(db, branchProposal.proposalId, branchRevision);
  await insertAmendment(db, publicProposal.proposalId, publicRevision);

  const list = (proposalId: string, cookie?: string) =>
    getAmendments({
      request: request(`/api/amendments?proposalId=${proposalId}`, cookie),
      url: new URL(`http://localhost/api/amendments?proposalId=${proposalId}`),
      locals,
    } as never);

  assert.equal(
    (await list(privateProposal.proposalId, "engage_dev_user=member")).status,
    404,
  );
  assert.equal(
    (await list(branchProposal.proposalId, "engage_dev_user=member")).status,
    404,
  );
  assert.equal(
    (await list(publicProposal.proposalId, "engage_dev_user=member")).status,
    200,
  );
  assert.equal(
    (await list(privateProposal.proposalId, "engage_dev_user=administrator"))
      .status,
    200,
  );

  const submit = (proposalId: string, baseRevisionId: string, cookie: string) =>
    postAmendment({
      request: new Request("http://localhost/api/amendments", {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          proposalId,
          baseRevisionId,
          changes: { summary: "A replacement summary for the amendment." },
        }),
      }),
      locals,
    } as never);

  const beforePrivate = await db
    .collection("amendments")
    .countDocuments({ proposalId: privateProposal.proposalId });
  assert.equal(
    (await submit(privateProposal.proposalId, privateRevision, "engage_dev_user=member"))
      .status,
    404,
  );
  assert.equal(
    (await submit(branchProposal.proposalId, branchRevision, "engage_dev_user=member"))
      .status,
    404,
  );
  assert.equal(
    await db
      .collection("amendments")
      .countDocuments({ proposalId: privateProposal.proposalId }),
    beforePrivate,
  );
  assert.equal(
    (await submit(publicProposal.proposalId, publicRevision, "engage_dev_user=member"))
      .status,
    201,
  );
});

it("comments and votes enforce visibility without weakening participation checks", async () => {
  const db = await getDatabase(env);
  const branchId = unique("access-branch");
  await db.collection("branches").insertOne({
    branchId,
    name: "Access Branch",
    kind: "state",
    recognised: true,
    createdAt: new Date(),
  });
  const branchMemberForCurrentBranch: SessionUser = {
    ...branchMember,
    activeBranchIds: [branchId],
  };
  await db.collection("branch_memberships").insertOne({
    branchId,
    memberId: branchMemberForCurrentBranch.memberId,
    status: "active",
    branchRole: "member",
  });

  const privateProposal = await insertProposal(db, {
    publicationScope: "private",
  });
  const branchProposal = await insertProposal(db, {
    publicationScope: "branch",
    originatingBranchId: branchId,
    jurisdictionBranchId: branchId,
    stage: "decide",
    ballotRevisionId: unique("access-ballot-revision"),
  });
  const publicProposal = await insertProposal(db, {
    publicationScope: "national",
    stage: "decide",
    ballotRevisionId: unique("access-ballot-revision"),
  });
  await insertRevision(db, branchProposal.proposalId);
  await insertRevision(db, publicProposal.proposalId);

  await assert.rejects(
    () =>
      addComment(db, member, {
        proposalId: privateProposal.proposalId,
        body: "A private proposal comment.",
      }),
    /not open for deliberation/,
  );
  await assert.rejects(
    () =>
      addComment(db, member, {
        proposalId: branchProposal.proposalId,
        body: "A branch proposal comment.",
      }),
    /not open for deliberation/,
  );
  assert.ok(
    await addComment(db, branchMemberForCurrentBranch, {
      proposalId: branchProposal.proposalId,
      body: "A branch member comment.",
    }),
  );
  assert.ok(
    await addComment(db, member, {
      proposalId: publicProposal.proposalId,
      body: "A public proposal comment.",
    }),
  );

  await assert.rejects(
    () =>
      castVote(db, member, {
        proposalId: privateProposal.proposalId,
        choice: "approve",
      }),
    /Proposal not found/,
  );
  await assert.rejects(
    () =>
      castVote(db, member, {
        proposalId: branchProposal.proposalId,
        choice: "approve",
      }),
    /Proposal not found/,
  );
  assert.equal(
    (
      await castVote(db, branchMemberForCurrentBranch, {
        proposalId: branchProposal.proposalId,
        choice: "approve",
      })
    ).choice,
    "approve",
  );
  assert.equal(
    (
      await castVote(db, member, {
        proposalId: publicProposal.proposalId,
        choice: "reject",
      })
    ).choice,
    "reject",
  );

  const commentsResponse = await postComment({
    request: new Request("http://localhost/api/comments", {
      method: "POST",
      headers: {
        Cookie: "engage_dev_user=member",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        proposalId: privateProposal.proposalId,
        body: "An API comment on a private proposal.",
      }),
    }),
    locals,
  } as never);
  assert.equal(commentsResponse.status, 400);
  const commentPayload = (await commentsResponse.json()) as { error: string };
  assert.equal(commentPayload.error, "This proposal is not open for deliberation.");

  const voteResponse = await postVote({
    request: new Request("http://localhost/api/votes", {
      method: "POST",
      headers: {
        Cookie: "engage_dev_user=member",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        proposalId: privateProposal.proposalId,
        choice: "approve",
      }),
    }),
    locals,
  } as never);
  assert.equal(voteResponse.status, 400);
  const votePayload = (await voteResponse.json()) as { error: string };
  assert.equal(votePayload.error, "Proposal not found.");
});

it("identifiable ballot records are limited to the explicitly authorised role", async () => {
  const db = await getDatabase(env);
  const proposalId = unique("access-ballot-proposal");
  const revisionId = unique("access-ballot-revision");
  await db.collection("proposals").insertOne({
    proposalId,
    slug: unique("access-ballot-slug"),
    title: "Ballot privacy proposal",
    space: "Governance",
    summary: "A proposal used for ballot privacy checks.",
    outcomes: [],
    details: "",
    stage: "decide",
    ballotRevisionId: revisionId,
    publicationScope: "national",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const records: VoteRecord[] = [
    {
      ballotId: proposalBallotId(proposalId),
      proposalId,
      revisionId,
      memberId: "dev-member-01",
      authorName: "Local Verified Member",
      choice: "approve",
      reason: "Member reason",
      updatedAt: new Date(),
    },
    {
      ballotId: proposalBallotId(proposalId),
      proposalId,
      revisionId,
      memberId: "another-member",
      authorName: "Another Member",
      choice: "reject",
      reason: "Another member private reason",
      updatedAt: new Date(),
    },
    {
      ballotId: proposalBallotId(proposalId),
      proposalId,
      revisionId,
      memberId: moderator.memberId,
      authorName: moderator.name,
      choice: "abstain",
      reason: "Moderator reason",
      updatedAt: new Date(),
    },
  ];
  for (const record of records)
    await db.collection(PROPOSAL_VOTES).insertOne(record);

  assert.equal(canViewIdentifiableBallots(null), false);
  assert.equal(canViewIdentifiableBallots(member), false);
  assert.equal(canViewIdentifiableBallots(moderator), false);
  assert.equal(canViewIdentifiableBallots(admin), true);

  assert.equal(ballotRecordsForViewer(records, null).length, 0);

  const memberView = ballotRecordsForViewer(records, member);
  assert.equal(memberView.length, 0);

  const devMemberView = ballotRecordsForViewer(records, {
    ...member,
    memberId: "dev-member-01",
  });
  assert.equal(devMemberView.length, 1);
  assert.equal(devMemberView[0]?.choice, "approve");
  assert.equal("memberId" in devMemberView[0]!, false);
  assert.equal("authorName" in devMemberView[0]!, false);

  const moderatorView = ballotRecordsForViewer(records, moderator);
  assert.equal(moderatorView.length, 1);
  assert.equal(moderatorView[0]?.choice, "abstain");
  assert.equal("memberId" in moderatorView[0]!, false);
  assert.equal("authorName" in moderatorView[0]!, false);

  const adminView = ballotRecordsForViewer(records, admin);
  assert.equal(adminView.length, 3);
  assert.equal("memberId" in adminView[0]!, true);

  const detail = (cookie?: string) =>
    getProposalDetailApi({
      params: { proposalId },
      request: request(`/api/proposals/${proposalId}`, cookie),
      locals,
    } as never);

  const publicDetail = (await (await detail()).json()) as {
    votesList: Array<Record<string, unknown>>;
  };
  assert.equal(publicDetail.votesList.length, 0);
  assert.equal(JSON.stringify(publicDetail).includes("Another member private reason"), false);

  const memberDetail = (await (
    await detail("engage_dev_user=member")
  ).json()) as { votesList: Array<Record<string, unknown>> };
  assert.equal(memberDetail.votesList.length, 1);
  assert.equal(memberDetail.votesList[0]?.choice, "approve");
  assert.equal(JSON.stringify(memberDetail).includes("Another member private reason"), false);

  const adminDetail = (await (
    await detail("engage_dev_user=administrator")
  ).json()) as { votesList: Array<Record<string, unknown>> };
  assert.equal(adminDetail.votesList.length, 3);
  assert.equal("memberId" in adminDetail.votesList[1]!, true);

  // An ordinary member cannot see a branch proposal through the detail API.
  const branchProposal = await insertProposal(db, {
    publicationScope: "branch",
    originatingBranchId: "access-branch-b",
    jurisdictionBranchId: "access-branch-b",
  });
  assert.equal(
    (
      await getProposalDetailApi({
        params: { proposalId: branchProposal.proposalId },
        request: request(
          `/api/proposals/${branchProposal.proposalId}`,
          "engage_dev_user=member",
        ),
        locals,
      } as never)
    ).status,
    404,
  );
  assert.equal(
    canViewProposal(
      {
        ...branchProposal,
        proposalId: branchProposal.proposalId,
      } as never,
      branchMember,
    ),
    false,
  );
});

it("archived revisions cannot be read by ordinary members even when the proposal is public", async () => {
  const db = await getDatabase(env);
  const archived = await insertProposal(db, {
    publicationScope: "national",
    stage: "archived",
  });
  await insertRevision(db, archived.proposalId);
  const response = await getRevisions({
    params: { proposalId: archived.proposalId },
    request: request(`/api/proposals/${archived.proposalId}/revisions`, "engage_dev_user=member"),
    locals,
  } as never);
  assert.equal(response.status, 404);
});
