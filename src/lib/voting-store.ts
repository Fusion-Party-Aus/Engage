import { ObjectId, type ClientSession, type Db } from "mongodb";
import { loadBallotCryptoConfig, loadBallotCryptoConfigForRead } from "./ballot-crypto.ts";
import { ballotExpired } from "./ballot-deadline.ts";
import { projectCommittedVoteTally } from "./ballot-tallies.ts";
import { runInTransaction } from "./db.ts";
import { notePriorParticipation, recordParticipation } from "./member-lifecycle.ts";
import {
  PENDING_VOTE_PREFERENCES,
  canViewProposal,
  normalizeProposalDoc,
} from "./proposal-helpers.ts";
import type {
  CommentRecord,
  MembershipStatus,
  PendingVotePreferenceRecord,
  PlatformEnv,
  ProposalRecord,
  ProposalStage,
  ProposalSummaryView,
  SessionUser,
  VoteChoice,
  VoteRecord,
  VoteTally,
} from "./types.ts";
import {
  PROPOSAL_VOTES,
  buildEncryptedVoteFields,
  computeAllBlindIndexesForMember,
  decodeStoredVote,
  findMemberVotes,
  proposalBallotId,
} from "./vote-storage.ts";

async function upsertStoredVote(
  db: Db,
  cryptoConfig: ReturnType<typeof loadBallotCryptoConfig>,
  input: {
    ballotId: string;
    proposalId: string;
    revisionId: string;
    amendmentId?: string;
    amendmentRevisionId?: string;
    memberId: string;
    authorName: string;
    choice: VoteChoice;
    reason: string;
  },
  session?: ClientSession,
): Promise<{
  votes: VoteTally;
  hadPreviousVote: boolean;
  previousChoice: VoteChoice | null;
  previousRevisionId: string | null;
}> {
  const sessionOpts = session ? { session } : undefined;
  const votesCol = db.collection<VoteRecord>(PROPOSAL_VOTES);
  const now = new Date();
  let hadPreviousVote = false;
  let previousChoice: VoteChoice | null = null;
  let previousRevisionId: string | null = null;
  if (cryptoConfig?.mode === "encrypt") {
    const encryptedFields = buildEncryptedVoteFields(cryptoConfig, {
      ...input,
      updatedAt: now,
    });
    const allBlindIndexes = computeAllBlindIndexesForMember(
      cryptoConfig,
      input.ballotId,
      input.memberId,
    );
    const existing = (await votesCol.findOne(
      {
        ballotId: input.ballotId,
        $or: [
          { memberId: input.memberId },
          { voterBlindIndex: { $in: allBlindIndexes } },
        ],
      } as any,
      sessionOpts,
    )) as (VoteRecord & { _id?: ObjectId }) | null;
    if (existing?._id) {
      hadPreviousVote = true;
      previousRevisionId =
        typeof existing.revisionId === "string"
          ? existing.revisionId
          : null;
      try {
        previousChoice = decodeStoredVote(
          existing as Record<string, any>,
          cryptoConfig,
        ).choice;
      } catch {
        // The prior choice cannot be read. The projection falls back to a full
        // recount instead of guessing a delta.
        previousChoice = null;
      }
      await votesCol.updateOne(
        { _id: existing._id } as any,
        {
          $set: encryptedFields as any,
          $unset: { memberId: "", authorName: "", choice: "", reason: "" },
        },
        sessionOpts,
      );
    } else {
      await votesCol.updateOne(
        {
          ballotId: input.ballotId,
          voterBlindIndex: encryptedFields.voterBlindIndex,
        } as any,
        { $set: encryptedFields as any },
        { upsert: true, ...(sessionOpts ?? {}) },
      );
    }
  } else {
    const before = (await votesCol.findOneAndUpdate(
      { ballotId: input.ballotId, memberId: input.memberId },
      {
        $set: {
          ballotId: input.ballotId,
          proposalId: input.proposalId,
          ...(input.amendmentId ? { amendmentId: input.amendmentId } : {}),
          revisionId: input.revisionId,
          ...(input.amendmentRevisionId
            ? { amendmentRevisionId: input.amendmentRevisionId }
            : {}),
          memberId: input.memberId,
          authorName: input.authorName,
          choice: input.choice,
          reason: input.reason,
          updatedAt: now,
        },
      },
      { upsert: true, returnDocument: "before", ...(sessionOpts ?? {}) },
    )) as (VoteRecord & { _id?: ObjectId }) | null;
    if (before) {
      hadPreviousVote = true;
      previousRevisionId =
        typeof before.revisionId === "string" ? before.revisionId : null;
      previousChoice =
        before.choice === "approve" ||
        before.choice === "abstain" ||
        before.choice === "reject"
          ? before.choice
          : null;
    }
  }

  const allVotes = await votesCol
    .find({ ballotId: input.ballotId }, sessionOpts)
    .toArray();
  const votes: VoteTally = { approve: 0, abstain: 0, reject: 0, total: 0 };
  for (const v of allVotes) {
    const decoded = decodeStoredVote(v as Record<string, any>, cryptoConfig);
    if (decoded.choice === "approve") votes.approve += 1;
    else if (decoded.choice === "abstain") votes.abstain += 1;
    else votes.reject += 1;
    votes.total += 1;
  }
  return { votes, hadPreviousVote, previousChoice, previousRevisionId };
}

