import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryDb } from "./db.ts";
import {
  CollaborationError,
  exportApproved,
  getInitiative,
  listContributions,
  readContributionMedia,
  reviewContribution,
  seedPilotInitiative,
  submitContribution,
  updateInitiative,
  type SubmissionInput,
} from "./collaboration.ts";
import { COLLABORATION_CONSENT_VERSION, PILOT_SLUG } from "./collaboration-options.ts";
import { prepareImage } from "./collaboration-media.ts";
import type { SessionUser } from "./types.ts";

const reviewer = {
  memberId: "reviewer-1",
  permissions: {
    national: ["collaboration.review", "collaboration.manage"],
    branches: {},
    grants: [],
  },
} as unknown as SessionUser;

const outsider = {
  memberId: "outsider-1",
  permissions: { national: ["proposals.edit"], branches: {}, grants: [] },
} as unknown as SessionUser;

const REQUEST_ID = "12345678-1234-4234-8234-123456789abc";
const REQUEST_ID_2 = "22345678-1234-4234-8234-123456789abc";

function submission(overrides: Partial<SubmissionInput> = {}): SubmissionInput {
  return {
    initiativeSlug: PILOT_SLUG,
    requestId: REQUEST_ID,
    answers: {
      meaning: "Fusion is the first party that treated my local problem as something we could actually solve.",
    },
    attribution: "named",
    displayName: "Sam Rivera",
    channels: ["website"],
    consent: true,
    ...overrides,
  };
}

const jpeg = () =>
  Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xe1, 0x00, 0x10, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x47, 0x50, 0x53, 0x4c, 0x61, 0x74, 0x00, 0x00,
    0xff, 0xda, 0x00, 0x02, 0x11, 0x22,
    0xff, 0xd9,
  ]);

function photo() {
  return new File([jpeg()], "me.jpg", { type: "image/jpeg" });
}

async function setup() {
  const db = createMemoryDb();
  await seedPilotInitiative(db);
  return db;
}

test("a guest can contribute without an account, and the record creates no governance or membership data", async () => {
  const db = await setup();
  const result = await submitContribution(db, submission());
  assert.equal(result.shareable, true);
  const row = await db.collection("collaboration_contributions").findOne({ contributionId: result.contributionId });
  assert.equal(row?.status, "new");
  assert.equal(row?.consentVersion, COLLABORATION_CONSENT_VERSION);
  assert.equal(row?.memberId, undefined);
  assert.equal(await db.collection("proposals").countDocuments(), 0);
  assert.equal(await db.collection("ballots").countDocuments(), 0);
  assert.equal(await db.collection("memberships").countDocuments(), 0);
  assert.equal(await db.collection("branch_memberships").countDocuments(), 0);
});

test("a private contribution is accepted and marked as not shareable", async () => {
  const db = await setup();
  const result = await submitContribution(db, submission({ channels: [] }));
  assert.equal(result.shareable, false);
});

test("submission validation refuses missing consent, thin content, unknown options and unsafe input", async () => {
  const db = await setup();
  const cases: Array<Partial<SubmissionInput>> = [
    { consent: false },
    { answers: {} },
    { answers: { meaning: "too short" } },
    { channels: ["billboard"] },
    { attribution: "maybe" },
    { allowAiEdits: true, allowEdits: false },
    { contactAllowed: true, email: "" },
    { contactAllowed: true, email: "not-an-email" },
    { attribution: "named", displayName: "A" },
    { website: "https://spam.example" },
  ];
  for (const change of cases) {
    await assert.rejects(submitContribution(db, submission(change)), CollaborationError);
  }
  await assert.rejects(submitContribution(db, submission({ answers: { meaning: "x".repeat(2_001) } })));
});

test("an anonymous contributor's name is never stored", async () => {
  const db = await setup();
  const result = await submitContribution(
    db,
    submission({ attribution: "anonymous", displayName: "Should Not Survive" }),
  );
  const row = await db.collection("collaboration_contributions").findOne({ contributionId: result.contributionId });
  assert.equal(row?.displayName, "");
});

test("resending the same form is idempotent, and a changed form with the reused reference is refused", async () => {
  const db = await setup();
  const first = await submitContribution(db, submission());
  const again = await submitContribution(db, submission());
  assert.equal(again.contributionId, first.contributionId);
  assert.equal(await db.collection("collaboration_contributions").countDocuments(), 1);
  await assert.rejects(
    submitContribution(db, submission({ answers: { meaning: "A completely different story that reuses the form reference." } })),
    /already been sent/,
  );
});

