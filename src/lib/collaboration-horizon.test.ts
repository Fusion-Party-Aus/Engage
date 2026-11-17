import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryDb } from "./db.ts";
import {
  seedPilotInitiative,
  submitContribution,
  reviewContribution,
  setGalleryPublication,
} from "./collaboration.ts";
import { PILOT_SLUG } from "./collaboration-options.ts";
import {
  authoriseHorizonFeed,
  type HorizonFeedAuth,
  buildHorizonFeed,
  horizonFeedEtag,
  parseSince,
} from "./collaboration-horizon.ts";
import type { SessionUser } from "./types.ts";

const reviewer = {
  memberId: "reviewer-1",
  permissions: { national: ["collaboration.review", "collaboration.manage"], branches: {}, grants: [] },
} as unknown as SessionUser;

async function setup() {
  const db = createMemoryDb();
  await seedPilotInitiative(db);
  return db;
}

async function publish(
  db: Awaited<ReturnType<typeof setup>>,
  overrides: Record<string, unknown> = {},
  withPhoto = false,
) {
  const files = withPhoto
    ? [new File([Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9])], "p.jpg", { type: "image/jpeg" })]
    : [];
  const result = await submitContribution(
    db,
    {
      initiativeSlug: PILOT_SLUG,
      requestId: crypto.randomUUID(),
      answers: { meaning: "A real story long enough to be accepted by the form." },
      attribution: "named",
      displayName: "Feed Person",
      channels: ["website"],
      consent: true,
      adultAttested: true,
      ...overrides,
    } as never,
    files,
  );
  await reviewContribution(db, reviewer, {
    contributionId: result.contributionId,
    action: "set_status",
    status: "approved",
    version: 0,
  });
  await setGalleryPublication(db, reviewer, {
    contributionId: result.contributionId,
    state: "publish",
    version: 1,
  });
  return result.contributionId;
}

function denial(result: HorizonFeedAuth): number {
  return result.ok ? 0 : result.status;
}

test("the feed fails closed without configuration and rejects a missing or wrong token", () => {
  assert.equal(authoriseHorizonFeed("Bearer anything", {}).ok, false);
  assert.equal(denial(authoriseHorizonFeed(null, {})), 503);
  assert.equal(denial(authoriseHorizonFeed(null, { HORIZON_FEED_TOKEN: "secret" })), 401);
  assert.equal(denial(authoriseHorizonFeed("Bearer wrong", { HORIZON_FEED_TOKEN: "secret" })), 401);
  assert.equal(authoriseHorizonFeed("bearer secret", { HORIZON_FEED_TOKEN: "secret" }).ok, true);
  assert.equal(denial(authoriseHorizonFeed("Basic secret", { HORIZON_FEED_TOKEN: "secret" })), 401);
});

