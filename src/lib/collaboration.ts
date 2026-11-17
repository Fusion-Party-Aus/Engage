import { createHash } from "node:crypto";
import { Binary, ObjectId, type ClientSession, type Db } from "mongodb";
import { runInTransaction } from "./db.ts";
import { hasPermission } from "./rbac.ts";
import type { SessionUser } from "./types.ts";
import {
  COLLABORATION_CONSENT_VERSION,
  COLLABORATION_STATUSES,
  CONTRIBUTION_LIMITS,
  CONTRIBUTION_PROFILES,
  INITIATIVE_STATUSES,
  MAX_INITIATIVE_QUESTIONS,
  MEDIA_LIMITS,
  PUBLICATION_CHANNELS,
  PILOT_INITIATIVE,
  PILOT_SLUG,
  isPublicInitiativeStatus,
  nextQuestionKey,
  slugifyTitle,
  type Attribution,
  type CollaborationInitiative,
  type CollaborationStatus,
  type ContributionProfile,
  type ContributionQuestion,
  type InitiativeStatus,
  type PublicationChannel,
} from "./collaboration-options.ts";
import { prepareImage, safeFilename } from "./collaboration-media.ts";

/**
 * Public collaboration matters (#143).
 *
 * A collaboration matter invites stories and photographs for Fusion's public
 * storytelling. It is not a proposal, a ballot, a membership record or a policy
 * decision. Contributors need no account and no party membership, and nothing
 * they send is published automatically.
 */

export class CollaborationError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "CollaborationError";
    this.status = status;
  }
}

const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

const INITIATIVES = "collaboration_initiatives";
const CONTRIBUTIONS = "collaboration_contributions";
const MEDIA = "collaboration_media";
const EVENTS = "collaboration_events";

/**
 * Retention defaults. They are obligations, not editorial settings: changing
 * one shortens or lengthens how long personal material is kept.
 */
export const RETENTION = {
  /** Declined material is cleared after this many days. */
  declinedDays: 90,
  /** A withdrawal made before automatic clearing existed is swept after this. */
  withdrawnDays: 30,
  /** An approved contribution's contact address is cleared after this many days. */
  approvedContactDays: 365,
} as const;

export interface ContributionMediaDescriptor {
  mediaId: string;
  mimeType: string;
  byteSize: number;
  originalFilename: string;
}

