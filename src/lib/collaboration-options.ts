/**
 * Vocabulary shared by the public contribution form, the review queue and the
 * server. Keep this module free of Node and MongoDB imports so the browser can
 * bundle it.
 *
 * Collaboration matters are public, non-governance participation. Nothing here
 * confers membership, voting authority or policy status (#143).
 */

export const COLLABORATION_CONSENT_VERSION = "stories-2026-11-17";

/**
 * Statuses, channels, attribution and edit permissions are fixed in code on
 * purpose: approval, export and media access all enforce them, so changing one
 * must pass review. The invitation's wording, questions and open state are data
 * an editor owns (see `updateInitiative`).
 */
export const COLLABORATION_STATUSES = {
  new: "New",
  needs_follow_up: "Needs follow-up",
  approved: "Approved",
  declined: "Declined",
  withdrawn: "Withdrawn",
} as const;

export type CollaborationStatus = keyof typeof COLLABORATION_STATUSES;

export const PUBLICATION_CHANNELS = {
  website: "Fusion website",
  social: "Social media",
  email: "Email and newsletters",
  print: "Print",
} as const;

export type PublicationChannel = keyof typeof PUBLICATION_CHANNELS;

export const ATTRIBUTION_OPTIONS = {
  named: "Use my name",
  anonymous: "Don't credit me by name",
} as const;

export type Attribution = keyof typeof ATTRIBUTION_OPTIONS;

export interface ContributionQuestion {
  key: string;
  label: string;
  hint?: string;
}

/** The four questions the pilot asks. Order is deliberate: earliest first. */
export const PILOT_QUESTIONS: readonly ContributionQuestion[] = [
  {
    key: "broughtYou",
    label: "What brought you to Fusion?",
    hint: "What first caught your interest? You don't need to be a member.",
  },
  {
    key: "staying",
    label: "What makes you stay?",
    hint: "Skip this if you're new.",
  },
  {
    key: "meaning",
    label: "What does Fusion mean to you?",
  },
  {
    key: "different",
    label: "What do you think makes Fusion different?",
  },
];

/**
 * Invitation lifecycle. Draft and archived invitations are not reachable from
 * the public site; paused and closed keep the page and its explanation, but stop
 * accepting contributions.
 */
export const INITIATIVE_STATUSES = {
  draft: "Draft",
  open: "Open",
  paused: "Paused",
  closed: "Closed",
  archived: "Archived",
} as const;

export type InitiativeStatus = keyof typeof INITIATIVE_STATUSES;

/** Statuses that have a public page at all. */
export const PUBLIC_INITIATIVE_STATUSES: readonly InitiativeStatus[] = [
  "open",
  "paused",
  "closed",
];

export function isPublicInitiativeStatus(value: unknown): value is InitiativeStatus {
  return typeof value === "string" && PUBLIC_INITIATIVE_STATUSES.includes(value as InitiativeStatus);
}

/**
 * What an invitation collects. Two reviewed profiles, not a form builder:
 * a story profile accepts photographs and credit; a consultation profile
 * accepts written responses only and never records a name or edit permission.
 */
export const CONTRIBUTION_PROFILES = {
  story: "Story with photographs",
  consultation: "Written responses",
} as const;

export type ContributionProfile = keyof typeof CONTRIBUTION_PROFILES;

export interface CollaborationInitiative {
  slug: string;
  title: string;
  summary: string;
  /** Why the material is wanted and how it will be used. */
  purpose: string;
  questions: readonly ContributionQuestion[];
  profile: ContributionProfile;
  status: InitiativeStatus;
  /** Set when an editor archives the invitation, cleared on restore. */
  archivedAt?: Date | null;
  /** Where a contributor asks for a correction or removal. Editorial, not code. */
  correctionEmail: string;
  createdAt: Date;
  updatedAt: Date;
}

export const PILOT_SLUG = "help-us-tell-fusions-story";

/** The seeded pilot initiative. Content is editable by rerunning the seed. */
export const PILOT_INITIATIVE = {
  slug: PILOT_SLUG,
  title: "Help us tell Fusion's story",
  summary:
    "We're collecting real stories and photographs from people connected to Fusion. Your words and pictures will help show what the party is actually like, in the place of slogans.",
  purpose:
    "Fusion's website is moving towards real people and real stories. We need honest material, not polished testimonials. Share as much or as little as you like, and choose how it can be used.",
  questions: PILOT_QUESTIONS,
  profile: "story" as const,
  status: "open" as const,
  correctionEmail: "engage@fusionparty.org.au",
} satisfies Omit<CollaborationInitiative, "createdAt" | "updatedAt">;

export const CONTRIBUTION_LIMITS = {
  answer: 2_000,
  caption: 400,
  displayName: 80,
  email: 254,
} as const;

/** Invitation questions are data, not code: editors may add or remove them. */
export const MAX_INITIATIVE_QUESTIONS = 6;
/** A readable, URL-safe identifier derived from the title. */
export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72)
    .replace(/-+$/g, "");
}

/** New questions get an opaque, stable key so existing answers stay attached. */
export function nextQuestionKey(existing: readonly { key: string }[]): string {
  let index = existing.length + 1;
  const used = new Set(existing.map((question) => question.key));
  while (used.has(`q${index}`)) index += 1;
  return `q${index}`;
}

export const MEDIA_LIMITS = {
  // Security bounds, not editorial settings: they bound one request's memory and
  // the private store. Changes belong in a reviewed code change.
  files: 3,
  fileBytes: 5 * 1024 * 1024,
  totalBytes: 12 * 1024 * 1024,
  caption: 400,
} as const;

/** Human labels for the review queue's consent summary. */
export function consentSummary(input: {
  channels: readonly string[];
  attribution: Attribution;
  allowEdits: boolean;
  allowAiEdits: boolean;
}): string {
  const channels = input.channels.length
    ? input.channels.map((key) => PUBLICATION_CHANNELS[key as PublicationChannel] ?? key).join(", ")
    : "Private only";
  const name =
    input.attribution === "named" ? "Named" : "Anonymous";
  const edits = input.allowEdits ? "Edits allowed" : "No edits";
  const ai = input.allowAiEdits ? "AI-assisted edits allowed" : "No AI edits";
  return `${channels} · ${name} · ${edits} · ${ai}`;
}
