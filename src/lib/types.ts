export type PolicyStatus = "draft" | "open" | "voting" | "adopted" | "archived";
export type ProposalKind = "policy" | "proposal";
export type VoteChoice = "approve" | "reject";
export type CommentKind = "comment" | "amendment";
export type UserRole = "member" | "moderator" | "administrator";
export type MembershipStatus = "pending" | "verified" | "suspended";

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
}

export interface PolicyRecord {
  policyId: string;
  slug: string;
  kind: ProposalKind;
  title: string;
  division: string;
  category: string;
  categorySummary?: string;
  statement: string;
  outcomes: string[];
  details: string;
  attachmentUrl?: string;
  status: PolicyStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface VoteTally {
  approve: number;
  reject: number;
  total: number;
}

export interface PolicySummaryView extends PolicyRecord {
  commentCount: number;
  votes: VoteTally;
}

export interface CommentRecord {
  commentId: string;
  policyId: string;
  memberId: string;
  authorName: string;
  kind: CommentKind;
  body: string;
  createdAt: Date;
}

export interface VoteRecord {
  policyId: string;
  memberId: string;
  choice: VoteChoice;
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
