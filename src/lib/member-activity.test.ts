import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoClient } from "mongodb";
import {
  buildActivityTimeline,
  type ActivityTimelineEvent,
  type ActivityTimelineKind,
} from "./activity-timeline.ts";
import { listMemberActivityStream, buildMemberCatchUp } from "./member-activity.ts";
import { createMemoryDb } from "./db.ts";

const uri = process.env.VOTING_TEST_MONGODB_URI;
const memberId = "activity-member";

test("activity timeline groups by Melbourne day and formats recent time", () => {
  const now = new Date("2026-11-07T16:00:00.000Z");
  const events: ActivityTimelineEvent[] = [
    {
      id: "today",
      date: new Date("2026-11-07T15:30:00.000Z"),
      actor: "You",
      action: "voted on",
      target: "Today proposal",
      kind: "vote",
    },
    {
      id: "yesterday",
      date: new Date("2026-11-07T09:00:00.000Z"),
      actor: "You",
      action: "contributed to",
      target: "Yesterday proposal",
      kind: "contribution",
    },
    {
      id: "older",
      date: new Date("2026-11-05T09:00:00.000Z"),
      actor: "You",
      action: "submitted",
      target: "Older proposal",
      kind: "proposal",
    },
  ];
  const groups = buildActivityTimeline(events, now);
  assert.deepEqual(
    groups.map((group) => group.label),
    ["Today", "Yesterday", "5 Nov 2026"],
  );
  assert.equal(groups[0]!.events[0]!.time, "30 min ago");
  assert.equal(groups[1]!.events[0]!.time, "8:00 pm");
});

