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
  BETTER_AUTH_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  RESEND_API_KEY?: string;
  AUTH_EMAIL_FROM?: string;
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
  activeBranchIds?: string[];
}

export interface BranchMembershipRecord {
  branchId: string;
  memberId: string;
  status: "active" | "revoked";
  branchRole?: "member" | "administrator";
  assignedBy?: string;
  assignedAt?: Date;
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
  publicationScope?: "private" | "branch" | "national";
  ballotRevisionId?: string;

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

export interface CommentRecord {
  commentId: string;
  proposalId: string;
  memberId: string;
  authorName: string;
  stance: CommentStance;
  body: string;
  upvotes: string[];
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