export async function castVote(
  db: Db,
  user: SessionUser,
  body: Record<string, unknown>,
  env?: Partial<PlatformEnv>,
): Promise<{ choice: VoteChoice; votes: VoteTally; amendmentId?: string }> {
  const cryptoConfig = loadBallotCryptoConfig(env ?? process.env);
  if (!user.canParticipate) {
    throw new Error(
      "Your membership must be verified before you can participate in decisions.",
    );
  }

  const proposalId =
    typeof body.proposalId === "string"
      ? body.proposalId.trim()
      : typeof body.policyId === "string"
        ? body.policyId.trim()
        : "";
  const proposal = await db
    .collection<ProposalRecord>("proposals")
    .findOne({ proposalId });
  if (!proposal || !canViewProposal(normalizeProposalDoc(proposal), user)) {
    throw new Error("Proposal not found.");
  }
  // Eligibility is decided in one place so proposal lists, proposal details and
  // ballot submission cannot drift apart. Following a branch never qualifies.
  const { getProposalEligibility } = await import("./branch-participation.ts");
  const eligibility = await getProposalEligibility(
    db,
    normalizeProposalDoc(proposal),
    user,
  );
  if (!eligibility.eligible) throw new Error(eligibility.reason);
  if (ballotExpired(proposal)) throw new Error("This ballot has closed.");
  const amendmentId =
    typeof body.amendmentId === "string" ? body.amendmentId.trim() : "";
  if (amendmentId) {
    if (proposal.stage !== "decide" || !proposal.ballotRevisionId) {
      throw new Error(
        "The proposal must have an open, revision-bound ballot before an amendment ballot can be used.",
      );
    }
    const amendment = await db
      .collection("amendments")
      .findOne({
        amendmentId,
        proposalId,
        status: "voting",
        baseRevisionId: proposal.ballotRevisionId,
        ballotRevisionId: proposal.ballotRevisionId,
      });
    if (
      !amendment?.ballotAmendmentRevisionId ||
      amendment.ballotAmendmentRevisionId !== amendment.currentRevisionId ||
      !(await db
        .collection("amendment_revisions")
        .findOne({
          amendmentId,
          revisionId: amendment.ballotAmendmentRevisionId,
        }))
    ) {
      throw new Error(
        "This amendment ballot is not bound to the current immutable wording revision.",
      );
    }
    if (ballotExpired({ ballotClosesAt: amendment.ballotClosesAt })) {
      throw new Error("This amendment ballot has closed.");
    }
    const rawChoice =
      typeof body.choice === "string" ? body.choice.trim().toLowerCase() : "";
    if (!["approve", "abstain", "reject", "do-not-approve"].includes(rawChoice)) {
      throw new Error("Choose Approve, Abstain, or Reject.");
    }
    const choice: VoteChoice =
      rawChoice === "approve"
        ? "approve"
        : rawChoice === "abstain"
          ? "abstain"
          : "reject";
    const ballotId = `amendment:${amendmentId}`;
    const reason =
      typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
    const votes = await runInTransaction(db, async (session) => {
      await notePriorParticipation(db, user.memberId, session);
      const stored = await upsertStoredVote(
        db,
        cryptoConfig,
        {
          ballotId,
          proposalId,
          amendmentId,
          revisionId: amendment.ballotRevisionId,
          amendmentRevisionId: amendment.ballotAmendmentRevisionId,
          memberId: user.memberId,
          authorName: user.name || "Verified Member",
          choice,
          reason,
        },
        session,
      );
      await recordParticipation(db, user.memberId, new Date(), session);
      return stored;
    });
    // The vote has committed. The display projection is written afterwards and
    // can never fail, delay or alter it.
    await projectCommittedVoteTally(db, {
      ballotId,
      revisionId: amendment.ballotRevisionId,
      choice,
      hadPreviousVote: votes.hadPreviousVote,
      previousChoice: votes.previousChoice,
      previousRevisionId: votes.previousRevisionId,
      cryptoConfig,
    });
    return { choice, votes: votes.votes, amendmentId };
  }
  if (proposal.stage !== "decide") {
    throw new Error("This proposal is not currently in the Decide stage.");
  }
  if (ballotExpired(proposal)) throw new Error("This ballot has closed.");

  let ballotRevisionId = proposal.ballotRevisionId;
  let lazyBindRevision = false;
  if (ballotRevisionId) {
    const currentBallotId = proposalBallotId(proposalId);
    const existingVotes = await db
      .collection<VoteRecord>(PROPOSAL_VOTES)
      .find({ proposalId, ballotId: currentBallotId })
      .toArray();
    if (existingVotes.some((vote) => vote.revisionId !== ballotRevisionId)) {
      throw new Error(
        "This ballot contains votes that are not bound to its frozen wording. An administrator must review and resolve the binding before voting can continue.",
      );
    }
  }
  if (!ballotRevisionId) {
    const currentBallotId = proposalBallotId(proposalId);
    const priorVotes = await db
      .collection<VoteRecord>(PROPOSAL_VOTES)
      .find({ proposalId, ballotId: currentBallotId })
      .toArray();
    if (priorVotes.length) {
      const ids = [
        ...new Set(
          priorVotes
            .map((vote) => vote.revisionId)
            .filter(
              (id): id is string => typeof id === "string" && id.length > 0,
            ),
        ),
      ];
      if (
        ids.length !== 1 ||
        priorVotes.some((vote) => vote.revisionId !== ids[0])
      ) {
        throw new Error(
          "This existing ballot has votes without one consistent revision reference. An administrator must review and bind the wording before voting can continue.",
        );
      }
      ballotRevisionId = ids[0];
      if (
        !(await db
          .collection("proposal_revisions")
          .findOne({ proposalId, revisionId: ballotRevisionId }))
      ) {
        throw new Error(
          "The existing ballot revision is missing. An administrator must review the ballot before voting can continue.",
        );
      }
    } else {
      const latest = await db
        .collection("proposal_revisions")
        .find({ proposalId })
        .sort({ createdAt: -1 })
        .limit(1)
        .toArray();
      ballotRevisionId = latest[0]?.revisionId;
    }
    if (!ballotRevisionId) {
      throw new Error(
        "A proposal revision is required before voting can begin.",
      );
    }
    lazyBindRevision = true;
  }

  const rawChoice =
    typeof body.choice === "string" ? body.choice.trim().toLowerCase() : "";
  if (!["approve", "abstain", "reject", "do-not-approve"].includes(rawChoice)) {
    throw new Error("Choose Approve, Abstain, or Reject.");
  }
  const choice: VoteChoice =
    rawChoice === "approve"
      ? "approve"
      : rawChoice === "abstain"
        ? "abstain"
        : "reject";
  const reason =
    typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";

  if (!ballotRevisionId) {
    throw new Error("A proposal revision is required before voting can begin.");
  }
  const initialBallotRevisionId = ballotRevisionId;
  const committed = await runInTransaction(db, async (session) => {
    const sessionOpts = session ? { session } : undefined;
    let resolvedRevisionId = initialBallotRevisionId;
    if (lazyBindRevision) {
      const bound = await db
        .collection("proposals")
        .updateOne(
          { proposalId, stage: "decide", ballotRevisionId: { $exists: false } },
          { $set: { ballotRevisionId: resolvedRevisionId } },
          sessionOpts,
        );
      if (!bound.matchedCount) {
        const current = await db
          .collection<ProposalRecord>("proposals")
          .findOne({ proposalId, stage: "decide" }, sessionOpts);
        if (!current?.ballotRevisionId) {
          throw new Error(
            "The ballot changed while its revision was being bound. Reload and try again.",
          );
        }
        resolvedRevisionId = current.ballotRevisionId;
      }
    }

    await notePriorParticipation(db, user.memberId, session);
    const stored = await upsertStoredVote(
      db,
      cryptoConfig,
      {
        ballotId: proposalBallotId(proposal.proposalId),
        proposalId: proposal.proposalId,
        revisionId: resolvedRevisionId,
        memberId: user.memberId,
        authorName: user.name || "Verified Member",
        choice,
        reason,
      },
      session,
    );

    // Clear any pending preference for this ballot now that a formal vote is recorded
    await db
      .collection<PendingVotePreferenceRecord>(PENDING_VOTE_PREFERENCES)
      .deleteOne(
        {
          ballotId: proposalBallotId(proposal.proposalId),
          memberId: user.memberId,
        },
        sessionOpts,
      );

    await recordParticipation(db, user.memberId, new Date(), session);
    return { ...stored, revisionId: resolvedRevisionId };
  });
  // The vote has committed. The display projection is written afterwards and
  // can never fail, delay or alter it.
  await projectCommittedVoteTally(db, {
    ballotId: proposalBallotId(proposal.proposalId),
    revisionId: committed.revisionId,
    choice,
    hadPreviousVote: committed.hadPreviousVote,
    previousChoice: committed.previousChoice,
    previousRevisionId: committed.previousRevisionId,
    cryptoConfig,
  });
  return { choice, votes: committed.votes };
}

