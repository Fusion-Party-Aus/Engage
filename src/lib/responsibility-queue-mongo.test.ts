import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { MongoClient, type Db } from "mongodb";
import {
  ALL_NATIONAL_PERMISSIONS,
  LEGACY_BRANCH_ADMIN_PERMISSIONS,
} from "./rbac.ts";
import { buildResponsibilityQueue } from "./responsibility-queue.ts";
import type { SessionUser } from "./types.ts";
import { proposalBallotId } from "./vote-storage.ts";

// The ballot and publication sources compose stored ballot rows, recorded
// results, a matter fallback and the policy registry. These cases run against
// a real MongoDB replica set; set VOTING_TEST_MONGODB_URI to run them.
const mongoUri = process.env.VOTING_TEST_MONGODB_URI;

const now = new Date("2026-11-15T02:00:00Z");
const DAY = 86_400_000;

const nationalAdmin: SessionUser = {
  memberId: "member-queue-admin",
  name: "Queue Administrator",
  email: "queue-admin@example.test",
  role: "administrator",
  roles: ["member", "administrator"],
  status: "verified",
  canParticipate: true,
  isStaff: true,
  isAdmin: true,
  isBranchAdmin: false,
  branchAdminIds: [],
  permissions: {
    national: [...ALL_NATIONAL_PERMISSIONS],
    branches: {},
    grants: [],
  },
};

function branchAdmin(branchId: string): SessionUser {
  return {
    memberId: `member-queue-${branchId}`,
    name: "Branch Administrator",
    email: `${branchId}@example.test`,
    role: "member",
    roles: ["member"],
    status: "verified",
    canParticipate: true,
    isStaff: false,
    isAdmin: false,
    isBranchAdmin: true,
    branchAdminIds: [branchId],
    permissions: {
      national: [],
      branches: { [branchId]: [...LEGACY_BRANCH_ADMIN_PERMISSIONS] },
      grants: [],
    },
  };
}

