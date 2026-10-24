import { ObjectId, type Db, type Document } from "mongodb";
import type { PlatformEnv, PlatformIdentity, VoteChoice } from "./types";
import { isBallotOpen, upsertCurrentVote, validateVoteChoice } from "./voting.mjs";
import { verifyVotingEligibility } from "./auth";

export interface BallotRecord extends Document {
  ballotId: string;
  proposalId: string;
  policyRevisionId: string;
  title: string;
  mode: "simulation" | "formal";
  status: "draft" | "open" | "closed";
  opensAt: Date;
  closesAt: Date;
}

export async function listBallots(db: Db): Promise<BallotRecord[]> {
  await closeExpiredBallots(db);
  return db.collection<BallotRecord>("ballots").find({}, {
    projection: { _id: 0, ballotId: 1, proposalId: 1, policyRevisionId: 1, title: 1, mode: 1, status: 1, opensAt: 1, closesAt: 1 },
  }).sort({ opensAt: 1, title: 1 }).toArray();
}

export async function closeExpiredBallots(db: Db, now = new Date()): Promise<number> {
  const result = await db.collection("ballots").updateMany(
    { status: "open", closesAt: { $lte: now } },
    { $set: { status: "closed", closedAt: now } },
  );
  if (result.modifiedCount > 0) await db.collection("operational_audit").insertOne({
    actorId: "system", actorSource: "system", action: "ballots_automatically_closed",
    targetType: "ballot_collection", createdAt: now, closedCount: result.modifiedCount,
  });
  return result.modifiedCount;
}

export async function getBallotResults(db: Db, ballot: BallotRecord): Promise<{ approve: number; doNotApprove: number; votesCast: number; outcome: string } | null> {
  if (ballot.status !== "closed") return null;
  const collectionName = ballot.mode === "simulation" ? "preview_votes" : "votes";
  const [approve, doNotApprove] = await Promise.all([
    db.collection(collectionName).countDocuments({ ballotId: ballot.ballotId, choice: "approve" }),
    db.collection(collectionName).countDocuments({ ballotId: ballot.ballotId, choice: "do-not-approve" }),
  ]);
  const votesCast = approve + doNotApprove;
  return { approve, doNotApprove, votesCast, outcome: votesCast === 0 ? "no-valid-votes" : approve > votesCast / 2 ? "approved" : "not-approved" };
}

async function addAudit(db: Db, identity: PlatformIdentity, action: string, ballotId: string, now: Date): Promise<void> {
  await db.collection("operational_audit").insertOne({
    _id: new ObjectId(), actorId: identity.memberId, actorSource: identity.source,
    action, targetType: "ballot", targetId: ballotId, createdAt: now,
    // Deliberately omit the selected choice and any prior choice.
  });
}

export async function castPreviewVote(db: Db, identity: PlatformIdentity, ballot: BallotRecord, choice: VoteChoice, env: PlatformEnv, now = new Date()): Promise<void> {
  if (env.APP_MODE !== "preview" || identity.source !== "synthetic") throw new Error("Demonstration voting is available only with a synthetic preview identity.");
  if (!validateVoteChoice(choice)) throw new Error("Choose Approve or Do Not Approve.");
  if (ballot.mode !== "simulation") throw new Error("This ballot is not marked as a synthetic simulation.");
  if (!isBallotOpen(ballot, now)) throw new Error("This ballot is not open.");
  const eligibility = await verifyVotingEligibility(identity, env);
  if (!eligibility.eligible) throw new Error("Your membership eligibility could not be confirmed.");

  const votes = db.collection("preview_votes");
  const selection = { ballotId: ballot.ballotId, memberId: identity.memberId };
  await upsertCurrentVote(votes, selection, choice, now);
  await addAudit(db, identity, "synthetic_simulation_vote_recorded", ballot.ballotId, now);
}
