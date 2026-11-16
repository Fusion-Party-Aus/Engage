export type ProposalStage =
  "propose" | "deliberate" | "decide" | "implement" | "archived";
export type ProposalKind = "policy" | "resolution";
/** How a proposal changes an already adopted policy. */
export type PolicyChangeType = "amend" | "repeal" | "replace";
export type PolicyPublicationStatus =
  | "unpublished"
  | "published"
  | "withdrawn"
  | "superseded"
  | "repealed";
export type VoteChoice = "approve" | "abstain" | "reject";
export type CommentStance = "support" | "concern" | "amendment" | "comment";
export type UserRole = "member" | "moderator" | "administrator";
export type MembershipStatus = "pending" | "verified" | "suspended";

export type BranchKind = "national" | "state" | "territory" | "constituent";
export interface BranchRecord {
  branchId: string;
  /** Stable public slug, for example "vic". Defaults to the identifier suffix. */
  slug?: string;
  name: string;
  kind: BranchKind;
  parentBranchId?: string;
  recognised?: boolean;
  createdAt: Date;
}
export interface ProposalRevision {
  revisionId: string;
  proposalId: string;
  parentRevisionId: string | null;
  authorId: string;
  createdAt: Date;
  snapshot: {
    title: string;
    summary: string;
    outcomes: string[];
    details: string;
  };
  contentHash: string;
  provenance?: PolicyProvenance;
}

/**
 * An immutable revision of an adopted policy that did not come from an Engage
 * ballot, for example an imported branch policy. Engage-ratified policy keeps
 * using `proposal_revisions`.
 */
export interface PolicyRevisionRecord {
  revisionId: string;
  policyId: string;
  revisionType: "imported-policy" | "policy-change";
  parentRevisionId: string | null;
  authorId: string;
  createdAt: Date;
  snapshot: {
    title: string;
    summary: string;
    outcomes: string[];
    details: string;
    /** The exact source document, preserved verbatim. */
    document?: Record<string, unknown>;
  };
  contentHash: string;
  provenance?: PolicyProvenance;
}

/** Lineage recorded when a proposal changes an adopted policy. */
export interface PolicyChangeLineage {
  changeType: PolicyChangeType;
  targetPolicyId: string;
  targetRevisionId: string | null;
  proposalId: string;
  revisionId: string;
  decisionEventId: string;
  authorityBranchId: string;
  recordedAt: Date;
  recordedBy: string;
}

export interface PlatformEnv {
  APP_MODE?: string;
  MONGODB_URI?: string;
  MONGODB_DB_NAME?: string;
  SESSION_SECRET?: string;
  BETTER_AUTH_URL?: string;
  PUBLIC_ORIGIN?: string;
  BETTER_AUTH_SECRET?: string;
  /** Optional dedicated key for hashing rate-limit subjects. */
  RATE_LIMIT_SECRET?: string;
  /** Server-side Cloudflare Turnstile secret. Never expose to the client. */
  TURNSTILE_SECRET_KEY?: string;
  /** Public Turnstile site key rendered by the widget. */
  PUBLIC_TURNSTILE_SITE_KEY?: string;
  /** "on" forces enforcement, "off" disables it. Production enforces by default. */
  TURNSTILE_ENFORCEMENT?: string;
  /** Optional expected siteverify hostname, e.g. engage.fusionparty.org.au */
  TURNSTILE_EXPECTED_HOSTNAME?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  RESEND_API_KEY?: string;
  AUTH_EMAIL_FROM?: string;
  RESEND_WEBHOOK_SECRET?: string;
  ENGAGE_CRON_SECRET?: string;
  ENGAGE_EMAIL_SECRET?: string;
  ENGAGE_DIGEST_ENABLED?: string;
  /** Gate and bearer secret for automatic CRM membership verification. */
  ENGAGE_CRM_VERIFICATION_ENABLED?: string;
  ENGAGE_CRM_VERIFICATION_CRON_SECRET?: string;
  /**
   * Opt-in future link: when "on", a member with an active CRM identity link
   * gets the CRM person id as the canonical public profile path. Legacy
   * member-id profile paths then redirect with 301. Off by default.
   */
  ENGAGE_PROFILE_CRM_IDENTIFIERS?: string;
  /**
   * Operational health thresholds (#39). Each scheduled job has a warn and a
   * fail threshold; warn must be below fail or the check reports unknown. Empty
   * or invalid values use the documented default, and the health report names
   * the value and its source.
   */
  GOVERNANCE_SCHEDULER_WARN_HOURS?: string;
  GOVERNANCE_SCHEDULER_STALE_HOURS?: string;
  DIGEST_WARN_HOURS?: string;
  DIGEST_STALE_HOURS?: string;
  MEMBERSHIP_VERIFICATION_WARN_HOURS?: string;
  MEMBERSHIP_VERIFICATION_STALE_HOURS?: string;
  BALLOT_CLOSURE_GRACE_HOURS?: string;
  EMAIL_DELIVERY_WINDOW_HOURS?: string;
  ENGAGE_ALLOW_INDEXING?: string;
  ENGAGE_DEFAULT_OG_IMAGE?: string;
  ENGAGE_PUBLIC_PULSE_POLL?: string;
  ENGAGE_PRIMARY_CTA_LABEL?: string;
  ENGAGE_PRIMARY_CTA_HREF?: string;
  ENGAGE_SOCIAL_LINKS_JSON?: string;
  ENGAGE_STATE_SITES_JSON?: string;
  ENGAGE_REPO_URL?: string;
  /**
   * Opt-in MongoDB driver command monitoring for the local rendering
   * performance harness. Ignored in production.
   */
  ENGAGE_DB_COMMAND_MONITOR?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  BALLOT_ENCRYPTION_MODE?: string;
  BALLOT_ENCRYPTION_KEYS?: string;
  BALLOT_ENCRYPTION_ACTIVE_KEY_ID?: string;
  BALLOT_BLIND_INDEX_KEY?: string;
  BALLOT_BLIND_INDEX_ACTIVE_KEY_ID?: string;
}

