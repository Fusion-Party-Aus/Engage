export type ActivityTimelineKind =
  | "vote"
  | "contribution"
  | "proposal"
  | "amendment"
  | "endorsement"
  | "member"
  | "governance";

export interface ActivityTimelineEvent {
  id: string;
  date: Date;
  actor: string;
  action: string;
  target: string;
  href?: string;
  kind: ActivityTimelineKind;
  badge?: string;
  summary?: string;
  details?: Array<{ label: string; href?: string }>;
}

export interface ActivityTimelineEntry
  extends Omit<ActivityTimelineEvent, "date"> {
  dateIso: string;
  time: string;
}

export interface ActivityTimelineGroup {
  label: string;
  events: ActivityTimelineEntry[];
}

const TIME_ZONE = "Australia/Melbourne";

const dayKey = (date: Date) =>
  date.toLocaleDateString("en-CA", { timeZone: TIME_ZONE });

const dayLabel = (date: Date, now: Date) => {
  const key = dayKey(date);
  const todayKey = dayKey(now);
  if (key === todayKey) return "Today";
  const [year, month, day] = todayKey.split("-").map(Number);
  const yesterdayKey = new Date(Date.UTC(year!, month! - 1, day! - 1))
    .toISOString()
    .slice(0, 10);
  if (key === yesterdayKey) return "Yesterday";
  return date.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: TIME_ZONE,
  });
};

const timeLabel = (date: Date, now: Date) => {
  const diff = now.getTime() - date.getTime();
  if (dayKey(date) === dayKey(now) && diff >= 0) {
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hr ago`;
  }
  return date.toLocaleTimeString("en-AU", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: TIME_ZONE,
  });
};

/** Group activity into a newest-first timeline, grouped by Melbourne day. */
export function buildActivityTimeline(
  events: ActivityTimelineEvent[],
  now: Date = new Date(),
): ActivityTimelineGroup[] {
  const sorted = [...events].sort(
    (left, right) => right.date.getTime() - left.date.getTime(),
  );
  const groups = new Map<string, ActivityTimelineGroup>();
  for (const event of sorted) {
    const label = dayLabel(event.date, now);
    const group =
      groups.get(label) ?? ({ label, events: [] } as ActivityTimelineGroup);
    group.events.push({
      ...event,
      dateIso: event.date.toISOString(),
      time: timeLabel(event.date, now),
    });
    groups.set(label, group);
  }
  return [...groups.values()];
}

export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}
