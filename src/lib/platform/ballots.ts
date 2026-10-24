import { ObjectId, type Db, type Document } from "mongodb";
import type { PlatformEnv, PlatformIdentity, VoteChoice } from "./types.ts";
import { calculateStrictMajority, formalVotingIsEnabled, isBallotOpen, upsertCurrentVote, validateVoteChoice } from "./voting.mjs";
import { verifyVotingEligibility } from "./auth.ts";

export interface BallotRecord extends Document {
  ballotId: string;
  proposalId: string;
  policyRevisionId: string;
  roundId?: string;
  title: string;
  domain?: string;
  mode?: "simulation" | "formal";
  status: "draft" | "open" | "closed";
  opensAt: Date;
  closesAt: Date;
  closedAt?: Date;
  priority?: number;
  bindingBallotsEnabled?: boolean;
  syntheticFixture?: boolean;
  fixtureNotice?: string;
}

export interface BallotResults {
  approve: number;
  doNotApprove: number;
  votesCast: number;
  outcome: "approved" | "not-approved" | "no-valid-votes";
}

export async function listBallots(db: Db): Promise<BallotRecord[]> {
  await closeExpiredBallots(db);
  return db.collection<BallotRecord>("ballots").find({}, {
    projection: {
      _id: 0, ballotId: 1, proposalId: 1, policyRevisionId: 1, roundId: 1,
      title: 1, domain: 1, mode: 1, status: 1, opensAt: 1, closesAt: 1, closedAt: 1,
      priority: 1, bindingBallotsEnabled: 1, syntheticFixture: 1, fixtureNotice: 1,
    },
  }).sort({ priority: 1, opensAt: 1, title: 1 }).toArray();
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

export async function getBallotResults(db: Db, ballot: BallotRecord): Promise<BallotResults | null> {
  if (ballot.status !== "closed") return null;
  const [approve, doNotApprove] = await Promise.all([
    db.collection("votes").countDocuments({ ballotId: ballot.ballotId, choice: "approve" }),
    db.collection("votes").countDocuments({ ballotId: ballot.ballotId, choice: "do-not-approve" }),
  ]);
  const { votesCast, outcome } = calculateStrictMajority(approve, doNotApprove);
  return { approve, doNotApprove, votesCast, outcome: outcome as BallotResults["outcome"] };
}

async function addAudit(db: Db, identity: PlatformIdentity, action: string, ballotId: string, now: Date): Promise<void> {
  await db.collection("operational_audit").insertOne({
    _id: new ObjectId(), actorId: identity.memberId, actorSource: identity.source,
    action, targetType: "ballot", targetId: ballotId, createdAt: now,
    // Deliberately omit the selected choice and any prior choice.
  });
}

export async function castVote(db: Db, identity: PlatformIdentity, ballot: BallotRecord, choice: VoteChoice, env: PlatformEnv, now = new Date()): Promise<void> {
  if (!validateVoteChoice(choice)) throw new Error("Choose Approve or Do Not Approve.");
  if (env.APP_MODE === "preview") {
    if (identity.source !== "synthetic") throw new Error("Preview voting requires a synthetic identity.");
  } else {
    if (identity.source !== "underground") throw new Error("Production voting requires an Underground member identity.");
    if (!formalVotingIsEnabled(env)) throw new Error("Binding ballots are disabled until the Underground identity and governance release gates are complete.");
  }
  if (!isBallotOpen(ballot, now)) throw new Error("This ballot is not open.");
  const eligibility = await verifyVotingEligibility(identity, env);
  if (!eligibility.eligible) throw new Error("Your membership eligibility could not be confirmed.");

  const votes = db.collection("votes");
  const selection = { ballotId: ballot.ballotId, memberId: identity.memberId };
  await upsertCurrentVote(votes, selection, choice, now, { identitySource: identity.source });
  await addAudit(db, identity, "ballot_vote_recorded", ballot.ballotId, now);
}

export const castPreviewVote = castVote;
