export interface ParticipationActivity {
  id: string;
  actorId?: string;
  actorName: string;
  kind: "vote" | "contribution" | "proposal";
  date: Date;
  proposalTitle: string;
  proposalSlug: string;
  firstParticipation?: boolean;
}

export type ParticipationFeedEntry =
  | {
      kind: "votes";
      actorId: string;
      actorName: string;
      count: number;
      firstDate: Date;
      lastDate: Date;
      proposals: Array<{ title: string; slug: string }>;
      firstParticipation: boolean;
    }
  | (ParticipationActivity & { firstParticipation: boolean });

const VOTE_GROUP_WINDOW_MS = 10 * 60 * 1000;

/** Groups only adjacent vote activity by the same identified member. Contributions remain individual. */
export function groupParticipationFeed(
  activities: ParticipationActivity[],
  firstParticipants: Set<string>,
): ParticipationFeedEntry[] {
  const sorted = [...activities].sort(
    (a, b) => b.date.getTime() - a.date.getTime(),
  );
  const feed: ParticipationFeedEntry[] = [];
  for (const activity of sorted) {
    const firstParticipation = Boolean(
      activity.actorId && firstParticipants.has(activity.actorId),
    );
    const previous = feed.at(-1);
    if (
      activity.kind === "vote" &&
      activity.actorId &&
      previous?.kind === "votes" &&
      previous.actorId === activity.actorId &&
      previous.firstDate.getTime() - activity.date.getTime() <=
        VOTE_GROUP_WINDOW_MS
    ) {
      previous.count++;
      previous.firstDate = activity.date;
      previous.proposals.push({
        title: activity.proposalTitle,
        slug: activity.proposalSlug,
      });
      previous.firstParticipation ||= firstParticipation;
    } else if (activity.kind === "vote" && activity.actorId) {
      feed.push({
        kind: "votes",
        actorId: activity.actorId,
        actorName: activity.actorName,
        count: 1,
        firstDate: activity.date,
        lastDate: activity.date,
        proposals: [
          { title: activity.proposalTitle, slug: activity.proposalSlug },
        ],
        firstParticipation,
      });
    } else {
      const { actorId: _actorId, ...entry } = activity;
      feed.push({ ...entry, firstParticipation });
    }
  }
  return feed;
}
