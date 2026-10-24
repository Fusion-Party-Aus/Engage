import type { Db } from "mongodb";
import type { PlatformIdentity } from "./types.ts";

export type MembershipStatus = "pending" | "verified" | "suspended";
export async function membershipEligibility(db: Db, memberId: string) {
  const record = await db.collection("memberships").findOne({ memberId });
  return { eligible: record?.status === "verified", checkedAt: new Date(), source: "manual_engage_verification" };
}

export async function membershipStatus(db: Db, memberId: string): Promise<MembershipStatus> {
  const record = await db.collection("memberships").findOne({ memberId });
  return record?.status === "verified" ? "verified" : record?.status === "suspended" ? "suspended" : "pending";
}

export async function changeMembership(db: Db, actor: PlatformIdentity, memberId: string, status: MembershipStatus) {
  // Read authorisation here as well as at the HTTP boundary; never trust supplied roles.
  if (actor.source !== "engage" || !await db.collection("application_roles").findOne({ memberId: actor.memberId, role: "administrator" })) throw new Error("Administrator role required.");
  if (!/^[a-f0-9]{24}$/.test(memberId) || !await db.collection("user").findOne({ _id: new (await import("mongodb")).ObjectId(memberId) })) throw new Error("Account not found.");
  const now = new Date();
  // Append audit first: a failed audit write cannot silently change eligibility.
  await db.collection("operational_audit").insertOne({ actorId: actor.memberId, actorSource: actor.source, action: "membership_change_requested", targetType: "member", targetId: memberId, status, createdAt: now });
  await db.collection("memberships").updateOne({ memberId }, { $set: { status, reviewedBy: actor.memberId, reviewedAt: now, ...(status === "verified" ? { verifiedBy: actor.memberId, verifiedAt: now } : {}) } }, { upsert: true });
}
