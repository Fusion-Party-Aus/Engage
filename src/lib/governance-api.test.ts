import { it } from "node:test";
import assert from "node:assert/strict";
import { getDatabase } from "./db.ts";
import { GET as listPolicies } from "../pages/api/v1/policies/index.ts";
import { POST as publishPolicy } from "../pages/api/admin/policies/publish.ts";
import { POST as withdrawPolicy } from "../pages/api/admin/policies/withdraw.ts";
import { POST as ratifyPolicy } from "../pages/api/admin/policies/ratify.ts";
import { GET as listPolicyVersions } from "../pages/api/v1/policies/[id]/versions/index.ts";
import { GET as getPolicyVersion } from "../pages/api/v1/policies/[id]/versions/[version].ts";
import { POST as openAmendmentBallot } from "../pages/api/admin/amendments/open-ballot.ts";
import { POST as bindBallot } from "../pages/api/admin/ballots/bind.ts";
import { POST as closeAmendmentBallot } from "../pages/api/admin/amendments/close-ballot.ts";
import { POST as approveAmendment } from "../pages/api/admin/amendments/accept.ts";
import { POST as supersedePolicy } from "../pages/api/admin/policies/supersede.ts";
import { POST as reconcilePublications } from "../pages/api/admin/policies/reconcile.ts";
import { POST as resolveAmendment } from "../pages/api/admin/amendments/resolve.ts";
import { POST as createBranch } from "../pages/api/admin/branches.ts";
import { PATCH as updateBranch } from "../pages/api/admin/branches.ts";
import { POST as assignBranchMembership } from "../pages/api/admin/branches/memberships.ts";
import { DELETE as revokeBranchMembership } from "../pages/api/admin/branches/memberships.ts";
import { POST as referProposal } from "../pages/api/admin/branches/referrals.ts";
import { GET as openApi } from "../pages/api/v1/openapi.json.ts";
import { GET as listPublicBranches } from "../pages/api/v1/branches/index.ts";
import { GET as getProposalDetailApi } from "../pages/api/proposals/[proposalId].ts";
import { PROPOSAL_VOTES, proposalBallotId } from "./vote-storage.ts";
import { castVote } from "./store.ts";
import type { SessionUser } from "./types.ts";

it("public Policy API hides unpublished records and publication retries reuse one outbox event", async () => {
  const env = { APP_MODE: "development" };
  const db = await getDatabase(env);
  const policyId = `test-policy-${crypto.randomUUID()}`;
  await db.collection("policy_registry").insertOne({
    policyId,
    proposalId: policyId,
    revisionId: "rev-1",
    revisionIds: ["rev-1"],
    status: "adopted",
    publicationStatus: "unpublished",
    title: "Test policy",
    approvedWording: "Approved test wording.",
    jurisdictionBranchId: "branch-test",
    jurisdiction: "State X",
    idempotencyKey: "internal-secret",
    ratification: {
      decisionEventId: "decision-1",
      authorityBranchId: "national",
      ratifiedBy: "private-member-id",
    },
    provenance: { category: "new-proposal" },
  });
  const get = (search = "", headers: HeadersInit = {}) =>
    listPolicies({
      locals: { runtime: { env } },
      request: new Request(`http://localhost/api/v1/policies${search}`, {
        headers,
      }),
      url: new URL(`http://localhost/api/v1/policies${search}`),
    } as never);
  let response = await get();
  let payload = (await response.json()) as {
    data: Array<Record<string, unknown>>;
  };
  assert.equal(
    payload.data.length,
    0,
    "unpublished policy must remain private",
  );

  const request = () =>
    new Request("http://localhost/api/admin/policies/publish", {
      method: "POST",
      headers: {
        Cookie: "engage_dev_user=administrator",
        "Content-Type": "application/json",
        "Idempotency-Key": `test-${policyId}`,
      },
      body: JSON.stringify({ policyId }),
    });
  const publish = () =>
    publishPolicy({
      request: request(),
      locals: { runtime: { env } },
    } as never);
  response = await publish();
  assert.equal(response.status, 201);
  const first = (await response.json()) as {
    event: { eventId: string; status: string };
  };
  assert.equal(first.event.status, "published");
  response = await publish();
  assert.equal(response.status, 201);
  const second = (await response.json()) as { event: { eventId: string } };
  assert.equal(second.event.eventId, first.event.eventId);
  assert.equal(
    await db
      .collection("publication_events")
      .countDocuments({ eventId: first.event.eventId }),
    1,
  );
  const duplicatePublication = await publishPolicy({
    request: new Request("http://localhost/api/admin/policies/publish", {
      method: "POST",
      headers: {
        Cookie: "engage_dev_user=administrator",
        "Content-Type": "application/json",
        "Idempotency-Key": `new-key-${policyId}`,
      },
      body: JSON.stringify({ policyId }),
    }),
    locals: { runtime: { env } },
  } as never);
  assert.equal(
    duplicatePublication.status,
    409,
    "a fresh key must not create a second publication event for an already published revision",
  );
  response = await get();
  payload = (await response.json()) as { data: Array<Record<string, unknown>> };
  assert.equal(payload.data[0]?.policyId, policyId);
  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes("internal-secret"));
  assert.ok(!serialized.includes("private-member-id"));
  const etag = response.headers.get("etag");
  assert.ok(etag);
  assert.equal((await get("", { "If-None-Match": etag! })).status, 304);
  response = await get("?branch=another-branch");
  payload = (await response.json()) as { data: Array<Record<string, unknown>> };
  assert.equal(
    payload.data.length,
    0,
    "branch filter must exclude other jurisdictions",
  );
});