export interface SessionUser {
  memberId: string;
  name: string;
  email: string;
  role: UserRole;
  /** All platform system roles held by the member. Member is always present. */
  roles?: UserRole[];
  status: MembershipStatus;
  canParticipate: boolean;
  isStaff: boolean;
  isAdmin: boolean;
  /** Explicitly delegated operational administration of these branch records. */
  branchAdminIds?: string[];
  isBranchAdmin?: boolean;
  /** Branches the person follows or is a verified member of, used for discovery. */
  activeBranchIds?: string[];
  /** Engage-owned personal branch subscriptions. */
  followedBranchIds?: string[];
  /** Organisational membership facts verified by a branch authority. */
  verifiedBranchIds?: string[];
  /** Effective granular permissions resolved from legacy and configurable roles. */
  permissions?: import("./rbac.ts").EffectivePermissionsSnapshot;
}

export interface BranchMembershipRecord {
  branchId: string;
  memberId: string;
  status: "active" | "revoked";
  branchRole?: "member" | "administrator";
  assignedBy?: string;
  assignedAt?: Date;
  /** Where the organisational membership fact came from. */
  source?: "engage-local" | "engage-legacy" | "underground-crm" | string;
  verifiedBy?: string;
  verifiedAt?: Date;
  revokedBy?: string;
  revokedAt?: Date;
  revocationReason?: string;
  externalMemberId?: string;
  version?: number;
  verification?: {
    method?: string;
    verifiedAt?: Date;
    verifiedBy?: string;
    authority?: string;
    note?: string;
  };
}

export interface BranchSubscriptionRecord {
  memberId: string;
  branchId: string;
  status: "following" | "unfollowed";
  source: "member" | "migration";
  createdAt: Date;
  updatedAt: Date;
}

export interface ProvenanceLink {
  label: string;
  url: string | null;
  description: string;
}

export interface PolicyProvenance {
  category:
    | "existing-repackaged"
    | "materially-revised"
    | "new-proposal"
    | "draft-derived"
    | "unverified"
    | "party-governance"
    | string;
  classification?: string;
  priorHeuristicCategory?: string;
  label: string;
  summary: string;
  evidenceBasis?: string;
  sourceTypes?: string[];
  flaggedNewInStaticExport?: boolean;
  lineageVerified?: boolean;
  materialEquivalenceVerified?: boolean;
  uncertaintyNote?: string;
  lineage?: ProvenanceLink[];
  valuesAlignment?: string[];
}

