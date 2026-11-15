import type { Db } from "mongodb";
import type { ActivityTimelineEvent } from "./activity-timeline.ts";
import {
  buildParticipationFeed,
  summarizeParticipation,
  type ParticipationActivity,
  type ParticipationSummary,
} from "./participation-feed.ts";
import { PROPOSAL_VOTES } from "./vote-storage.ts";

export interface AdminParticipationProposal {
  proposalId: string;
  slug: string;
  title: string;
  authorId?: string;
  authorName?: string;
  createdAt: string;
}

export interface AdminParticipationOptions {
  /**
   * Identifiable ballot records are only read for users who may view them.
   * Encrypted records carry no member identity and are always anonymised.
   */
  showIdentifiableBallots: boolean;
  windowStart: Date;
}

export interface AdminParticipationResult {
  events: ActivityTimelineEvent[];
  summary: ParticipationSummary;
}

const ANONYMOUS_VOTER = "A member";

const actionFor: Record<ParticipationActivity["kind"], string> = {
  vote: "voted on",
  contribution: "contributed to",
  proposal: "submitted",
};

/**
 * Build the Recent member participation feed and its summary from one window.
 *
 * Votes are classified as votes, whether or not the storage model retains the
 * voter's identity. Vote choices, reasons, tallies and envelopes are never read.
 */
export async function loadAdminParticipation(
  db: Db,
  proposals: AdminParticipationProposal[],
  { showIdentifiableBallots, windowStart }: AdminParticipationOptions,
): Promise<AdminParticipationResult> {
  const proposalMap = new Map(
    proposals.map((proposal) => [proposal.proposalId, proposal]),
  );
  const allowedProposalIds = [...proposalMap.keys()];
  const empty = {
    events: [] as ActivityTimelineEvent[],
    summary: summarizeParticipation([]),
  };
  if (!allowedProposalIds.length) return empty;

  const proposalScope = { proposalId: { $in: allowedProposalIds } };
  const [recentVotes, recentComments] = await Promise.all([
    showIdentifiableBallots
      ? db
          .collection(PROPOSAL_VOTES)
          .find(
            {
              ...proposalScope,
              ballotId: /^proposal:/,
              updatedAt: { $gte: windowStart },
            },
            {
              // `voterBlindIndex` is an in-memory de-duplication key only. It is
              // never rendered or returned to the browser.
              projection: {
                _id: 1,
                proposalId: 1,
                ballotId: 1,
                memberId: 1,
                authorName: 1,
                voterBlindIndex: 1,
                updatedAt: 1,
              },
            },
          )
          .sort({ updatedAt: -1 })
          .toArray()
      : Promise.resolve([]),
    db
      .collection("comments")
      .find(
        { ...proposalScope, createdAt: { $gte: windowStart } },
        {
          projection: {
            commentId: 1,
            proposalId: 1,
            memberId: 1,
            authorName: 1,
            createdAt: 1,
            _id: 0,
          },
        },
      )
      .sort({ createdAt: -1 })
      .toArray(),
  ]);

  const voteActivities: ParticipationActivity[] = recentVotes.flatMap(
    (entry: any) => {
      const proposal = proposalMap.get(entry.proposalId);
      if (!proposal) return [];
      const named =
        typeof entry.memberId === "string" && entry.memberId.length > 0;
      const ballot = String(entry.ballotId ?? proposal.proposalId);
      return [
        {
          id: String(entry._id),
          ...(named ? { actorId: entry.memberId } : {}),
          actorName: named ? entry.authorName || "Member" : ANONYMOUS_VOTER,
          kind: "vote" as const,
          date: new Date(entry.updatedAt),
          proposalTitle: proposal.title,
          proposalSlug: proposal.slug,
          // One row per ballot and voter. Replayed or backfilled records for the
          // same act collapse; distinct ballots remain distinct rows.
          dedupeKey: named
            ? `${ballot}:${entry.memberId}`
            : `${ballot}:${String(entry.voterBlindIndex ?? entry._id)}`,
        },
      ];
    },
  );

  const commentActivities: ParticipationActivity[] = recentComments.flatMap(
    (entry: any) => {
      const proposal = proposalMap.get(entry.proposalId);
      return proposal
        ? [
            {
              id: entry.commentId,
              actorId: entry.memberId,
              actorName: entry.authorName || "Member",
              kind: "contribution" as const,
              date: new Date(entry.createdAt),
              proposalTitle: proposal.title,
              proposalSlug: proposal.slug,
              dedupeKey: `comment:${entry.commentId}`,
            },
          ]
        : [];
    },
  );

  const proposalActivities: ParticipationActivity[] = [...proposalMap.values()]
    .filter(
      (proposal) =>
        proposal.authorId &&
        new Date(proposal.createdAt).getTime() >= windowStart.getTime(),
    )
    .map((proposal) => ({
      id: proposal.proposalId,
      actorId: proposal.authorId,
      actorName: proposal.authorName || "Member",
      kind: "proposal",
      date: new Date(proposal.createdAt),
      proposalTitle: proposal.title,
      proposalSlug: proposal.slug,
      dedupeKey: `proposal:${proposal.proposalId}`,
    }));

  const recentActivities = [
    ...voteActivities,
    ...commentActivities,
    ...proposalActivities,
  ];
  const activeMemberIds = [
    ...new Set(
      recentActivities
        .map((entry) => entry.actorId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  const priorActivity = activeMemberIds.length
    ? await Promise.all([
        showIdentifiableBallots
          ? db
              .collection(PROPOSAL_VOTES)
              .find(
                {
                  memberId: { $in: activeMemberIds },
                  ballotId: /^proposal:/,
                  updatedAt: { $lt: windowStart },
                },
                { projection: { memberId: 1, _id: 0 } },
              )
              .toArray()
          : Promise.resolve([]),
        db
          .collection("comments")
          .find(
            { memberId: { $in: activeMemberIds }, createdAt: { $lt: windowStart } },
            { projection: { memberId: 1, _id: 0 } },
          )
          .toArray(),
        db
          .collection("proposals")
          .find(
            { authorId: { $in: activeMemberIds }, createdAt: { $lt: windowStart } },
            { projection: { authorId: 1, _id: 0 } },
          )
          .toArray(),
      ])
    : [[], [], []];

  const priorParticipants = new Set<string>();
  for (const entry of priorActivity[0] as any[]) {
    if (entry.memberId) priorParticipants.add(entry.memberId);
  }
  for (const entry of priorActivity[1] as any[]) {
    if (entry.memberId) priorParticipants.add(entry.memberId);
  }
  for (const entry of priorActivity[2] as any[]) {
    if (entry.authorId) priorParticipants.add(entry.authorId);
  }
  const firstParticipants = new Set(
    activeMemberIds.filter((id) => !priorParticipants.has(id)),
  );

  const feed = buildParticipationFeed(recentActivities, firstParticipants);
  return {
    events: feed.map((entry) => ({
      id: `${entry.kind}-${entry.id}`,
      date: entry.date,
      actor: entry.actorName,
      action: actionFor[entry.kind],
      target: entry.proposalTitle,
      href: `/proposals/${entry.proposalSlug}/`,
      kind: entry.kind,
      badge: entry.firstParticipation ? "First participation" : undefined,
    })),
    summary: summarizeParticipation(feed),
  };
}