export interface ContributionRecordView {
  contributionId: string;
  initiativeSlug: string;
  answers: Record<string, string>;
  caption: string;
  displayName: string;
  email: string;
  attribution: Attribution;
  channels: PublicationChannel[];
  allowEdits: boolean;
  allowAiEdits: boolean;
  contactAllowed: boolean;
  status: CollaborationStatus;
  contributorMessage: string;
  internalNotes: string;
  usedChannels: PublicationChannel[];
  publicationHistory: Array<{
    channel: PublicationChannel;
    reference: string;
    recordedBy: string;
    recordedAt: string;
  }>;
  media: ContributionMediaDescriptor[];
  version: number;
  consentVersion: string;
  contentClearedAt: string | null;
  galleryHiddenAt: string | null;
  /** The invitation as it read when this contribution was sent. */
  questions: Array<{ key: string; label: string }>;
  initiativeTitle: string;
  initiativePurpose: string;
  inputAcceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContributionInbox {
  items: ContributionRecordView[];
  total: number;
  counts: Record<CollaborationStatus, number>;
  withMedia: number;
}

function clampText(
  value: unknown,
  label: string,
  min: number,
  max: number,
): string {
  if (value === undefined || value === null) {
    if (min === 0) return "";
    throw new CollaborationError(`${label} is required.`);
  }
  if (typeof value !== "string") throw new CollaborationError(`${label} must be text.`);
  const trimmed = value.replace(/\r\n/g, "\n").trim();
  if (trimmed.length < min) throw new CollaborationError(`${label} is too short.`);
  if (trimmed.length > max) {
    throw new CollaborationError(`${label} must be ${max} characters or fewer.`);
  }
  return trimmed;
}

function channelsFrom(value: unknown): PublicationChannel[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new CollaborationError("Choose how we may use your contribution.");
  const chosen: PublicationChannel[] = [];
  for (const raw of value) {
    if (typeof raw !== "string" || !Object.hasOwn(PUBLICATION_CHANNELS, raw)) {
      throw new CollaborationError("Choose how we may use your contribution.");
    }
    const channel = raw as PublicationChannel;
    if (!chosen.includes(channel)) chosen.push(channel);
  }
  return chosen;
}

function attributionFrom(value: unknown): Attribution {
  if (value === "named" || value === "anonymous") return value;
  throw new CollaborationError("Choose whether we may use your name.");
}

function emailLooksValid(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** Collaborators need no account, so only the reviewer is authorised here. */
function assertReviewer(user: SessionUser | null | undefined): SessionUser {
  if (!user) throw new CollaborationError("Sign in required.", 401);
  if (!hasPermission(user, "collaboration.review")) {
    throw new CollaborationError("You do not have permission to review contributions.", 403);
  }
  return user;
}

export async function listOpenInitiatives(db: Db): Promise<CollaborationInitiative[]> {
  const rows = await db
    .collection(INITIATIVES)
    .find({ status: "open" })
    .sort({ createdAt: 1 })
    .toArray();
  return rows.map(toInitiative);
}

export async function getInitiative(
  db: Db,
  slug: string,
): Promise<CollaborationInitiative | null> {
  const row = await db.collection(INITIATIVES).findOne({ slug });
  return row ? toInitiative(row) : null;
}

/** A draft or archived invitation has no public page. */
export async function getPublicInitiative(
  db: Db,
  slug: string,
): Promise<CollaborationInitiative | null> {
  const initiative = await getInitiative(db, slug);
  return initiative && isPublicInitiativeStatus(initiative.status) ? initiative : null;
}

export interface InitiativeSummary {
  initiative: CollaborationInitiative;
  contributions: number;
  awaitingReview: number;
}

/** Every invitation, newest first, with the counts an editor needs. */
export async function listInitiatives(db: Db): Promise<InitiativeSummary[]> {
  const rows = await db.collection(INITIATIVES).find({}).sort({ createdAt: -1 }).toArray();
  return Promise.all(
    rows.map(async (row) => {
      const initiative = toInitiative(row);
      const [contributions, awaitingReview] = await Promise.all([
        db.collection(CONTRIBUTIONS).countDocuments({ initiativeSlug: initiative.slug }),
        db
          .collection(CONTRIBUTIONS)
          .countDocuments({ initiativeSlug: initiative.slug, status: { $in: ["new", "needs_follow_up"] } }),
      ]);
      return { initiative, contributions, awaitingReview };
    }),
  );
}

function toInitiative(row: Record<string, any>): CollaborationInitiative {
  const questions = Array.isArray(row.questions) ? row.questions : [];
  return {
    slug: String(row.slug),
    title: String(row.title),
    summary: String(row.summary ?? ""),
    purpose: String(row.purpose ?? ""),
    profile: Object.hasOwn(CONTRIBUTION_PROFILES, row.profile) ? (row.profile as ContributionProfile) : "story",
    questions: questions.map((question: any) => ({
      key: String(question.key),
      label: String(question.label),
      ...(question.hint ? { hint: String(question.hint) } : {}),
    })) satisfies ContributionQuestion[],
    status: Object.hasOwn(INITIATIVE_STATUSES, row.status) ? (row.status as InitiativeStatus) : "draft",
    archivedAt: row.archivedAt ? new Date(row.archivedAt) : null,
    correctionEmail: String(row.correctionEmail ?? PILOT_INITIATIVE.correctionEmail),
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

/**
 * Create the pilot initiative if it does not exist. Insert-only: an editor's
 * wording, questions and open/paused/closed decision must survive a redeploy.
 * Re-seeding only fills a missing record.
 */
export async function seedPilotInitiative(
  db: Db,
  overrides: Partial<typeof PILOT_INITIATIVE> = {},
): Promise<CollaborationInitiative> {
  const now = new Date();
  const definition = { ...PILOT_INITIATIVE, ...overrides, slug: overrides.slug ?? PILOT_SLUG };
  await db.collection(INITIATIVES).updateOne(
    { slug: definition.slug },
    {
      $setOnInsert: {
        slug: definition.slug,
        title: definition.title,
        summary: definition.summary,
        purpose: definition.purpose,
        questions: definition.questions,
        profile: definition.profile,
        status: definition.status,
        createdAt: now,
        updatedAt: now,
      },
    },
    { upsert: true },
  );
  const saved = await getInitiative(db, definition.slug);
  if (!saved) throw new CollaborationError("Could not create the initiative.", 500);
  return saved;
}

export interface InitiativeCreateInput {
  title: unknown;
  summary: unknown;
  purpose: unknown;
  question: unknown;
  hint?: unknown;
  correctionEmail: unknown;
  profile?: unknown;
}

/**
 * Create an invitation as a draft. It has no public page until an editor opens
 * it, which keeps creation and publication as separate decisions.
 */
export async function createInitiative(
  db: Db,
  user: SessionUser | null | undefined,
  input: InitiativeCreateInput,
): Promise<CollaborationInitiative> {
  if (!user) throw new CollaborationError("Sign in required.", 401);
  if (!hasPermission(user, "collaboration.manage")) {
    throw new CollaborationError("You do not have permission to create an invitation.", 403);
  }
  const title = clampText(input.title, "Title", 3, 120);
  const summary = clampText(input.summary, "Summary", 10, 600);
  const purpose = clampText(input.purpose, "Purpose", 10, 1_200);
  const label = clampText(input.question, "First question", 3, 160);
  const hint = clampText(input.hint, "Question hint", 0, 200);
  const correctionEmail = clampText(input.correctionEmail, "Correction email", 5, 254);
  if (!emailLooksValid(correctionEmail)) {
    throw new CollaborationError("Enter a valid email address for corrections and removals.");
  }
  const profile =
    input.profile === undefined || input.profile === ""
      ? "story"
      : input.profile;
  if (typeof profile !== "string" || !Object.hasOwn(CONTRIBUTION_PROFILES, profile)) {
    throw new CollaborationError("Choose what this invitation collects.");
  }
  const base = slugifyTitle(title) || "invitation";
  const now = new Date();
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const slug = attempt === 1 ? base : `${base}-${attempt}`;
    // The unique index is the backstop; this check also keeps the in-memory
    // preview honest, where indexes are not enforced.
    if (await db.collection(INITIATIVES).countDocuments({ slug })) continue;
    try {
      await db.collection(INITIATIVES).insertOne({
        slug,
        title,
        summary,
        purpose,
        questions: [{ key: nextQuestionKey([]), label, ...(hint ? { hint } : {}) }],
        profile,
        status: "draft",
        correctionEmail,
        createdAt: now,
        updatedAt: now,
        createdBy: user.memberId,
      });
      const saved = await getInitiative(db, slug);
      if (!saved) throw new CollaborationError("Could not create the invitation.", 500);
      return saved;
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
  }
  throw new CollaborationError("Could not find a free address for this invitation. Try a different title.", 409);
}

export interface InitiativeUpdateInput {
  slug: unknown;
  title: unknown;
  summary: unknown;
  purpose: unknown;
  status: unknown;
  questions: unknown;
  correctionEmail: unknown;
}

/**
 * Editors own the invitation's words and questions. Keys are stable: an existing
 * question keeps its key when its label changes, so earlier answers survive;
 * a new question receives the next free opaque key. Nothing here can change the
 * consent vocabulary, statuses, limits or permissions, which are enforced rules.
 */
export async function updateInitiative(
  db: Db,
  user: SessionUser | null | undefined,
  input: InitiativeUpdateInput,
): Promise<CollaborationInitiative> {
  if (!user) throw new CollaborationError("Sign in required.", 401);
  if (!hasPermission(user, "collaboration.manage")) {
    throw new CollaborationError("You do not have permission to change this invitation.", 403);
  }
  const slug = clampText(input.slug, "Invitation", 1, 120);
  const current = await getInitiative(db, slug);
  if (!current) throw new CollaborationError("That invitation no longer exists.", 404);
  const status = input.status;
  if (typeof status !== "string" || !Object.hasOwn(INITIATIVE_STATUSES, status)) {
    throw new CollaborationError("Choose the invitation's state.");
  }
  if (!Array.isArray(input.questions) || input.questions.length < 1) {
    throw new CollaborationError("Ask at least one question.");
  }
  if (input.questions.length > MAX_INITIATIVE_QUESTIONS) {
    throw new CollaborationError(`Use ${MAX_INITIATIVE_QUESTIONS} questions or fewer.`);
  }
  const correctionEmail = clampText(input.correctionEmail, "Correction email", 5, 254);
  if (!emailLooksValid(correctionEmail)) {
    throw new CollaborationError("Enter a valid email address for corrections and removals.");
  }
  const existingKeys = new Set(current.questions.map((question) => question.key));
  const questions: ContributionQuestion[] = [];
  for (const raw of input.questions) {
    const entry = raw as Record<string, unknown>;
    const label = clampText(entry.label, "Question", 3, 160);
    const hint = clampText(entry.hint, "Question hint", 0, 200);
    const key =
      typeof entry.key === "string" && existingKeys.has(entry.key)
        ? entry.key
        : nextQuestionKey([...current.questions, ...questions]);
    if (questions.some((question) => question.key === key)) {
      throw new CollaborationError("Reload the invitation and try again.");
    }
    questions.push({ key, label, ...(hint ? { hint } : {}) });
  }
  await db.collection(INITIATIVES).updateOne(
    { slug },
    {
      $set: {
        title: clampText(input.title, "Title", 3, 120),
        summary: clampText(input.summary, "Summary", 10, 600),
        purpose: clampText(input.purpose, "Purpose", 10, 1_200),
        status,
        questions,
        correctionEmail: correctionEmail,
        updatedAt: new Date(),
        updatedBy: user.memberId,
        ...(status === "archived" ? { archivedAt: new Date() } : {}),
      },
      ...(status === "archived" ? {} : { $unset: { archivedAt: "" } }),
    },
  );
  const saved = await getInitiative(db, slug);
  if (!saved) throw new CollaborationError("That invitation no longer exists.", 404);
  return saved;
}

export interface SubmissionInput {
  initiativeSlug: string;
  requestId: string;
  answers: Record<string, unknown>;
  caption?: unknown;
  displayName?: unknown;
  email?: unknown;
  attribution: unknown;
  channels: unknown;
  allowEdits?: unknown;
  allowAiEdits?: unknown;
  contactAllowed?: unknown;
  consent?: unknown;
  website?: unknown;
}

export interface SubmissionResult {
  contributionId: string;
  /** True when at least one publication channel was permitted. */
  shareable: boolean;
}

export async function submitContribution(
  db: Db,
  input: SubmissionInput,
  files: readonly File[] = [],
): Promise<SubmissionResult> {
  if (input.website) throw new CollaborationError("Could not accept this submission.");
  if (input.consent !== true) {
    throw new CollaborationError("Confirm this is your own story and photos before sending.");
  }
  if (!UUID_PATTERN.test(String(input.requestId ?? ""))) {
    throw new CollaborationError("Please reload the page and try again.");
  }
  const initiative = await getInitiative(db, String(input.initiativeSlug ?? ""));
  if (!initiative) throw new CollaborationError("That invitation is not available.", 404);
  if (initiative.status !== "open") {
    throw new CollaborationError("This invitation is not accepting contributions right now.", 409);
  }

  const knownKeys = new Set(initiative.questions.map((question) => question.key));
  for (const [key, value] of Object.entries(input.answers ?? {})) {
    if (!knownKeys.has(key) && typeof value === "string" && value.trim()) {
      throw new CollaborationError(
        "This invitation changed while you were writing. Your words are still here. Reload to see the current questions.",
        409,
      );
    }
  }
  if (initiative.profile === "consultation" && files.length > 0) {
    throw new CollaborationError("This invitation asks for written responses only.");
  }
  const answers: Record<string, string> = {};
  for (const question of initiative.questions) {
    const value = clampText(
      input.answers?.[question.key],
      question.label,
      0,
      CONTRIBUTION_LIMITS.answer,
    );
    if (value) answers[question.key] = value;
  }
  const caption =
    initiative.profile === "consultation"
      ? ""
      : clampText(input.caption, "Photo caption", 0, CONTRIBUTION_LIMITS.caption);
  const attribution: Attribution =
    initiative.profile === "consultation" ? "anonymous" : attributionFrom(input.attribution);
  const channels = channelsFrom(input.channels);
  const allowEdits = initiative.profile === "story" && input.allowEdits === true;
  const allowAiEdits = initiative.profile === "story" && input.allowAiEdits === true;
  if (allowAiEdits && !allowEdits) {
    throw new CollaborationError(
      "Choose whether ordinary edits are allowed before optional AI-assisted edits.",
    );
  }
  const contactAllowed = input.contactAllowed === true;
  const email = contactAllowed
    ? clampText(input.email, "Email", 5, CONTRIBUTION_LIMITS.email)
    : "";
  if (email && !emailLooksValid(email)) {
    throw new CollaborationError("Enter an email address we can reply to, or leave it blank.");
  }
  if (allowAiEdits && !contactAllowed) {
    throw new CollaborationError(
      "Add a reply address so we can show you an AI-assisted edit before it is used, or leave it off.",
    );
  }
  const displayName =
    attribution === "named"
      ? clampText(input.displayName, "Your name", 2, CONTRIBUTION_LIMITS.displayName)
      : "";

  if (files.length > MEDIA_LIMITS.files) {
    throw new CollaborationError(`Add up to ${MEDIA_LIMITS.files} photos.`);
  }
  const prepared: Array<{ file: File; image: ReturnType<typeof prepareImage> }> = [];
  let totalBytes = 0;
  for (const file of files) {
    const bytes = Buffer.from(await file.arrayBuffer());
    totalBytes += bytes.length;
    if (totalBytes > MEDIA_LIMITS.totalBytes) {
      throw new CollaborationError(
        `Photos must total ${MEDIA_LIMITS.totalBytes / (1024 * 1024)} MB or less.`,
        413,
      );
    }
    prepared.push({ file, image: prepareImage(bytes) });
  }

  const longestAnswer = Object.values(answers).reduce(
    (longest, value) => Math.max(longest, value.length),
    0,
  );
  if (!prepared.length && longestAnswer < 20) {
    throw new CollaborationError("Add a few words, or a photo, before sending.");
  }

  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        answers,
        caption,
        attribution,
        channels,
        allowEdits,
        allowAiEdits,
        email,
        displayName,
        consent: true,
        media: prepared.map((entry) => entry.image.sha256),
      }),
    )
    .digest("hex");
  const _id = new ObjectId(
    createHash("sha256").update(input.requestId).digest("hex").slice(0, 24),
  );
  const existing = await db.collection(CONTRIBUTIONS).findOne({ _id });
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw new CollaborationError(
        "This form has already been sent. Reload the page to share something else.",
        409,
      );
    }
    return { contributionId: String(existing.contributionId), shareable: channels.length > 0 };
  }

  const now = new Date();
  const contributionId = input.requestId;
  const media: ContributionMediaDescriptor[] = prepared.map(({ file, image }) => ({
    mediaId: new ObjectId().toHexString(),
    mimeType: image.mimeType,
    byteSize: image.bytes.length,
    originalFilename: safeFilename(file.name),
  }));

  let inserted = false;
  try {
    await db.collection(CONTRIBUTIONS).insertOne({
      _id,
      contributionId,
      initiativeSlug: initiative.slug,
      // Snapshot what the contributor actually read and answered.
      initiativeTitle: initiative.title,
      initiativePurpose: initiative.purpose,
      questions: initiative.questions.map((question) => ({ key: question.key, label: question.label })),
      profile: initiative.profile,
      answers,
      caption,
      displayName,
      email,
      attribution,
      channels,
      allowEdits,
      allowAiEdits,
      contactAllowed,
      status: "new",
      contributorMessage: "",
      internalNotes: "",
      usedChannels: [],
      publicationHistory: [],
      media,
      hasMedia: media.length > 0,
      fingerprint,
      version: 0,
      consentVersion: COLLABORATION_CONSENT_VERSION,
      createdAt: now,
      updatedAt: now,
    });
    inserted = true;
    for (const [index, entry] of prepared.entries()) {
      const descriptor = media[index]!;
      await db.collection(MEDIA).insertOne({
        mediaId: descriptor.mediaId,
        contributionId,
        initiativeSlug: initiative.slug,
        mimeType: entry.image.mimeType,
        byteSize: entry.image.bytes.length,
        sha256: entry.image.sha256,
        originalFilename: descriptor.originalFilename,
        bytes: entry.image.bytes,
        createdAt: now,
      });
    }
  } catch (error) {
    if (inserted) {
      await db.collection(CONTRIBUTIONS).deleteOne({ contributionId }).catch(() => {});
      await db.collection(MEDIA).deleteMany({ contributionId }).catch(() => {});
    }
    if ((error as { code?: number }).code !== 11000) throw error;
    const saved = await db.collection(CONTRIBUTIONS).findOne({ _id });
    if (saved?.fingerprint !== fingerprint) {
      throw new CollaborationError(
        "This form has already been sent. Reload the page to share something else.",
        409,
      );
    }
  }

  return { contributionId, shareable: channels.length > 0 };
}

