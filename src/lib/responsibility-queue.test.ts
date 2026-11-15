import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Db } from "mongodb";
import { createMemoryDb } from "./db.ts";
import {
  LEGACY_BRANCH_ADMIN_PERMISSIONS,
  LEGACY_MODERATOR_PERMISSIONS,
  ALL_NATIONAL_PERMISSIONS,
  type PermissionKey,
} from "./rbac.ts";
import {
  buildResponsibilityQueue,
  viewerHasResponsibility,
  type ResponsibilityQueue,
} from "./responsibility-queue.ts";
import type { SessionUser } from "./types.ts";
import { proposalBallotId } from "./vote-storage.ts";

const now = new Date("2026-11-15T02:00:00Z");
const DAY = 86_400_000;

function viewer(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    memberId: "member-viewer",
    name: "Viewer",
    email: "viewer@example.test",
    role: "member",
    roles: ["member"],
    status: "verified",
    canParticipate: true,
    isStaff: false,
    isAdmin: false,
    isBranchAdmin: false,
    branchAdminIds: [],
    activeBranchIds: [],
    permissions: { national: [], branches: {}, grants: [] },
    ...overrides,
  };
}

const nationalAdmin = viewer({
  memberId: "member-national-admin",
  role: "administrator",
  roles: ["member", "administrator"],
  isStaff: true,
  isAdmin: true,
  permissions: {
    national: [...ALL_NATIONAL_PERMISSIONS],
    branches: {},
    grants: [],
  },
});

const moderator = viewer({
  memberId: "member-moderator",
  role: "moderator",
  roles: ["member", "moderator"],
  isStaff: true,
  permissions: {
    national: [...LEGACY_MODERATOR_PERMISSIONS],
    branches: {},
    grants: [],
  },
});

function branchAdmin(
  branchId: string,
  permissions: PermissionKey[] = [...LEGACY_BRANCH_ADMIN_PERMISSIONS],
): SessionUser {
  return viewer({
    memberId: `member-admin-${branchId}`,
    isBranchAdmin: true,
    branchAdminIds: [branchId],
    permissions: {
      national: [],
      branches: { [branchId]: permissions },
      grants: [],
    },
  });
}

