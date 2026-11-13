export type ProposalStage =
  "propose" | "deliberate" | "decide" | "implement" | "archived";
export type ProposalKind = "policy" | "resolution";
export type VoteChoice = "approve" | "abstain" | "reject";
export type CommentStance = "support" | "concern" | "amendment" | "comment";
export type UserRole = "member" | "moderator" | "administrator";
export type MembershipStatus = "pending" | "verified" | "suspended";

export type BranchKind = "national" | "state" | "territory" | "constituent";
export interface BranchRecord {
  branchId: string;
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

export interface PlatformEnv {
  APP_MODE?: string;
  MONGODB_URI?: string;
  MONGODB_DB_NAME?: string;
  SESSION_SECRET?: string;
  BETTER_AUTH_URL?: string;
  PUBLIC_ORIGIN?: string;
  BETTER_AUTH_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  RESEND_API_KEY?: string;
  AUTH_EMAIL_FROM?: string;
  RESEND_WEBHOOK_SECRET?: string;
  ENGAGE_CRON_SECRET?: string;
  ENGAGE_EMAIL_SECRET?: string;
  ENGAGE_DIGEST_ENABLED?: string;
  ENGAGE_ALLOW_INDEXING?: string;
  ENGAGE_DEFAULT_OG_IMAGE?: string;
  ENGAGE_PUBLIC_PULSE_POLL?: string;
  ENGAGE_PRIMARY_CTA_LABEL?: string;
  ENGAGE_PRIMARY_CTA_HREF?: string;
  ENGAGE_SOCIAL_LINKS_JSON?: string;
  ENGAGE_STATE_SITES_JSON?: string;
  ENGAGE_REPO_URL?: string;
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
  supersededByProposalId?: string;
  supersededByNote?: string;

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
  upvotes: string[];
  upvoteEvents?: Array<{ memberId: string; at: Date }>;
  feedback?: ContributionFeedback;
  feedbackHistory?: ContributionFeedbackHistoryEntry[];
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
  status: MembershipStatus;
  disabled: boolean;
  emailVerified: boolean;
  createdAt?: Date;
}