test(
  "member activity stream covers votes, contributions, endorsements, amendments and outcomes",
  { skip: !uri },
  async () => {
    const client = await new MongoClient(uri!).connect();
    const db = client.db(
      `engage_activity_${crypto.randomUUID().replaceAll("-", "")}`,
    );
    try {
      const now = new Date("2026-11-07T15:00:00.000Z");
      await db.collection("proposals").insertMany([
        {
          proposalId: "P-1",
          slug: "member-proposal",
          title: "Member proposal",
          space: "Housing",
          stage: "implement",
          authorId: memberId,
          createdAt: new Date("2026-10-20T00:00:00.000Z"),
        },
        {
          proposalId: "P-2",
          slug: "other-proposal",
          title: "Other proposal",
          space: "Health",
          stage: "decide",
          createdAt: new Date("2026-10-21T00:00:00.000Z"),
        },
      ]);
      await db.collection("proposal_votes").insertOne({
        ballotId: "proposal:P-2",
        proposalId: "P-2",
        memberId,
        choice: "approve",
        reason: "Clear wording.",
        updatedAt: now,
      });
      await db.collection("comments").insertMany([
        {
          commentId: "C-1",
          proposalId: "P-2",
          memberId,
          authorName: "Activity Member",
          stance: "support",
          body: "My own contribution",
          upvotes: ["other-member"],
          upvoteEvents: [{ memberId: "other-member", at: now }],
          createdAt: new Date("2026-11-01T00:00:00.000Z"),
        },
        {
          commentId: "C-2",
          proposalId: "P-1",
          memberId: "other-member",
          authorName: "Other Member",
          stance: "concern",
          body: "A contribution I endorsed",
          upvotes: [memberId],
          upvoteEvents: [
            {
              memberId,
              at: new Date("2026-11-06T12:00:00.000Z"),
            },
          ],
          createdAt: new Date("2026-11-05T00:00:00.000Z"),
        },
      ]);
      await db.collection("amendments").insertOne({
        amendmentId: "A-1",
        proposalId: "P-1",
        authorId: memberId,
        status: "applied",
        createdAt: new Date("2026-10-25T00:00:00.000Z"),
        ballotOpenedAt: new Date("2026-10-27T00:00:00.000Z"),
        ballotDecision: {
          result: "endorsed",
          decidedAt: new Date("2026-10-28T00:00:00.000Z"),
        },
        formalApproval: { approvedAt: new Date("2026-10-29T00:00:00.000Z") },
        appliedAt: new Date("2026-10-30T00:00:00.000Z"),
      });
      await db.collection("proposal_revisions").insertMany([
        {
          revisionId: "R-backfill",
          proposalId: "P-1",
          authorId: memberId,
          provenance: "legacy-backfill",
          createdAt: new Date("2026-10-20T00:00:00.000Z"),
        },
        {
          revisionId: "R-later",
          proposalId: "P-1",
          authorId: memberId,
          provenance: "member-edit",
          createdAt: new Date("2026-10-26T00:00:00.000Z"),
        },
      ]);
      await db.collection("ballot_results").insertOne({
        proposalId: "P-1",
        result: "successful",
        recordedAt: new Date("2026-11-02T00:00:00.000Z"),
      });
      await db.collection("policy_registry").insertOne({
        policyId: "P-1",
        proposalId: "P-1",
        title: "Member proposal",
        ratification: { ratifiedAt: new Date("2026-11-03T00:00:00.000Z") },
        publishedAt: new Date("2026-11-04T00:00:00.000Z"),
      });
      await db.collection("operational_audit").insertOne({
        action: "membership role changed",
        actorId: memberId,
        createdAt: now,
      });

      const events = await listMemberActivityStream(db, memberId);
      const kinds = new Set(events.map((event) => event.kind));
      for (const kind of [
        "vote",
        "contribution",
        "proposal",
        "amendment",
        "endorsement",
        "governance",
      ] as ActivityTimelineKind[])
        assert.ok(kinds.has(kind), `missing ${kind} event`);

      assert.ok(
        events.some(
          (event) =>
            event.id === "vote-proposal:P-2-2026-11-07T15:00:00.000Z" &&
            event.target === "Other proposal",
        ),
      );
      assert.ok(
        events.some(
          (event) =>
            event.kind === "contribution" &&
            event.details?.[0]?.label === "1 endorsement",
        ),
      );
      assert.ok(
        events.some(
          (event) =>
            event.id === "endorsement-C-2" &&
            event.date.toISOString() === "2026-11-06T12:00:00.000Z",
        ),
      );
      assert.equal(
        events.filter((event) => event.kind === "amendment").length,
        5,
      );
      assert.ok(
        events.some(
          (event) =>
            event.kind === "governance" &&
            event.id === "revision-R-later",
        ),
      );
      assert.ok(
        events.some(
          (event) =>
            event.kind === "governance" &&
            event.id === "ballot-result-P-1",
        ),
      );
      assert.ok(
        events.some(
          (event) => event.kind === "governance" && event.id === "ratified-P-1",
        ),
      );
      assert.ok(
        events.some(
          (event) => event.kind === "governance" && event.id === "published-P-1",
        ),
      );
      assert.equal(
        events.some((event) => event.id.includes("operational_audit")),
        false,
        "administrative audit events must not enter the member stream",
      );
      assert.equal(
        events.some((event) => event.id === "revision-R-backfill"),
        false,
        "legacy backfill revisions are not member activity",
      );
    } finally {
      await db.dropDatabase();
      await client.close();
    }
  },
);