async function seedMatter(
  db: Db,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const proposalId = String(overrides.proposalId ?? "PROP-QUEUE");
  await db.collection("proposals").insertOne({
    proposalId,
    slug: proposalId.toLowerCase(),
    title: overrides.title ?? `Matter ${proposalId}`,
    stage: "decide",
    ballotRevisionId: "rev-1",
    ballotClosesAt: new Date(now.getTime() + 3 * DAY),
    originatingBranchId: "branch-a",
    governanceAuthorityBranchId: "branch-a",
    jurisdictionBranchId: "branch-a",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  return proposalId;
}

async function seedBallot(
  db: Db,
  proposalId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const ballotId = proposalBallotId(proposalId);
  await db.collection("ballots").insertOne({
    ballotId,
    matterId: proposalId,
    matterType: "policy",
    purpose: "matter_adoption",
    revisionId: "rev-1",
    electorate: { scope: "branch", branchId: "branch-a" },
    governanceAuthorityBranchId: "branch-a",
    jurisdictionBranchId: "branch-a",
    status: "open",
    closesAt: new Date(now.getTime() + 3 * DAY),
    openedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  return ballotId;
}

async function seedResult(
  db: Db,
  proposalId: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await db.collection("ballot_results").insertOne({
    decisionEventId: `decision-${proposalId}`,
    ballotId: proposalBallotId(proposalId),
    proposalId,
    matterId: proposalId,
    revisionId: "rev-1",
    result: "successful",
    recordedBy: "SECRET-RECORDER",
    recordedAt: now,
    ...overrides,
  });
}

function group(queue: ResponsibilityQueue, key: string) {
  return queue.groups.find((entry) => entry.key === key);
}

function allItems(queue: ResponsibilityQueue) {
  return queue.groups.flatMap((entry) => entry.items);
}

describe("responsibility queue read model", () => {
  it("lists a closed ballot without an outcome, and closing soon only for an open ballot inside seven days", async () => {
    const db = createMemoryDb();
    await seedMatter(db, {
      proposalId: "PROP-OVERDUE",
      title: "Overdue outcome",
      ballotClosesAt: new Date(now.getTime() - 2 * DAY),
    });
    await seedBallot(db, "PROP-OVERDUE", {
      closesAt: new Date(now.getTime() - 2 * DAY),
    });
    await seedMatter(db, {
      proposalId: "PROP-CLOSING",
      title: "Closing ballot",
      ballotClosesAt: new Date(now.getTime() + 3 * DAY),
    });
    await seedBallot(db, "PROP-CLOSING");
    await seedMatter(db, {
      proposalId: "PROP-LATER",
      title: "Later ballot",
      ballotClosesAt: new Date(now.getTime() + 15 * DAY),
    });
    await seedBallot(db, "PROP-LATER", {
      closesAt: new Date(now.getTime() + 15 * DAY),
    });
    await seedMatter(db, {
      proposalId: "PROP-RECORDED",
      title: "Recorded ballot",
      ballotClosesAt: new Date(now.getTime() - 2 * DAY),
    });
    await seedBallot(db, "PROP-RECORDED", {
      closesAt: new Date(now.getTime() - 2 * DAY),
      status: "closed",
    });
    await seedResult(db, "PROP-RECORDED");

    const queue = await buildResponsibilityQueue(db, nationalAdmin, { now });
    const outcome = group(queue, "ballot-outcome");
    const closing = group(queue, "ballot-closing");

    assert.ok(outcome);
    assert.deepEqual(
      outcome.items.map((item) => item.title),
      ["Overdue outcome"],
    );
    assert.equal(outcome.items[0]?.permission, "ballots.record_result");
    assert.equal(outcome.items[0]?.actionLabel, "Record outcome");
    assert.equal(
      outcome.items[0]?.href,
      "/admin/proposals/prop-overdue/#record-outcome",
    );

    assert.ok(closing);
    assert.deepEqual(
      closing.items.map((item) => item.title),
      ["Closing ballot"],
    );
    assert.equal(closing.items[0]?.actionLabel, "View ballot");

    const titles = allItems(queue).map((item) => item.title);
    assert.equal(titles.includes("Later ballot"), false);
    assert.equal(titles.includes("Recorded ballot"), false);
    // A still-open ballot never appears as a recorded-outcome task.
    assert.equal(
      outcome.items.some((item) => item.title === "Closing ballot"),
      false,
    );
    assert.equal(queue.groups[0]?.key, "ballot-outcome");
    assert.equal(queue.groups[1]?.key, "ballot-closing");
  });

  it("asks for wording binding only while a Decide matter has no bound revision", async () => {
    const db = createMemoryDb();
    await seedMatter(db, {
      proposalId: "PROP-UNBOUND",
      title: "Unbound matter",
      ballotRevisionId: undefined,
    });
    await seedBallot(db, "PROP-UNBOUND", { revisionId: "" });
    await seedMatter(db, {
      proposalId: "PROP-BOUND",
      title: "Bound matter",
      ballotRevisionId: "rev-1",
    });
    await seedBallot(db, "PROP-BOUND");

    const queue = await buildResponsibilityQueue(db, nationalAdmin, { now });
    const binding = group(queue, "ballot-binding");
    assert.ok(binding);
    assert.deepEqual(
      binding.items.map((item) => item.actionLabel),
      ["Bind wording"],
    );
    assert.equal(binding.items[0]?.permission, "ballots.bind");
    assert.equal(binding.items[0]?.title, "Unbound matter");
  });

  it("reports overdue advancement, and points to the blocking amendment instead of forcing an advance", async () => {
    const db = createMemoryDb();
    await seedMatter(db, {
      proposalId: "PROP-LATE",
      title: "Late deliberation",
      stage: "deliberate",
      ballotRevisionId: undefined,
      deliberationEndsAt: new Date(now.getTime() - DAY),
    });
    await seedMatter(db, {
      proposalId: "PROP-DUE-SOON",
      title: "Deliberation still running",
      stage: "deliberate",
      ballotRevisionId: undefined,
      deliberationEndsAt: new Date(now.getTime() + DAY),
    });
    await seedMatter(db, {
      proposalId: "PROP-BLOCKED",
      title: "Blocked deliberation",
      stage: "deliberate",
      ballotRevisionId: undefined,
      deliberationEndsAt: new Date(now.getTime() - 2 * DAY),
    });
    await db.collection("amendments").insertOne({
      amendmentId: "AMD-BLOCKING",
      proposalId: "PROP-BLOCKED",
      status: "proposed",
      changes: { title: "Blocking change" },
    });

    const queue = await buildResponsibilityQueue(db, nationalAdmin, { now });
    const advancement = group(queue, "advancement");
    assert.ok(advancement);
    assert.equal(advancement.items.length, 2);
    const late = advancement.items.find((item) => item.title === "Late deliberation");
    assert.equal(late?.actionLabel, "Advance proposal");
    assert.equal(late?.permission, "ballots.bind");
    const blocked = advancement.items.find(
      (item) => item.title === "Blocked deliberation",
    );
    assert.equal(blocked?.actionLabel, "Review amendment");
    assert.equal(blocked?.permission, "amendments.resolve");
    assert.match(blocked?.reason ?? "", /amendment is unresolved/);
    assert.equal(
      advancement.items.some((item) => item.title === "Deliberation still running"),
      false,
    );
  });

  it("lists only amendment states that have an existing officer action", async () => {
    const db = createMemoryDb();
    await seedMatter(db, {
      proposalId: "PROP-AMEND",
      title: "Amendment matter",
      stage: "decide",
      ballotRevisionId: "rev-ballot",
      ballotClosesAt: new Date(now.getTime() + 10 * DAY),
    });
    await db.collection("proposal_revisions").insertOne({
      proposalId: "PROP-AMEND",
      revisionId: "rev-ballot",
      createdAt: now,
      snapshot: { title: "Wording", summary: "", outcomes: [], details: "" },
    });
    await db.collection("amendment_revisions").insertOne({
      amendmentId: "AMD-READY",
      revisionId: "amd-rev-ready",
      createdAt: now,
    });
    for (const amendment of [
      {
        amendmentId: "AMD-PROPOSED",
        proposalId: "PROP-AMEND",
        status: "proposed",
        changes: { title: "Review me" },
        baseRevisionId: "rev-ballot",
        createdAt: now,
      },
      {
        amendmentId: "AMD-READY",
        proposalId: "PROP-AMEND",
        status: "ready",
        changes: { title: "Ballot me" },
        baseRevisionId: "rev-ballot",
        currentRevisionId: "amd-rev-ready",
        createdAt: now,
      },
      {
        amendmentId: "AMD-APPLIED",
        proposalId: "PROP-AMEND",
        status: "applied",
        changes: { title: "Already done" },
        appliedRevisionId: "rev-ballot",
        createdAt: now,
      },
    ]) {
      await db.collection("amendments").insertOne(amendment);
    }
    await seedMatter(db, {
      proposalId: "PROP-ACCEPT",
      title: "Accepted amendment matter",
      stage: "deliberate",
      ballotRevisionId: undefined,
      deliberationEndsAt: new Date(now.getTime() + 5 * DAY),
    });
    await db.collection("proposal_revisions").insertOne({
      proposalId: "PROP-ACCEPT",
      revisionId: "rev-base",
      createdAt: now,
      snapshot: { title: "Base", summary: "", outcomes: [], details: "" },
    });
    await db.collection("amendments").insertOne({
      amendmentId: "AMD-ACCEPTED",
      proposalId: "PROP-ACCEPT",
      status: "accepted",
      changes: { title: "Apply me" },
      baseRevisionId: "rev-base",
      createdAt: now,
    });

    const queue = await buildResponsibilityQueue(db, nationalAdmin, { now });
    const amendments = group(queue, "amendments");
    assert.ok(amendments);
    assert.deepEqual(
      amendments.items.map((item) => [item.title, item.actionLabel]),
      [
        ["Review me", "Review amendment"],
        ["Ballot me", "Open ballot"],
        ["Apply me", "Apply amendment"],
      ],
    );
    assert.equal(
      amendments.items.some((item) => item.title === "Already done"),
      false,
    );
    assert.deepEqual(
      amendments.items.map((item) => item.permission),
      ["amendments.resolve", "amendments.manage_ballot", "amendments.apply"],
    );
  });

  it("lists an overdue endorsement ballot and an endorsed amendment only when the next act exists", async () => {
    const db = createMemoryDb();
    await seedMatter(db, {
      proposalId: "PROP-ENDORSE",
      title: "Endorsement matter",
      stage: "decide",
      ballotRevisionId: "rev-endorse",
      ballotClosesAt: new Date(now.getTime() + 12 * DAY),
    });
    await db.collection("amendments").insertOne({
      amendmentId: "AMD-ENDORSED",
      proposalId: "PROP-ENDORSE",
      status: "endorsed",
      changes: { title: "Add a rural guarantee" },
      baseRevisionId: "rev-endorse",
      currentRevisionId: "amd-rev-endorsed",
      ballotRevisionId: "rev-endorse",
      ballotAmendmentRevisionId: "amd-rev-endorsed",
      ballotDecision: { result: "endorsed" },
      createdAt: now,
    });
    await db.collection("amendment_revisions").insertOne({
      amendmentId: "AMD-ENDORSED",
      revisionId: "amd-rev-endorsed",
      createdAt: now,
    });
    await db.collection("amendments").insertOne({
      amendmentId: "AMD-VOTING",
      proposalId: "PROP-ENDORSE",
      status: "voting",
      changes: { title: "Close the rural ballot" },
      baseRevisionId: "rev-endorse",
      ballotRevisionId: "rev-endorse",
      ballotClosesAt: new Date(now.getTime() - DAY),
      createdAt: now,
    });
    await db.collection("amendments").insertOne({
      amendmentId: "AMD-VOTING-LATER",
      proposalId: "PROP-ENDORSE",
      status: "voting",
      changes: { title: "Still open" },
      baseRevisionId: "rev-endorse",
      ballotRevisionId: "rev-endorse",
      ballotClosesAt: new Date(now.getTime() + 2 * DAY),
      createdAt: now,
    });
    await db.collection("amendments").insertOne({
      amendmentId: "AMD-ENDORSED-INCOMPLETE",
      proposalId: "PROP-ENDORSE",
      status: "endorsed",
      changes: { title: "Incomplete endorsement" },
      baseRevisionId: "rev-endorse",
      currentRevisionId: "amd-rev-endorsed",
      ballotRevisionId: "rev-endorse",
      createdAt: now,
    });

    const queue = await buildResponsibilityQueue(db, nationalAdmin, { now });
    const amendments = group(queue, "amendments");
    assert.ok(amendments);
    assert.deepEqual(
      amendments.items.map((item) => [item.title, item.actionLabel]),
      [
        ["Close the rural ballot", "Close ballot"],
        ["Add a rural guarantee", "Record approval"],
      ],
    );
    assert.equal(
      amendments.items.some((item) => item.title === "Still open"),
      false,
    );
    assert.equal(
      amendments.items.some((item) => item.title === "Incomplete endorsement"),
      false,
    );
  });

  it("excludes an archived matter's amendments", async () => {
    const db = createMemoryDb();
    await seedMatter(db, {
      proposalId: "PROP-ARCHIVED",
      title: "Archived matter",
      stage: "archived",
      ballotRevisionId: undefined,
    });
    await db.collection("amendments").insertOne({
      amendmentId: "AMD-ARCHIVED",
      proposalId: "PROP-ARCHIVED",
      status: "proposed",
      changes: { title: "Stale amendment" },
      createdAt: now,
    });
    const queue = await buildResponsibilityQueue(db, nationalAdmin, { now });
    assert.equal(group(queue, "amendments"), undefined);
  });

  it("reports a verification count without personal detail and only ratified unpublished policies", async () => {
    const db = createMemoryDb();
    for (const membership of [
      { memberId: "SECRET-MEMBER-1", status: "pending" },
      { memberId: "SECRET-MEMBER-2", status: "pending" },
      { memberId: "SECRET-MEMBER-3", status: "verified" },
    ]) {
      await db.collection("memberships").insertOne(membership);
    }
    await db.collection("membership_verification_reviews").insertOne({
      reviewId: "review-1",
      memberId: "SECRET-MEMBER-2",
      reason: "ambiguous",
      status: "open",
    });
    for (const policy of [
      {
        policyId: "POL-UNPUBLISHED",
        title: "Coastal policy",
        kind: "policy",
        status: "adopted",
        publicationStatus: "unpublished",
        ratifiedAt: new Date(now.getTime() - 4 * DAY),
      },
      {
        policyId: "POL-PUBLISHED",
        title: "Published policy",
        kind: "policy",
        status: "adopted",
        publicationStatus: "published",
      },
      {
        policyId: "GOV-REGISTRY-ROW",
        proposalId: "GOV-1",
        title: "Governance resolution",
        status: "adopted",
        publicationStatus: "unpublished",
      },
    ]) {
      await db.collection("policy_registry").insertOne(policy);
    }
    await db.collection("proposals").insertOne({
      proposalId: "GOV-1",
      kind: "resolution",
      stage: "implement",
    });

    const queue = await buildResponsibilityQueue(db, nationalAdmin, { now });
    const verification = group(queue, "member-verification");
    assert.ok(verification);
    assert.equal(verification.count, 2);
    assert.equal(verification.items.length, 1);
    assert.equal(verification.items[0]?.title, "2 members to verify");
    assert.equal(verification.items[0]?.actionLabel, "Review members");
    assert.equal(verification.items[0]?.href, "/admin/members/");

    const publication = group(queue, "policy-publication");
    assert.ok(publication);
    assert.deepEqual(
      publication.items.map((item) => item.title),
      ["Coastal policy"],
    );

    const serialised = JSON.stringify(queue);
    for (const secret of [
      "SECRET-MEMBER-1",
      "SECRET-MEMBER-2",
      "SECRET-MEMBER-3",
      "@example.test",
      '"approve"',
      '"reject"',
      '"abstain"',
      "tally",
      "proposalId",
      "governanceAuthorityBranchId",
    ]) {
      assert.equal(
        serialised.includes(secret),
        false,
        `queue leaked ${secret}`,
      );
    }
  });

  it("excludes every item a moderator cannot act on and gives a national administrator every group", async () => {
    const db = createMemoryDb();
    await seedMatter(db, {
      proposalId: "PROP-A",
      title: "Branch A matter",
      ballotClosesAt: new Date(now.getTime() - DAY),
    });
    await seedBallot(db, "PROP-A", { closesAt: new Date(now.getTime() - DAY) });
    await db.collection("memberships").insertOne({
      memberId: "member-pending",
      status: "pending",
    });
    await db.collection("policy_registry").insertOne({
      policyId: "POL-A",
      title: "Adopted policy",
      status: "adopted",
      publicationStatus: "unpublished",
    });

    const moderatorQueue = await buildResponsibilityQueue(db, moderator, { now });
    assert.deepEqual(moderatorQueue.groups, []);
    assert.equal(moderatorQueue.total, 0);
    assert.equal(moderatorQueue.hasResponsibility, false);
    assert.equal(viewerHasResponsibility(moderator), false);

    const adminQueue = await buildResponsibilityQueue(db, nationalAdmin, { now });
    assert.ok(adminQueue.groups.length >= 3);
    assert.equal(adminQueue.hasResponsibility, true);
    assert.deepEqual(
      adminQueue.groups.map((entry) => entry.key),
      ["ballot-outcome", "member-verification", "policy-publication"],
    );
  });

  it("limits a branch administrator to their own branch", async () => {
    const db = createMemoryDb();
    await seedMatter(db, {
      proposalId: "PROP-A",
      title: "Branch A matter",
      ballotClosesAt: new Date(now.getTime() - DAY),
    });
    await seedBallot(db, "PROP-A", { closesAt: new Date(now.getTime() - DAY) });
    await seedMatter(db, {
      proposalId: "PROP-B",
      title: "Branch B matter",
      originatingBranchId: "branch-b",
      governanceAuthorityBranchId: "branch-b",
      jurisdictionBranchId: "branch-b",
      ballotClosesAt: new Date(now.getTime() - DAY),
    });
    await seedBallot(db, "PROP-B", {
      closesAt: new Date(now.getTime() - DAY),
      governanceAuthorityBranchId: "branch-b",
      jurisdictionBranchId: "branch-b",
    });

    const queue = await buildResponsibilityQueue(db, branchAdmin("branch-a"), {
      now,
    });
    assert.deepEqual(allItems(queue).map((item) => item.title), [
      "Branch A matter",
    ]);
    assert.equal(viewerHasResponsibility(branchAdmin("branch-a")), true);

    const mismatched = viewer({
      memberId: "member-cross-scope",
      isBranchAdmin: true,
      branchAdminIds: ["branch-b"],
      permissions: {
        national: [],
        branches: { "branch-b": ["ballots.record_result"] },
        grants: [],
      },
    });
    const mismatchedQueue = await buildResponsibilityQueue(db, mismatched, {
      now,
    });
    const mismatchedTitles = allItems(mismatchedQueue).map((item) => item.title);
    assert.equal(mismatchedTitles.includes("Branch A matter"), false);
    assert.deepEqual(mismatchedTitles, ["Branch B matter"]);
  });

  it("returns an empty queue for an administrator with nothing outstanding", async () => {
    const db = createMemoryDb();
    const queue = await buildResponsibilityQueue(db, nationalAdmin, { now });
    assert.deepEqual(queue.groups, []);
    assert.equal(queue.total, 0);
    assert.equal(queue.hasResponsibility, true);
  });

  it("degrades only the failing source and never returns the error object", async () => {
    const db = createMemoryDb();
    await seedMatter(db, {
      proposalId: "PROP-FAIL",
      title: "Closed matter",
      ballotClosesAt: new Date(now.getTime() - DAY),
    });
    await seedBallot(db, "PROP-FAIL", {
      closesAt: new Date(now.getTime() - DAY),
    });
    await db.collection("policy_registry").insertOne({
      policyId: "POL-FAIL",
      title: "Unpublished policy",
      status: "adopted",
      publicationStatus: "unpublished",
    });
    const failing = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "collection") {
          return (name: string) => {
            if (name === "ballots") throw new Error("SECRET-DB-ERROR");
            return target.collection(name);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as Db;

    const queue = await buildResponsibilityQueue(failing, nationalAdmin, { now });
    const failed = group(queue, "ballot-outcome");
    assert.ok(failed);
    assert.equal(
      failed.error,
      "Couldn't load ballot responsibilities just now.",
    );
    assert.deepEqual(failed.items, []);
    assert.ok(JSON.stringify(queue).includes("SECRET-DB-ERROR") === false);
    assert.deepEqual(
      group(queue, "policy-publication")?.items.map((item) => item.title),
      ["Unpublished policy"],
    );
  });

  it("orders groups and items deterministically", async () => {
    const db = createMemoryDb();
    await seedMatter(db, {
      proposalId: "PROP-LATE",
      title: "Later closing",
      ballotClosesAt: new Date(now.getTime() + 6 * DAY),
    });
    await seedBallot(db, "PROP-LATE", {
      closesAt: new Date(now.getTime() + 6 * DAY),
    });
    await seedMatter(db, {
      proposalId: "PROP-SOON",
      title: "Sooner closing",
      ballotClosesAt: new Date(now.getTime() + 2 * DAY),
    });
    await seedBallot(db, "PROP-SOON", {
      closesAt: new Date(now.getTime() + 2 * DAY),
    });
    await seedMatter(db, {
      proposalId: "PROP-UNBOUND",
      title: "Unbound",
      ballotRevisionId: undefined,
    });
    await seedBallot(db, "PROP-UNBOUND");

    const first = await buildResponsibilityQueue(db, nationalAdmin, { now });
    const second = await buildResponsibilityQueue(db, nationalAdmin, { now });
    assert.deepEqual(first, second);
    assert.deepEqual(
      first.groups.map((entry) => entry.key),
      ["ballot-closing", "ballot-binding"],
    );
    assert.deepEqual(
      group(first, "ballot-closing")?.items.map((item) => item.title),
      ["Sooner closing", "Later closing"],
    );
  });
});
