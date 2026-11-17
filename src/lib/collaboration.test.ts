import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryDb } from "./db.ts";
import {
  CollaborationError,
  createInitiative,
  exportApproved,
  getInitiative,
  getPublicInitiative,
  listContributions,
  listInitiatives,
  listPublishedContributions,
  readPublishedMedia,
  setGalleryVisibility,
  purgeExpiredContent,
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

test("withdrawing a contribution removes its words, name, contact details and photographs at once", async () => {
  const db = await setup();
  const result = await submitContribution(
    db,
    submission({ contactAllowed: true, email: "sam@example.com" }),
    [photo()],
  );
  const before = await listContributions(db, reviewer);
  assert.equal(before.items[0]?.media.length, 1);

  await reviewContribution(db, reviewer, {
    contributionId: result.contributionId,
    action: "set_status",
    status: "withdrawn",
    version: 0,
  });

  const row = await db.collection("collaboration_contributions").findOne({ contributionId: result.contributionId });
  assert.deepEqual(row?.answers, {});
  assert.equal(row?.caption, "");
  assert.equal(row?.displayName, "");
  assert.equal(row?.email, "");
  assert.deepEqual(row?.media, []);
  assert.ok(row?.contentClearedAt);
  assert.equal(await db.collection("collaboration_media").countDocuments(), 0);
  const events = await db.collection("collaboration_events").find({ contributionId: result.contributionId }).toArray();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.toStatus, "withdrawn");
});

test("the retention sweep is dry by default and clears only material past its window", async () => {
  const db = await setup();
  const old = new Date(Date.now() - 200 * 86_400_000);

  const declined = await submitContribution(db, submission());
  await reviewContribution(db, reviewer, {
    contributionId: declined.contributionId,
    action: "set_status",
    status: "declined",
    version: 0,
  });
  await db.collection("collaboration_contributions").updateOne(
    { contributionId: declined.contributionId },
    { $set: { updatedAt: old } },
  );

  const recent = await submitContribution(db, submission({ requestId: REQUEST_ID_2 }));
  await reviewContribution(db, reviewer, {
    contributionId: recent.contributionId,
    action: "set_status",
    status: "declined",
    version: 0,
  });

  const dry = await purgeExpiredContent(db);
  assert.deepEqual(dry, { declined: 1, withdrawn: 0, contactAddresses: 0, applied: false });
  const stillThere = await db.collection("collaboration_contributions").findOne({ contributionId: declined.contributionId });
  assert.ok(Object.keys(stillThere?.answers ?? {}).length > 0);

  const applied = await purgeExpiredContent(db, { apply: true });
  assert.equal(applied.declined, 1);
  const cleared = await db.collection("collaboration_contributions").findOne({ contributionId: declined.contributionId });
  assert.deepEqual(cleared?.answers, {});
  assert.equal(cleared?.contentClearedReason, "declined");
  assert.equal(cleared?.status, "declined");
  const untouched = await db.collection("collaboration_contributions").findOne({ contributionId: recent.contributionId });
  assert.ok(Object.keys(untouched?.answers ?? {}).length > 0);
});