export interface ProposalRecord {
  proposalId: string;
  slug: string;
  title: string;
  space: string;
  spaceSummary?: string;
  summary: string;
  outcomes: string[];
  details: string;
  detailHtml?: string;
  provenance?: PolicyProvenance;
  attachmentUrl?: string;
  attachmentDescription?: string;
  stage: ProposalStage;
  implementationNote?: string;
  authorId?: string;
  authorName?: string;
  createdAt: Date;
  updatedAt: Date;
  kind?: ProposalKind | string;
  originatingBranchId?: string;
  governanceAuthorityBranchId?: string;
  jurisdictionBranchId?: string;
  /** Canonical geographic proposal scope key. Branch identity stays separate. */
  scope?: string;
  publicationScope?: "private" | "branch" | "national";
  ballotRevisionId?: string;
  ballotClosesAt?: Date;
  /**
   * Set by the lifecycle scheduler when the ballot deadline has passed and the
   * closure has been recorded. Closing never changes the stage or records a
   * result. Absent means no closure has been recorded.
   */
  ballotClosedAt?: Date;
  /**
   * The independent seconder required before a proposal enters Deliberate (D3).
   * Server-side only; the seconder's member ID is not exposed in public DTOs.
   */
  secondedBy?: string;
  secondedAt?: Date;
  /** The deliberation deadline derived from `secondedAt` (D4). */
  deliberationEndsAt?: Date;
  supersededByProposalId?: string;
  supersededByNote?: string;
  /**
   * Set when this proposal changes an adopted policy. The target must be a
   * published policy record; drafts cannot claim to have changed it.
   */
  targetPolicyId?: string;
  targetPolicyRevisionId?: string;
  changeType?: PolicyChangeType;
  /** The commitment or section an amendment proposes to change. */
  targetSection?: string;
  /** Replacement wording offered with a replacement proposal. */
  proposedWording?: string;

  // Backwards compatibility aliases
  policyId?: string;
  category?: string;
  categorySummary?: string;
  statement?: string;
  status?: string;
  division?: string;
}

export interface VoteTally {
  approve: number;
  abstain: number;
  reject: number;
  total: number;
}

export interface ProposalSummaryView extends ProposalRecord {
  commentCount: number;
  votes: VoteTally;
  /**
   * Set only when a display read opted into tolerating unreadable votes. The
   * tally then covers readable votes only and callers must surface the gap.
   */
  unreadableVoteCount?: number;
}

export type ContributionFeedbackStatus =
  | "incorporated"
  | "considered"
  | "deferred"
  | "declined";

export type ContributionFeedbackEvidenceKind =
  | "amendment"
  | "revision"
  | "decision"
  | "policy";

export interface ContributionFeedbackEvidence {
  kind: ContributionFeedbackEvidenceKind;
  recordId: string;
  label?: string;
}

export interface ContributionFeedback {
  status: ContributionFeedbackStatus;
  note?: string;
  evidence?: ContributionFeedbackEvidence;
  updatedBy: string;
  updatedByName: string;
  updatedAt: Date;
}

export interface ContributionFeedbackHistoryEntry {
  action: ContributionFeedbackStatus | "cleared";
  note?: string;
  evidence?: ContributionFeedbackEvidence;
  updatedBy: string;
  updatedByName: string;
  updatedAt: Date;
}

export interface CommentRecord {
  commentId: string;
  proposalId: string;
  memberId: string;
  authorName: string;
  stance: CommentStance;
  body: string;
  /** Comment this one replies to. Absent or null for a top-level contribution. */
  parentCommentId?: string | null;
  /** Nesting depth: 0 for a top-level contribution. */
  depth?: number;
  upvotes: string[];
  /** Member ids of downvotes. Aggregated only; never returned to a viewer. */
  downvotes?: string[];
  upvoteEvents?: Array<{ memberId: string; at: Date }>;
  /** Compare-and-swap version for atomic comment vote updates. */
  voteVersion?: number;
  feedback?: ContributionFeedback;
  feedbackHistory?: ContributionFeedbackHistoryEntry[];
  /**
   * Set when the body was removed but replies still depend on the comment.
   * The record is retained as a placeholder so replies stay in context.
   */
  deletedAt?: Date;
  deletedBy?: string;
  createdAt: Date;
}

export interface VoteRecord {
  ballotId: string;
  proposalId: string;
  revisionId?: string;
  amendmentId?: string;
  memberId: string;
  authorName?: string;
  choice: VoteChoice;
  reason?: string;
  updatedAt: Date;
}

export interface PendingVotePreferenceRecord {
  ballotId: string;
  proposalId: string;
  revisionId?: string;
  memberId: string;
  authorName?: string;
  choice: VoteChoice;
  reason?: string;
  updatedAt: Date;
}

export interface MemberRecord {
  memberId: string;
  name: string;
  email: string;
  role: UserRole;
  /** All platform system roles held by the member. Member is always present. */
  roles?: UserRole[];
  status: MembershipStatus;
  disabled: boolean;
  emailVerified: boolean;
  createdAt?: Date;
  /** Branch-scoped administrator assignments (system Branch Administrator). */
  branchAdministratorOf?: string[];
  /** Active custom role assignments, including their branch scope. */
  delegatedRoles?: string[];
}

