import { ObjectId, type Db } from "mongodb";
import type { PlatformIdentity } from "./types";

export type SubmissionKind = "comment" | "amendment" | "alternative";
const validKinds = new Set<SubmissionKind>(["comment", "amendment", "alternative"]);

export interface ConsultationSubmissionInput {
  roundId: string;
  policyId: string;
  policyRevisionId: string;
  kind: SubmissionKind;
  title?: string;
  body: string;
}

export function validateSubmission(value: Record<string, unknown>): ConsultationSubmissionInput | null {
  const { roundId, policyId, policyRevisionId, kind, title, body } = value;
  if (typeof roundId !== "string" || !roundId || typeof policyId !== "string" || !policyId || typeof policyRevisionId !== "string" || !policyRevisionId) return null;
  if (typeof kind !== "string" || !validKinds.has(kind as SubmissionKind) || typeof body !== "string" || body.trim().length < 10 || body.length > 10_000) return null;
  if (title !== undefined && (typeof title !== "string" || title.length > 160)) return null;
  return { roundId, policyId, policyRevisionId, kind: kind as SubmissionKind, title: typeof title === "string" ? title.trim() : undefined, body: body.trim() };
}

export async function createSubmission(db: Db, identity: PlatformIdentity, input: ConsultationSubmissionInput): Promise<string> {
  const round = await db.collection("consultation_rounds").findOne({ roundId: input.roundId, status: "open" });
  const now = new Date();
  if (!round || !(round.opensAt instanceof Date) || !(round.closesAt instanceof Date) || now < round.opensAt || now >= round.closesAt) throw new Error("This consultation is not open for submissions.");
  const revision = await db.collection("policy_revisions").findOne({ policyId: input.policyId, revisionId: input.policyRevisionId });
  if (!revision) throw new Error("The policy version for this submission could not be found.");
  const result = await db.collection("consultation_submissions").insertOne({
    _id: new ObjectId(), submissionId: new ObjectId().toHexString(), ...input,
    memberId: identity.memberId, synthetic: identity.source === "synthetic", status: "pending", createdAt: now, updatedAt: now,
  });
  return result.insertedId.toString();
}

export async function listOwnSubmissions(db: Db, memberId: string) {
  return db.collection("consultation_submissions").find({ memberId }, {
    projection: { _id: 0, submissionId: 1, roundId: 1, policyId: 1, policyRevisionId: 1, kind: 1, title: 1, body: 1, status: 1, createdAt: 1, moderatorResponse: 1 },
  }).sort({ createdAt: -1 }).limit(100).toArray();
}

export async function reviewSubmission(db: Db, identity: PlatformIdentity, submissionId: string, status: "accepted" | "declined" | "needs-changes", moderatorResponse?: string): Promise<boolean> {
  if (moderatorResponse && moderatorResponse.length > 2_000) throw new Error("Moderator response is too long.");
  const now = new Date();
  const updated = await db.collection("consultation_submissions").updateOne(
    { submissionId, status: "pending" },
    { $set: { status, moderatorResponse: moderatorResponse?.trim() || undefined, reviewedBy: identity.memberId, reviewedAt: now, updatedAt: now } },
  );
  if (updated.modifiedCount) await db.collection("operational_audit").insertOne({
    actorId: identity.memberId, actorSource: identity.source, action: "consultation_submission_reviewed",
    targetType: "consultation_submission", targetId: submissionId, status, createdAt: now,
  });
  return updated.modifiedCount === 1;
}
