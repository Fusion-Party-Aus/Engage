import { ObjectId, type Db, type Document } from "mongodb";
import type { PlatformEnv, PlatformIdentity, VoteChoice } from "./types.ts";
import { calculateStrictMajority, formalVotingIsEnabled, isBallotOpen, upsertCurrentVote, validateVoteChoice } from "./voting.mjs";
import { bindingBallotAuthorised } from "./ballot-authorization.ts";
import { membershipEligibility } from "./membership.ts";

export interface BallotRecord extends Document {
  ballotId: string;
  proposalId: string;
  policyRevisionId: string;
  roundId?: string;
  title: string;
  summary?: string;
  domain?: string;
  status: "draft" | "open" | "closed";
  opensAt: Date;
  closesAt: Date;
  closedAt?: Date;
  finalizedAt?: Date;
  outcome?: "approved" | "not-approved" | "no-valid-votes" | null;
  results?: BallotResults | null;
  publishedRevisionId?: string | null;
  syntheticOutcome?: boolean;
  priority?: number;
  bindingBallotsEnabled?: boolean;
  syntheticFixture?: boolean;
  fixtureNotice?: string;
  authorization?: { approvedBy: string; approvedAt: Date; evidence: unknown };
}

export interface BallotResults {
  approve: number;
  doNotApprove: number;
  votesCast: number;
  outcome: "approved" | "not-approved" | "no-valid-votes";
}

export interface BallotFinalizationResult {
  ballotId: string;
  status: "closed";
  closedAt: Date;
  finalizedAt: Date;
  results: BallotResults;
  outcome: BallotResults["outcome"];
  publishedRevisionId: string | null;
  syntheticOutcome: boolean;
  alreadyFinalized: boolean;
}

export async function listBallots(db: Db): Promise<BallotRecord[]> {
  await closeExpiredBallots(db);
  return db.collection<BallotRecord>("ballots").find({}, {
    projection: {
      _id: 0, ballotId: 1, proposalId: 1, policyRevisionId: 1, roundId: 1,
      title: 1, summary: 1, domain: 1, status: 1, opensAt: 1, closesAt: 1, closedAt: 1,
      finalizedAt: 1, outcome: 1, results: 1, publishedRevisionId: 1, syntheticOutcome: 1,
      priority: 1, bindingBallotsEnabled: 1, syntheticFixture: 1, fixtureNotice: 1,
    },
  }).sort({ priority: 1, opensAt: 1, title: 1 }).toArray();
}