/**
 * Remove the contributor's words, name, contact address and photographs, and
 * keep only the review record. Irreversible by design.
 */
async function clearContributionContent(
  db: Db,
  contributionId: string,
  reason: "withdrawn" | "declined" | "retention",
  options: { keepContact?: boolean; session?: ClientSession; touch?: boolean } = {},
): Promise<void> {
  await db.collection(MEDIA).deleteMany({ contributionId }, { session: options.session });
  await db.collection(CONTRIBUTIONS).updateOne(
    { contributionId },
    {
      $set: {
        answers: {},
        caption: "",
        displayName: "",
        contributorMessage: "",
        internalNotes: "",
        media: [],
        hasMedia: false,
        ...(options.keepContact ? {} : { email: "", contactAllowed: false }),
        contentClearedAt: new Date(),
        contentClearedReason: reason,
        ...(options.touch === false ? {} : { updatedAt: new Date() }),
      },
    },
    { session: options.session },
  );
}

/**
 * Retention sweep, dry-run by default. Withdrawals clear immediately at the
 * moment of review; this catches declined material after the retention window,
 * legacy withdrawals, and stale contact addresses.
 */
export async function purgeExpiredContent(
  db: Db,
  options: { now?: Date; apply?: boolean } = {},
): Promise<{
  declined: number;
  withdrawn: number;
  contactAddresses: number;
  applied: boolean;
}> {
  const now = options.now ?? new Date();
  const day = 86_400_000;
  const before = (days: number) => new Date(now.getTime() - days * day);
  const declined = await db
    .collection(CONTRIBUTIONS)
    .find({ status: "declined", contentClearedAt: { $exists: false }, updatedAt: { $lt: before(RETENTION.declinedDays) } })
    .project({ contributionId: 1 })
    .toArray();
  const withdrawn = await db
    .collection(CONTRIBUTIONS)
    .find({ status: "withdrawn", contentClearedAt: { $exists: false }, updatedAt: { $lt: before(RETENTION.withdrawnDays) } })
    .project({ contributionId: 1 })
    .toArray();
  const contacts = await db
    .collection(CONTRIBUTIONS)
    .find({ status: "approved", email: { $ne: "" }, updatedAt: { $lt: before(RETENTION.approvedContactDays) } })
    .project({ contributionId: 1 })
    .toArray();

  if (options.apply) {
    for (const row of declined) {
      await clearContributionContent(db, String(row.contributionId), "declined");
    }
    for (const row of withdrawn) {
      await clearContributionContent(db, String(row.contributionId), "withdrawn");
    }
    for (const row of contacts) {
      await db
        .collection(CONTRIBUTIONS)
        .updateOne(
          { contributionId: row.contributionId },
          { $set: { email: "", contactAllowed: false, updatedAt: new Date() } },
        );
    }
  }
  return {
    declined: declined.length,
    withdrawn: withdrawn.length,
    contactAddresses: contacts.length,
    applied: options.apply === true,
  };
}

