export interface ParticipationActivity {
  id: string;
  actorId?: string;
  actorName: string;
  kind: "vote" | "contribution" | "proposal";
  date: Date;
  proposalTitle: string;
  proposalSlug: string;
  /**
   * Stable identity for one recorded act, used to drop replay/backfill
   * duplicates. A vote is identified by its ballot and, where the storage
   * model keeps it, the member. Separate ballots stay separate rows.
   */
  dedupeKey?: string;
}

export type ParticipationFeedEntry = ParticipationActivity & {
  firstParticipation: boolean;
};

export interface ParticipationSummary {
  votes: number;
  contributions: number;
  proposals: number;
  firstTimeParticipants: number;
}

/**
 * Produce one feed row per recorded act, newest first, without collapsing
 * distinct votes on different ballots. Votes from encrypted ballot records have
 * no actor identity and keep their anonymised actor label.
 */
export function buildParticipationFeed(
  activities: ParticipationActivity[],
  firstParticipants: Set<string>,
): ParticipationFeedEntry[] {
  const seen = new Set<string>();
  const feed: ParticipationFeedEntry[] = [];
  const sorted = [...activities].sort(
    (a, b) => b.date.getTime() - a.date.getTime(),
  );
  for (const activity of sorted) {
    const key = activity.dedupeKey ?? activity.id;
    if (seen.has(key)) continue;
    seen.add(key);
    feed.push({
      ...activity,
      firstParticipation: Boolean(
        activity.actorId && firstParticipants.has(activity.actorId),
      ),
    });
  }
  return feed;
}

/** Counts for the summary strip. They are derived from the same rows as the tabs. */
export function summarizeParticipation(
  feed: ParticipationFeedEntry[],
): ParticipationSummary {
  return {
    votes: feed.filter((entry) => entry.kind === "vote").length,
    contributions: feed.filter((entry) => entry.kind === "contribution").length,
    proposals: feed.filter((entry) => entry.kind === "proposal").length,
    firstTimeParticipants: new Set(
      feed
        .filter((entry) => entry.firstParticipation && entry.actorId)
        .map((entry) => entry.actorId),
    ).size,
  };
}