test("a paused or closed invitation stops accepting contributions", async () => {
  const db = await setup();
  await updateInitiative(db, reviewer, {
    slug: PILOT_SLUG,
    title: "Help us tell Fusion's story",
    summary: await getInitiative(db, PILOT_SLUG).then((initiative) => initiative!.summary),
    purpose: await getInitiative(db, PILOT_SLUG).then((initiative) => initiative!.purpose),
    status: "closed",
    correctionEmail: "engage@fusionparty.org.au",
    questions: (await getInitiative(db, PILOT_SLUG))!.questions,
  });
  await assert.rejects(submitContribution(db, submission()), /not accepting/);
});

test("only a reviewer may read the queue, and contact details stay inside it", async () => {
  const db = await setup();
  await submitContribution(db, submission({ contactAllowed: true, email: "sam@example.com" }));
  await assert.rejects(listContributions(db, null), /Sign in/);
  await assert.rejects(listContributions(db, outsider), /permission/);
  const inbox = await listContributions(db, reviewer);
  assert.equal(inbox.total, 1);
  assert.equal(inbox.items[0]?.email, "sam@example.com");
  assert.deepEqual(inbox.counts, { new: 1, needs_follow_up: 0, approved: 0, declined: 0, withdrawn: 0 });
});

test("publication is a deliberate act: private-only consent cannot be approved, permitted channels can", async () => {
  const db = await setup();
  const privateOnly = await submitContribution(db, submission({ channels: [] }));
  await assert.rejects(
    reviewContribution(db, reviewer, {
      contributionId: privateOnly.contributionId,
      action: "set_status",
      status: "approved",
      version: 0,
    }),
    /private use only/,
  );

  const shareable = await submitContribution(
    db,
    submission({ requestId: REQUEST_ID_2, channels: ["website", "print"] }),
  );
  const saved = await reviewContribution(db, reviewer, {
    contributionId: shareable.contributionId,
    action: "set_status",
    status: "approved",
    contributorMessage: "Thank you.",
    internalNotes: "Strong local story.",
    version: 0,
  });
  assert.equal(saved.status, "approved");
  assert.equal(saved.version, 1);
  const events = await db.collection("collaboration_events").find({ contributionId: shareable.contributionId }).toArray();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.actorId, reviewer.memberId);
});

test("an outsider cannot change a decision, and the version guard prevents overwriting a reviewer", async () => {
  const db = await setup();
  const result = await submitContribution(db, submission());
  await assert.rejects(
    reviewContribution(db, outsider, { contributionId: result.contributionId, action: "set_status", status: "approved", version: 0 }),
    /permission/,
  );
  await reviewContribution(db, reviewer, {
    contributionId: result.contributionId,
    action: "set_status",
    status: "needs_follow_up",
    version: 0,
  });
  await assert.rejects(
    reviewContribution(db, reviewer, { contributionId: result.contributionId, action: "set_status", status: "approved", version: 0 }),
    /changed since/,
  );
});

test("recording a use is limited to permitted channels and keeps a history", async () => {
  const db = await setup();
  const result = await submitContribution(db, submission({ channels: ["website"] }));
  await reviewContribution(db, reviewer, {
    contributionId: result.contributionId,
    action: "set_status",
    status: "approved",
    version: 0,
  });
  await assert.rejects(
    reviewContribution(db, reviewer, {
      contributionId: result.contributionId,
      action: "record_use",
      channel: "print",
      reference: "Autumn print run",
      version: 1,
    }),
    /did not allow/,
  );
  await reviewContribution(db, reviewer, {
    contributionId: result.contributionId,
    action: "record_use",
    channel: "website",
    reference: "/about/",
    version: 1,
  });
  const inbox = await listContributions(db, reviewer);
  const item = inbox.items[0]!;
  assert.deepEqual(item.usedChannels, ["website"]);
  assert.equal(item.publicationHistory[0]?.reference, "/about/");
  assert.equal(item.publicationHistory[0]?.recordedBy, reviewer.memberId);
});

test("a withdrawal is recorded without deleting the audit trail", async () => {
  const db = await setup();
  const result = await submitContribution(db, submission());
  await reviewContribution(db, reviewer, {
    contributionId: result.contributionId,
    action: "set_status",
    status: "withdrawn",
    internalNotes: "Contributor asked us to remove it.",
    version: 0,
  });
  assert.equal(await db.collection("collaboration_contributions").countDocuments(), 1);
  assert.equal((await listContributions(db, reviewer, { status: "withdrawn" })).total, 1);
});