it("supports admin-managed data-driven branches, explicit memberships and referrals", async () => {
  const env = { APP_MODE: "development" };
  const db = await getDatabase(env);
  const admin = {
    Cookie: "engage_dev_user=administrator",
    "Content-Type": "application/json",
  };
  const missingAuth = await createBranch({
    request: new Request("http://localhost/api/admin/branches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "State X", kind: "state" }),
    }),
    locals: { runtime: { env } },
  } as never);
  assert.equal(missingAuth.status, 401);
  const parentId = `branch-national-${crypto.randomUUID()}`;
  const parent = await createBranch({
    request: new Request("http://localhost/api/admin/branches", {
      method: "POST",
      headers: admin,
      body: JSON.stringify({
        branchId: parentId,
        name: "National",
        kind: "national",
        recognised: true,
      }),
    }),
    locals: { runtime: { env } },
  } as never);
  assert.equal(parent.status, 201);
  const childId = `branch-state-${crypto.randomUUID()}`;
  const child = await createBranch({
    request: new Request("http://localhost/api/admin/branches", {
      method: "POST",
      headers: admin,
      body: JSON.stringify({
        branchId: childId,
        name: "State X",
        kind: "state",
        parentBranchId: parentId,
        recognised: true,
      }),
    }),
    locals: { runtime: { env } },
  } as never);
  assert.equal(child.status, 201);
  const memberId = `branch-member-${crypto.randomUUID()}`;
  await db
    .collection("memberships")
    .insertOne({ memberId, status: "verified" });
  const assign = await assignBranchMembership({
    request: new Request("http://localhost/api/admin/branches/memberships", {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ branchId: childId, memberId }),
    }),
    locals: { runtime: { env } },
  } as never);
  assert.equal(assign.status, 201);
  assert.equal(
    (
      await db
        .collection("branch_memberships")
        .findOne({ branchId: childId, memberId })
    )?.status,
    "active",
  );
  assert.equal(
    await db
      .collection("branch_membership_events")
      .countDocuments({ branchId: childId, memberId, action: "assigned" }),
    1,
  );
  const duplicateAssignment = await assignBranchMembership({
    request: new Request("http://localhost/api/admin/branches/memberships", {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ branchId: childId, memberId }),
    }),
    locals: { runtime: { env } },
  } as never);
  assert.equal(duplicateAssignment.status, 200);
  const delegation = await assignBranchMembership({
    request: new Request("http://localhost/api/admin/branches/memberships", {
      method: "POST",
      headers: admin,
      body: JSON.stringify({
        branchId: childId,
        memberId,
        branchRole: "administrator",
      }),
    }),
    locals: { runtime: { env } },
  } as never);
  assert.equal(delegation.status, 200);
  assert.equal(
    (
      await db
        .collection("branch_memberships")
        .findOne({ branchId: childId, memberId })
    )?.branchRole,
    "administrator",
  );
  assert.equal(
    await db
      .collection("branch_membership_events")
      .countDocuments({ branchId: childId, memberId, action: "role-changed" }),
    1,
  );
  const revoked = await revokeBranchMembership({
    request: new Request("http://localhost/api/admin/branches/memberships", {
      method: "DELETE",
      headers: admin,
      body: JSON.stringify({ branchId: childId, memberId }),
    }),
    locals: { runtime: { env } },
  } as never);
  assert.equal(revoked.status, 200);
  assert.equal(
    await db
      .collection("branch_membership_events")
      .countDocuments({ branchId: childId, memberId, action: "revoked" }),
    1,
  );
  const proposalId = `branch-referral-proposal-${crypto.randomUUID()}`;
  await db
    .collection("proposals")
    .insertOne({
      proposalId,
      originatingBranchId: childId,
      title: "Proposal",
      stage: "deliberate",
    });
  const referral = await referProposal({
    request: new Request("http://localhost/api/admin/branches/referrals", {
      method: "POST",
      headers: admin,
      body: JSON.stringify({
        proposalId,
        targetBranchId: parentId,
        reason: "Requesting review at national scope.",
      }),
    }),
    locals: { runtime: { env } },
  } as never);
  assert.equal(referral.status, 201);
  const record = await db
    .collection("branch_referrals")
    .findOne({ proposalId, targetBranchId: parentId });
  assert.equal(record?.sourceBranchId, childId);
  const edit = await updateBranch({
    request: new Request("http://localhost/api/admin/branches", {
      method: "PATCH",
      headers: admin,
      body: JSON.stringify({
        branchId: childId,
        name: "Updated State X",
        kind: "state",
        parentBranchId: parentId,
        recognised: true,
      }),
    }),
    locals: { runtime: { env } },
  } as never);
  assert.equal(edit.status, 200);
  assert.equal(
    (
      await db
        .collection("branch_events")
        .findOne({ branchId: childId, action: "updated" })
    )?.after.name,
    "Updated State X",
  );
  const cycle = await updateBranch({
    request: new Request("http://localhost/api/admin/branches", {
      method: "PATCH",
      headers: admin,
      body: JSON.stringify({
        branchId: childId,
        name: "Updated State X",
        kind: "state",
        parentBranchId: childId,
        recognised: true,
      }),
    }),
    locals: { runtime: { env } },
  } as never);
  assert.equal(cycle.status, 400);
});

