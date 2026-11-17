import assert from "node:assert/strict";
import { test } from "node:test";
import {
  forbiddenFeedKeys,
  horizonFeedErrors,
} from "./collaboration-horizon-consumer.ts";

function validFeed() {
  return {
    generatedAt: "2026-11-17T05:00:00.000Z",
    since: null,
    nextSince: "2026-11-17T05:00:00.000Z",
    stories: [
      {
        id: "story-1",
        initiative: { slug: "help-us-tell-fusions-story", title: "Help us tell Fusion's story" },
        publishedAt: "2026-11-17T05:00:00.000Z",
        name: "Feed Person",
        attribution: "named",
        answers: [{ label: "What brought you to Fusion?", text: "A local campaign." }],
        caption: "",
        media: [
          {
            url: "https://engage.example/api/collaboration/media/aaaaaaaaaaaaaaaaaaaaaaaa",
            mimeType: "image/png",
            alt: "Photograph 1 of 1 shared by Feed Person",
          },
        ],
        channels: ["website"],
        editorial: { consentVersion: "stories-2026-11-17", allowEdits: false, allowAiEdits: false },
      },
    ],
  };
}

test("a well-formed feed passes the consumer contract", () => {
  assert.deepEqual(horizonFeedErrors(validFeed()), []);
});

test("the contract refuses anonymous stories that carry a name, or named stories without one", () => {
  const anonymousWithName = validFeed();
  anonymousWithName.stories[0]!.attribution = "anonymous";
  assert.match(horizonFeedErrors(anonymousWithName).join(" "), /anonymous but carries a name/);

  const namedWithoutName = validFeed();
  namedWithoutName.stories[0]!.name = "";
  assert.match(horizonFeedErrors(namedWithoutName).join(" "), /named but has no name/);
});

test("the contract refuses material without website consent, bad media or duplicate ids", () => {
  const socialOnly = validFeed();
  socialOnly.stories[0]!.channels = ["social"];
  assert.match(horizonFeedErrors(socialOnly).join(" "), /does not include website/);

  const badMedia = validFeed();
  badMedia.stories[0]!.media[0]!.url = "javascript:alert(1)";
  badMedia.stories[0]!.media[0]!.alt = "";
  const mediaErrors = horizonFeedErrors(badMedia).join(" ");
  assert.match(mediaErrors, /url is not an http URL/);
  assert.match(mediaErrors, /alt is empty/);

  const duplicate = validFeed();
  duplicate.stories.push(structuredClone(duplicate.stories[0]!));
  assert.match(horizonFeedErrors(duplicate).join(" "), /duplicated/);
});

test("the contract refuses private fields anywhere in the payload", () => {
  const payload = validFeed();
  (payload.stories[0] as Record<string, unknown>).internalNotes = "do not ship";
  (payload.stories[0] as Record<string, unknown>).email = "person@example.com";
  const errors = horizonFeedErrors(payload).join(" ");
  assert.match(errors, /Forbidden key present: .*internalNotes/);
  assert.match(errors, /Forbidden key present: .*email/);
  assert.deepEqual(forbiddenFeedKeys({ a: { claimedByMemberId: "x" } }), [".a.claimedByMemberId"]);
});

test("the contract checks the envelope and media types", () => {
  const invalid = validFeed() as ReturnType<typeof validFeed> & Record<string, unknown>;
  invalid.nextSince = "soon";
  invalid.generatedAt = "not a date";
  invalid.stories[0]!.media[0]!.mimeType = "text/html";
  const errors = horizonFeedErrors(invalid).join(" ");
  assert.match(errors, /generatedAt is not a date/);
  assert.match(errors, /nextSince is not null or a date/);
  assert.match(errors, /mimeType is not an image/);
});