export async function listContributions(
  db: Db,
  user: SessionUser | null | undefined,
  filters: { status?: unknown; page?: unknown; q?: unknown } = {},
): Promise<ContributionInbox> {
  assertReviewer(user);
  const status =
    typeof filters.status === "string" && Object.hasOwn(COLLABORATION_STATUSES, filters.status)
      ? (filters.status as CollaborationStatus)
      : undefined;
  const page = Number(filters.page ?? 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) {
    throw new CollaborationError("Choose a valid page.");
  }
  const reference =
    typeof filters.q === "string" ? filters.q.trim().replace(/[^a-z0-9]/gi, "").slice(0, 36) : "";
  const filter: Record<string, unknown> = status ? { status } : {};
  if (reference.length >= 3) {
    filter.contributionId = new RegExp(`^${reference}`, "i");
  }
  const [total, rows, statusCounts, withMedia] = await Promise.all([
    db.collection(CONTRIBUTIONS).countDocuments(filter),
    db
      .collection(CONTRIBUTIONS)
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(page * 20)
      .toArray(),
    Promise.all(
      Object.keys(COLLABORATION_STATUSES).map(async (key) => [
        key,
        await db.collection(CONTRIBUTIONS).countDocuments({ status: key }),
      ] as const),
    ),
    db.collection(CONTRIBUTIONS).countDocuments({ hasMedia: true }),
  ]);
  return {
    items: rows.slice((page - 1) * 20).map(toContributionView),
    total,
    counts: Object.fromEntries(statusCounts) as Record<CollaborationStatus, number>,
    withMedia,
  };
}