describe(
  "responsibility queue (real MongoDB replica set)",
  { skip: !mongoUri },
  () => {
    let client: MongoClient;
    let db: Db;

    before(async () => {
      client = await new MongoClient(mongoUri!).connect();
      db = client.db(
        `engage_rq_test_${crypto.randomUUID().replaceAll("-", "")}`,
      );
    });

    after(async () => {
      await db?.dropDatabase();
      await client?.close();
    });

    it("derives ballot and publication items from stored documents", async () => {
      await db.collection("proposals").insertMany([
        {
          proposalId: "PROP-QUEUE-OVERDUE",
          slug: "prop-queue-overdue",
          title: "Overdue ballot",
          stage: "decide",
          ballotRevisionId: "rev-overdue",
          ballotClosesAt: new Date(now.getTime() - 3 * DAY),
          originatingBranchId: "branch-nat",
          governanceAuthorityBranchId: "branch-nat",
          jurisdictionBranchId: "branch-nat",
          createdAt: now,
          updatedAt: now,
        },
        {
          proposalId: "PROP-QUEUE-SOON",
          slug: "prop-queue-soon",
          title: "Closing ballot",
          stage: "decide",
          ballotRevisionId: "rev-soon",
          ballotClosesAt: new Date(now.getTime() + 3 * DAY),
          originatingBranchId: "branch-nat",
          governanceAuthorityBranchId: "branch-nat",
          jurisdictionBranchId: "branch-nat",
          createdAt: now,
          updatedAt: now,
        },
        {
          proposalId: "PROP-QUEUE-DONE",
          slug: "prop-queue-done",
          title: "Recorded ballot",
          stage: "decide",
          ballotRevisionId: "rev-done",
          ballotClosesAt: new Date(now.getTime() - 4 * DAY),
          originatingBranchId: "branch-nat",
          governanceAuthorityBranchId: "branch-nat",
          jurisdictionBranchId: "branch-nat",
          createdAt: now,
          updatedAt: now,
        },
        {
          proposalId: "PROP-QUEUE-UNBOUND",
          slug: "prop-queue-unbound",
          title: "Unbound ballot",
          stage: "decide",
          originatingBranchId: "branch-nat",
          governanceAuthorityBranchId: "branch-nat",
          jurisdictionBranchId: "branch-nat",
          createdAt: now,
          updatedAt: now,
        },
      ]);
      await db.collection("ballots").insertMany([
        {
          ballotId: proposalBallotId("PROP-QUEUE-OVERDUE"),
          matterId: "PROP-QUEUE-OVERDUE",
          matterType: "policy",
          purpose: "matter_adoption",
          revisionId: "rev-overdue",
          electorate: { scope: "national", branchId: "branch-nat" },
          governanceAuthorityBranchId: "branch-nat",
          jurisdictionBranchId: "branch-nat",
          status: "closed",
          closesAt: new Date(now.getTime() - 3 * DAY),
          openedAt: now,
          createdAt: now,
          updatedAt: now,
        },
        {
          ballotId: proposalBallotId("PROP-QUEUE-SOON"),
          matterId: "PROP-QUEUE-SOON",
          matterType: "policy",
          purpose: "matter_adoption",
          revisionId: "rev-soon",
          electorate: { scope: "national", branchId: "branch-nat" },
          governanceAuthorityBranchId: "branch-nat",
          jurisdictionBranchId: "branch-nat",
          status: "open",
          closesAt: new Date(now.getTime() + 3 * DAY),
          openedAt: now,
          createdAt: now,
          updatedAt: now,
        },
        {
          ballotId: proposalBallotId("PROP-QUEUE-DONE"),
          matterId: "PROP-QUEUE-DONE",
          matterType: "policy",
          purpose: "matter_adoption",
          revisionId: "rev-done",
          electorate: { scope: "national", branchId: "branch-nat" },
          governanceAuthorityBranchId: "branch-nat",
          jurisdictionBranchId: "branch-nat",
          status: "certified",
          closesAt: new Date(now.getTime() - 4 * DAY),
          openedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      ]);
      await db.collection("ballot_results").insertOne({
        decisionEventId: "decision-recorded",
        ballotId: proposalBallotId("PROP-QUEUE-DONE"),
        proposalId: "PROP-QUEUE-DONE",
        matterId: "PROP-QUEUE-DONE",
        revisionId: "rev-done",
        result: "successful",
        recordedBy: "SECRET-RECORDER",
        recordedAt: now,
      });
      await db.collection("policy_registry").insertMany([
        {
          policyId: "POL-QUEUE-UNPUBLISHED",
          title: "Adopted but unpublished",
          kind: "policy",
          status: "adopted",
          publicationStatus: "unpublished",
          ratifiedAt: new Date(now.getTime() - 2 * DAY),
          ratification: { decisionEventId: "decision-recorded" },
        },
        {
          policyId: "POL-QUEUE-PUBLISHED",
          title: "Already published",
          kind: "policy",
          status: "adopted",
          publicationStatus: "published",
        },
      ]);

      const queue = await buildResponsibilityQueue(db, nationalAdmin, { now });
      const keys = queue.groups.map((entry) => entry.key);
      assert.deepEqual(keys, [
        "ballot-outcome",
        "ballot-closing",
        "ballot-binding",
        "policy-publication",
      ]);
      const outcome = queue.groups.find((entry) => entry.key === "ballot-outcome");
      assert.deepEqual(
        outcome?.items.map((item) => item.title),
        ["Overdue ballot"],
      );
      const closing = queue.groups.find((entry) => entry.key === "ballot-closing");
      assert.deepEqual(
        closing?.items.map((item) => item.title),
        ["Closing ballot"],
      );
      const binding = queue.groups.find((entry) => entry.key === "ballot-binding");
      assert.deepEqual(
        binding?.items.map((item) => item.title),
        ["Unbound ballot"],
      );
      const publication = queue.groups.find(
        (entry) => entry.key === "policy-publication",
      );
      assert.deepEqual(
        publication?.items.map((item) => item.title),
        ["Adopted but unpublished"],
      );
      assert.equal(JSON.stringify(queue).includes("SECRET-RECORDER"), false);
    });

    it("gives a branch administrator only their own branch's stored ballot", async () => {
      const branchMatter = (proposalId: string, branchId: string) => ({
        proposalId,
        slug: proposalId.toLowerCase(),
        title: `${branchId} matter`,
        stage: "decide",
        ballotRevisionId: `rev-${branchId}`,
        ballotClosesAt: new Date(now.getTime() - DAY),
        originatingBranchId: branchId,
        governanceAuthorityBranchId: branchId,
        jurisdictionBranchId: branchId,
        createdAt: now,
        updatedAt: now,
      });
      await db.collection("proposals").insertMany([
        branchMatter("PROP-QUEUE-A", "branch-a"),
        branchMatter("PROP-QUEUE-B", "branch-b"),
      ]);
      await db.collection("ballots").insertMany(
        ["branch-a", "branch-b"].map((branchId) => ({
          ballotId: proposalBallotId(branchId === "branch-a" ? "PROP-QUEUE-A" : "PROP-QUEUE-B"),
          matterId: branchId === "branch-a" ? "PROP-QUEUE-A" : "PROP-QUEUE-B",
          matterType: "policy",
          purpose: "matter_adoption",
          revisionId: `rev-${branchId}`,
          electorate: { scope: "branch", branchId },
          governanceAuthorityBranchId: branchId,
          jurisdictionBranchId: branchId,
          status: "closed",
          closesAt: new Date(now.getTime() - DAY),
          openedAt: now,
          createdAt: now,
          updatedAt: now,
        })),
      );

      const queue = await buildResponsibilityQueue(db, branchAdmin("branch-a"), {
        now,
      });
      const titles = queue.groups.flatMap((entry) =>
        entry.items.map((item) => item.title),
      );
      assert.deepEqual(titles, ["branch-a matter"]);
      assert.equal(queue.groups.some((entry) => entry.key === "policy-publication"), false);
    });
  },
);