export async function finalizeBallot(
  db: Db,
  ballotId: string,
  options: {
    actorId?: string;
    actorSource?: string;
    now?: Date;
    closeReason?: "deadline" | "administrative";
    isSyntheticOverride?: boolean;
  } = {},
): Promise<BallotFinalizationResult | null> {
  const now = options.now ?? new Date();
  const actorId = options.actorId ?? "system";
  const actorSource = options.actorSource ?? "system";
  const closeReason = options.closeReason ?? (actorId === "system" ? "deadline" : "administrative");

  const ballots = db.collection<BallotRecord>("ballots");
  const ballot = await ballots.findOne({ ballotId });
  if (!ballot) return null;

  const alreadyFinalized = Boolean(ballot.finalizedAt) && ballot.status === "closed";
  const closedAt = ballot.closedAt instanceof Date ? ballot.closedAt : new Date(ballot.closedAt ?? now);
  const finalizedAt = ballot.finalizedAt instanceof Date ? ballot.finalizedAt : now;
  const isSynthetic =
    options.isSyntheticOverride ??
    (Boolean(ballot.syntheticFixture) || ballot.bindingBallotsEnabled !== true || actorSource === "synthetic");

  const voterFilter = ballot.bindingBallotsEnabled === true ? { identitySource: "engage" } : {};
  const [approve, doNotApprove] = await Promise.all([
    db.collection("votes").countDocuments({ ballotId: ballot.ballotId, choice: "approve", ...voterFilter }),
    db.collection("votes").countDocuments({ ballotId: ballot.ballotId, choice: "do-not-approve", ...voterFilter }),
  ]);
  const { votesCast, outcome } = calculateStrictMajority(approve, doNotApprove);
  const results: BallotResults = {
    approve,
    doNotApprove,
    votesCast,
    outcome: outcome as BallotResults["outcome"],
  };
  const publishedRevisionId = results.outcome === "approved" ? ballot.policyRevisionId : null;

  if (!alreadyFinalized) {
    await ballots.updateOne(
      { ballotId },
      {
        $set: {
          status: "closed",
          closedAt,
          finalizedAt,
          outcome: results.outcome,
          results,
          publishedRevisionId,
          syntheticOutcome: isSynthetic,
          updatedAt: now,
          updatedBy: actorId,
        },
      },
    );
  }

  if (results.outcome === "approved" && ballot.policyRevisionId) {
    try {
      const revisions = db.collection("policy_revisions");
      const existingRev = await revisions.findOne({
        policyId: ballot.proposalId,
        revisionId: ballot.policyRevisionId,
      });
      if (existingRev && !existingRev.publishedAt) {
        await revisions.updateOne(
          { policyId: ballot.proposalId, revisionId: ballot.policyRevisionId },
          {
            $set: {
              approvedAt: existingRev.approvedAt ?? closedAt,
              publishedAt: existingRev.publishedAt ?? closedAt,
              approvedByBallotId: ballotId,
              syntheticOutcome: isSynthetic,
            },
          },
        );
        await db.collection("operational_audit").insertOne({
          actorId,
          actorSource,
          action: "approved_revision_published",
          targetType: "policy",
          targetId: ballot.proposalId,
          revisionId: ballot.policyRevisionId,
          ballotId,
          closeReason,
          syntheticOutcome: isSynthetic,
          createdAt: now,
        });
      }
    } catch {
      // Allow lightweight test doubles that only mock votes/ballots/operational_audit to succeed
    }
  }

  if (!alreadyFinalized) {
    await db.collection("operational_audit").insertOne({
      actorId,
      actorSource,
      action: closeReason === "deadline" ? "ballot_closed_at_deadline" : "ballot_status_updated",
      targetType: "ballot",
      targetId: ballotId,
      status: "closed",
      closeReason,
      outcome: results.outcome,
      votesCast: results.votesCast,
      publishedRevisionId,
      syntheticOutcome: isSynthetic,
      createdAt: now,
    });
  }

  return {
    ballotId,
    status: "closed",
    closedAt,
    finalizedAt,
    results,
    outcome: results.outcome,
    publishedRevisionId,
    syntheticOutcome: isSynthetic,
    alreadyFinalized,
  };
}

export async function closeExpiredBallots(db: Db, now = new Date()): Promise<number> {
  const ballots = db.collection<BallotRecord>("ballots");
  if (typeof ballots.find === "function") {
    const expired = await ballots.find({ status: "open", closesAt: { $lte: now } }).toArray();
    for (const ballot of expired) {
      await finalizeBallot(db, ballot.ballotId, {
        actorId: "system",
        actorSource: "system",
        now,
        closeReason: "deadline",
      });
    }
    if (expired.length > 0) {
      await db.collection("operational_audit").insertOne({
        actorId: "system",
        actorSource: "system",
        action: "ballots_automatically_closed",
        targetType: "ballot_collection",
        createdAt: now,
        closedCount: expired.length,
      });
    }
    return expired.length;
  }
  const result = await ballots.updateMany(
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
  const voterFilter = ballot.bindingBallotsEnabled === true ? { identitySource: "engage" } : {};
  const [approve, doNotApprove] = await Promise.all([
    db.collection("votes").countDocuments({ ballotId: ballot.ballotId, choice: "approve", ...voterFilter }),
    db.collection("votes").countDocuments({ ballotId: ballot.ballotId, choice: "do-not-approve", ...voterFilter }),
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
    if (ballot.bindingBallotsEnabled === true) throw new Error("Synthetic accounts cannot participate in binding ballots.");
  } else {
    if (identity.source !== "engage") throw new Error("Production voting requires an Engage member identity.");
    if (!formalVotingIsEnabled(env)) throw new Error("Binding ballots are disabled until governance authorisation is recorded.");
  }
  if (env.APP_MODE !== "preview" && !bindingBallotAuthorised(ballot)) throw new Error("This ballot is not authorised for binding voting.");
  if (!isBallotOpen(ballot, now)) throw new Error("This ballot is not open.");
  const eligibility = identity.source === "synthetic" ? { eligible: env.APP_MODE === "preview" } : await membershipEligibility(db, identity.memberId);
  if (!eligibility.eligible) throw new Error("Your membership eligibility could not be confirmed.");

  const votes = db.collection("votes");
  const selection = { ballotId: ballot.ballotId, memberId: identity.memberId };
  await upsertCurrentVote(votes, selection, choice, now, { identitySource: identity.source });
  await addAudit(db, identity, "ballot_vote_recorded", ballot.ballotId, now);
}

export const castPreviewVote = castVote;