function toContributionView(row: Record<string, any>): ContributionRecordView {
  return {
    contributionId: String(row.contributionId),
    initiativeSlug: String(row.initiativeSlug),
    answers: (row.answers ?? {}) as Record<string, string>,
    caption: String(row.caption ?? ""),
    displayName: String(row.displayName ?? ""),
    email: String(row.email ?? ""),
    attribution: row.attribution === "named" ? "named" : "anonymous",
    channels: Array.isArray(row.channels) ? row.channels : [],
    allowEdits: row.allowEdits === true,
    allowAiEdits: row.allowAiEdits === true,
    contactAllowed: row.contactAllowed === true,
    status: (Object.hasOwn(COLLABORATION_STATUSES, row.status) ? row.status : "new") as CollaborationStatus,
    contributorMessage: String(row.contributorMessage ?? ""),
    internalNotes: String(row.internalNotes ?? ""),
    usedChannels: Array.isArray(row.usedChannels) ? row.usedChannels : [],
    publicationHistory: (Array.isArray(row.publicationHistory) ? row.publicationHistory : []).map(
      (entry: any) => ({
        channel: entry.channel as PublicationChannel,
        reference: String(entry.reference ?? ""),
        recordedBy: String(entry.recordedBy ?? ""),
        recordedAt: new Date(entry.recordedAt).toISOString(),
      }),
    ),
    media: (Array.isArray(row.media) ? row.media : []).map((entry: any) => ({
      mediaId: String(entry.mediaId),
      mimeType: String(entry.mimeType),
      byteSize: Number(entry.byteSize ?? 0),
      originalFilename: String(entry.originalFilename ?? "photo"),
    })),
    version: Number(row.version ?? 0),
    consentVersion: String(row.consentVersion ?? ""),
    contentClearedAt: row.contentClearedAt ? new Date(row.contentClearedAt).toISOString() : null,
    galleryHiddenAt: row.galleryHiddenAt ? new Date(row.galleryHiddenAt).toISOString() : null,
    questions: (Array.isArray(row.questions) ? row.questions : []).map((question: any) => ({
      key: String(question.key),
      label: String(question.label),
    })),
    initiativeTitle: String(row.initiativeTitle ?? row.initiativeSlug ?? ""),
    initiativePurpose: String(row.initiativePurpose ?? ""),
    inputAcceptedAt: row.inputAcceptedAt ? new Date(row.inputAcceptedAt).toISOString() : null,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

async function appendEvent(
  db: Db,
  input: {
    contributionId: string;
    action: string;
    actorId: string;
    fromStatus?: CollaborationStatus;
    toStatus?: CollaborationStatus;
    note?: string;
    channel?: PublicationChannel;
  },
  session?: ClientSession,
): Promise<void> {
  await db.collection(EVENTS).insertOne(
    {
      eventId: new ObjectId().toHexString(),
      ...input,
      at: new Date(),
    },
    { session },
  );
}

export type ReviewAction = "set_status" | "record_use";

export interface ReviewInput {
  contributionId: unknown;
  action: unknown;
  status?: unknown;
  contributorMessage?: unknown;
  internalNotes?: unknown;
  channel?: unknown;
  reference?: unknown;
  version: unknown;
}

/**
 * One reviewed decision at a time. Optimistic `version` prevents two reviewers
 * overwriting each other, and every change leaves an audit event.
 */
export async function reviewContribution(
  db: Db,
  user: SessionUser | null | undefined,
  input: ReviewInput,
): Promise<{ status: CollaborationStatus; version: number; acceptedAt: string | null }> {
  const reviewer = assertReviewer(user);
  const contributionId = clampText(input.contributionId, "Contribution", 36, 36);
  const current = await db.collection(CONTRIBUTIONS).findOne({ contributionId });
  if (!current) throw new CollaborationError("That contribution is no longer available.", 404);
  if (!Number.isSafeInteger(input.version) || Number(input.version) < 0) {
    throw new CollaborationError("Reload this contribution and try again.");
  }
  if (Number(input.version) !== Number(current.version)) {
    throw new CollaborationError(
      "This contribution changed since you opened it. Refresh and try again.",
      409,
    );
  }
  const fromStatus = current.status as CollaborationStatus;
  const acceptedAt = current.inputAcceptedAt
    ? new Date(current.inputAcceptedAt).toISOString()
    : null;
  // Withdrawal and retention clearing are terminal for the material. A record
  // with no story, name or photographs cannot be published later.
  const materialGone = fromStatus === "withdrawn" || Boolean(current.contentClearedAt);

  if (input.action === "accept_input") {
    if (materialGone) {
      throw new CollaborationError(
        "This contribution was withdrawn or its material has been cleared, so it cannot be accepted.",
        409,
      );
    }
    const now = new Date();
    await runInTransaction(db, async (session) => {
      const written = await db.collection(CONTRIBUTIONS).updateOne(
        { contributionId, version: current.version },
        {
          $set: { inputAcceptedAt: now, inputAcceptedBy: reviewer.memberId, updatedAt: now },
          $inc: { version: 1 },
        },
        { session },
      );
      if (!written.matchedCount) {
        throw new CollaborationError(
          "This contribution changed while you were reviewing it. Refresh and try again.",
          409,
        );
      }
      await appendEvent(
        db,
        { contributionId, action: "accept_input", actorId: reviewer.memberId },
        session,
      );
    });
    return { status: fromStatus, version: Number(current.version) + 1, acceptedAt: now.toISOString() };
  }

  if (input.action === "record_use") {
    if (fromStatus !== "approved" || materialGone) {
      throw new CollaborationError("Approve this contribution before recording where it was used.");
    }
    const channel = input.channel;
    if (typeof channel !== "string" || !Object.hasOwn(PUBLICATION_CHANNELS, channel)) {
      throw new CollaborationError("Choose where it was used.");
    }
    if (!Array.isArray(current.channels) || !current.channels.includes(channel)) {
      throw new CollaborationError(
        "The contributor did not allow this use. Choose a permitted channel.",
      );
    }
    const reference = clampText(input.reference, "Where it was used", 2, 200);
    const usedChannels = Array.isArray(current.usedChannels) ? [...current.usedChannels] : [];
    if (!usedChannels.includes(channel)) usedChannels.push(channel);
    await runInTransaction(db, async (session) => {
      const written = await db.collection(CONTRIBUTIONS).updateOne(
        { contributionId, version: current.version },
        {
          $set: {
            usedChannels,
            publicationHistory: [
              ...(Array.isArray(current.publicationHistory) ? current.publicationHistory : []),
              { channel, reference, recordedBy: reviewer.memberId, recordedAt: new Date() },
            ],
            updatedAt: new Date(),
          },
          $inc: { version: 1 },
        },
        { session },
      );
      if (!written.matchedCount) {
        throw new CollaborationError(
          "This contribution changed while you were reviewing it. Refresh and try again.",
          409,
        );
      }
      await appendEvent(
        db,
        {
          contributionId,
          action: "record_use",
          actorId: reviewer.memberId,
          channel: channel as PublicationChannel,
          note: reference,
        },
        session,
      );
    });
    return { status: fromStatus, version: Number(current.version) + 1, acceptedAt };
  }

  if (input.action !== "set_status") throw new CollaborationError("Choose what to do.");
  const status = input.status;
  if (typeof status !== "string" || !Object.hasOwn(COLLABORATION_STATUSES, status)) {
    throw new CollaborationError("Choose a valid status.");
  }
  const nextStatus = status as CollaborationStatus;
  if (materialGone) {
    throw new CollaborationError(
      "This contribution was withdrawn or its material has been cleared and cannot be reopened.",
      409,
    );
  }
  if (nextStatus === "approved") {
    if (!Array.isArray(current.channels) || current.channels.length === 0) {
      throw new CollaborationError(
        "The contributor allowed private use only, so this cannot be published. Accept it as consultation input instead.",
      );
    }
    if (current.attribution === "named" && !String(current.displayName ?? "").trim()) {
      throw new CollaborationError("A named contribution needs a name before approval.");
    }
  }
  // An omitted field means "leave it alone"; an explicit string, including "",
  // is an intentional edit. This stops a status change erasing review notes.
  const contributorMessage =
    input.contributorMessage === undefined
      ? String(current.contributorMessage ?? "")
      : clampText(input.contributorMessage, "Message for the contributor", 0, 1_000);
  const internalNotes =
    input.internalNotes === undefined
      ? String(current.internalNotes ?? "")
      : clampText(input.internalNotes, "Internal notes", 0, 2_000);
  await runInTransaction(db, async (session) => {
    const written = await db.collection(CONTRIBUTIONS).updateOne(
      { contributionId, version: current.version },
      {
        $set: { status: nextStatus, contributorMessage, internalNotes, updatedAt: new Date() },
        $inc: { version: 1 },
      },
      { session },
    );
    if (!written.matchedCount) {
      throw new CollaborationError(
        "This contribution changed while you were reviewing it. Refresh and try again.",
        409,
      );
    }
    await appendEvent(
      db,
      {
        contributionId,
        action: "set_status",
        actorId: reviewer.memberId,
        fromStatus,
        toStatus: nextStatus,
      },
      session,
    );
    // A withdrawal removes the material at once, in the same transaction as the
    // decision and its audit event. Only the review record remains.
    if (nextStatus === "withdrawn") {
      await clearContributionContent(db, contributionId, "withdrawn", { session, touch: false });
    }
  });
  return { status: nextStatus, version: Number(current.version) + 1, acceptedAt };
}

export interface PublishedContribution {
  contributionId: string;
  name: string;
  attribution: Attribution;
  answers: Array<{ label: string; text: string }>;
  caption: string;
  media: Array<{ mediaId: string; mimeType: string }>;
  publishedAt: string;
}

/**
 * What may appear on the public gallery: an approved story whose contributor
 * chose the website channel, whose material still exists, and which a reviewer
 * has not hidden. Written responses are never published individually.
 */
const PUBLISHED_FILTER = {
  status: "approved",
  profile: "story",
  channels: { $in: ["website"] },
  contentClearedAt: { $exists: false },
  galleryHiddenAt: { $exists: false },
} as const;

export async function listPublishedContributions(
  db: Db,
  initiativeSlug: string,
): Promise<PublishedContribution[]> {
  const rows = await db
    .collection(CONTRIBUTIONS)
    .find({ ...PUBLISHED_FILTER, initiativeSlug })
    .sort({ updatedAt: -1 })
    .limit(60)
    .toArray();
  return rows.map((row) => {
    const questions = Array.isArray(row.questions) ? row.questions : [];
    const answers = Object.entries((row.answers ?? {}) as Record<string, string>)
      .filter(([, value]) => value.trim().length > 0)
      .map(([key, value]) => ({
        label: String(questions.find((question: any) => question.key === key)?.label ?? ""),
        text: value,
      }))
      .filter((answer) => answer.label);
    return {
      contributionId: String(row.contributionId),
      name: row.attribution === "named" ? String(row.displayName ?? "") : "",
      attribution: row.attribution === "named" ? "named" : "anonymous",
      answers,
      caption: String(row.caption ?? ""),
      media: (Array.isArray(row.media) ? row.media : []).map((entry: any) => ({
        mediaId: String(entry.mediaId),
        mimeType: String(entry.mimeType),
      })),
      publishedAt: new Date(row.updatedAt).toISOString(),
    };
  });
}

export async function countPublishedContributions(
  db: Db,
  initiativeSlug: string,
): Promise<number> {
  return db.collection(CONTRIBUTIONS).countDocuments({ ...PUBLISHED_FILTER, initiativeSlug });
}

/** Public media for a currently published story. Everything else is a 404. */
export async function readPublishedMedia(
  db: Db,
  mediaId: string,
): Promise<{ bytes: Buffer; mimeType: string }> {
  if (!/^[a-f0-9]{24}$/i.test(mediaId)) {
    throw new CollaborationError("That photo is not available.", 404);
  }
  const media = await db.collection(MEDIA).findOne({ mediaId });
  if (!media) throw new CollaborationError("That photo is not available.", 404);
  const published = await db
    .collection(CONTRIBUTIONS)
    .findOne({ ...PUBLISHED_FILTER, contributionId: media.contributionId });
  if (!published) throw new CollaborationError("That photo is not available.", 404);
  const stored = media.bytes;
  const bytes = Buffer.isBuffer(stored)
    ? stored
    : stored instanceof Binary
      ? Buffer.from(stored.buffer)
      : Buffer.from(stored ?? []);
  if (!bytes.length) throw new CollaborationError("That photo is not available.", 404);
  return { bytes, mimeType: String(media.mimeType) };
}

/** A reviewer can remove a story from the public gallery without withdrawing it. */
export async function setGalleryVisibility(
  db: Db,
  user: SessionUser | null | undefined,
  input: { contributionId: unknown; hidden: unknown; version: unknown },
): Promise<{ hidden: boolean; version: number }> {
  const reviewer = assertReviewer(user);
  const contributionId = clampText(input.contributionId, "Contribution", 36, 36);
  const current = await db.collection(CONTRIBUTIONS).findOne({ contributionId });
  if (!current) throw new CollaborationError("That contribution is no longer available.", 404);
  if (current.status !== "approved" || current.contentClearedAt) {
    throw new CollaborationError("Only an approved contribution can appear on the gallery.");
  }
  if (Number(input.version) !== Number(current.version)) {
    throw new CollaborationError("This contribution changed since you opened it. Refresh and try again.", 409);
  }
  const hidden = input.hidden === true;
  await runInTransaction(db, async (session) => {
    const written = await db.collection(CONTRIBUTIONS).updateOne(
      { contributionId, version: current.version },
      {
        $set: {
          ...(hidden ? { galleryHiddenAt: new Date() } : {}),
          updatedAt: new Date(),
        },
        ...(hidden ? {} : { $unset: { galleryHiddenAt: "" } }),
        $inc: { version: 1 },
      },
      { session },
    );
    if (!written.matchedCount) {
      throw new CollaborationError("This contribution changed while you were reviewing it. Refresh and try again.", 409);
    }
    await appendEvent(
      db,
      {
        contributionId,
        action: hidden ? "hide_from_gallery" : "show_in_gallery",
        actorId: reviewer.memberId,
      },
      session,
    );
  });
  return { hidden, version: Number(current.version) + 1 };
}

/** Private media is readable only by a reviewer, never by a public route. */
export async function readContributionMedia(
  db: Db,
  user: SessionUser | null | undefined,
  mediaId: string,
): Promise<{ bytes: Buffer; mimeType: string; filename: string }> {
  assertReviewer(user);
  if (!/^[a-f0-9]{24}$/i.test(mediaId)) {
    throw new CollaborationError("That photo is not available.", 404);
  }
  const row = await db.collection(MEDIA).findOne({ mediaId });
  if (!row) throw new CollaborationError("That photo is not available.", 404);
  // MongoDB returns a BSON Binary, while the in-memory preview keeps a Buffer.
  // Normalise both; Buffer.from(Binary) silently yields zero bytes.
  const stored = row.bytes;
  const bytes = Buffer.isBuffer(stored)
    ? stored
    : stored instanceof Binary
      ? Buffer.from(stored.buffer)
      : Buffer.from(stored ?? []);
  if (!bytes.length) throw new CollaborationError("That photo is not available.", 404);
  return {
    bytes,
    mimeType: String(row.mimeType),
    filename: String(row.originalFilename ?? "photo"),
  };
}

/**
 * Hand-off for the website team. Approved contributions only, with the
 * contributor's permissions attached. Contact details and internal notes are
 * deliberately excluded: the website team does not need them.
 */
export async function exportApproved(
  db: Db,
  user: SessionUser | null | undefined,
): Promise<Record<string, unknown>> {
  assertReviewer(user);
  const rows = await db
    .collection(CONTRIBUTIONS)
    .find({ status: "approved" })
    .sort({ updatedAt: 1 })
    .toArray();
  return {
    consentVersion: COLLABORATION_CONSENT_VERSION,
    exportedAt: new Date().toISOString(),
    contributions: rows.map((row) => ({
      contributionId: row.contributionId,
      initiative: row.initiativeSlug,
      name: row.attribution === "named" ? row.displayName : "",
      attribution: row.attribution,
      answers: row.answers ?? {},
      caption: row.caption ?? "",
      channels: row.channels ?? [],
      allowEdits: row.allowEdits === true,
      allowAiEdits: row.allowAiEdits === true,
      media: (row.media ?? []).map((entry: any) => ({
        mediaId: entry.mediaId,
        mimeType: entry.mimeType,
        byteSize: entry.byteSize,
        download: `/api/admin/collaboration/media/${entry.mediaId}`,
      })),
      approvedAt: new Date(row.updatedAt).toISOString(),
      publicationHistory: row.publicationHistory ?? [],
    })),
  };
}
