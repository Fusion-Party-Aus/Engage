import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { MongoClient, type Db } from "mongodb";
import { BALLOT_OUTCOME_RULE_BASIS } from "./ballots.ts";
import { closeDatabase } from "./db.ts";
import { buildDecisionRecord } from "./decision-record.ts";
import type { SessionUser } from "./types.ts";
import { proposalBallotId } from "./vote-storage.ts";

// Persistence matters for this read model: it composes immutable revisions,
// amendment outcomes, a certified result and publication events written by
// separate domain paths. These cases run against a real MongoDB replica set;
// set VOTING_TEST_MONGODB_URI (the full suite expects it) to run them.
const mongoUri = process.env.VOTING_TEST_MONGODB_URI;

const viewer: SessionUser = {
  memberId: "member-record-viewer",
  name: "Record Viewer",
  email: "record-viewer@example.test",
  status: "verified",
  role: "member",
  roles: ["member"],
  permissions: { national: [], branches: {}, grants: [] },
  canParticipate: true,
  isStaff: false,
  isAdmin: false,
  isBranchAdmin: false,
  branchAdminIds: [],
  activeBranchIds: ["branch-nat"],
};

const now = new Date("2026-11-15T02:00:00Z");

describe(
  "decision record read model (real MongoDB replica set)",
  { skip: !mongoUri },
  () => {
    let client: MongoClient;
    let db: Db;

    before(async () => {
      client = await new MongoClient(mongoUri!).connect();
      db = client.db(
        `engage_decision_record_test_${crypto.randomUUID().replaceAll("-", "")}`,
      );
    });

    after(async () => {
      await closeDatabase();
      await db?.dropDatabase();
      await client?.close();
    });

    it("composes voted wording, an applied amendment, result and publication from stored documents", async () => {
      const proposalId = "PROP-RECORD-MONGO";
      const ballotId = proposalBallotId(proposalId);
      await db.collection("proposals").insertOne({
        proposalId,
        slug: "prop-record-mongo",
        title: "Real document decision record",
        summary: "A stored policy proposal.",
        details: "Proposal details.",
        outcomes: ["A stored outcome"],
        kind: "policy",
        stage: "implement",
        publicationScope: "national",
        ballotRevisionId: "rev-2",
        ballotClosesAt: new Date("2026-11-20T01:00:00Z"),
        authorId: "SECRET_AUTHOR_ID",
        authorName: "SECRET_AUTHOR_NAME",
        createdAt: now,
        updatedAt: now,
      });
      await db.collection("proposal_revisions").insertMany([
        {
          proposalId,
          revisionId: "rev-1",
          parentRevisionId: null,
          createdAt: new Date(now.getTime() - 2000),
          snapshot: {
            title: "Original wording",
            summary: "Original summary.",
            outcomes: ["Original outcome"],
            details: "Original detail.",
          },
          contentHash: "hash-rev-1",
          authorId: "SECRET_REVISION_AUTHOR",
        },
        {
          proposalId,
          revisionId: "rev-2",
          parentRevisionId: "rev-1",
          createdAt: now,
          snapshot: {
            title: "Amended wording",
            summary: "Amended summary.",
            outcomes: ["Amended outcome"],
            details: "Amended detail.",
          },
          contentHash: "hash-rev-2",
          authorId: "SECRET_REVISION_AUTHOR",
        },
      ]);
      await db.collection("amendments").insertOne({
        amendmentId: "AMD-MONGO-1",
        proposalId,
        baseRevisionId: "rev-1",
        currentRevisionId: "amendment-rev-1",
        ballotAmendmentRevisionId: "amendment-rev-1",
        changes: { title: "Amended wording" },
        status: "applied",
        appliedRevisionId: "rev-2",
        appliedAt: now,
        appliedBy: "SECRET_APPLIER_ID",
        authorId: "SECRET_AMENDMENT_AUTHOR",
        ballotDecision: { result: "endorsed", decidedAt: now },
        formalApproval: { amendmentRevisionId: "amendment-rev-1" },
        createdAt: new Date(now.getTime() - 1000),
      });
      await db.collection("ballots").insertOne({
        schemaVersion: 1,
        ballotId,
        matterId: proposalId,
        matterType: "policy",
        purpose: "matter_adoption",
        revisionId: "rev-2",
        electorate: { scope: "national", branchId: "branch-nat" },
        governanceAuthorityBranchId: "branch-nat",
        jurisdictionBranchId: "branch-nat",
        status: "certified",
        closesAt: new Date("2026-11-20T01:00:00Z"),
        openedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await db.collection("ballot_results").insertOne({
        decisionEventId: "DECISION-MONGO-1",
        ballotId,
        proposalId,
        matterId: proposalId,
        revisionId: "rev-2",
        result: "successful",
        computedResult: "successful",
        ruleBasis: BALLOT_OUTCOME_RULE_BASIS,
        tally: { approve: 11, abstain: 4, reject: 5, total: 20 },
        recordedBy: "SECRET_RECORDER_ID",
        recordedAt: now,
      });
      await db.collection("policy_registry").insertOne({
        policyId: proposalId,
        proposalId,
        title: "Real document decision record",
        status: "adopted",
        publicationStatus: "published",
        ratification: {
          ratifiedAt: now,
          ratifiedRevisionId: "rev-2",
          ratifiedBy: "SECRET_RECORDER_ID",
        },
        publishedAt: new Date("2026-11-16T01:00:00Z"),
      });
      await db.collection("publication_events").insertOne({
        eventId: "pub-mongo-1",
        policyId: proposalId,
        revisionId: "rev-2",
        status: "published",
        publishedBy: "SECRET_RECORDER_ID",
        publishedAt: new Date("2026-11-16T01:00:00Z"),
      });

      const record = await buildDecisionRecord(db, "prop-record-mongo", viewer);
      assert.ok(record);
      assert.equal(record.matter.stage, "implement");
      assert.equal(record.votedWording?.revisionId, "rev-2");
      assert.equal(record.votedWording?.contentHash, "hash-rev-2");
      assert.equal(record.revisionHistory.length, 2);
      assert.equal(record.amendments.length, 1);
      assert.equal(record.amendments[0]?.status, "applied");
      assert.equal(record.adoptedWording.state, "derived");
      if (record.adoptedWording.state === "derived") {
        assert.equal(record.adoptedWording.rule, "D16");
        assert.equal(record.adoptedWording.revision.revisionId, "rev-2");
        assert.equal(record.adoptedWording.revision.contentHash, "hash-rev-2");
        assert.equal(record.adoptedWording.viaAmendmentRevisionId, "amendment-rev-1");
      }
      assert.equal(record.ballot?.ballotId, ballotId);
      assert.equal(record.ballot?.boundToVotedWording, true);
      assert.equal(record.result?.computedResult, "successful");
      assert.deepEqual(record.result?.tally, {
        approve: 11,
        abstain: 4,
        reject: 5,
        total: 20,
      });
      assert.equal(record.publication.state, "recorded");
      assert.equal(record.publication.publicationStatus, "published");
      assert.equal(record.publication.ratifiedRevisionHash, "hash-rev-2");
      assert.equal(record.publication.events.length, 1);

      const serialised = JSON.stringify(record);
      for (const secret of [
        "SECRET_AUTHOR_ID",
        "SECRET_AUTHOR_NAME",
        "SECRET_REVISION_AUTHOR",
        "SECRET_AMENDMENT_AUTHOR",
        "SECRET_APPLIER_ID",
        "SECRET_RECORDER_ID",
      ]) {
        assert.equal(serialised.includes(secret), false, `leaked ${secret}`);
      }
    });

    it("requires collision review for two applied amendments stored together", async () => {
      const proposalId = "PROP-RECORD-COLLISION";
      await db.collection("proposals").insertOne({
        proposalId,
        slug: "prop-record-collision",
        title: "Collision matter",
        summary: "Two applied amendments.",
        details: "",
        stage: "implement",
        publicationScope: "national",
        ballotRevisionId: "rev-3",
        createdAt: now,
        updatedAt: now,
      });
      await db.collection("proposal_revisions").insertMany([
        {
          proposalId,
          revisionId: "rev-1",
          parentRevisionId: null,
          createdAt: new Date(now.getTime() - 3000),
          snapshot: { title: "Original", summary: "", outcomes: [], details: "" },
          contentHash: "hash-rev-1",
        },
        {
          proposalId,
          revisionId: "rev-2",
          parentRevisionId: "rev-1",
          createdAt: new Date(now.getTime() - 2000),
          snapshot: { title: "First", summary: "", outcomes: [], details: "" },
          contentHash: "hash-rev-2",
        },
        {
          proposalId,
          revisionId: "rev-3",
          parentRevisionId: "rev-2",
          createdAt: now,
          snapshot: { title: "Second", summary: "", outcomes: [], details: "" },
          contentHash: "hash-rev-3",
        },
      ]);
      await db.collection("amendments").insertMany([
        {
          amendmentId: "AMD-C1",
          proposalId,
          status: "applied",
          appliedRevisionId: "rev-2",
          appliedAt: now,
          createdAt: now,
        },
        {
          amendmentId: "AMD-C2",
          proposalId,
          status: "applied",
          appliedRevisionId: "rev-3",
          appliedAt: now,
          createdAt: now,
        },
      ]);
      await db.collection("ballot_results").insertOne({
        decisionEventId: "DECISION-COLLISION",
        ballotId: proposalBallotId(proposalId),
        proposalId,
        revisionId: "rev-3",
        result: "successful",
        tally: { approve: 5, abstain: 0, reject: 1, total: 6 },
        ruleBasis: BALLOT_OUTCOME_RULE_BASIS,
        computedResult: "successful",
        recordedAt: now,
      });

      const record = await buildDecisionRecord(db, proposalId, viewer);
      assert.ok(record);
      assert.equal(record.adoptedWording.state, "review-required");
      if (record.adoptedWording.state === "review-required") {
        assert.equal(record.adoptedWording.reason, "multiple-applied-amendments");
      }
      assert.equal(JSON.stringify(record.adoptedWording).includes('"revision"'), false);
    });
  },
);
