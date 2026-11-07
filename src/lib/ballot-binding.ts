import { createHash } from "node:crypto";
import type { ClientSession, Db } from "mongodb";
import { PROPOSAL_VOTES, proposalBallotId } from "./vote-storage.ts";

export interface BindBallotInput {
  proposalId: string;
  revisionId: string;
  decisionEventId: string;
  reason: string;
  actorId: string;
  bindingBasis?: string;
  migrationBatchId?: string;
  contentHash?: string;
  allowedStages?: string[];
  session?: ClientSession;
}

export interface BallotBindingEvent {
  eventId: string;
  proposalId: string;
  ballotId: string;
  revisionId: string;
  decisionEventId: string;
  reason: string;
  reviewedVoteCount: number;
  reboundVoteCount: number;
  actorId: string;
  bindingBasis?: string;
  migrationBatchId?: string;
  contentHash?: string;
  createdAt: Date;
}

export class BallotBindingError extends Error {
  status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.name = "BallotBindingError";
    this.status = status;
  }
}

export function ballotBindingEventId(
  proposalId: string,
  decisionEventId: string,
): string {
  return `bind-${createHash("sha256")
    .update(`${proposalId}\0${decisionEventId}`)
    .digest("hex")}`;
}

/**
 * Bind an existing ballot to one exact proposal revision and attach any
 * unbound votes to that same revision.
 *
 * The operation is deliberately reviewable and idempotent:
 * - the decision-event reference identifies one binding decision;
 * - a repeated identical request returns the original event;
 * - a repeated request with different wording or reasoning is rejected;
 * - votes that already name another revision are never reassigned.
 */
