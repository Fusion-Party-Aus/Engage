import type { Db } from "mongodb";
import type { PlatformIdentity } from "./types.ts";

export type MembershipStatus = "pending" | "verified" | "suspended";
interface MembershipRecord {
  memberId: string;
  status: MembershipStatus;
  auditVersion?: number;
  auditHistory?: { actorId: string; actorSource: string; action: string; fromStatus: MembershipStatus; status: MembershipStatus; createdAt: Date }[];
}

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
  if (!["pending", "verified", "suspended"].includes(status)) throw new Error("Invalid membership status.");
  const memberships = db.collection<MembershipRecord>("memberships");
  // The unique memberId index makes initialisation safe across administrators.
  await memberships.updateOne({ memberId }, { $setOnInsert: { status: "pending", auditVersion: 0 } }, { upsert: true });
  const previous = await memberships.findOne({ memberId });
  if (!previous) throw new Error("Membership could not be loaded.");
  const fromStatus = previous.status ?? "pending";
  if (fromStatus === status) return;
  const changed = await memberships.updateOne(
    { memberId, auditVersion: previous.auditVersion ?? { $exists: false } },
    {
      $set: { status, reviewedBy: actor.memberId, reviewedAt: now,
        ...(status === "verified" ? { verifiedBy: actor.memberId, verifiedAt: now } : {}) },
      $inc: { auditVersion: 1 },
      $push: { auditHistory: { actorId: actor.memberId, actorSource: actor.source,
        action: "membership_status_changed", fromStatus, status, createdAt: now } },
    },
  );
  if (!changed.matchedCount) throw new Error("Membership changed concurrently; reload and retry.");
}
