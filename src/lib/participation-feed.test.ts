import { it } from "node:test";
import assert from "node:assert/strict";
import {
  buildParticipationFeed,
  summarizeParticipation,
  type ParticipationActivity,
} from "./participation-feed.ts";

const vote = (
  overrides: Partial<ParticipationActivity> & Pick<ParticipationActivity, "id">,
): ParticipationActivity => ({
  actorName: "Member",
  kind: "vote",
  date: new Date("2026-11-12T10:31:00Z"),
  proposalTitle: "Guarantee Net Neutrality",
  proposalSlug: "guarantee-net-neutrality",
  ...overrides,
});

it("keeps a vote classified as a vote when the ballot record has no member identity", () => {
  const feed = buildParticipationFeed(
    [
      vote({
        id: "encrypted-1",
        actorName: "A member",
        dedupeKey: "proposal:p1:blind-1",
      }),
    ],
    new Set(),
  );
  assert.equal(feed.length, 1);
  assert.equal(feed[0]!.kind, "vote");
  assert.equal(feed[0]!.actorName, "A member");
  assert.equal(feed[0]!.firstParticipation, false);
});

it("does not collapse genuinely separate votes on different ballots", () => {
  const feed = buildParticipationFeed(
    [
      vote({
        id: "vote-a",
        actorId: "member-1",
        actorName: "Ada Member",
        proposalTitle: "Housing",
        proposalSlug: "housing",
        dedupeKey: "proposal:p1:member-1",
      }),
      vote({
        id: "vote-b",
        actorId: "member-1",
        actorName: "Ada Member",
        proposalTitle: "Transport",
        proposalSlug: "transport",
        dedupeKey: "proposal:p2:member-1",
      }),
    ],
    new Set(["member-1"]),
  );
  assert.equal(feed.filter((entry) => entry.kind === "vote").length, 2);
  assert.ok(feed.every((entry) => entry.firstParticipation));
});

it("drops replayed duplicates of the same ballot and voter", () => {
  const feed = buildParticipationFeed(
    [
      vote({ id: "original", dedupeKey: "proposal:p1:blind-1" }),
      vote({ id: "replayed", dedupeKey: "proposal:p1:blind-1" }),
      vote({
        id: "different-ballot",
        dedupeKey: "proposal:p2:blind-1",
        proposalTitle: "Transport",
        proposalSlug: "transport",
      }),
    ],
    new Set(),
  );
  assert.deepEqual(
    feed.map((entry) => entry.id),
    ["original", "different-ballot"],
  );
});

it("summary counts match the feed categories and tabs", () => {
  const feed = buildParticipationFeed(
    [
      vote({ id: "vote-1", actorId: "member-1", dedupeKey: "proposal:p1:member-1" }),
      vote({
        id: "vote-2",
        actorId: "member-2",
        actorName: "Alex Member",
        dedupeKey: "proposal:p2:member-2",
        proposalTitle: "Transport",
        proposalSlug: "transport",
      }),
      {
        id: "comment-1",
        actorId: "member-1",
        actorName: "Ada Member",
        kind: "contribution",
        date: new Date("2026-11-12T11:00:00Z"),
        proposalTitle: "Housing",
        proposalSlug: "housing",
      },
      {
        id: "proposal-1",
        actorId: "member-3",
        actorName: "Sam Member",
        kind: "proposal",
        date: new Date("2026-11-12T12:00:00Z"),
        proposalTitle: "Transport",
        proposalSlug: "transport",
      },
    ],
    new Set(["member-2", "member-3"]),
  );
  const summary = summarizeParticipation(feed);
  assert.equal(summary.votes, feed.filter((entry) => entry.kind === "vote").length);
  assert.equal(
    summary.contributions,
    feed.filter((entry) => entry.kind === "contribution").length,
  );
  assert.equal(
    summary.proposals,
    feed.filter((entry) => entry.kind === "proposal").length,
  );
  assert.deepEqual(summary, {
    votes: 2,
    contributions: 1,
    proposals: 1,
    firstTimeParticipants: 2,
  });
  assert.equal(feed.length, 4);
});
