import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Db } from "mongodb";
import { BALLOT_OUTCOME_RULE_BASIS } from "./ballots.ts";
import { createMemoryDb } from "./db.ts";
import {
  buildDecisionRecord,
  deriveAdoptedWording,
  type DecisionRecord,
} from "./decision-record.ts";
import type { SessionUser } from "./types.ts";
import { PROPOSAL_VOTES, proposalBallotId } from "./vote-storage.ts";

const nationalMember = (memberId = "member-viewer"): SessionUser => ({
  memberId,
  name: "Member Viewer",
  email: `${memberId}@example.test`,
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
});

const now = new Date("2026-11-15T01:00:00Z");

interface SeedRevision {
  revisionId: string;
  title: string;
  details: string;
  createdAt?: Date;
}

async function seedMatter(
  db: Db,
  input: {
    proposalId?: string;
    slug?: string;
    stage?: string;
    publicationScope?: string;
    ballotRevisionId?: string;
    revisions?: SeedRevision[];
    amendments?: Array<Record<string, unknown>>;
    result?: Record<string, unknown> | null;
    ballotClosesAt?: Date;
  } = {},
): Promise<string> {
  const proposalId = input.proposalId ?? "PROP-RECORD";
  const slug = input.slug ?? proposalId.toLowerCase();
  await db.collection("proposals").insertOne({
    proposalId,
    slug,
    title: "Decision record matter",
    summary: "A matter used to verify the decision record.",
    details: "Proposal detail.",
    outcomes: ["An agreed outcome"],
    kind: "policy",
    stage: input.stage ?? "implement",
    publicationScope: input.publicationScope ?? "national",
    ballotRevisionId: input.ballotRevisionId,
    ballotClosesAt: input.ballotClosesAt ?? new Date("2026-11-20T01:00:00Z"),
    authorId: "SECRET_AUTHOR_ID",
    authorName: "SECRET_AUTHOR_NAME",
    createdAt: now,
    updatedAt: now,
  });
  for (const [index, revision] of (input.revisions ?? []).entries()) {
    await db.collection("proposal_revisions").insertOne({
      proposalId,
      revisionId: revision.revisionId,
      parentRevisionId:
        index === 0 ? null : input.revisions![index - 1]!.revisionId,
      createdAt: revision.createdAt ?? new Date(now.getTime() + index * 1000),
      snapshot: {
        title: revision.title,
        summary: `Summary for ${revision.title}`,
        outcomes: [`Outcome for ${revision.title}`],
        details: revision.details,
      },
      contentHash: `hash-${revision.revisionId}`,
      authorId: "SECRET_REVISION_AUTHOR",
    });
  }
  for (const [index, amendment] of (input.amendments ?? []).entries()) {
    await db.collection("amendments").insertOne({
      amendmentId: `AMD-${index + 1}`,
      proposalId,
      baseRevisionId: input.revisions?.[0]?.revisionId ?? null,
      currentRevisionId: "SECRET_AMENDMENT_REVISION",
      changes: { title: `Amendment ${index + 1}` },
      status: "proposed",
      authorId: "SECRET_AMENDMENT_AUTHOR",
      createdAt: now,
      ...amendment,
    });
  }
  if (input.result) {
    await db.collection("ballot_results").insertOne({
      decisionEventId: "DECISION-1",
      ballotId: proposalBallotId(proposalId),
      proposalId,
      matterId: proposalId,
      revisionId: input.ballotRevisionId,
      result: "successful",
      tally: { approve: 7, abstain: 2, reject: 3, total: 12 },
      ruleBasis: BALLOT_OUTCOME_RULE_BASIS,
      computedResult: "successful",
      recordedBy: "SECRET_RECORDER_ID",
      recordedAt: now,
      ...input.result,
    });
  }
  return proposalId;
}