export async function savePendingVotePreference(
  db: Db,
  user: SessionUser,
  body: Record<string, unknown>,
): Promise<{
  choice: VoteChoice;
  pendingVerification: true;
  revisionId: string;
}> {
  if (user.status === "suspended") {
    throw new Error(
      "Your account is suspended and cannot save ballot preferences.",
    );
  }
  const proposalId =
    typeof body.proposalId === "string"
      ? body.proposalId.trim()
      : typeof body.policyId === "string"
        ? body.policyId.trim()
        : "";
  const proposal = await db
    .collection<ProposalRecord>("proposals")
    .findOne({ proposalId });
  if (!proposal || !canViewProposal(normalizeProposalDoc(proposal), user)) {
    throw new Error("Proposal not found.");
  }
  if (proposal.stage !== "decide") {
    throw new Error("This proposal is not currently in the Decide stage.");
  }
  if (ballotExpired(proposal)) throw new Error("This ballot has closed.");

  let ballotRevisionId = proposal.ballotRevisionId;
  if (!ballotRevisionId) {
    const latest = await db
      .collection("proposal_revisions")
      .find({ proposalId })
      .sort({ createdAt: -1 })
      .limit(1)
      .toArray();
    ballotRevisionId = latest[0]?.revisionId;
  }
  if (!ballotRevisionId) {
    throw new Error(
      "A proposal revision is required before a ballot preference can be saved.",
    );
  }

  const rawChoice =
    typeof body.choice === "string" ? body.choice.trim().toLowerCase() : "";
  if (!["approve", "abstain", "reject", "do-not-approve"].includes(rawChoice)) {
    throw new Error("Choose Approve, Abstain, or Reject.");
  }
  const choice: VoteChoice =
    rawChoice === "approve"
      ? "approve"
      : rawChoice === "abstain"
        ? "abstain"
        : "reject";
  const reason =
    typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";

  await db
    .collection<PendingVotePreferenceRecord>(PENDING_VOTE_PREFERENCES)
    .updateOne(
      {
        ballotId: proposalBallotId(proposal.proposalId),
        memberId: user.memberId,
      },
      {
        $set: {
          ballotId: proposalBallotId(proposal.proposalId),
          proposalId: proposal.proposalId,
          revisionId: ballotRevisionId,
          memberId: user.memberId,
          authorName: user.name || "Pending Member",
          choice,
          ...(reason ? { reason } : { reason: "" }),
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );

  return {
    choice,
    pendingVerification: true,
    revisionId: ballotRevisionId,
  };
}

export async function promotePendingVotePreferences(
  db: Db,
  memberId: string,
): Promise<number> {
  const pendingCol = db.collection<PendingVotePreferenceRecord>(
    PENDING_VOTE_PREFERENCES,
  );
  const pendingItems = await pendingCol.find({ memberId }).toArray();
  if (pendingItems.length === 0) return 0;

  const userDoc = ObjectId.isValid(memberId)
    ? await db.collection("user").findOne({ _id: new ObjectId(memberId) })
    : null;
  if (userDoc?.disabled === true) return 0;

  const membershipDoc = await db
    .collection<{ memberId: string; status: MembershipStatus }>("memberships")
    .findOne({ memberId, status: "verified" });
  if (!membershipDoc) return 0;

  const authorName =
    typeof userDoc?.name === "string" && userDoc.name.trim()
      ? userDoc.name.trim()
      : "Verified Member";

  let promoted = 0;
  const votesCol = db.collection<VoteRecord>(PROPOSAL_VOTES);

  for (const item of pendingItems) {
    const rawProposal = await db
      .collection<ProposalRecord>("proposals")
      .findOne({ proposalId: item.proposalId });
    if (!rawProposal) continue;
    const proposal = normalizeProposalDoc(rawProposal);
    if (proposal.stage !== "decide" || ballotExpired(proposal)) continue;

    // Enforce identical branch electorate eligibility as castVote. National
    // governance is included for every verified Engage account.
    if (proposal.jurisdictionBranchId) {
      const [branch, branchMembership] = await Promise.all([
        db.collection("branches").findOne({
          branchId: proposal.jurisdictionBranchId,
          recognised: true,
        }),
        db.collection("branch_memberships").findOne({
          branchId: proposal.jurisdictionBranchId,
          memberId,
          status: "active",
        }),
      ]);
      if (!branch) continue;
      if (String((branch as any).kind) !== "national" && !branchMembership) {
        continue;
      }
    }

    const ballotRevisionId = proposal.ballotRevisionId;
    if (!ballotRevisionId || item.revisionId !== ballotRevisionId) {
      continue;
    }

    const existingFormalVote = await votesCol.findOne({
      ballotId: proposalBallotId(proposal.proposalId),
      memberId,
    });
    if (!existingFormalVote) {
      await votesCol.updateOne(
        {
          ballotId: proposalBallotId(proposal.proposalId),
          memberId,
        },
        {
          $set: {
            ballotId: proposalBallotId(proposal.proposalId),
            proposalId: proposal.proposalId,
            revisionId: ballotRevisionId,
            memberId,
            authorName,
            choice: item.choice,
            reason: item.reason ?? "",
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      );
      promoted += 1;
    }

    await pendingCol.deleteOne({
      ballotId: proposalBallotId(proposal.proposalId),
      memberId,
    });
  }

  return promoted;
}

export async function listUserActivity(
  db: Db,
  memberId: string,
  availableProposals?: ProposalSummaryView[],
): Promise<{
  proposals: ProposalRecord[];
  comments: Array<
    CommentRecord & { proposalTitle: string; proposalSlug: string }
  >;
  votes: Array<
    VoteRecord & {
      proposalTitle: string;
      proposalSlug: string;
      proposalStage: ProposalStage;
    }
  >;
}> {
  const cryptoConfig = loadBallotCryptoConfigForRead(process.env);
  const [proposals, comments] = await Promise.all([
    availableProposals
      ? Promise.resolve(availableProposals)
      : db.collection<ProposalRecord>("proposals").find({}).toArray(),
    db
      .collection<CommentRecord>("comments")
      .find({ memberId })
      .sort({ createdAt: -1 })
      .toArray(),
  ]);
  const votes = await findMemberVotes(
    db,
    memberId,
    proposals.map((p) => proposalBallotId(p.proposalId)),
    cryptoConfig,
  );

  const proposalMap = new Map(proposals.map((p) => [p.proposalId, p]));

  return {
    proposals: proposals.filter((p) => p.authorId === memberId),
    comments: comments.map((c) => {
      const p = proposalMap.get(c.proposalId);
      return {
        ...c,
        proposalTitle: p?.title ?? c.proposalId,
        proposalSlug: p?.slug ?? c.proposalId,
      };
    }),
    votes: votes.map((v) => {
      const p = proposalMap.get(v.proposalId);
      return {
        ...v,
        memberId: v.memberId ?? memberId,
        authorName: v.authorName ?? "",
        proposalTitle: p?.title ?? v.proposalId,
        proposalSlug: p?.slug ?? v.proposalId,
        proposalStage: p?.stage ?? "deliberate",
      };
    }),
  };
}