it("publishes only the public branch schema and omits administrator identifiers", async () => {
  const env = { APP_MODE: "development" };
  const db = await getDatabase(env);
  const branchId = `public-branch-${crypto.randomUUID()}`;
  await db
    .collection("branches")
    .insertOne({
      branchId,
      name: "Public State",
      kind: "state",
      recognised: true,
      updatedBy: "private-admin-id",
      createdAt: new Date(),
    });
  const nextBranchId = `zz-public-branch-${crypto.randomUUID()}`;
  await db
    .collection("branches")
    .insertOne({
      branchId: nextBranchId,
      name: "Public Territory",
      kind: "territory",
      recognised: true,
      updatedBy: "private-admin-id",
      createdAt: new Date(),
    });
  const response = await listPublicBranches({
    request: new Request("http://localhost/api/v1/branches"),
    url: new URL("http://localhost/api/v1/branches"),
    locals: { runtime: { env } },
  } as never);
  const result = (await response.json()) as {
    data: Array<Record<string, unknown>>;
  };
  const publicBranch = result.data.find((row) => row.branchId === branchId)!;
  assert.equal(publicBranch.name, "Public State");
  assert.equal("updatedBy" in publicBranch, false);
  assert.equal("createdAt" in publicBranch, false);
  const firstPageResponse = await listPublicBranches({
    request: new Request("http://localhost/api/v1/branches?limit=1"),
    url: new URL("http://localhost/api/v1/branches?limit=1"),
    locals: { runtime: { env } },
  } as never);
  const firstPage = (await firstPageResponse.json()) as {
    data: Array<{ branchId: string }>;
    meta: { nextCursor: string | null };
  };
  assert.equal(firstPage.data.length, 1);
  assert.ok(firstPage.meta.nextCursor);
  const secondUrl = new URL(
    `http://localhost/api/v1/branches?limit=1&cursor=${encodeURIComponent(firstPage.meta.nextCursor!)}`,
  );
  const secondPage = await listPublicBranches({
    request: new Request(secondUrl),
    url: secondUrl,
    locals: { runtime: { env } },
  } as never);
  const secondPayload = (await secondPage.json()) as {
    data: Array<{ branchId: string }>;
  };
  assert.equal(secondPayload.data.length, 1);
  assert.notEqual(secondPayload.data[0]?.branchId, firstPage.data[0]?.branchId);
});