function assertNoIdentifiers(record: DecisionRecord | null) {
  const serialised = JSON.stringify(record);
  for (const secret of [
    "SECRET_AUTHOR_ID",
    "SECRET_AUTHOR_NAME",
    "SECRET_REVISION_AUTHOR",
    "SECRET_AMENDMENT_AUTHOR",
    "SECRET_RECORDER_ID",
    "SECRET_VOTER_ID",
    "SECRET_VOTER_NAME",
  ]) {
    assert.equal(
      serialised.includes(secret),
      false,
      `read model leaked ${secret}`,
    );
  }
  for (const field of [
    "memberId",
    "authorId",
    "authorName",
    "recordedBy",
    "appliedBy",
    "voterBlindIndex",
    "voteEnvelope",
    "votesList",
    "myVote",
    "comments",
  ]) {
    assert.equal(
      serialised.includes(`"${field}"`),
      false,
      `read model exposed ${field}`,
    );
  }
}

describe("decision record read model", () => {
  it("derives the bound revision as adopted wording when no amendment was applied (D15)", async () => {
    const db = createMemoryDb();
    const proposalId = await seedMatter(db, {
      ballotRevisionId: "rev-1",
      revisions: [{ revisionId: "rev-1", title: "Voted wording", details: "Voted detail." }],
      amendments: [{ status: "rejected", ballotDecision: { result: "not-endorsed" } }],
      result: { revisionId: "rev-1" },
    });

    const record = await buildDecisionRecord(db, proposalId, nationalMember());
    assert.ok(record);
    assert.equal(record.votedWording?.revisionId, "rev-1");
    assert.equal(record.votedWording?.contentHash, "hash-rev-1");
    assert.equal(record.amendments.length, 1);
    assert.equal(record.amendments[0]?.status, "rejected");
    assert.equal(record.adoptedWording.state, "derived");
    if (record.adoptedWording.state === "derived") {
      assert.equal(record.adoptedWording.rule, "D15");
      assert.equal(record.adoptedWording.revision.revisionId, "rev-1");
      assert.equal(record.adoptedWording.revision.contentHash, "hash-rev-1");
    }
    assert.equal(record.result?.result, "successful");
    assert.deepEqual(record.result?.tally, {
      approve: 7,
      abstain: 2,
      reject: 3,
      total: 12,
    });
    assert.equal(record.ballot?.ballotId, proposalBallotId(proposalId));
    assert.equal(record.ballot?.boundToVotedWording, true);
    assert.equal(record.publication.state, "not-published");
    assertNoIdentifiers(record);
  });

  it("derives the resulting revision when exactly one amendment was applied (D16)", async () => {
    const db = createMemoryDb();
    const proposalId = await seedMatter(db, {
      ballotRevisionId: "rev-2",
      revisions: [
        { revisionId: "rev-1", title: "Original wording", details: "Original detail." },
        { revisionId: "rev-2", title: "Amended wording", details: "Amended detail." },
      ],
      amendments: [
        {
          status: "applied",
          appliedRevisionId: "rev-2",
          appliedAt: now,
          ballotDecision: { result: "endorsed" },
          formalApproval: { amendmentRevisionId: "AMEND-REV-1" },
        },
      ],
      result: { revisionId: "rev-2" },
    });

    const record = await buildDecisionRecord(db, proposalId, nationalMember());
    assert.ok(record);
    assert.equal(record.revisionHistory.length, 2);
    assert.equal(record.amendments[0]?.successfullyApplied, true);
    assert.equal(record.adoptedWording.state, "derived");
    if (record.adoptedWording.state === "derived") {
      assert.equal(record.adoptedWording.rule, "D16");
      assert.equal(record.adoptedWording.revision.revisionId, "rev-2");
      assert.equal(record.adoptedWording.revision.contentHash, "hash-rev-2");
      assert.equal(record.adoptedWording.viaAmendmentId, "AMD-1");
      assert.equal(record.adoptedWording.viaAmendmentRevisionId, "AMEND-REV-1");
    }
    assertNoIdentifiers(record);
  });

  it("does not change adopted wording for a rejected or not-endorsed amendment", async () => {
    const db = createMemoryDb();
    const proposalId = await seedMatter(db, {
      ballotRevisionId: "rev-1",
      revisions: [{ revisionId: "rev-1", title: "Voted wording", details: "Detail." }],
      amendments: [
        { status: "rejected", ballotDecision: { result: "not-endorsed" } },
        { status: "withdrawn" },
      ],
      result: { revisionId: "rev-1" },
    });

    const record = await buildDecisionRecord(db, proposalId, nationalMember());
    assert.ok(record);
    assert.equal(record.adoptedWording.state, "derived");
    if (record.adoptedWording.state === "derived") {
      assert.equal(record.adoptedWording.rule, "D15");
      assert.equal(record.adoptedWording.revision.revisionId, "rev-1");
    }
  });

  it("requires collision review and derives nothing when two amendments were applied (D17–D18)", async () => {
    const db = createMemoryDb();
    const proposalId = await seedMatter(db, {
      ballotRevisionId: "rev-3",
      revisions: [
        { revisionId: "rev-1", title: "Original", details: "Original." },
        { revisionId: "rev-2", title: "First change", details: "First." },
        { revisionId: "rev-3", title: "Second change", details: "Second." },
      ],
      amendments: [
        { status: "applied", appliedRevisionId: "rev-2", appliedAt: now },
        { status: "applied", appliedRevisionId: "rev-3", appliedAt: now },
      ],
      result: { revisionId: "rev-3" },
    });

    const record = await buildDecisionRecord(db, proposalId, nationalMember());
    assert.ok(record);
    assert.equal(record.adoptedWording.state, "review-required");
    if (record.adoptedWording.state === "review-required") {
      assert.equal(record.adoptedWording.reason, "multiple-applied-amendments");
      assert.deepEqual(record.adoptedWording.amendmentIds, ["AMD-1", "AMD-2"]);
    }
    const adoptedJson = JSON.stringify(record.adoptedWording);
    assert.equal(adoptedJson.includes('"revision"'), false);
    assert.equal(adoptedJson.includes("Second change"), false);
  });

  it("requires review rather than deriving when an amendment is accepted but not applied", async () => {
    const db = createMemoryDb();
    const proposalId = await seedMatter(db, {
      ballotRevisionId: "rev-1",
      revisions: [{ revisionId: "rev-1", title: "Voted wording", details: "Detail." }],
      amendments: [{ status: "accepted" }],
      result: { revisionId: "rev-1" },
    });

    const record = await buildDecisionRecord(db, proposalId, nationalMember());
    assert.ok(record);
    assert.equal(record.adoptedWording.state, "review-required");
    if (record.adoptedWording.state === "review-required") {
      assert.equal(record.adoptedWording.reason, "approved-amendment-not-applied");
    }
  });

  it("requires review when the applied revision is not the ballot wording", async () => {
    const db = createMemoryDb();
    const proposalId = await seedMatter(db, {
      ballotRevisionId: "rev-2",
      revisions: [
        { revisionId: "rev-1", title: "Original", details: "Original." },
        { revisionId: "rev-2", title: "Voted", details: "Voted." },
        { revisionId: "rev-3", title: "Later edit", details: "Later." },
      ],
      amendments: [{ status: "applied", appliedRevisionId: "rev-3", appliedAt: now }],
      result: { revisionId: "rev-2" },
    });

    const record = await buildDecisionRecord(db, proposalId, nationalMember());
    assert.ok(record);
    assert.equal(record.adoptedWording.state, "review-required");
    if (record.adoptedWording.state === "review-required") {
      assert.equal(record.adoptedWording.reason, "applied-revision-not-ballot-wording");
    }
  });

  it("requires review when the result names a different revision", async () => {
    const db = createMemoryDb();
    const proposalId = await seedMatter(db, {
      ballotRevisionId: "rev-1",
      revisions: [
        { revisionId: "rev-1", title: "Voted", details: "Voted." },
        { revisionId: "rev-2", title: "Other", details: "Other." },
      ],
      result: { revisionId: "rev-2" },
    });

    const record = await buildDecisionRecord(db, proposalId, nationalMember());
    assert.ok(record);
    assert.equal(record.adoptedWording.state, "review-required");
    if (record.adoptedWording.state === "review-required") {
      assert.equal(record.adoptedWording.reason, "result-names-other-revision");
    }
  });

  it("records an unsuccessful ballot without deriving adopted wording", async () => {
    const db = createMemoryDb();
    const proposalId = await seedMatter(db, {
      ballotRevisionId: "rev-1",
      revisions: [{ revisionId: "rev-1", title: "Voted", details: "Voted." }],
      result: {
        result: "unsuccessful",
        computedResult: "unsuccessful",
        tally: { approve: 2, abstain: 0, reject: 8, total: 10 },
        revisionId: "rev-1",
      },
    });

    const record = await buildDecisionRecord(db, proposalId, nationalMember());
    assert.ok(record);
    assert.equal(record.adoptedWording.state, "not-adopted");
    if (record.adoptedWording.state === "not-adopted") {
      assert.equal(record.adoptedWording.result, "unsuccessful");
    }
  });

  it("keeps a legacy result readable and identifiable only as a legacy record", async () => {
    const db = createMemoryDb();
    const proposalId = await seedMatter(db, {
      ballotRevisionId: "rev-1",
      revisions: [{ revisionId: "rev-1", title: "Voted", details: "Voted." }],
      result: {
        result: "successful",
        tally: undefined,
        computedResult: undefined,
        ruleBasis: undefined,
        revisionId: "rev-1",
      },
    });

    const record = await buildDecisionRecord(db, proposalId, nationalMember());
    assert.ok(record);
    assert.equal(record.result?.recordedBeforeComputation, true);
    assert.equal(record.result?.tally, null);
    assert.equal(record.result?.computedResult, null);
    assert.equal(record.adoptedWording.state, "derived");
  });

  it("shows a recorded override reason but no officer identity", async () => {
    const db = createMemoryDb();
    const proposalId = await seedMatter(db, {
      ballotRevisionId: "rev-1",
      revisions: [{ revisionId: "rev-1", title: "Voted", details: "Voted." }],
      result: {
        result: "successful",
        computedResult: "unsuccessful",
        revisionId: "rev-1",
        override: {
          reason: "Procedural defect was reviewed and accepted.",
          by: "SECRET_RECORDER_ID",
          at: now,
        },
      },
    });

    const record = await buildDecisionRecord(db, proposalId, nationalMember());
    assert.ok(record);
    assert.equal(
      record.result?.overrideReason,
      "Procedural defect was reviewed and accepted.",
    );
    assert.equal(JSON.stringify(record).includes("SECRET_RECORDER_ID"), false);
  });

  it("handles a matter with no revisions, no ballot, no result and no publication", async () => {
    const db = createMemoryDb();
    const proposalId = await seedMatter(db, {
      proposalId: "PROP-EMPTY",
      stage: "propose",
      revisions: [],
    });

    const record = await buildDecisionRecord(db, proposalId, nationalMember());
    assert.ok(record);
    assert.equal(record.votedWording, null);
    assert.equal(record.revisionHistory.length, 0);
    assert.equal(record.ballot, null);
    assert.equal(record.result, null);
    assert.equal(record.adoptedWording.state, "pending");
    if (record.adoptedWording.state === "pending") {
      assert.equal(record.adoptedWording.reason, "no-result");
    }
    assert.equal(record.publication.state, "not-published");
    assert.deepEqual(record.publication.events, []);
  });

  it("does not invent publication state and reports recorded publication events", async () => {
    const db = createMemoryDb();
    const proposalId = await seedMatter(db, {
      ballotRevisionId: "rev-1",
      revisions: [{ revisionId: "rev-1", title: "Voted", details: "Voted." }],
      result: { revisionId: "rev-1" },
    });
    await db.collection("policy_registry").insertOne({
      policyId: proposalId,
      proposalId,
      title: "Decision record matter",
      status: "adopted",
      publicationStatus: "published",
      publicationScape: "national",
      ratifiedAt: now,
      publishedAt: new Date("2026-11-16T01:00:00Z"),
      ratification: {
        ratifiedAt: now,
        ratifiedRevisionId: "rev-1",
        ratifiedBy: "SECRET_RECORDER_ID",
      },
    });
    await db.collection("publication_events").insertOne({
      eventId: "pub-1",
      policyId: proposalId,
      revisionId: "rev-1",
      status: "published",
      publishedBy: "SECRET_RECORDER_ID",
      publishedAt: new Date("2026-11-16T01:00:00Z"),
    });
    await db.collection("publication_events").insertOne({
      eventId: "withdraw-1",
      policyId: proposalId,
      revisionId: "rev-1",
      status: "withdrawn",
      transition: "withdrawn",
      reason: "Published in error.",
      actorId: "SECRET_RECORDER_ID",
      createdAt: new Date("2026-11-17T01:00:00Z"),
    });

    const record = await buildDecisionRecord(db, proposalId, nationalMember());
    assert.ok(record);
    assert.equal(record.publication.state, "recorded");
    assert.equal(record.publication.publicationStatus, "published");
    assert.equal(record.publication.ratifiedRevisionId, "rev-1");
    assert.equal(record.publication.ratifiedRevisionHash, "hash-rev-1");
    assert.equal(record.publication.events.length, 2);
    assert.equal(record.publication.events[1]?.transition, "withdrawn");
    assert.equal(record.publication.events[1]?.reason, "Published in error.");
    assert.equal(JSON.stringify(record).includes("SECRET_RECORDER_ID"), false);
  });

  it("marks publication as not applicable to a governance resolution", async () => {
    const db = createMemoryDb();
    const proposalId = await seedMatter(db, {
      proposalId: "GOV-RECORD",
      ballotRevisionId: "rev-1",
      revisions: [{ revisionId: "rev-1", title: "Voted", details: "Voted." }],
      result: { revisionId: "rev-1" },
    });
    await db.collection("proposals").updateOne({ proposalId }, { $set: { kind: "resolution" } });

    const record = await buildDecisionRecord(db, proposalId, nationalMember());
    assert.ok(record);
    assert.equal(record.matter.matterType, "resolution");
    assert.equal(record.publication.state, "not-applicable");
  });

  it("refuses a private draft to an unauthenticated or unrelated viewer without leaking it", async () => {
    const db = createMemoryDb();
    await seedMatter(db, {
      proposalId: "PROP-PRIVATE",
      stage: "propose",
      publicationScope: "private",
      revisions: [],
    });

    assert.equal(await buildDecisionRecord(db, "PROP-PRIVATE", null), null);
    assert.equal(
      await buildDecisionRecord(db, "PROP-PRIVATE", nationalMember("member-outsider")),
      null,
    );

    const author: SessionUser = {
      ...nationalMember("SECRET_AUTHOR_ID"),
    };
    const record = await buildDecisionRecord(db, "PROP-PRIVATE", author);
    assert.ok(record);
    assert.equal(record.matter.title, "Decision record matter");
  });

  it("never exposes individual ballot records when they exist in storage", async () => {
    const db = createMemoryDb();
    const proposalId = await seedMatter(db, {
      ballotRevisionId: "rev-1",
      revisions: [{ revisionId: "rev-1", title: "Voted", details: "Voted." }],
      result: { revisionId: "rev-1" },
    });
    await db.collection(PROPOSAL_VOTES).insertOne({
      ballotId: proposalBallotId(proposalId),
      proposalId,
      revisionId: "rev-1",
      memberId: "SECRET_VOTER_ID",
      authorName: "SECRET_VOTER_NAME",
      choice: "approve",
      reason: "A private reason",
      voterBlindIndex: "SECRET_BLIND_INDEX",
      voteEnvelope: "SECRET_ENVELOPE",
    });

    const record = await buildDecisionRecord(db, proposalId, nationalMember());
    assert.ok(record);
    assertNoIdentifiers(record);
    assert.equal(JSON.stringify(record).includes("A private reason"), false);
    assert.equal(JSON.stringify(record).includes("SECRET_BLIND_INDEX"), false);
    assert.deepEqual(record.result?.tally, {
      approve: 7,
      abstain: 2,
      reject: 3,
      total: 12,
    });
  });

  it("derives nothing without a result, even when wording is bound", () => {
    const derived = deriveAdoptedWording({
      votedWording: {
        revisionId: "rev-1",
        contentHash: "hash",
        createdAt: now,
        ordinal: 1,
        title: "Voted",
        summary: "",
        outcomes: [],
        details: "",
        isBallotWording: true,
      },
      revisions: [],
      amendments: [],
      result: null,
    });
    assert.equal(derived.state, "pending");
  });
});