test("catch-up digest groups persisted activity for proposals the member joined", async () => {
  const db = createMemoryDb();
  const since = new Date("2026-11-01T00:00:00.000Z");
  const user = {
    memberId,
    name: "Activity Member",
    email: "activity@example.test",
    role: "member" as const,
    status: "verified" as const,
    canParticipate: true,
    isStaff: false,
    isAdmin: false,
  };
  const insertAll = async (name: string, docs: Array<Record<string, unknown>>) => {
    for (const doc of docs) await db.collection(name).insertOne(doc);
  };
  await insertAll("proposals", [
    {
      proposalId: "P-1",
      slug: "joined-proposal",
      title: "Joined proposal",
      space: "Housing",
      stage: "decide",
      summary: "Summary",
      outcomes: [],
      details: "",
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
      updatedAt: new Date("2026-11-04T00:00:00.000Z"),
    },
    {
      proposalId: "P-2",
      slug: "untouched-proposal",
      title: "Untouched proposal",
      space: "Health",
      stage: "decide",
      summary: "Summary",
      outcomes: [],
      details: "",
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
      updatedAt: new Date("2026-11-04T00:00:00.000Z"),
    },
    {
      proposalId: "P-3",
      slug: "private-proposal",
      title: "Private proposal",
      space: "Internal",
      publicationScope: "private",
      stage: "deliberate",
      summary: "Summary",
      outcomes: [],
      details: "",
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
      updatedAt: new Date("2026-11-04T00:00:00.000Z"),
    },
  ]);
  await insertAll("proposal_votes", [
    {
      ballotId: "proposal:P-1",
      proposalId: "P-1",
      memberId,
      choice: "approve",
      updatedAt: new Date("2026-10-20T00:00:00.000Z"),
    },
    {
      ballotId: "proposal:P-3",
      proposalId: "P-3",
      memberId,
      choice: "approve",
      updatedAt: new Date("2026-10-20T00:00:00.000Z"),
    },
  ]);
  await insertAll("comments", [
    {
      commentId: "C-new",
      proposalId: "P-1",
      memberId: "other-member",
      authorName: "Other Member",
      stance: "concern",
      body: "A new concern after the member last looked.",
      upvotes: [],
      createdAt: new Date("2026-11-03T00:00:00.000Z"),
    },
    {
      commentId: "C-old",
      proposalId: "P-1",
      memberId: "other-member",
      authorName: "Other Member",
      stance: "comment",
      body: "Too old to be a catch-up item.",
      upvotes: [],
      createdAt: new Date("2026-10-20T00:00:00.000Z"),
    },
    {
      commentId: "C-own",
      proposalId: "P-1",
      memberId,
      authorName: "Activity Member",
      stance: "support",
      body: "The member's own comment.",
      upvotes: [],
      createdAt: new Date("2026-11-03T00:00:00.000Z"),
    },
    {
      commentId: "C-unrelated",
      proposalId: "P-2",
      memberId: "other-member",
      authorName: "Other Member",
      stance: "support",
      body: "Not relevant.",
      upvotes: [],
      createdAt: new Date("2026-11-03T00:00:00.000Z"),
    },
  ]);
  await db.collection("amendments").insertOne({
    amendmentId: "A-1",
    proposalId: "P-1",
    authorId: "other-member",
    status: "endorsed",
    createdAt: new Date("2026-10-25T00:00:00.000Z"),
    ballotOpenedAt: new Date("2026-11-02T00:00:00.000Z"),
    ballotDecision: {
      result: "endorsed",
      decidedAt: new Date("2026-11-04T00:00:00.000Z"),
    },
  });
  await db.collection("ballot_results").insertOne({
    proposalId: "P-1",
    result: "successful",
    recordedAt: new Date("2026-11-05T00:00:00.000Z"),
  });
  await db.collection("policy_registry").insertOne({
    policyId: "POL-1",
    proposalId: "P-1",
    title: "Joined proposal",
    ratification: { ratifiedAt: new Date("2026-11-06T00:00:00.000Z") },
    publishedAt: new Date("2026-11-07T00:00:00.000Z"),
  });

  const groups = await buildMemberCatchUp(db, memberId, since, user);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.proposalId, "P-1");
  const ids = groups[0]!.items.map((item) => item.id);
  assert.ok(ids.includes("catchup-comment-C-new"));
  assert.equal(ids.includes("catchup-comment-C-old"), false);
  assert.equal(ids.includes("catchup-comment-C-own"), false);
  assert.equal(ids.includes("catchup-comment-C-unrelated"), false);
  assert.ok(ids.includes("catchup-amendment-A-1-Ballot open"));
  assert.ok(ids.includes("catchup-amendment-A-1-Endorsed"));
  assert.ok(ids.includes("catchup-result-P-1"));
  assert.ok(ids.includes("catchup-policy-POL-1-Ratified"));
  assert.ok(ids.includes("catchup-policy-POL-1-Published"));
  assert.equal(
    groups.some((group) => group.proposalId === "P-3"),
    false,
    "a private proposal is not visible to an unrelated member",
  );
});