it("keeps vote identities private in public proposal reads and lets members verify only their own vote", async () => {
  const env = { APP_MODE: "development" };
  const db = await getDatabase(env);
  const proposalId = `vote-privacy-${crypto.randomUUID()}`;
  await db
    .collection("proposals")
    .insertOne({
      proposalId,
      slug: proposalId,
      title: "Vote privacy",
      space: "Governance",
      summary: "A proposal summary for vote privacy checks.",
      outcomes: [],
      details: "",
      stage: "decide",
      ballotRevisionId: "privacy-revision",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  await db
    .collection(PROPOSAL_VOTES)
    .insertOne({
      ballotId: proposalBallotId(proposalId),
      proposalId,
      revisionId: "privacy-revision",
      memberId: "dev-member-01",
      authorName: "Local Verified Member",
      choice: "approve",
      reason: "My reason",
      updatedAt: new Date(),
    });
  await db
    .collection(PROPOSAL_VOTES)
    .insertOne({
      ballotId: proposalBallotId(proposalId),
      proposalId,
      revisionId: "privacy-revision",
      memberId: "another-member",
      authorName: "Another Member",
      choice: "reject",
      reason: "Private reason",
      updatedAt: new Date(),
    });
  const get = (cookie = "") =>
    getProposalDetailApi({
      params: { proposalId },
      request: new Request(`http://localhost/api/proposals/${proposalId}`, {
        headers: cookie ? { Cookie: cookie } : {},
      }),
      locals: { runtime: { env } },
    } as never);
  const publicDetail = (await (await get()).json()) as {
    votesList: Array<Record<string, unknown>>;
  };
  assert.equal(publicDetail.votesList.length, 0);
  const memberDetail = (await (await get("engage_dev_user=member")).json()) as {
    votesList: Array<Record<string, unknown>>;
  };
  assert.equal(memberDetail.votesList.length, 1);
  assert.equal(memberDetail.votesList[0]?.choice, "approve");
  assert.equal("memberId" in memberDetail.votesList[0]!, false);
  assert.equal("authorName" in memberDetail.votesList[0]!, false);
});

it("withdrawal retry returns its durable event after the policy is no longer publicly published", async () => {
  const env = { APP_MODE: "development" };
  const db = await getDatabase(env);
  const policyId = `withdraw-test-${crypto.randomUUID()}`;
  await db
    .collection("policy_registry")
    .insertOne({
      policyId,
      revisionId: "rev-w",
      status: "adopted",
      publicationStatus: "published",
      jurisdiction: "State X",
      provenance: { category: "new-proposal" },
    });
  const key = `withdraw-${policyId}`;
  const call = () =>
    withdrawPolicy({
      request: new Request("http://localhost/api/admin/policies/withdraw", {
        method: "POST",
        headers: {
          Cookie: "engage_dev_user=administrator",
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify({ policyId, reason: "Correction required." }),
      }),
      locals: { runtime: { env } },
    } as never);
  const first = await call();
  assert.equal(first.status, 201);
  const event1 = (await first.json()) as { event: { eventId: string } };
  const retry = await call();
  assert.equal(retry.status, 200);
  const event2 = (await retry.json()) as { event: { eventId: string } };
  assert.equal(event2.event.eventId, event1.event.eventId);
  assert.equal(
    (await db.collection("policy_registry").findOne({ policyId }))
      ?.publicationStatus,
    "withdrawn",
  );
  const secondWithdrawal = await withdrawPolicy({
    request: new Request("http://localhost/api/admin/policies/withdraw", {
      method: "POST",
      headers: {
        Cookie: "engage_dev_user=administrator",
        "Content-Type": "application/json",
        "Idempotency-Key": `${key}-again`,
      },
      body: JSON.stringify({
        policyId,
        reason: "Duplicate event should be rejected.",
      }),
    }),
    locals: { runtime: { env } },
  } as never);
  assert.equal(secondWithdrawal.status, 409);
});

it("ratification requires a successful result for the exact revision and decision event", async () => {
  const env = { APP_MODE: "development" };
  const db = await getDatabase(env);
  const proposalId = `ratify-test-${crypto.randomUUID()}`;
  const revisionId = `revision-${crypto.randomUUID()}`;
  const authorityBranchId = `branch-${crypto.randomUUID()}`;
  await db
    .collection("branches")
    .insertOne({
      branchId: authorityBranchId,
      name: "Recognised Authority",
      kind: "national",
      recognised: true,
    });
  await db
    .collection("proposals")
    .insertOne({ proposalId, stage: "implement", space: "Governance" });
  await db
    .collection("proposal_revisions")
    .insertOne({
      proposalId,
      revisionId,
      parentRevisionId: null,
      createdAt: new Date(),
      snapshot: {
        title: "Ratified wording",
        summary: "A sufficiently long summary for policy review.",
        outcomes: ["Commitment"],
        details: "Exact approved wording.",
      },
      contentHash: "hash",
    });
  await db
    .collection("ballot_results")
    .insertOne({
      proposalId,
      revisionId,
      result: "successful",
      decisionEventId: "ballot-decision-1",
    });
  const call = (decisionEventId: string) =>
    ratifyPolicy({
      request: new Request("http://localhost/api/admin/policies/ratify", {
        method: "POST",
        headers: {
          Cookie: "engage_dev_user=administrator",
          "Content-Type": "application/json",
          "Idempotency-Key": `ratify-${proposalId}`,
        },
        body: JSON.stringify({
          proposalId,
          revisionId,
          decisionEventId,
          authorityBranchId,
        }),
      }),
      locals: { runtime: { env } },
    } as never);
  assert.equal((await call("wrong-event")).status, 409);
  const response = await call("ballot-decision-1");
  assert.equal(response.status, 201);
  const { policy } = (await response.json()) as {
    policy: { revisionId: string; ratification: { decisionEventId: string } };
  };
  assert.equal(policy.revisionId, revisionId);
  assert.equal(policy.ratification.decisionEventId, "ballot-decision-1");
});

it("ratifies exact wording in an immutable composite revision for formally accepted amendments", async () => {
  const env = { APP_MODE: "development" };
  const db = await getDatabase(env);
  const proposalId = `ratify-amend-${crypto.randomUUID()}`;
  const revisionId = `ballot-${crypto.randomUUID()}`;
  const authorityBranchId = `authority-${crypto.randomUUID()}`;
  const amendmentId = `accepted-${crypto.randomUUID()}`;
  await db
    .collection("branches")
    .insertOne({
      branchId: authorityBranchId,
      name: "Recognised Authority",
      kind: "national",
      recognised: true,
    });
  await db
    .collection("proposals")
    .insertOne({
      proposalId,
      stage: "implement",
      space: "Governance",
      summary: "Original proposal wording.",
    });
  await db
    .collection("proposal_revisions")
    .insertOne({
      proposalId,
      revisionId,
      parentRevisionId: null,
      createdAt: new Date(),
      snapshot: {
        title: "Ratified wording",
        summary: "Original proposal wording.",
        outcomes: ["Original commitment"],
        details: "Original text.",
      },
      contentHash: "source-hash",
    });
  await db
    .collection("ballot_results")
    .insertOne({
      proposalId,
      revisionId,
      result: "successful",
      decisionEventId: `event-${proposalId}`,
    });
  const amendmentRevisionId = `amendment-rev-${crypto.randomUUID()}`;
  await db
    .collection("amendment_revisions")
    .insertOne({
      amendmentId,
      revisionId: amendmentRevisionId,
      snapshot: {
        summary: "Amended wording.",
        outcomes: ["Adopted commitment"],
      },
    });
  await db
    .collection("amendments")
    .insertOne({
      amendmentId,
      proposalId,
      baseRevisionId: revisionId,
      currentRevisionId: amendmentRevisionId,
      ballotAmendmentRevisionId: amendmentRevisionId,
      status: "accepted",
      formalApproval: { baseRevisionId: revisionId, amendmentRevisionId },
    });
  const key = `ratify-${proposalId}`;
  const call = () =>
    ratifyPolicy({
      request: new Request("http://localhost/api/admin/policies/ratify", {
        method: "POST",
        headers: {
          Cookie: "engage_dev_user=administrator",
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify({
          proposalId,
          revisionId,
          decisionEventId: `event-${proposalId}`,
          authorityBranchId,
          adoptedAmendmentIds: [amendmentId],
        }),
      }),
      locals: { runtime: { env } },
    } as never);
  const response = await call();
  assert.equal(response.status, 201);
  const { policy } = (await response.json()) as {
    policy: {
      revisionId: string;
      revisionIds: string[];
      summary: string;
      commitments: string[];
      ratification: { ballotRevisionId: string; adoptedAmendmentIds: string[] };
    };
  };
  assert.notEqual(policy.revisionId, revisionId);
  assert.deepEqual(policy.revisionIds, [revisionId, policy.revisionId]);
  assert.equal(policy.summary, "Amended wording.");
  assert.deepEqual(policy.commitments, ["Adopted commitment"]);
  assert.equal(policy.ratification.ballotRevisionId, revisionId);
  assert.deepEqual(policy.ratification.adoptedAmendmentIds, [amendmentId]);
  const composite = await db
    .collection("proposal_revisions")
    .findOne({ proposalId, revisionId: policy.revisionId });
  assert.equal(composite?.parentRevisionId, revisionId);
  assert.equal(composite?.revisionType, "ratified-policy");
  assert.equal(
    (await db.collection("proposals").findOne({ proposalId }))?.summary,
    "Original proposal wording.",
  );
  assert.equal((await call()).status, 200);
  assert.equal(
    await db
      .collection("proposal_revisions")
      .countDocuments({ proposalId, revisionType: "ratified-policy" }),
    1,
  );
});

it("version API exposes exact published snapshots without member identifiers", async () => {
  const env = { APP_MODE: "development" };
  const db = await getDatabase(env);
  const policyId = `versions-${crypto.randomUUID()}`;
  const revisionId = `rev-${crypto.randomUUID()}`;
  await db
    .collection("proposal_revisions")
    .insertOne({
      proposalId: policyId,
      revisionId,
      parentRevisionId: null,
      authorId: "private-author",
      createdAt: new Date(),
      snapshot: {
        title: "Policy wording",
        summary: "Snapshot summary.",
        outcomes: ["Outcome"],
        details: "Exact wording.",
      },
      contentHash: "sha256-example",
    });
  const olderRevision = `a-${crypto.randomUUID()}`;
  await db
    .collection("proposal_revisions")
    .insertOne({
      proposalId: policyId,
      revisionId: olderRevision,
      parentRevisionId: null,
      authorId: "private-author",
      createdAt: new Date(0),
      snapshot: {
        title: "Earlier policy wording",
        summary: "Earlier summary.",
        outcomes: [],
        details: "Earlier exact wording.",
      },
      contentHash: "earlier-hash",
    });
  await db
    .collection("policy_registry")
    .insertOne({
      policyId,
      proposalId: policyId,
      revisionId,
      revisionIds: [revisionId, olderRevision],
      status: "adopted",
      publicationStatus: "published",
    });
  const context: any = {
    params: { id: policyId, version: revisionId },
    locals: { runtime: { env } },
    request: new Request(
      `http://localhost/api/v1/policies/${policyId}/versions/${revisionId}`,
    ),
    url: new URL(
      `http://localhost/api/v1/policies/${policyId}/versions?limit=1`,
    ),
  };
  const list = await listPolicyVersions(context);
  assert.equal(list.status, 200);
  const listPayload = (await list.json()) as {
    data: Array<Record<string, unknown>>;
    meta: { limit: number; nextCursor: string | null };
  };
  assert.equal(listPayload.data.length, 1);
  assert.ok(listPayload.meta.nextCursor);
  assert.ok(!JSON.stringify(listPayload).includes("private-author"));
  const secondVersionUrl = new URL(
    `http://localhost/api/v1/policies/${policyId}/versions?limit=1&cursor=${encodeURIComponent(listPayload.meta.nextCursor!)}`,
  );
  const secondVersionPage = await listPolicyVersions({
    ...context,
    request: new Request(secondVersionUrl),
    url: secondVersionUrl,
  });
  const secondVersionPayload = (await secondVersionPage.json()) as {
    data: Array<{ revisionId: string }>;
    meta: { nextCursor: string | null };
  };
  assert.equal(secondVersionPayload.data.length, 1);
  assert.notEqual(
    secondVersionPayload.data[0]?.revisionId,
    listPayload.data[0]?.revisionId,
  );
  assert.equal(secondVersionPayload.meta.nextCursor, null);
  const exact = await getPolicyVersion(context);
  assert.equal(exact.status, 200);
  assert.match(exact.headers.get("cache-control") ?? "", /immutable/);
  assert.ok(exact.headers.get("etag"));
  assert.match(exact.headers.get("link") ?? "", /rel="canonical"/);
  const exactPayload = (await exact.json()) as {
    data: Record<string, unknown>;
  };
  const conditional = await getPolicyVersion({
    ...context,
    request: new Request(
      `http://localhost/api/v1/policies/${policyId}/versions/${revisionId}`,
      { headers: { "If-None-Match": exact.headers.get("etag")! } },
    ),
  });
  assert.equal(conditional.status, 304);
  assert.equal(exactPayload.data.revisionId, revisionId);
  const hidden = await getPolicyVersion({
    params: { id: policyId, version: "unknown" },
    locals: { runtime: { env } },
  } as never);
  assert.equal(hidden.status, 404);
});

it("serves a versioned OpenAPI contract with policy and branch schemas", async () => {
  const response = await openApi({} as never);
  assert.equal(response.status, 200);
  const spec = (await response.json()) as {
    openapi: string;
    paths: Record<string, unknown>;
    components: { schemas: Record<string, unknown> };
  };
  assert.equal(spec.openapi, "3.1.0");
  assert.ok(spec.paths["/policies/{id}/versions/{version}"]);
  assert.ok(spec.paths["/branches/{id}/policies"]);
  assert.ok(spec.components.schemas.Policy);
  assert.ok(spec.components.schemas.Version);
  assert.ok(spec.components.schemas.Branch);
});

it("amendment ballot opens on the frozen revision and closes as endorsement without editing proposal wording", async () => {
  const env = { APP_MODE: "development" };
  const db = await getDatabase(env);
  const proposalId = `amend-ballot-${crypto.randomUUID()}`;
  const revisionId = `ballot-rev-${crypto.randomUUID()}`;
  const amendmentId = `amend-${crypto.randomUUID()}`;
  await db
    .collection("proposals")
    .insertOne({
      proposalId,
      stage: "decide",
      ballotRevisionId: revisionId,
      title: "Frozen text",
      summary: "Unchanged wording.",
    });
  await db
    .collection("proposal_revisions")
    .insertOne({
      proposalId,
      revisionId,
      snapshot: {
        title: "Frozen text",
        summary: "Unchanged wording.",
        outcomes: [],
        details: "",
      },
    });
  const amendmentRevisionId = `amendment-rev-${crypto.randomUUID()}`;
  await db
    .collection("amendment_revisions")
    .insertOne({
      amendmentId,
      revisionId: amendmentRevisionId,
      snapshot: { summary: "Suggested amended wording." },
    });
  await db
    .collection("amendments")
    .insertOne({
      amendmentId,
      proposalId,
      baseRevisionId: revisionId,
      currentRevisionId: amendmentRevisionId,
      changes: { summary: "Suggested amended wording." },
      status: "proposed",
    });
  const adminRequest = (url: string) =>
    new Request(`http://localhost${url}`, {
      method: "POST",
      headers: {
        Cookie: "engage_dev_user=administrator",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ amendmentId }),
    });
  const opened = await openAmendmentBallot({
    request: adminRequest("/api/admin/amendments/open-ballot"),
    locals: { runtime: { env } },
  } as never);
  assert.equal(opened.status, 201);
  const member: SessionUser = {
    memberId: `member-${crypto.randomUUID()}`,
    name: "Member",
    email: "member@example.test",
    role: "member",
    status: "verified",
    canParticipate: true,
    isStaff: false,
    isAdmin: false,
  };
  const vote = await castVote(db, member, {
    proposalId,
    amendmentId,
    choice: "approve",
  });
  assert.deepEqual(vote.votes, { approve: 1, abstain: 0, reject: 0, total: 1 });
  const closeRequest = new Request(
    "http://localhost/api/admin/amendments/close-ballot",
    {
      method: "POST",
      headers: {
        Cookie: "engage_dev_user=administrator",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amendmentId,
        result: "endorsed",
        decisionEventId: "amendment-decision-1",
      }),
    },
  );
  const closed = await closeAmendmentBallot({
    request: closeRequest,
    locals: { runtime: { env } },
  } as never);
  assert.equal(closed.status, 200);
  const state = await db.collection("proposals").findOne({ proposalId });
  assert.equal(state?.summary, "Unchanged wording.");
  assert.equal(state?.ballotRevisionId, revisionId);
  const amendment = await db.collection("amendments").findOne({ amendmentId });
  assert.equal(amendment?.status, "endorsed");
  assert.equal(amendment?.ballotDecision?.tally.approve, 1);
});

it("formal amendment approval records the exact wording revision endorsed by its ballot", async () => {
  const env = { APP_MODE: "development" };
  const db = await getDatabase(env);
  const proposalId = `formal-amendment-${crypto.randomUUID()}`;
  const amendmentId = `formal-${crypto.randomUUID()}`;
  const proposalRevisionId = `proposal-rev-${crypto.randomUUID()}`;
  const amendmentRevisionId = `amendment-rev-${crypto.randomUUID()}`;
  await db
    .collection("proposals")
    .insertOne({
      proposalId,
      stage: "decide",
      ballotRevisionId: proposalRevisionId,
    });
  await db
    .collection("amendment_revisions")
    .insertOne({
      amendmentId,
      revisionId: amendmentRevisionId,
      parentRevisionId: null,
      snapshot: { summary: "Exact endorsed wording." },
    });
  await db
    .collection("amendments")
    .insertOne({
      amendmentId,
      proposalId,
      status: "endorsed",
      currentRevisionId: amendmentRevisionId,
      baseRevisionId: proposalRevisionId,
      ballotRevisionId: proposalRevisionId,
      ballotAmendmentRevisionId: amendmentRevisionId,
      ballotDecision: {
        result: "endorsed",
        decisionEventId: "member-endorsement-1",
      },
    });
  const response = await approveAmendment({
    request: new Request("http://localhost/api/admin/amendments/accept", {
      method: "POST",
      headers: {
        Cookie: "engage_dev_user=administrator",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amendmentId,
        decisionEventId: "formal-approval-1",
      }),
    }),
    locals: { runtime: { env } },
  } as never);
  assert.equal(response.status, 200);
  const saved = await db.collection("amendments").findOne({ amendmentId });
  assert.equal(saved?.status, "accepted");
  assert.equal(saved?.formalApproval?.amendmentRevisionId, amendmentRevisionId);
  assert.equal(saved?.formalApproval?.baseRevisionId, proposalRevisionId);
});

it("requires explicit audited wording review before continuing an ambiguous legacy ballot", async () => {
  const env = { APP_MODE: "development" };
  const db = await getDatabase(env);
  const proposalId = `legacy-bind-${crypto.randomUUID()}`;
  const revisionId = `legacy-revision-${crypto.randomUUID()}`;
  await db
    .collection("proposals")
    .insertOne({ proposalId, stage: "decide", title: "Legacy ballot" });
  await db
    .collection("proposal_revisions")
    .insertOne({
      proposalId,
      revisionId,
      parentRevisionId: null,
      createdAt: new Date(),
      snapshot: { title: "Reviewed wording" },
      contentHash: "reviewed-hash",
    });
  await db
    .collection(PROPOSAL_VOTES)
    .insertOne({
      ballotId: proposalBallotId(proposalId),
      proposalId,
      memberId: "legacy-member",
      choice: "approve",
      updatedAt: new Date(),
    });
  const call = (decisionEventId = "legacy-review-event") =>
    bindBallot({
      request: new Request("http://localhost/api/admin/ballots/bind", {
        method: "POST",
        headers: {
          Cookie: "engage_dev_user=administrator",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          proposalId,
          revisionId,
          decisionEventId,
          reason:
            "Compared the saved proposal wording with the signed ballot record.",
        }),
      }),
      locals: { runtime: { env } },
    } as never);
  const response = await call();
  assert.equal(response.status, 201);
  const vote = await db
    .collection(PROPOSAL_VOTES)
    .findOne({ proposalId, memberId: "legacy-member" });
  assert.equal(vote?.choice, "approve");
  assert.equal(vote?.revisionId, revisionId);
  assert.equal(
    (await db.collection("proposals").findOne({ proposalId }))
      ?.ballotRevisionId,
    revisionId,
  );
  assert.equal(
    await db
      .collection("ballot_binding_events")
      .countDocuments({ proposalId, revisionId }),
    1,
  );
  assert.equal((await call()).status, 200);
  const member = {
    memberId: `new-member-${crypto.randomUUID()}`,
    name: "New Member",
    email: "member@example.test",
    role: "member" as const,
    status: "verified" as const,
    canParticipate: true,
    isStaff: false,
    isAdmin: false,
  };
  await castVote(db, member, { proposalId, choice: "reject" });
  assert.equal(
    await db
      .collection(PROPOSAL_VOTES)
      .countDocuments({ ballotId: proposalBallotId(proposalId) }),
    2,
  );
});

