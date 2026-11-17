import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryDb } from "./db.ts";
import {
  CollaborationError,
  contributionTokenSecret,
  createInitiative,
  exportApproved,
  getInitiative,
  getPublicInitiative,
  listContributions,
  clearExpiredContribution,
  listInitiatives,
  listPublishedContributions,
  manageContribution,
  viewManagedContribution,
  readPublishedMedia,
  setGalleryPublication,
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
    adultAttested: true,
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
  assert.ok(row?.adultAttestedAt instanceof Date);
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
    { adultAttested: false },
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
  await db.collection("collaboration_contributions").updateOne(
    { contributionId: result.contributionId },
    { $set: { approvedAt: new Date(Date.now() - 400 * 86_400_000) } },
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
      version: 2,
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

  // Approval alone never publishes.
  assert.equal((await listPublishedContributions(db, PILOT_SLUG)).length, 0);
  for (const id of [named.contributionId, anonymous.contributionId]) {
    await setGalleryPublication(db, reviewer, { contributionId: id, state: "publish", version: 1 });
  }
  const gallery = await listPublishedContributions(db, PILOT_SLUG);
  const storyIds = await Promise.all(
    [named.contributionId, anonymous.contributionId].map(async (contributionId) =>
      String((await db.collection("collaboration_contributions").findOne({ contributionId }))?.storyId),
    ),
  );
  assert.deepEqual(gallery.map((entry) => entry.contributionId).sort(), storyIds.sort());
  const namedEntry = gallery.find((entry) => entry.contributionId === storyIds[0])!;
  const anonymousEntry = gallery.find((entry) => entry.contributionId === storyIds[1])!;
  assert.notEqual(namedEntry.contributionId, named.contributionId);
  assert.notEqual(anonymousEntry.contributionId, anonymous.contributionId);
  assert.equal(namedEntry.name, "Sam Rivera");
  assert.equal(anonymousEntry.name, "");
  assert.equal(namedEntry.media.length, 1);
  assert.equal(namedEntry.answers.some((answer) => answer.label === "What does Fusion mean to you?"), true);
  assert.equal(unapproved.contributionId.length > 0, true);
});

test("a public story never reveals the submission reference, and a replay cannot reissue authority", async () => {
  const db = await setup();
  const original = await submitContribution(db, submission({ channels: ["website"] }));
  assert.ok(original.manageToken);
  await reviewContribution(db, reviewer, {
    contributionId: original.contributionId,
    action: "set_status",
    status: "approved",
    version: 0,
  });
  await setGalleryPublication(db, reviewer, {
    contributionId: original.contributionId,
    state: "publish",
    version: 1,
  });

  const gallery = await listPublishedContributions(db, PILOT_SLUG);
  assert.equal(gallery.length, 1);
  const publicStory = gallery[0]!;
  assert.notEqual(publicStory.contributionId, original.contributionId);
  assert.match(publicStory.contributionId, /^[a-f0-9]{24}$/);
  const exposed = JSON.stringify(gallery);
  assert.equal(exposed.includes(original.contributionId), false);
  assert.equal(exposed.includes(original.manageToken!), false);

  // An outsider replays the public story's content with the same reference.
  const replay = await submitContribution(db, submission({ channels: ["website"] }));
  assert.equal(replay.contributionId, original.contributionId);
  assert.equal(replay.manageToken, null);
  assert.equal(await db.collection("collaboration_contributions").countDocuments(), 1);

  // The original contributor's token still works; the replay granted nothing.
  await manageContribution(db, {
    token: original.manageToken!,
    action: "correct",
    answers: { meaning: "The original contributor's correction, still authorised." },
  });
  const row = await db.collection("collaboration_contributions").findOne({
    contributionId: original.contributionId,
  });
  assert.equal(row?.answers.meaning, "The original contributor's correction, still authorised.");
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
  // Approved but not yet published: still private.
  await assert.rejects(readPublishedMedia(db, mediaId), /not available/);
  await setGalleryPublication(db, reviewer, {
    contributionId: result.contributionId,
    state: "publish",
    version: 1,
  });
  const published = await readPublishedMedia(db, mediaId);
  assert.equal(published.mimeType, "image/jpeg");
  assert.ok(published.bytes.length > 0);

  await setGalleryPublication(db, reviewer, {
    contributionId: result.contributionId,
    state: "hide",
    version: 2,
  });
  await assert.rejects(readPublishedMedia(db, mediaId), /not available/);
  await setGalleryPublication(db, reviewer, {
    contributionId: result.contributionId,
    state: "show",
    version: 3,
  });
  assert.ok((await readPublishedMedia(db, mediaId)).bytes.length > 0);

  await reviewContribution(db, reviewer, {
    contributionId: result.contributionId,
    action: "set_status",
    status: "withdrawn",
    version: 4,
  });
  await assert.rejects(readPublishedMedia(db, mediaId), /not available/);
  assert.equal(await db.collection("collaboration_media").countDocuments(), 0);
});

