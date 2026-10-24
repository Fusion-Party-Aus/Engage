import { createHash } from "node:crypto";
import { ObjectId, type Db, type Document, type ClientSession } from "mongodb";
import type { PlatformEnv, PlatformIdentity, VoteChoice } from "./types.ts";
import { calculateStrictMajority, formalVotingIsEnabled, validateVoteChoice } from "./voting.mjs";
import { bindingBallotAuthorised } from "./ballot-authorization.ts";
import { membershipEligibility } from "./membership.ts";

export interface BallotRecord extends Document {
  ballotId: string;
  proposalId: string;
  policyRevisionId: string;
  roundId?: string;
  title: string;
  summary?: string;
  domain?: string | null;
  status: "draft" | "open" | "closed";
  admissionId?: ObjectId;
  lastAdmissionAt?: Date;
  opensAt: Date;
  closesAt: Date;
  closedAt?: Date;
  finalizedAt?: Date;
  resultsRecordedAt?: Date;
  closure?: { actorId: string; actorSource: string; closeReason: string; syntheticOutcome: boolean };
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

// Admission and closure must contend on the same ballot document. A transaction
// keeps that write and the member's selection atomic; standalone MongoDB fails closed.
async function ballotWrite<T>(db: Db, write: (session: ClientSession) => Promise<T>): Promise<T> {
  return db.client.withSession((session) => session.withTransaction(() => write(session), {
    readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, readPreference: "primary",
  }));
}

export async function listBallots(db: Db): Promise<BallotRecord[]> {
  await closeExpiredBallots(db);
  return db.collection<BallotRecord>("ballots").find({}, {
    projection: {
      _id: 0, ballotId: 1, proposalId: 1, policyRevisionId: 1, roundId: 1,
      title: 1, summary: 1, domain: 1, status: 1, opensAt: 1, closesAt: 1, closedAt: 1,
      finalizedAt: 1, resultsRecordedAt: 1, outcome: 1, results: 1, publishedRevisionId: 1, syntheticOutcome: 1,
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

  const alreadyFinalized = Boolean(ballot.finalizedAt);
  if (alreadyFinalized && !ballot.results) throw new Error("Recorded ballot result is missing; restore the authoritative record before retrying.");
  // First close admission. The winning caller records the closure provenance.
  await ballotWrite(db, (session) => ballots.updateOne({ ballotId, status: { $ne: "closed" } }, { $set: {
    status: "closed",
    ...(options.now ? { closedAt: options.now } : {}),
    closure: { actorId, actorSource, closeReason, syntheticOutcome: options.isSyntheticOverride ??
      (Boolean(ballot.syntheticFixture) || ballot.bindingBallotsEnabled !== true || actorSource === "synthetic") },
  }, ...(!options.now ? { $currentDate: { closedAt: true } } : {}) }, { session }));
  let recorded = (await ballots.findOne({ ballotId }))!;
  if (!recorded.results) {
    const voterFilter = recorded.bindingBallotsEnabled === true ? { identitySource: "engage" } : {};
    const [approve, doNotApprove] = await Promise.all([
      db.collection("votes").countDocuments({ ballotId, choice: "approve", ...voterFilter }),
      db.collection("votes").countDocuments({ ballotId, choice: "do-not-approve", ...voterFilter }),
    ]);
    const { votesCast, outcome } = calculateStrictMajority(approve, doNotApprove);
    // Compare-and-set: only one tally becomes authoritative, including across workers.
    await ballots.updateOne({ ballotId, results: null }, { $set: {
      results: { approve, doNotApprove, votesCast, outcome: outcome as BallotResults["outcome"] }, outcome: outcome as BallotResults["outcome"],
      resultsRecordedAt: options.now ?? new Date(), publishedRevisionId: null,
      syntheticOutcome: recorded.closure?.syntheticOutcome ?? Boolean(recorded.syntheticOutcome),
    } });
    recorded = (await ballots.findOne({ ballotId }))!;
  }
  if (!recorded.results) throw new Error("Ballot result could not be recorded; retry closure.");
  const results = recorded.results;
  const closedAt = recorded.closedAt ?? now;
  const closure = recorded.closure ?? { actorId, actorSource, closeReason, syntheticOutcome: Boolean(recorded.syntheticOutcome) };
  const publishedRevisionId = results.outcome === "approved" ? recorded.policyRevisionId : null;
  // A durable result is the outbox. Until all effects succeed finalizedAt stays absent.
  if (!recorded.finalizedAt) {
    const audit = async (kind: string, event: Document) => {
      const _id = new ObjectId(createHash("sha256").update(`ballot:${ballotId}:${kind}`).digest("hex").slice(0, 24));
      await db.collection("operational_audit").updateOne({ _id }, { $setOnInsert: event }, { upsert: true });
    };
    if (publishedRevisionId) {
      const revisions = db.collection("policy_revisions");
      const key = { policyId: recorded.proposalId, revisionId: publishedRevisionId };
      const revision = await revisions.findOne(key);
      if (!revision) throw new Error("Approved revision is missing; restore it and retry ballot closure.");
      if (revision.publishedAt && revision.approvedByBallotId !== ballotId) {
        throw new Error("Revision was published by another decision; resolve the conflict before retrying closure.");
      }
      await revisions.updateOne({ ...key, publishedAt: null }, { $set: {
        approvedAt: revision.approvedAt ?? closedAt, publishedAt: closedAt,
        approvedByBallotId: ballotId, syntheticOutcome: closure.syntheticOutcome,
      } });
      const published = await revisions.findOne(key);
      if (!published?.publishedAt || published.approvedByBallotId !== ballotId) throw new Error("Revision publication did not complete; retry closure.");
      await audit("publication", {
        ...closure, action: "approved_revision_published", targetType: "policy", targetId: recorded.proposalId,
        revisionId: publishedRevisionId, ballotId, createdAt: closedAt,
      });
    }
    await audit("closure", {
      ...closure, action: closure.closeReason === "deadline" ? "ballot_closed_at_deadline" : "ballot_status_updated",
      targetType: "ballot", targetId: ballotId, ballotId, status: "closed", outcome: results.outcome,
      votesCast: results.votesCast, publishedRevisionId, createdAt: closedAt,
    });
    await ballots.updateOne({ ballotId, finalizedAt: { $exists: false } }, { $set: {
      finalizedAt: options.now ?? new Date(), publishedRevisionId, updatedAt: options.now ?? new Date(), updatedBy: closure.actorId,
    } });
    recorded = (await ballots.findOne({ ballotId }))!;
  }
  return {
    ballotId, status: "closed", closedAt, finalizedAt: recorded.finalizedAt!, results,
    outcome: results.outcome, publishedRevisionId: recorded.publishedRevisionId ?? null,
    syntheticOutcome: Boolean(recorded.syntheticOutcome), alreadyFinalized,
  };
}

export async function closeExpiredBallots(db: Db, now?: Date): Promise<number> {
  const ballots = db.collection<BallotRecord>("ballots");
  const expired = await ballots.find({ status: "open", closesAt: { $lte: now ?? new Date() } }).toArray();
  const incomplete = await ballots.find({ status: "closed", finalizedAt: { $exists: false } }).toArray();
  for (const ballot of [...expired, ...incomplete]) {
    await finalizeBallot(db, ballot.ballotId, { now, closeReason: "deadline" });
  }
  return expired.length;
}

export async function getBallotResults(_db: Db, ballot: BallotRecord): Promise<BallotResults | null> {
  return ballot.status === "closed" ? ballot.results ?? null : null;
}

async function addAudit(db: Db, identity: PlatformIdentity, action: string, ballotId: string, now: Date, session: ClientSession): Promise<void> {
  await db.collection("operational_audit").insertOne({
    _id: new ObjectId(), actorId: identity.memberId, actorSource: identity.source,
    action, targetType: "ballot", targetId: ballotId, createdAt: now,
    // Deliberately omit the selected choice and any prior choice.
  }, { session });
}

export async function castVote(db: Db, identity: PlatformIdentity, ballot: BallotRecord, choice: VoteChoice, env: PlatformEnv, now?: Date): Promise<void> {
  if (!validateVoteChoice(choice)) throw new Error("Choose Approve or Do Not Approve.");
  if (env.APP_MODE === "preview") {
    if (identity.source !== "synthetic") throw new Error("Preview voting requires a synthetic identity.");
    if (ballot.bindingBallotsEnabled === true) throw new Error("Synthetic accounts cannot participate in binding ballots.");
  } else {
    if (identity.source !== "engage") throw new Error("Production voting requires an Engage member identity.");
    if (!formalVotingIsEnabled(env)) throw new Error("Binding ballots are disabled until governance authorisation is recorded.");
  }
  const eligibility = identity.source === "synthetic" ? { eligible: env.APP_MODE === "preview" } : await membershipEligibility(db, identity.memberId);
  if (!eligibility.eligible) throw new Error("Your membership eligibility could not be confirmed.");

  await ballotWrite(db, async (session) => {
    // Production always uses database time at admission, including on transaction
    // retry. The optional clock is retained only for synthetic preview fixtures.
    const clock = env.APP_MODE === "preview" && now ? now : "$$NOW";
    const admitted = await db.collection<BallotRecord>("ballots").findOneAndUpdate({
      ballotId: ballot.ballotId, status: "open",
      $expr: { $and: [{ $lte: ["$opensAt", clock] }, { $gt: ["$closesAt", clock] }] },
    }, [{ $set: { admissionId: new ObjectId(), lastAdmissionAt: clock } }], { session, returnDocument: "after" });
    if (!admitted) throw new Error("This ballot is not open.");
    if (env.APP_MODE === "preview" && admitted.bindingBallotsEnabled === true) throw new Error("Synthetic accounts cannot participate in binding ballots.");
    if (env.APP_MODE !== "preview" && !bindingBallotAuthorised(admitted)) throw new Error("This ballot is not authorised for binding voting.");
    const receivedAt = now && env.APP_MODE === "preview" ? now : admitted.lastAdmissionAt!;
    await db.collection("votes").updateOne({ ballotId: admitted.ballotId, memberId: identity.memberId }, {
      $set: { choice, updatedAt: receivedAt, identitySource: identity.source },
      $setOnInsert: { createdAt: receivedAt },
    }, { session, upsert: true });
    await addAudit(db, identity, "ballot_vote_recorded", admitted.ballotId, receivedAt, session);
  });
}
