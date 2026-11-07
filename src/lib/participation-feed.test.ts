import { it } from "node:test";
import assert from "node:assert/strict";
import {
  groupParticipationFeed,
  type ParticipationActivity,
} from "./participation-feed.ts";

it("groups consecutive votes by one member and keeps contributions distinct", () => {
  const start = new Date("2026-11-06T01:07:00Z");
  const activities: ParticipationActivity[] = Array.from(
    { length: 12 },
    (_, i) => ({
      id: `vote-${i}`,
      actorId: "member-ethan",
      actorName: "Ethan Cornwill",
      kind: "vote",
      date: new Date(start.getTime() + i * 38_000),
      proposalTitle: `Proposal ${i + 1}`,
      proposalSlug: `proposal-${i + 1}`,
    }),
  );
  activities.push({
    id: "comment-other",
    actorId: "member-other",
    actorName: "Alex Member",
    kind: "contribution",
    date: new Date(start.getTime() + 10 * 60_000),
    proposalTitle: "Housing",
    proposalSlug: "housing",
  });
  const feed = groupParticipationFeed(activities, new Set(["member-other"]));
  const ethan = feed.find(
    (entry) => entry.kind === "votes" && entry.actorId === "member-ethan",
  );
  const contribution = feed.find((entry) => entry.kind === "contribution");
  assert.equal(ethan?.kind, "votes");
  if (ethan?.kind === "votes") assert.equal(ethan.count, 12);
  assert.equal(
    feed.filter(
      (entry) => entry.kind === "votes" && entry.actorId === "member-ethan",
    ).length,
    1,
  );
  assert.equal(contribution?.kind, "contribution");
  assert.equal(contribution?.firstParticipation, true);
});

it("starts a new vote group when another member's activity interrupts it", () => {
  const date = new Date("2026-11-06T01:00:00Z");
  const feed = groupParticipationFeed(
    [
      {
        id: "a1",
        actorId: "a",
        actorName: "A",
        kind: "vote",
        date,
        proposalTitle: "One",
        proposalSlug: "one",
      },
      {
        id: "b1",
        actorId: "b",
        actorName: "B",
        kind: "vote",
        date: new Date(date.getTime() - 1000),
        proposalTitle: "Two",
        proposalSlug: "two",
      },
      {
        id: "a2",
        actorId: "a",
        actorName: "A",
        kind: "vote",
        date: new Date(date.getTime() - 2000),
        proposalTitle: "Three",
        proposalSlug: "three",
      },
    ],
    new Set(),
  );
  assert.equal(
    feed.filter((entry) => entry.kind === "votes" && entry.actorId === "a")
      .length,
    2,
  );
});
