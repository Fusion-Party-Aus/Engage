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
