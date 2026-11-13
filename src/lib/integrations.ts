import type { Db } from "mongodb";
import type { BranchMembershipRecord } from "./types.ts";

export const API_CONTRACT_VERSION = "v1";

export interface ExternalMembershipCheck {
  memberId: string;
  branchId: string;
  verified: boolean;
  source: "engage-local" | "engage-legacy" | "underground-crm" | string;
  checkedAt: Date;
  externalMemberId?: string;
}

/**
 * Integration seam for authoritative membership verification and revocation
 * (e.g. Underground CRM). Engage operates standalone by default and never
 * requires synchronous external availability for voting or participation.
 */
export interface MembershipAuthorityAdapter {
  readonly sourceId: string;
  verifyMembership(
    db: Db,
    memberId: string,
    branchId: string,
  ): Promise<ExternalMembershipCheck>;
}

export class StandaloneMembershipAuthority implements MembershipAuthorityAdapter {
  readonly sourceId = "engage-local";

  async verifyMembership(
    db: Db,
    memberId: string,
    branchId: string,
  ): Promise<ExternalMembershipCheck> {
    const record = await db
      .collection<BranchMembershipRecord>("branch_memberships")
      .findOne({ memberId, branchId, status: "active" });

    return {
      memberId,
      branchId,
      verified: Boolean(record),
      source: record?.source ?? this.sourceId,
      checkedAt: new Date(),
      ...(record?.externalMemberId
        ? { externalMemberId: record.externalMemberId }
        : {}),
    };
  }
}

export const defaultMembershipAuthority: MembershipAuthorityAdapter =
  new StandaloneMembershipAuthority();

/**
 * Validate an HTTP `Idempotency-Key` header for external or administrative
 * write operations.
 */
export function parseIdempotencyKey(request: Request): string | null {
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key || key.length > 200) return null;
  return key;
}