test("an approved reply address is cleared after a year while the story stays", async () => {
  const db = await setup();
  const result = await submitContribution(
    db,
    submission({ contactAllowed: true, email: "sam@example.com" }),
  );
  await reviewContribution(db, reviewer, {
    contributionId: result.contributionId,
    action: "set_status",
    status: "approved",
    version: 0,
  });
  await db.collection("collaboration_contributions").updateOne(
    { contributionId: result.contributionId },
    { $set: { updatedAt: new Date(Date.now() - 400 * 86_400_000) } },
  );
  const applied = await purgeExpiredContent(db, { apply: true });
  assert.equal(applied.contactAddresses, 1);
  const row = await db.collection("collaboration_contributions").findOne({ contributionId: result.contributionId });
  assert.equal(row?.email, "");
  assert.ok(Object.keys(row?.answers ?? {}).length > 0);
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

const newInvitation = {
  title: "Our stories",
  summary: "Real stories from people who work with Fusion in their own communities.",
  purpose: "We want to show the work as it happens, in the words of the people doing it.",
  question: "What are you working on?",
  correctionEmail: "stories@fusionparty.org.au",
};

test("editors create invitations as drafts, with unique addresses, and only they can do it", async () => {
  const db = await setup();
  await assert.rejects(createInitiative(db, outsider, newInvitation), /permission/);
  await assert.rejects(createInitiative(db, null, newInvitation), /Sign in/);

  const first = await createInitiative(db, reviewer, newInvitation);
  assert.equal(first.status, "draft");
  assert.equal(first.slug, "our-stories");
  assert.equal(first.questions.length, 1);
  assert.equal(await getPublicInitiative(db, first.slug), null);

  const second = await createInitiative(db, reviewer, newInvitation);
  assert.equal(second.slug, "our-stories-2");
  assert.equal(await getInitiative(db, second.slug).then((item) => item?.slug), "our-stories-2");
});

test("creation validates the title, wording, question, correction address and slug input", async () => {
  const db = await setup();
  for (const change of [
    { title: "A" },
    { summary: "short" },
    { purpose: "short" },
    { question: "No" },
    { correctionEmail: "not-an-email" },
  ]) {
    await assert.rejects(createInitiative(db, reviewer, { ...newInvitation, ...change }), CollaborationError);
  }
  const punctuation = await createInitiative(db, reviewer, { ...newInvitation, title: "What's your story?!" });
  assert.equal(punctuation.slug, "what-s-your-story");
});

test("a draft is private, opening publishes it, and archiving hides it again", async () => {
  const db = await setup();
  const created = await createInitiative(db, reviewer, newInvitation);
  const answer = {
    ...submission(),
    initiativeSlug: created.slug,
    answers: { [created.questions[0]!.key]: "A long enough answer about the work we are doing." },
  };
  await assert.rejects(submitContribution(db, answer), /not accepting/);

  const open = await updateInitiative(db, reviewer, {
    slug: created.slug,
    title: created.title,
    summary: created.summary,
    purpose: created.purpose,
    status: "open",
    correctionEmail: created.correctionEmail,
    questions: created.questions,
  });
  assert.equal(open.status, "open");
  assert.equal((await getPublicInitiative(db, created.slug))?.slug, created.slug);
  const saved = await submitContribution(db, answer);
  assert.ok(saved.contributionId);

  const paused = await updateInitiative(db, reviewer, {
    slug: created.slug,
    title: created.title,
    summary: created.summary,
    purpose: created.purpose,
    status: "paused",
    correctionEmail: created.correctionEmail,
    questions: created.questions,
  });
  assert.equal(paused.status, "paused");
  assert.ok(await getPublicInitiative(db, created.slug));
  await assert.rejects(submitContribution(db, { ...answer, requestId: REQUEST_ID_2 }), /not accepting/);

  const archived = await updateInitiative(db, reviewer, {
    slug: created.slug,
    title: created.title,
    summary: created.summary,
    purpose: created.purpose,
    status: "archived",
    correctionEmail: created.correctionEmail,
    questions: created.questions,
  });
  assert.equal(archived.status, "archived");
  assert.ok(archived.archivedAt instanceof Date);
  assert.equal(await getPublicInitiative(db, created.slug), null);

  const restored = await updateInitiative(db, reviewer, {
    slug: created.slug,
    title: created.title,
    summary: created.summary,
    purpose: created.purpose,
    status: "open",
    correctionEmail: created.correctionEmail,
    questions: created.questions,
  });
  assert.equal(restored.archivedAt, null);
});

test("multiple invitations keep their contributions and counts separate", async () => {
  const db = await setup();
  const second = await createInitiative(db, reviewer, newInvitation);
  await updateInitiative(db, reviewer, {
    slug: second.slug,
    title: second.title,
    summary: second.summary,
    purpose: second.purpose,
    status: "open",
    correctionEmail: second.correctionEmail,
    questions: second.questions,
  });

  await submitContribution(db, submission());
  await submitContribution(db, {
    ...submission(),
    requestId: REQUEST_ID_2,
    initiativeSlug: second.slug,
    answers: { [second.questions[0]!.key]: "A long enough answer about our local campaign." },
  });

  const summaries = await listInitiatives(db);
  const pilot = summaries.find((item) => item.initiative.slug === PILOT_SLUG);
  const other = summaries.find((item) => item.initiative.slug === second.slug);
  assert.equal(pilot?.contributions, 1);
  assert.equal(pilot?.awaitingReview, 1);
  assert.equal(other?.contributions, 1);

  const inbox = await listContributions(db, reviewer);
  assert.equal(inbox.total, 2);
  assert.deepEqual(
    inbox.items.map((item) => item.initiativeSlug).sort(),
    [PILOT_SLUG, second.slug].sort(),
  );
});

test("changing a decision never erases earlier review notes, and an explicit blank clears them", async () => {
  const db = await setup();
  const result = await submitContribution(db, submission());
  await reviewContribution(db, reviewer, {
    contributionId: result.contributionId,
    action: "set_status",
    status: "needs_follow_up",
    internalNotes: "Photographer gave permission on 3 November.",
    contributorMessage: "Could you confirm the location?",
    version: 0,
  });
  const saved = await reviewContribution(db, reviewer, {
    contributionId: result.contributionId,
    action: "set_status",
    status: "approved",
    version: 1,
  });
  assert.equal(saved.status, "approved");
  const row = await db.collection("collaboration_contributions").findOne({ contributionId: result.contributionId });
  assert.equal(row?.internalNotes, "Photographer gave permission on 3 November.");
  assert.equal(row?.contributorMessage, "Could you confirm the location?");

  await reviewContribution(db, reviewer, {
    contributionId: result.contributionId,
    action: "set_status",
    status: "approved",
    internalNotes: "",
    version: 2,
  });
  const cleared = await db.collection("collaboration_contributions").findOne({ contributionId: result.contributionId });
  assert.equal(cleared?.internalNotes, "");
});

test("a submission that answers a removed question is refused instead of silently dropping it", async () => {
  const db = await setup();
  await assert.rejects(
    submitContribution(db, submission({ answers: { removedQuestion: "A real answer that would be lost." } })),
    /invitation changed/,
  );
});

test("a contribution keeps the question wording it answered, even after the invitation changes", async () => {
  const db = await setup();
  const created = await submitContribution(db, submission());
  const initiative = (await getInitiative(db, PILOT_SLUG))!;
  await updateInitiative(db, reviewer, {
    slug: PILOT_SLUG,
    title: "Renamed invitation",
    summary: initiative.summary,
    purpose: "A rewritten purpose that no longer matches what the contributor read.",
    status: "open",
    correctionEmail: initiative.correctionEmail,
    questions: [{ key: "newKey", label: "A brand new question" }],
  });
  const inbox = await listContributions(db, reviewer);
  const item = inbox.items.find((entry) => entry.contributionId === created.contributionId)!;
  assert.equal(
    item.questions.find((question) => question.key === "meaning")?.label,
    "What does Fusion mean to you?",
  );
  assert.equal(item.initiativeTitle, "Help us tell Fusion's story");
});

test("private consultation input can be accepted without being approved for publication", async () => {
  const db = await setup();
  const result = await submitContribution(db, submission({ channels: [] }));
  await assert.rejects(
    reviewContribution(db, reviewer, {
      contributionId: result.contributionId,
      action: "set_status",
      status: "approved",
      version: 0,
    }),
    /private use only/,
  );
  const accepted = await reviewContribution(db, reviewer, {
    contributionId: result.contributionId,
    action: "accept_input",
    version: 0,
  });
  assert.ok(accepted.acceptedAt);
  assert.equal(accepted.status, "new");
  const row = await db.collection("collaboration_contributions").findOne({ contributionId: result.contributionId });
  assert.equal(row?.inputAcceptedBy, reviewer.memberId);
  const events = await db.collection("collaboration_events").find({ contributionId: result.contributionId }).toArray();
  assert.deepEqual(events.map((event) => event.action), ["accept_input"]);
  const exported = await exportApproved(db, reviewer);
  assert.equal((exported.contributions as unknown[]).length, 0);
});

test("withdrawal and retention clearing are terminal for publication", async () => {
  const db = await setup();
  const withdrawn = await submitContribution(db, submission());
  await reviewContribution(db, reviewer, {
    contributionId: withdrawn.contributionId,
    action: "set_status",
    status: "withdrawn",
    version: 0,
  });
  await assert.rejects(
    reviewContribution(db, reviewer, {
      contributionId: withdrawn.contributionId,
      action: "set_status",
      status: "approved",
      version: 1,
    }),
    /cannot be reopened/,
  );

  const cleared = await submitContribution(db, submission({ requestId: REQUEST_ID_2 }));
  await reviewContribution(db, reviewer, {
    contributionId: cleared.contributionId,
    action: "set_status",
    status: "declined",
    version: 0,
  });
  await db.collection("collaboration_contributions").updateOne(
    { contributionId: cleared.contributionId },
    { $set: { updatedAt: new Date(Date.now() - 200 * 86_400_000) } },
  );
  await purgeExpiredContent(db, { apply: true });
  await assert.rejects(
    reviewContribution(db, reviewer, {
      contributionId: cleared.contributionId,
      action: "set_status",
      status: "approved",
      version: 1,
    }),
    /cannot be reopened/,
  );
});

test("the same channel can hold several publication placements", async () => {
  const db = await setup();
  const result = await submitContribution(db, submission({ channels: ["website"] }));
  await reviewContribution(db, reviewer, {
    contributionId: result.contributionId,
    action: "set_status",
    status: "approved",
    version: 0,
  });
  await reviewContribution(db, reviewer, {
    contributionId: result.contributionId,
    action: "record_use",
    channel: "website",
    reference: "/about/",
    version: 1,
  });
  await reviewContribution(db, reviewer, {
    contributionId: result.contributionId,
    action: "record_use",
    channel: "website",
    reference: "/campaigns/rail/",
    version: 2,
  });
  const item = (await listContributions(db, reviewer)).items[0]!;
  assert.deepEqual(item.usedChannels, ["website"]);
  assert.deepEqual(item.publicationHistory.map((entry) => entry.reference), ["/about/", "/campaigns/rail/"]);
});

test("AI-assisted edits need a reply address so the contributor can approve the result", async () => {
  const db = await setup();
  await assert.rejects(
    submitContribution(
      db,
      submission({ allowEdits: true, allowAiEdits: true, contactAllowed: false }),
    ),
    /reply address/,
  );
  const accepted = await submitContribution(
    db,
    submission({
      allowEdits: true,
      allowAiEdits: true,
      contactAllowed: true,
      email: "sam@example.com",
    }),
  );
  assert.ok(accepted.contributionId);
});

test("the queue can be searched by the reference a contributor keeps", async () => {
  const db = await setup();
  const first = await submitContribution(db, submission());
  await submitContribution(db, submission({ requestId: REQUEST_ID_2 }));
  const found = await listContributions(db, reviewer, { q: first.contributionId.slice(0, 8) });
  assert.equal(found.total, 1);
  assert.equal(found.items[0]?.contributionId, first.contributionId);
  assert.equal((await listContributions(db, reviewer, { q: "zzzzzzzz" })).total, 0);
  assert.equal((await listContributions(db, reviewer, { q: "ab" })).total, 2);
});

test("a contribution records the purpose the contributor was shown", async () => {
  const db = await setup();
  await submitContribution(db, submission());
  const item = (await listContributions(db, reviewer)).items[0]!;
  assert.match(item.initiativePurpose, /honest material/);
});

test("a consultation invitation collects written responses only", async () => {
  const db = await setup();
  const created = await createInitiative(db, reviewer, { ...newInvitation, profile: "consultation" });
  assert.equal(created.profile, "consultation");
  await updateInitiative(db, reviewer, {
    slug: created.slug,
    title: created.title,
    summary: created.summary,
    purpose: created.purpose,
    status: "open",
    correctionEmail: created.correctionEmail,
    questions: created.questions,
  });
  const answer = {
    ...submission(),
    initiativeSlug: created.slug,
    answers: { [created.questions[0]!.key]: "A clear written response about the station upgrade." },
    displayName: "Should Not Be Stored",
    allowEdits: true,
    allowAiEdits: false,
  };
  await assert.rejects(submitContribution(db, answer, [photo()]), /written responses only/);
  const saved = await submitContribution(db, { ...answer, requestId: REQUEST_ID_2 });
  assert.ok(saved.contributionId);
  const row = await db.collection("collaboration_contributions").findOne({ contributionId: saved.contributionId });
  assert.equal(row?.profile, "consultation");
  assert.equal(row?.displayName, "");
  assert.equal(row?.attribution, "anonymous");
  assert.equal(row?.allowEdits, false);
  assert.equal(row?.hasMedia, false);
});

test("the public gallery contains only approved website stories, credited as chosen", async () => {
  const db = await setup();
  const named = await submitContribution(db, submission({ channels: ["website"] }), [photo()]);
  const anonymous = await submitContribution(
    db,
    submission({ requestId: REQUEST_ID_2, channels: ["website"], attribution: "anonymous", displayName: "Hidden" }),
  );
  const socialOnly = await submitContribution(
    db,
    submission({ requestId: "32345678-1234-4234-8234-123456789abc", channels: ["social"] }),
  );
  const unapproved = await submitContribution(
    db,
    submission({ requestId: "42345678-1234-4234-8234-123456789abc", channels: ["website"] }),
  );
  for (const id of [named.contributionId, anonymous.contributionId, socialOnly.contributionId]) {
    await reviewContribution(db, reviewer, {
      contributionId: id,
      action: "set_status",
      status: "approved",
      version: 0,
    });
  }

  const gallery = await listPublishedContributions(db, PILOT_SLUG);
  assert.deepEqual(
    gallery.map((entry) => entry.contributionId).sort(),
    [named.contributionId, anonymous.contributionId].sort(),
  );
  const namedEntry = gallery.find((entry) => entry.contributionId === named.contributionId)!;
  const anonymousEntry = gallery.find((entry) => entry.contributionId === anonymous.contributionId)!;
  assert.equal(namedEntry.name, "Sam Rivera");
  assert.equal(anonymousEntry.name, "");
  assert.equal(namedEntry.media.length, 1);
  assert.equal(namedEntry.answers.some((answer) => answer.label === "What does Fusion mean to you?"), true);
  assert.equal(unapproved.contributionId.length > 0, true);
});

test("published photographs are served only while their story is published", async () => {
  const db = await setup();
  const result = await submitContribution(db, submission({ channels: ["website"] }), [photo()]);
  const mediaId = (await listContributions(db, reviewer)).items[0]!.media[0]!.mediaId;

  await assert.rejects(readPublishedMedia(db, mediaId), /not available/);
  await reviewContribution(db, reviewer, {
    contributionId: result.contributionId,
    action: "set_status",
    status: "approved",
    version: 0,
  });
  const published = await readPublishedMedia(db, mediaId);
  assert.equal(published.mimeType, "image/jpeg");
  assert.ok(published.bytes.length > 0);

  await setGalleryVisibility(db, reviewer, {
    contributionId: result.contributionId,
    hidden: true,
    version: 1,
  });
  await assert.rejects(readPublishedMedia(db, mediaId), /not available/);
  await setGalleryVisibility(db, reviewer, {
    contributionId: result.contributionId,
    hidden: false,
    version: 2,
  });
  assert.ok((await readPublishedMedia(db, mediaId)).bytes.length > 0);

  await reviewContribution(db, reviewer, {
    contributionId: result.contributionId,
    action: "set_status",
    status: "withdrawn",
    version: 3,
  });
  await assert.rejects(readPublishedMedia(db, mediaId), /not available/);
  assert.equal(await db.collection("collaboration_media").countDocuments(), 0);
});

test("gallery visibility is a reviewer action, needs approval, and is audited", async () => {
  const db = await setup();
  const result = await submitContribution(db, submission({ channels: ["website"] }));
  await assert.rejects(
    setGalleryVisibility(db, outsider, { contributionId: result.contributionId, hidden: true, version: 0 }),
    /permission/,
  );
  await assert.rejects(
    setGalleryVisibility(db, reviewer, { contributionId: result.contributionId, hidden: true, version: 0 }),
    /approved/,
  );
  await reviewContribution(db, reviewer, {
    contributionId: result.contributionId,
    action: "set_status",
    status: "approved",
    version: 0,
  });
  await assert.rejects(
    setGalleryVisibility(db, reviewer, { contributionId: result.contributionId, hidden: true, version: 0 }),
    /changed since/,
  );
  await setGalleryVisibility(db, reviewer, { contributionId: result.contributionId, hidden: true, version: 1 });
  const inbox = await listContributions(db, reviewer);
  assert.ok(inbox.items[0]?.galleryHiddenAt);
  const actions = (await db.collection("collaboration_events").find({ contributionId: result.contributionId }).toArray()).map(
    (event) => event.action,
  );
  assert.deepEqual(actions, ["set_status", "hide_from_gallery"]);
});

test("a written consultation is never published individually, even with website consent", async () => {
  const db = await setup();
  const created = await createInitiative(db, reviewer, { ...newInvitation, profile: "consultation" });
  await updateInitiative(db, reviewer, {
    slug: created.slug,
    title: created.title,
    summary: created.summary,
    purpose: created.purpose,
    status: "open",
    correctionEmail: created.correctionEmail,
    questions: created.questions,
  });
  const result = await submitContribution(db, {
    ...submission(),
    initiativeSlug: created.slug,
    answers: { [created.questions[0]!.key]: "A long written response from a local resident." },
    channels: ["website"],
  });
  await reviewContribution(db, reviewer, {
    contributionId: result.contributionId,
    action: "set_status",
    status: "approved",
    version: 0,
  });
  assert.equal((await listPublishedContributions(db, created.slug)).length, 0);
});
