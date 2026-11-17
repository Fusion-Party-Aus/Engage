import type { Db } from "mongodb";
import {
  loadBallotCryptoConfigForRead,
  type BallotCryptoConfig,
} from "./ballot-crypto.ts";
import { ballotExpired } from "./ballot-deadline.ts";
import {
  getProposalEligibility,
  type ProposalEligibilityFacts,
} from "./branch-participation.ts";
import { canViewProposal, normalizeProposalDoc } from "./proposal-helpers.ts";
import {
  findMemberVotes,
  proposalBallotId,
  type DecodedVoteRecord,
} from "./vote-storage.ts";
import type { ProposalSummaryView, SessionUser } from "./types.ts";

/**
 * The electorate: which open ballots this viewer may still vote on.
 *
 * Eligibility is always `getProposalEligibility`; this module adds only the
 * ballot facts around it — binding, deadline, whether a vote already exists and
 * which amendment ballots belong to the open matter ballot. A list read
 * prefetches branches, memberships and votes once, so a page pays for four
 * queries rather than one per proposal.
 */
export interface ElectorateBallot {
  key: string;
  kind: "matter" | "amendment";
  ballotId: string;
  revisionId: string;
  amendmentId?: string;
  amendmentRevisionId?: string;
  proposalId: string;
  slug: string;
  title: string;
  href: string;
  closesAt?: Date;
  /** Matter fields for discovery lists; amendment rows leave these empty. */
  space?: string;
  summary?: string;
  /** True when this viewer already voted on this exact ballot and revision. */
  voted: boolean;
}

export interface ElectorateOptions {
  /** Pre-loaded proposals. Visibility and stage are still checked. */
  proposals?: ProposalSummaryView[];
  now?: Date;
  /** Pre-loaded decoded votes, so a page does not read them twice. */
  votes?: DecodedVoteRecord[] | Promise<DecodedVoteRecord[]>;
  /**
   * Decryption configuration. Pages use the tolerant read loader; the digest
   * passes its strict loader so a broken key ring still fails loudly.
   */
  cryptoConfig?: BallotCryptoConfig | null;
}

function asDate(value: unknown): Date | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : undefined;
}

async function loadDecideProposals(db: Db): Promise<ProposalSummaryView[]> {
  const rows = await db
    .collection("proposals")
    .find(
      { stage: "decide" },
      { projection: { detailHtml: 0, details: 0 } },
    )
    .sort({ proposalId: 1 })
    .toArray();
  return rows.map((row) => ({
    ...normalizeProposalDoc(row),
    commentCount: 0,
    votes: { approve: 0, abstain: 0, reject: 0, total: 0 },
  }));
}

interface VotingAmendmentRow {
  amendmentId: string;
  proposalId: string;
  title?: string;
  ballotClosesAt?: Date | string | null;
  ballotRevisionId?: string;
  ballotAmendmentRevisionId?: string;
  currentRevisionId?: string;
  baseRevisionId?: string;
}

async function loadVotingAmendments(
  db: Db,
  proposalIds: string[],
): Promise<VotingAmendmentRow[]> {
  if (!proposalIds.length) return [];
  return db
    .collection<VotingAmendmentRow>("amendments")
    .find(
      { status: "voting", proposalId: { $in: proposalIds } },
      {
        projection: {
          amendmentId: 1,
          proposalId: 1,
          title: 1,
          ballotClosesAt: 1,
          ballotRevisionId: 1,
          ballotAmendmentRevisionId: 1,
          currentRevisionId: 1,
          baseRevisionId: 1,
        },
      },
    )
    .toArray();
}

function votedFor(
  votes: DecodedVoteRecord[],
  ballotId: string,
  revisionId?: string,
  amendmentRevisionId?: string,
): boolean {
  return votes.some(
    (vote) =>
      vote.ballotId === ballotId &&
      vote.revisionId === revisionId &&
      (amendmentRevisionId === undefined ||
        vote.amendmentRevisionId === amendmentRevisionId),
  );
}

function factsFor(
  proposal: ProposalSummaryView,
  branches: Map<string, unknown>,
  memberships: Set<string>,
  following: Set<string>,
): ProposalEligibilityFacts | undefined {
  const branchId = proposal.jurisdictionBranchId;
  if (!branchId) return undefined;
  return {
    branch: (branches.get(branchId) ?? null) as ProposalEligibilityFacts["branch"],
    isMember: memberships.has(branchId),
    isFollowing: following.has(branchId),
  };
}