it("reconciles a pending publication event after the policy status write was interrupted", async () => {
  const env = { APP_MODE: "development" };
  const db = await getDatabase(env);
  const policyId = `reconcile-${crypto.randomUUID()}`;
  const eventId = `pub-reconcile-${policyId}`;
  const publishedAt = new Date();
  await db
    .collection("policy_registry")
    .insertOne({
      policyId,
      revisionId: "revision-r",
      status: "adopted",
      publicationStatus: "unpublished",
    });
  await db
    .collection("publication_events")
    .insertOne({
      eventId,
      policyId,
      revisionId: "revision-r",
      status: "pending",
      publishedAt,
    });
  const response = await reconcilePublications({
    request: new Request("http://localhost/api/admin/policies/reconcile", {
      method: "POST",
      headers: { Cookie: "engage_dev_user=administrator" },
    }),
    locals: { runtime: { env } },
  } as never);
  assert.equal(response.status, 200);
  assert.equal(
    (await db.collection("policy_registry").findOne({ policyId }))
      ?.publicationStatus,
    "published",
  );
  assert.equal(
    (await db.collection("publication_events").findOne({ eventId }))?.status,
    "published",
  );
});

it("supersession records its successor revision and withdraws only the old published entry", async () => {
  const env = { APP_MODE: "development" };
  const db = await getDatabase(env);
  const oldId = `old-policy-${crypto.randomUUID()}`;
  const successorId = `new-policy-${crypto.randomUUID()}`;
  const key = `supersede-${oldId}`;
  await db
    .collection("policy_registry")
    .insertOne({
      policyId: oldId,
      revisionId: "old-rev",
      status: "adopted",
      publicationStatus: "published",
      jurisdiction: "State X",
    });
  await db
    .collection("policy_registry")
    .insertOne({
      policyId: successorId,
      revisionId: "new-rev",
      status: "adopted",
      publicationStatus: "unpublished",
    });
  const call = () =>
    supersedePolicy({
      request: new Request("http://localhost/api/admin/policies/supersede", {
        method: "POST",
        headers: {
          Cookie: "engage_dev_user=administrator",
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify({
          policyId: oldId,
          successorPolicyId: successorId,
          reason: "Newer policy adopted.",
        }),
      }),
      locals: { runtime: { env } },
    } as never);
  const response = await call();
  assert.equal(response.status, 201);
  const payload = (await response.json()) as {
    event: { successorRevisionId: string };
  };
  assert.equal(payload.event.successorRevisionId, "new-rev");
  assert.equal(
    (await db.collection("policy_registry").findOne({ policyId: oldId }))
      ?.publicationStatus,
    "superseded",
  );
  assert.equal((await call()).status, 200);
  const newKey = await supersedePolicy({
    request: new Request("http://localhost/api/admin/policies/supersede", {
      method: "POST",
      headers: {
        Cookie: "engage_dev_user=administrator",
        "Content-Type": "application/json",
        "Idempotency-Key": `${key}-again`,
      },
      body: JSON.stringify({
        policyId: oldId,
        successorPolicyId: successorId,
        reason: "Duplicate event should be rejected.",
      }),
    }),
    locals: { runtime: { env } },
  } as never);
  assert.equal(newKey.status, 409);
});

it("requires explicit replacement wording to resolve an overlapping stale amendment", async () => {
  const env = { APP_MODE: "development" };
  const db = await getDatabase(env);
  const proposalId = `conflict-${crypto.randomUUID()}`;
  const amendmentId = `conflict-amendment-${crypto.randomUUID()}`;
  const oldRevision = `old-${crypto.randomUUID()}`;
  const currentRevision = `current-${crypto.randomUUID()}`;
  await db
    .collection("proposal_revisions")
    .insertOne({
      proposalId,
      revisionId: oldRevision,
      createdAt: new Date(1),
      snapshot: { summary: "Old" },
    });
  await db
    .collection("proposal_revisions")
    .insertOne({
      proposalId,
      revisionId: currentRevision,
      createdAt: new Date(2),
      snapshot: { summary: "Changed" },
    });
  await db
    .collection("amendments")
    .insertOne({
      amendmentId,
      proposalId,
      baseRevisionId: oldRevision,
      status: "conflict",
      changes: { summary: "Suggested" },
      conflicts: ["summary"],
    });
  const call = (changes?: Record<string, unknown>) =>
    resolveAmendment({
      request: new Request("http://localhost/api/admin/amendments/resolve", {
        method: "POST",
        headers: {
          Cookie: "engage_dev_user=administrator",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amendmentId,
          outcome: "ready",
          reason: "Resolved against current wording.",
          ...(changes ? { changes } : {}),
        }),
      }),
      locals: { runtime: { env } },
    } as never);
  assert.equal((await call()).status, 409);
  assert.equal(
    (await call({ summary: "Explicitly reconciled wording" })).status,
    200,
  );
  const saved = await db.collection("amendments").findOne({ amendmentId });
  assert.equal(saved?.baseRevisionId, currentRevision);
  assert.equal(saved?.changes.summary, "Explicitly reconciled wording");
  assert.equal(saved?.status, "ready");
  assert.ok(saved?.currentRevisionId);
});