test("gallery publication is a separate, authorised, audited decision", async () => {
  const db = await setup();
  const result = await submitContribution(db, submission({ channels: ["website"] }));
  await assert.rejects(
    setGalleryPublication(db, outsider, { contributionId: result.contributionId, state: "publish", version: 0 }),
    /permission/,
  );
  await assert.rejects(
    setGalleryPublication(db, reviewer, { contributionId: result.contributionId, state: "publish", version: 0 }),
    /approved/,
  );
  await reviewContribution(db, reviewer, {
    contributionId: result.contributionId,
    action: "set_status",
    status: "approved",
    version: 0,
  });
  assert.equal((await listPublishedContributions(db, PILOT_SLUG)).length, 0);
  await assert.rejects(
    setGalleryPublication(db, reviewer, { contributionId: result.contributionId, state: "publish", version: 0 }),
    /changed since/,
  );
  const published = await setGalleryPublication(db, reviewer, {
    contributionId: result.contributionId,
    state: "publish",
    version: 1,
  });
  assert.equal(published.state, "published");
  await assert.rejects(
    setGalleryPublication(db, reviewer, { contributionId: result.contributionId, state: "publish", version: 2 }),
    /already in the public gallery/,
  );

  const hidden = await setGalleryPublication(db, reviewer, {
    contributionId: result.contributionId,
    state: "hide",
    version: 2,
  });
  assert.equal(hidden.state, "hidden");
  assert.equal(hidden.publishedAt, published.publishedAt);
  assert.equal((await listPublishedContributions(db, PILOT_SLUG)).length, 0);
  const shown = await setGalleryPublication(db, reviewer, {
    contributionId: result.contributionId,
    state: "show",
    version: 3,
  });
  assert.equal(shown.publishedAt, published.publishedAt);
  assert.equal((await listPublishedContributions(db, PILOT_SLUG)).length, 1);

  const inbox = await listContributions(db, reviewer);
  assert.equal(inbox.items[0]?.galleryPublishedAt, published.publishedAt);
  const actions = (await db.collection("collaboration_events").find({ contributionId: result.contributionId }).toArray()).map(
    (event) => event.action,
  );
  assert.deepEqual(actions, ["set_status", "publish_to_gallery", "hide_from_gallery", "show_in_gallery"]);
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

test("contact retention runs from the approval date, not from later reviewer activity", async () => {
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
  const approved = await db.collection("collaboration_contributions").findOne({ contributionId: result.contributionId });
  assert.ok(approved?.approvedAt instanceof Date);

  await db.collection("collaboration_contributions").updateOne(
    { contributionId: result.contributionId },
    {
      $set: {
        approvedAt: new Date(Date.now() - 400 * 86_400_000),
        // Later reviewer activity, such as recording a use, must not extend it.
        updatedAt: new Date(),
      },
    },
  );
  await purgeExpiredContent(db, { apply: true });
  const row = await db.collection("collaboration_contributions").findOne({ contributionId: result.contributionId });
  assert.equal(row?.email, "");
  assert.ok(Object.keys(row?.answers ?? {}).length > 0);
});

test("a retention clear refuses a record that changed after selection", async () => {
  const db = await setup();
  const result = await submitContribution(db, submission());
  await reviewContribution(db, reviewer, {
    contributionId: result.contributionId,
    action: "set_status",
    status: "declined",
    version: 0,
  });
  // A reviewer reopens it before the sweep clears it.
  await reviewContribution(db, reviewer, {
    contributionId: result.contributionId,
    action: "set_status",
    status: "needs_follow_up",
    version: 1,
  });
  assert.equal(await clearExpiredContribution(db, result.contributionId, "declined"), false);
  const row = await db.collection("collaboration_contributions").findOne({ contributionId: result.contributionId });
  assert.ok(Object.keys(row?.answers ?? {}).length > 0);
  assert.equal(row?.contentClearedAt, undefined);
});

test("a management token is stable, hashed at rest and opens only its own contribution", async () => {
  const db = await setup();
  const first = await submitContribution(db, submission(), [], { tokenSecret: "test-secret" });
  const retry = await submitContribution(db, submission(), [], { tokenSecret: "test-secret" });
  const second = await submitContribution(
    db,
    submission({ requestId: REQUEST_ID_2 }),
    [],
    { tokenSecret: "test-secret" },
  );
  assert.ok(first.manageToken);
  assert.equal(retry.manageToken, null);
  assert.match(first.manageToken, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(second.manageToken);
  assert.notEqual(first.manageToken, second.manageToken);

  const row = await db.collection("collaboration_contributions").findOne({ contributionId: first.contributionId });
  assert.equal(row?.manageTokenHash?.length, 64);
  assert.equal(JSON.stringify(row).includes(first.manageToken), false);

  const view = await viewManagedContribution(db, first.manageToken);
  assert.equal(view.contributionId, first.contributionId);
  assert.equal(view.answers[0]?.label, "What does Fusion mean to you?");
  assert.equal(view.status, "new");
  await assert.rejects(viewManagedContribution(db, first.manageToken.slice(0, -1) + "A"), /not valid/);
});

test("the contributor can correct their words, which returns the story to review and off the gallery", async () => {
  const db = await setup();
  const result = await submitContribution(
    db,
    submission({ channels: ["website"], contactAllowed: true, email: "sam@example.com" }),
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
  assert.equal((await listPublishedContributions(db, PILOT_SLUG)).length, 1);

  const view = await viewManagedContribution(db, result.manageToken!);
  await manageContribution(db, {
    token: result.manageToken!,
    action: "correct",
    answers: { meaning: "A corrected story that says what I actually meant to say." },
    caption: "A corrected caption",
  });
  const row = await db.collection("collaboration_contributions").findOne({ contributionId: result.contributionId });
  assert.equal(row?.answers.meaning, "A corrected story that says what I actually meant to say.");
  assert.equal(row?.caption, "A corrected caption");
  assert.equal(row?.status, "needs_follow_up");
  assert.ok(row?.galleryHiddenAt);
  assert.ok(row?.correctedAt);
  assert.equal(view.emailMasked, "s**@example.com");
  assert.equal((await listPublishedContributions(db, PILOT_SLUG)).length, 0);
  const events = await db.collection("collaboration_events").find({ contributionId: result.contributionId }).toArray();
  assert.equal(events.some((event) => event.action === "correct_by_contributor" && event.actorId === "contributor"), true);
});

test("the contributor can hide from the gallery, then withdraw everything without an account", async () => {
  const db = await setup();
  const result = await submitContribution(
    db,
    submission({ channels: ["website"], contactAllowed: true, email: "sam@example.com" }),
    [photo()],
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

  await manageContribution(db, { token: result.manageToken!, action: "hide" });
  assert.equal((await listPublishedContributions(db, PILOT_SLUG)).length, 0);
  const approved = await db.collection("collaboration_contributions").findOne({ contributionId: result.contributionId });
  assert.equal(approved?.status, "approved");

  const withdrawn = await manageContribution(db, { token: result.manageToken!, action: "withdraw" });
  assert.equal(withdrawn.withdrawn, true);
  const row = await db.collection("collaboration_contributions").findOne({ contributionId: result.contributionId });
  assert.equal(row?.status, "withdrawn");
  assert.equal(row?.email, "");
  assert.deepEqual(row?.answers, {});
  assert.deepEqual(row?.media, []);
  assert.equal(row?.manageTokenHash, undefined);
  assert.equal(await db.collection("collaboration_media").countDocuments(), 0);
  await assert.rejects(viewManagedContribution(db, result.manageToken!), /not valid/);
  await assert.rejects(
    manageContribution(db, { token: result.manageToken!, action: "withdraw" }),
    /not valid/,
  );
});

test("show cannot resurrect a story that was never published", async () => {
  const db = await setup();
  const result = await submitContribution(db, submission({ channels: ["website"] }));
  await reviewContribution(db, reviewer, {
    contributionId: result.contributionId,
    action: "set_status",
    status: "approved",
    version: 0,
  });
  await assert.rejects(
    setGalleryPublication(db, reviewer, {
      contributionId: result.contributionId,
      state: "show",
      version: 1,
    }),
    /not been published/,
  );
});

const memberUser = { memberId: "member-1", name: "Member One" } as unknown as SessionUser;
const otherUser = { memberId: "member-2", name: "Member Two" } as unknown as SessionUser;

test("linking a contribution needs a signed-in member and explicit consent", async () => {
  const db = await setup();
  const result = await submitContribution(db, submission());
  await assert.rejects(
    manageContribution(db, { token: result.manageToken!, action: "claim", consentToLink: true, user: null }),
    /Sign in/,
  );
  await assert.rejects(
    manageContribution(db, { token: result.manageToken!, action: "claim", consentToLink: false, user: memberUser }),
    /Confirm/,
  );
  await assert.rejects(
    manageContribution(db, { token: "not-a-real-token-not-a-real-token-not-a-real", action: "claim", consentToLink: true, user: memberUser }),
    /not valid/,
  );
});

test("a claim stores the member, time and consent version, and is idempotent", async () => {
  const db = await setup();
  const result = await submitContribution(db, submission());
  const first = await manageContribution(db, {
    token: result.manageToken!,
    action: "claim",
    consentToLink: true,
    user: memberUser,
  });
  assert.equal(first.claimed, true);
  const row = await db.collection("collaboration_contributions").findOne({ contributionId: result.contributionId });
  assert.equal(row?.claimedByMemberId, "member-1");
  assert.ok(row?.claimedAt instanceof Date);
  assert.equal(row?.claimConsentVersion, "claim-2026-11-17");

  const again = await manageContribution(db, {
    token: result.manageToken!,
    action: "claim",
    consentToLink: true,
    user: memberUser,
  });
  assert.equal(again.alreadyLinked, true);
  const events = await db.collection("collaboration_events").find({ contributionId: result.contributionId }).toArray();
  assert.equal(events.filter((event) => event.action === "claim_by_member").length, 1);
  assert.equal(events[0]?.actorId, "member-1");

  await assert.rejects(
    manageContribution(db, {
      token: result.manageToken!,
      action: "claim",
      consentToLink: true,
      user: otherUser,
    }),
    /different account/,
  );
});

test("claiming changes neither publication nor who can manage the contribution", async () => {
  const db = await setup();
  const result = await submitContribution(db, submission({ channels: ["website"] }), [photo()]);
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
  await manageContribution(db, {
    token: result.manageToken!,
    action: "claim",
    consentToLink: true,
    user: memberUser,
  });
  const row = await db.collection("collaboration_contributions").findOne({ contributionId: result.contributionId });
  assert.equal(row?.status, "approved");
  assert.ok(row?.galleryPublishedAt);
  assert.equal((await listPublishedContributions(db, PILOT_SLUG)).length, 1);

  // The token still manages it, and no account permission was created.
  await manageContribution(db, { token: result.manageToken!, action: "hide" });
  assert.equal((await listPublishedContributions(db, PILOT_SLUG)).length, 0);
  assert.equal(
    await db.collection("application_roles").countDocuments({ memberId: "member-1" }),
    0,
  );
});

test("the contributor can unlink the account, and a withdrawn contribution cannot be claimed", async () => {
  const db = await setup();
  const result = await submitContribution(db, submission());
  await manageContribution(db, {
    token: result.manageToken!,
    action: "claim",
    consentToLink: true,
    user: memberUser,
  });
  const unlinked = await manageContribution(db, {
    token: result.manageToken!,
    action: "unclaim",
    user: memberUser,
  });
  assert.equal(unlinked.claimed, false);
  const row = await db.collection("collaboration_contributions").findOne({ contributionId: result.contributionId });
  assert.equal(row?.claimedByMemberId, undefined);
  const events = await db.collection("collaboration_events").find({ contributionId: result.contributionId }).toArray();
  assert.equal(events.some((event) => event.action === "unclaim_by_member"), true);

  await manageContribution(db, { token: result.manageToken!, action: "withdraw" });
  await assert.rejects(
    manageContribution(db, {
      token: result.manageToken!,
      action: "claim",
      consentToLink: true,
      user: memberUser,
    }),
    /not valid/,
  );
});

test("management-token signing fails closed in production without a configured secret", () => {
  assert.throws(
    () => contributionTokenSecret({ APP_MODE: "production" }),
    /signing secret is configured/,
  );
  assert.equal(
    contributionTokenSecret({ APP_MODE: "production", BETTER_AUTH_SECRET: "a-secure-secret" }),
    "a-secure-secret",
  );
  assert.equal(contributionTokenSecret({ APP_MODE: "development" }), "engage-collaboration-local");
});

test("a submission reference cannot be reused across invitations", async () => {
  const db = await setup();
  const created = await createInitiative(db, reviewer, newInvitation);
  await db.collection("collaboration_initiatives").updateOne(
    { slug: created.slug },
    {
      $set: {
        status: "open",
        questions: [{ key: "meaning", label: "What does Fusion mean to you?" }],
      },
    },
  );
  const shared = { answers: { meaning: "The same words, deliberately reused with the same reference." } };
  await submitContribution(db, submission(shared));
  await assert.rejects(
    submitContribution(db, submission({ ...shared, initiativeSlug: created.slug })),
    /already been sent/,
  );
});

test("a written consultation cannot be published to the gallery", async () => {
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
    answers: { [created.questions[0]!.key]: "A written response that is long enough to be accepted." },
    channels: ["website"],
  });
  await reviewContribution(db, reviewer, {
    contributionId: result.contributionId,
    action: "set_status",
    status: "approved",
    version: 0,
  });
  await assert.rejects(
    setGalleryPublication(db, reviewer, {
      contributionId: result.contributionId,
      state: "publish",
      version: 1,
    }),
    /not published individually/,
  );
});