test("the feed carries only published, website-consented stories, with no private fields", async () => {
  const db = await setup();
  const published = await publish(
    db,
    { contactAllowed: true, email: "sam@example.com", attribution: "named", allowEdits: true },
    true,
  );
  const socialOnly = await submitContribution(db, {
    initiativeSlug: PILOT_SLUG,
    requestId: crypto.randomUUID(),
    answers: { meaning: "A story that may only be used on social media, not the website." },
    attribution: "anonymous",
    channels: ["social"],
    consent: true,
    adultAttested: true,
  });
  await reviewContribution(db, reviewer, {
    contributionId: socialOnly.contributionId,
    action: "set_status",
    status: "approved",
    version: 0,
  });
  // Hide the anonymous one after publication.
  const second = await submitContribution(db, {
    initiativeSlug: PILOT_SLUG,
    requestId: crypto.randomUUID(),
    answers: { meaning: "A second story that will be hidden from the feed after publication." },
    attribution: "anonymous",
    channels: ["website"],
    consent: true,
    adultAttested: true,
  });
  await reviewContribution(db, reviewer, {
    contributionId: second.contributionId,
    action: "set_status",
    status: "approved",
    version: 0,
  });
  await setGalleryPublication(db, reviewer, {
    contributionId: second.contributionId,
    state: "publish",
    version: 1,
  });
  await setGalleryPublication(db, reviewer, {
    contributionId: second.contributionId,
    state: "hide",
    version: 2,
  });

  const feed = await buildHorizonFeed(db, {
    initiativeSlug: PILOT_SLUG,
    baseUrl: "https://engage.example",
  });
  assert.ok(feed);
  // Two social-only / unapproved entries are excluded; the hidden one too.
  const ids = feed!.stories.map((story) => story.id);
  assert.deepEqual(ids, [published]);
  const story = feed!.stories[0]!;
  assert.equal(story.name, "Feed Person");
  assert.equal(story.attribution, "named");
  assert.equal(story.editorial.consentVersion, "stories-2026-11-17");
  assert.equal(story.editorial.allowEdits, true);
  assert.match(story.media[0]!.url, /^https:\/\/engage\.example\/api\/collaboration\/media\/[a-f0-9]{24}$/);
  assert.equal(story.media[0]!.alt, "Photograph 1 of 1 shared by Feed Person");

  const serialised = JSON.stringify(feed);
  for (const forbidden of ["sam@example.com", "manageTokenHash", "internalNotes", "claimedByMemberId", "phone"]) {
    assert.equal(serialised.includes(forbidden), false, forbidden);
  }
  assert.equal(feed!.initiative?.slug, PILOT_SLUG);
});

test("incremental polling uses publication time and a stable entity tag", async () => {
  const db = await setup();
  const older = await publish(db);
  const newer = await publish(db, { requestId: crypto.randomUUID() });
  await db.collection("collaboration_contributions").updateOne(
    { contributionId: older },
    { $set: { galleryPublishedAt: new Date("2026-11-01T00:00:00.000Z") } },
  );
  await db.collection("collaboration_contributions").updateOne(
    { contributionId: newer },
    { $set: { galleryPublishedAt: new Date("2026-11-10T00:00:00.000Z") } },
  );

  const full = await buildHorizonFeed(db, { initiativeSlug: PILOT_SLUG, baseUrl: "https://engage.example" });
  assert.equal(full!.stories.length, 2);
  assert.equal(full!.nextSince, "2026-11-10T00:00:00.000Z");
  const etag = horizonFeedEtag(full!);
  assert.match(etag, /^W\/"[a-f0-9]{20}"$/);
  const repeat = await buildHorizonFeed(db, { initiativeSlug: PILOT_SLUG, baseUrl: "https://engage.example" });
  assert.equal(horizonFeedEtag(repeat!), etag);

  const incremental = await buildHorizonFeed(db, {
    initiativeSlug: PILOT_SLUG,
    baseUrl: "https://engage.example",
    since: new Date("2026-11-05T00:00:00.000Z"),
  });
  assert.deepEqual(incremental!.stories.map((story) => story.id), [newer]);
  assert.notEqual(horizonFeedEtag(incremental!), etag);
});

test("an unscoped feed names the invitation on each story, and an unknown scope is refused", async () => {
  const db = await setup();
  await publish(db);
  const feed = await buildHorizonFeed(db, { baseUrl: "https://engage.example" });
  assert.ok(feed);
  assert.equal(feed!.initiative, undefined);
  assert.equal(feed!.stories[0]?.initiative.slug, PILOT_SLUG);
  assert.equal(feed!.stories[0]?.initiative.title, "Help us tell Fusion's story");

  assert.equal(
    await buildHorizonFeed(db, { initiativeSlug: "missing-invitation", baseUrl: "https://engage.example" }),
    null,
  );
});

test("since parsing accepts ISO dates and rejects nonsense", () => {
  assert.equal(parseSince(null), null);
  assert.equal(parseSince("2026-11-10T00:00:00.000Z")?.toISOString(), "2026-11-10T00:00:00.000Z");
  assert.equal(parseSince("last Tuesday"), null);
});