async function collect(
  db: Db,
  viewer: SessionUser,
  options: ElectorateOptions,
  includeAmendments: boolean,
): Promise<ElectorateBallot[]> {
  if (!viewer.canParticipate) return [];
  const now = options.now ?? new Date();
  const proposals = (options.proposals ?? (await loadDecideProposals(db)))
    .filter(
      (proposal) =>
        proposal.stage === "decide" &&
        Boolean(proposal.ballotRevisionId) &&
        !ballotExpired(proposal, now),
    );

  const branchIds = [
    ...new Set(
      proposals
        .map((proposal) => proposal.jurisdictionBranchId)
        .filter((branchId): branchId is string => Boolean(branchId)),
    ),
  ];
  const [branchRows, membershipRows, followingRows] = branchIds.length
    ? await Promise.all([
        db
          .collection<any>("branches")
          .find({ branchId: { $in: branchIds } })
          .toArray(),
        db
          .collection<any>("branch_memberships")
          .find({
            memberId: viewer.memberId,
            status: "active",
            branchId: { $in: branchIds },
          })
          .project({ branchId: 1 })
          .toArray(),
        db
          .collection<any>("branch_subscriptions")
          .find({
            memberId: viewer.memberId,
            status: "following",
            branchId: { $in: branchIds },
          })
          .project({ branchId: 1 })
          .toArray(),
      ])
    : [[], [], []];

  const branches = new Map(
    branchRows.map((row: any) => [String(row.branchId), row]),
  );
  const memberships = new Set(
    membershipRows.map((row: any) => String(row.branchId)),
  );
  const following = new Set(
    followingRows.map((row: any) => String(row.branchId)),
  );
  // A branch member can see their branch's proposals even when the session
  // object was built for a background job without discovery facts.
  const visibilityViewer: SessionUser = {
    ...viewer,
    activeBranchIds: [
      ...new Set([...(viewer.activeBranchIds ?? []), ...memberships]),
    ],
  };
  const visible = proposals.filter((proposal) =>
    canViewProposal(proposal, visibilityViewer),
  );

  const amendments = includeAmendments
    ? await loadVotingAmendments(
        db,
        visible.map((proposal) => proposal.proposalId),
      )
    : [];
  const amendmentsByProposal = new Map<string, VotingAmendmentRow[]>();
  for (const amendment of amendments) {
    const list = amendmentsByProposal.get(amendment.proposalId) ?? [];
    list.push(amendment);
    amendmentsByProposal.set(amendment.proposalId, list);
  }

  const ballotIds = [
    ...visible.map((proposal) => proposalBallotId(proposal.proposalId)),
    ...amendments.map((amendment) => `amendment:${amendment.amendmentId}`),
  ];
  const votes = options.votes
    ? await options.votes
    : await findMemberVotes(
        db,
        viewer.memberId,
        ballotIds,
        options.cryptoConfig ?? loadBallotCryptoConfigForRead(process.env),
      );

  const ballots: ElectorateBallot[] = [];
  for (const proposal of visible) {
    const eligibility = await getProposalEligibility(
      db,
      proposal,
      viewer,
      factsFor(proposal, branches, memberships, following),
    );
    if (!eligibility.eligible) continue;

    const ballotId = proposalBallotId(proposal.proposalId);
    const revisionId = String(proposal.ballotRevisionId);
    const closesAt = asDate(proposal.ballotClosesAt);
    ballots.push({
      key: `proposal:${proposal.proposalId}:${revisionId}:${closesAt ? closesAt.toISOString() : "open"}`,
      kind: "matter",
      ballotId,
      revisionId,
      proposalId: proposal.proposalId,
      slug: proposal.slug,
      title: proposal.title,
      href: `/proposals/${encodeURIComponent(proposal.slug)}/#proposal-vote`,
      closesAt,
      space: proposal.space,
      summary: proposal.summary,
      voted: votedFor(votes, ballotId, revisionId),
    });

    if (!includeAmendments) continue;
    for (const amendment of amendmentsByProposal.get(proposal.proposalId) ?? []) {
      if (
        amendment.ballotRevisionId !== proposal.ballotRevisionId ||
        amendment.baseRevisionId !== proposal.ballotRevisionId ||
        !amendment.ballotAmendmentRevisionId ||
        amendment.currentRevisionId !== amendment.ballotAmendmentRevisionId
      ) {
        continue;
      }
      const amendmentClosesAt =
        asDate(amendment.ballotClosesAt) ?? closesAt;
      if (ballotExpired({ ballotClosesAt: amendmentClosesAt }, now)) continue;
      const amendmentBallotId = `amendment:${amendment.amendmentId}`;
      ballots.push({
        key: `amendment:${amendment.amendmentId}:${amendment.ballotAmendmentRevisionId}:${amendmentClosesAt ? amendmentClosesAt.toISOString() : "open"}`,
        kind: "amendment",
        ballotId: amendmentBallotId,
        revisionId: String(amendment.ballotRevisionId),
        amendmentId: amendment.amendmentId,
        amendmentRevisionId: String(amendment.ballotAmendmentRevisionId),
        proposalId: proposal.proposalId,
        slug: proposal.slug,
        title: `Amendment: ${amendment.title || proposal.title}`,
        href: `/proposals/${encodeURIComponent(proposal.slug)}/#deliberation`,
        closesAt: amendmentClosesAt,
        voted: votedFor(
          votes,
          amendmentBallotId,
          amendment.ballotRevisionId,
          amendment.ballotAmendmentRevisionId,
        ),
      });
    }
  }
  return ballots;
}

/**
 * Every eligible open matter ballot, whether voted or not. The home progress
 * denominator and the outstanding filter both derive from this one list.
 */
export async function openMatterBallots(
  db: Db,
  viewer: SessionUser,
  options: ElectorateOptions = {},
): Promise<ElectorateBallot[]> {
  return collect(db, viewer, options, false);
}

/** Eligible, bound, open matter ballots this viewer has not voted on. */
export async function outstandingMatterBallots(
  db: Db,
  viewer: SessionUser,
  options: ElectorateOptions = {},
): Promise<ElectorateBallot[]> {
  return (await collect(db, viewer, options, false)).filter(
    (ballot) => !ballot.voted,
  );
}

/**
 * Every outstanding ballot for the viewer, including amendment endorsement
 * ballots, ordered by the soonest close. The digest uses this; pages that only
 * show matter votes use `outstandingMatterBallots`.
 */
export async function outstandingBallots(
  db: Db,
  viewer: SessionUser,
  options: ElectorateOptions = {},
): Promise<ElectorateBallot[]> {
  return (await collect(db, viewer, options, true))
    .filter((ballot) => !ballot.voted)
    .sort(
      (left, right) =>
        (left.closesAt?.getTime() ?? Infinity) -
        (right.closesAt?.getTime() ?? Infinity),
    );
}