test("approved export carries permissions, not contact details or internal notes", async () => {
  const db = await setup();
  const result = await submitContribution(
    db,
    submission({ contactAllowed: true, email: "sam@example.com", allowEdits: true, allowAiEdits: false }),
  );
  await submitContribution(db, submission({ requestId: REQUEST_ID_2, channels: [] }));
  await reviewContribution(db, reviewer, {
    contributionId: result.contributionId,
    action: "set_status",
    status: "approved",
    internalNotes: "Never export this.",
    version: 0,
  });
  const payload = await exportApproved(db, reviewer);
  const exported = payload.contributions as Array<Record<string, unknown>>;
  assert.equal(exported.length, 1);
  assert.equal(exported[0]?.name, "Sam Rivera");
  assert.deepEqual(exported[0]?.channels, ["website"]);
  assert.equal(exported[0]?.email, undefined);
  assert.equal(exported[0]?.internalNotes, undefined);
  assert.match(JSON.stringify(payload), /consentVersion/);
  assert.doesNotMatch(JSON.stringify(payload), /Never export this/);
});

test("photographs are stored privately, sanitised, and readable only by a reviewer", async () => {
  const db = await setup();
  const result = await submitContribution(db, submission(), [photo()]);
  const inbox = await listContributions(db, reviewer);
  const media = inbox.items[0]!.media;
  assert.equal(media.length, 1);
  assert.equal(inbox.withMedia, 1);
  const stored = await db.collection("collaboration_media").findOne({ mediaId: media[0]!.mediaId });
  assert.ok(Buffer.isBuffer(stored?.bytes));
  assert.doesNotMatch(Buffer.from(stored!.bytes).toString("latin1"), /GPSLat/);

  await assert.rejects(readContributionMedia(db, outsider, media[0]!.mediaId), /permission/);
  await assert.rejects(readContributionMedia(db, null, media[0]!.mediaId), /Sign in/);
  const read = await readContributionMedia(db, reviewer, media[0]!.mediaId);
  assert.equal(read.mimeType, "image/jpeg");
  assert.ok(read.bytes.length > 0);

  const listRow = await db.collection("collaboration_contributions").findOne({ contributionId: result.contributionId });
  assert.equal(listRow?.hasMedia, true);
});

test("a contribution with neither words nor a photo is refused", async () => {
  const db = await setup();
  await assert.rejects(submitContribution(db, submission({ answers: {} })), /photo/);
});

test("editors own the invitation, and new questions receive stable keys without detaching answers", async () => {
  const db = await setup();
  const original = (await getInitiative(db, PILOT_SLUG))!;
  await assert.rejects(
    updateInitiative(db, outsider, {
      slug: PILOT_SLUG,
      title: "Hijacked",
      summary: original.summary,
      purpose: original.purpose,
      status: "open",
      correctionEmail: "engage@fusionparty.org.au",
      questions: original.questions,
    }),
    /permission/,
  );

  const saved = await updateInitiative(db, reviewer, {
    slug: PILOT_SLUG,
    title: "Help us tell Fusion's story",
    summary: original.summary,
    purpose: original.purpose,
    status: "open",
    correctionEmail: "stories@fusionparty.org.au",
    questions: [
      { key: original.questions[0]!.key, label: "What first caught your interest?" },
      { label: "What should we know about your local area?" },
    ],
  });
  assert.equal(saved.correctionEmail, "stories@fusionparty.org.au");
  assert.equal(saved.questions[0]?.key, original.questions[0]?.key);
  assert.match(saved.questions[1]?.key ?? "", /^q\d+$/);

  const again = await updateInitiative(db, reviewer, {
    slug: PILOT_SLUG,
    title: saved.title,
    summary: saved.summary,
    purpose: saved.purpose,
    status: saved.status,
    correctionEmail: saved.correctionEmail,
    questions: saved.questions,
  });
  assert.deepEqual(again.questions.map((question) => question.key), saved.questions.map((question) => question.key));

  await assert.rejects(
    updateInitiative(db, reviewer, {
      slug: PILOT_SLUG,
      title: saved.title,
      summary: saved.summary,
      purpose: saved.purpose,
      status: "open",
      correctionEmail: "not-an-email",
      questions: saved.questions,
    }),
    /email/,
  );
});

test("re-seeding never overwrites an editor's invitation", async () => {
  const db = await setup();
  const original = (await getInitiative(db, PILOT_SLUG))!;
  await updateInitiative(db, reviewer, {
    slug: PILOT_SLUG,
    title: "Our stories",
    summary: original.summary,
    purpose: original.purpose,
    status: "paused",
    correctionEmail: original.correctionEmail,
    questions: original.questions,
  });
  const seeded = await seedPilotInitiative(db);
  assert.equal(seeded.title, "Our stories");
  assert.equal(seeded.status, "paused");
});

test("the pilot photographs accepted by the form are JPEG or PNG only", async () => {
  const db = await setup();
  await assert.rejects(
    submitContribution(db, submission(), [new File([Buffer.from("<html>no</html>")], "x.jpg", { type: "image/jpeg" })]),
    /JPEG or PNG/,
  );
  assert.throws(() => prepareImage(Buffer.from("GIF89a")), /JPEG or PNG/);
});
