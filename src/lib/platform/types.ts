export type VoteChoice = "approve" | "do-not-approve";
export type PlatformRole = "member" | "moderator" | "administrator";

export interface PlatformEnv {
  APP_MODE?: "preview" | "production" | string;
  MONGODB_URI?: string;
  MONGODB_DB_NAME?: string;
  SESSION_SECRET?: string;
  PREVIEW_MEMBER_IDS?: string;
  PREVIEW_ADMIN_ID?: string;
  BINDING_BALLOTS_ENABLED?: string;
  FORMAL_BALLOTS_ENABLED?: string;
}

export interface PlatformIdentity {
  memberId: string;
  source: "synthetic" | "underground";
  roles: PlatformRole[];
}

export interface EligibilityResult {
  eligible: boolean;
  source: "synthetic" | "underground";
  checkedAt: Date;
}

export interface RuntimeLocals {
  runtime?: { env?: PlatformEnv };
  env?: PlatformEnv;
}

export interface ConsultationRoundRecord {
  roundId: string;
  program?: string;
  label?: string;
  title?: string;
  description?: string;
  status: string;
  opensAt: Date;
  closesAt: Date;
  policyIds: string[];
}

export interface ConsultationSubmissionRecord {
  submissionId: string;
  roundId: string;
  policyId: string;
  policyRevisionId: string;
  kind: "comment" | "amendment" | "alternative";
  title?: string;
  body: string;
  status: "pending" | "accepted" | "needs-changes" | "declined";
  createdAt: Date;
  moderatorResponse?: string;
}