export async function bindBallotToRevision(
  db: Db,
  input: BindBallotInput,
): Promise<{ event: BallotBindingEvent; idempotent: boolean }> {
  const proposalId = input.proposalId.trim();
  const revisionId = input.revisionId.trim();
  const decisionEventId = input.decisionEventId.trim();
  const reason = input.reason.trim();
  if (!proposalId || !revisionId || !decisionEventId || !reason)
    throw new BallotBindingError(
      "Proposal, exact revision, decision event reference and review reason are required.",
      400,
    );

  const sessionOptions = input.session ? { session: input.session } : undefined;

  const allowedStages = input.allowedStages ?? ["decide"];
  const proposal = await db
    .collection("proposals")
    .findOne(
      { proposalId, stage: { $in: allowedStages } },
      sessionOptions,
    );
  if (!proposal)
    throw new BallotBindingError("Proposal ballot not found.", 404);

  const revision = await db
    .collection("proposal_revisions")
    .findOne({ proposalId, revisionId }, sessionOptions);
  if (!revision)
    throw new BallotBindingError(
      "The selected wording revision does not belong to this proposal.",
      404,
    );

  const eventId = ballotBindingEventId(proposalId, decisionEventId);
  const priorEvent = await db
    .collection("ballot_binding_events")
    .findOne({ eventId }, sessionOptions);
  if (priorEvent) {
    if (priorEvent.revisionId !== revisionId || priorEvent.reason !== reason)
      throw new BallotBindingError(
        "Decision event reference was already used for a different ballot binding.",
      );
    return { event: priorEvent as BallotBindingEvent, idempotent: true };
  }

  const ballotId = proposalBallotId(proposalId);
  const votes = await db
    .collection(PROPOSAL_VOTES)
    .find({ proposalId, ballotId }, sessionOptions)
    .toArray();
  const conflicts = votes.some(
    (vote: any) => vote.revisionId && vote.revisionId !== revisionId,
  );
  if (
    conflicts ||
    (proposal.ballotRevisionId && proposal.ballotRevisionId !== revisionId)
  )
    throw new BallotBindingError(
      "Recorded ballot wording conflicts with the selected revision. Engage will not reassign those votes.",
    );

  if (!proposal.ballotRevisionId) {
    const bound = await db.collection("proposals").updateOne(
      {
        proposalId,
        stage: { $in: allowedStages },
        ballotRevisionId: { $exists: false },
      },
      {
        $set: {
          ballotRevisionId: revisionId,
          ballotRevisionBoundAt: new Date(),
          ballotRevisionBoundBy: input.actorId,
        },
      },
      sessionOptions,
    );
    if (!bound.matchedCount) {
      const current = await db
        .collection("proposals")
        .findOne(
          { proposalId, stage: { $in: allowedStages } },
          sessionOptions,
        );
      if (current?.ballotRevisionId !== revisionId)
        throw new BallotBindingError(
          "Ballot wording changed during review. Reload and confirm the recorded revision.",
        );
    }
  }

  let reboundVoteCount = 0;
  for (const vote of votes as any[]) {
    if (vote.revisionId === revisionId) continue;
    if (vote.revisionId && vote.revisionId !== revisionId)
      throw new BallotBindingError(
        "A vote changed during review; no conflicting vote was reassigned.",
      );
    const updated = await db.collection(PROPOSAL_VOTES).updateOne(
      { _id: vote._id, ballotId, proposalId },
      { $set: { revisionId, revisionBindingEventId: eventId } },
      sessionOptions,
    );
    if (updated.matchedCount) reboundVoteCount++;
  }

  const event: BallotBindingEvent = {
    eventId,
    proposalId,
    ballotId,
    revisionId,
    decisionEventId,
    reason,
    reviewedVoteCount: votes.length,
    reboundVoteCount,
    actorId: input.actorId,
    ...(input.bindingBasis ? { bindingBasis: input.bindingBasis } : {}),
    ...(input.migrationBatchId
      ? { migrationBatchId: input.migrationBatchId }
      : {}),
    ...(input.contentHash ? { contentHash: input.contentHash } : {}),
    createdAt: new Date(),
  };

  try {
    await db.collection("ballot_binding_events").insertOne(event, sessionOptions);
  } catch (error) {
    // A concurrent retry may have inserted the same deterministic event first.
    const concurrent = await db
      .collection("ballot_binding_events")
      .findOne({ eventId }, sessionOptions);
    if (
      concurrent &&
      concurrent.revisionId === revisionId &&
      concurrent.reason === reason
    )
      return { event: concurrent as BallotBindingEvent, idempotent: true };
    throw new BallotBindingError(
      "The ballot binding event could not be recorded consistently. Reload and verify the ballot before retrying.",
    );
  }

  await verifyBallotBinding(
    db,
    proposalId,
    revisionId,
    input.session,
    allowedStages,
  );
  return { event, idempotent: false };
}

export async function verifyBallotBinding(
  db: Db,
  proposalId: string,
  revisionId: string,
  session?: ClientSession,
  allowedStages: string[] = ["decide"],
): Promise<void> {
  const sessionOptions = session ? { session } : undefined;
  const proposal = await db
    .collection("proposals")
    .findOne(
      { proposalId, stage: { $in: allowedStages } },
      sessionOptions,
    );
  if (proposal?.ballotRevisionId !== revisionId)
    throw new BallotBindingError(
      "Binding verification failed: the ballot is not attached to the reviewed revision.",
    );
  const ballotId = proposalBallotId(proposalId);
  const votes = await db
    .collection(PROPOSAL_VOTES)
    .find({ proposalId, ballotId }, sessionOptions)
    .toArray();
  if (votes.some((vote) => vote.revisionId !== revisionId))
    throw new BallotBindingError(
      "Binding verification failed: one or more existing votes are not attached to the reviewed revision.",
    );
  const events = await db
    .collection("ballot_binding_events")
    .countDocuments({ proposalId, revisionId }, sessionOptions);
  if (events < 1)
    throw new BallotBindingError(
      "Binding verification failed: no binding audit event was recorded.",
    );
}
