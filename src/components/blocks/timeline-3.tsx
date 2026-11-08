import { useMemo, useState } from "react";
import {
  CheckCircle2,
  FilePenLine,
  Gavel,
  Lightbulb,
  MessageCircle,
  Search,
  ThumbsUp,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import type {
  ActivityTimelineGroup,
  ActivityTimelineKind,
} from "@/lib/activity-timeline";
import { initialsOf } from "@/lib/activity-timeline";
import { Avatar, AvatarFallback } from "../ui/avatar";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const icons: Record<ActivityTimelineKind, LucideIcon> = {
  vote: CheckCircle2,
  contribution: MessageCircle,
  proposal: Lightbulb,
  amendment: FilePenLine,
  endorsement: ThumbsUp,
  member: UserPlus,
  governance: Gavel,
};

export interface ActivityTimelineProps {
  groups: ActivityTimelineGroup[];
  title?: string;
  description?: string;
  badge?: string;
  headingId?: string;
  filters?: Array<{ id: "all" | ActivityTimelineKind; label: string }>;
  searchable?: boolean;
  emptyMessage?: string;
}

export default function ActivityTimeline({
  groups,
  title,
  description,
  badge,
  headingId,
  filters,
  searchable = false,
  emptyMessage = "No activity to show yet.",
}: ActivityTimelineProps) {
  const [activeFilter, setActiveFilter] = useState<"all" | ActivityTimelineKind>(
    "all",
  );
  const [query, setQuery] = useState("");

  const allEvents = useMemo(
    () => groups.flatMap((group) => group.events),
    [groups],
  );
  const counts = useMemo(() => {
    const result: Record<string, number> = { all: allEvents.length };
    for (const event of allEvents) {
      result[event.kind] = (result[event.kind] ?? 0) + 1;
    }
    return result;
  }, [allEvents]);

  const visibleGroups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return groups
      .map((group) => ({
        ...group,
        events: group.events.filter((event) => {
          if (activeFilter !== "all" && event.kind !== activeFilter)
            return false;
          if (!needle) return true;
          const haystack = [
            event.actor,
            event.action,
            event.target,
            event.summary ?? "",
            ...(event.details ?? []).map((detail) => detail.label),
          ]
            .join(" ")
            .toLowerCase();
          return haystack.includes(needle);
        }),
      }))
      .filter((group) => group.events.length > 0);
  }, [groups, activeFilter, query]);

  const visibleCount = visibleGroups.reduce(
    (total, group) => total + group.events.length,
    0,
  );

  return (
    <div className="flex flex-col gap-5" data-timeline>
      {(title || description || badge) && (
        <div className="flex items-start justify-between gap-4">
          <div className="grid gap-1">
            {title && (
              <h2
                className="m-0 font-heading text-xl font-bold tracking-tight text-foreground"
                id={headingId}
              >
                {title}
              </h2>
            )}
            {description && (
              <p className="m-0 text-sm text-muted-foreground">{description}</p>
            )}
          </div>
          {badge && (
            <Badge className="shrink-0" variant="secondary">
              {badge}
            </Badge>
          )}
        </div>
      )}

      {(filters || searchable) && (
        <div className="flex flex-wrap items-center gap-2">
          {filters?.map((filter) => (
            <Button
              aria-pressed={activeFilter === filter.id}
              className="h-8 rounded-lg px-2.5 text-xs"
              key={filter.id}
              onClick={() => setActiveFilter(filter.id)}
              size="sm"
              type="button"
              variant={activeFilter === filter.id ? "secondary" : "ghost"}
            >
              {filter.label}
              <span className="tabular-nums text-muted-foreground">
                {counts[filter.id] ?? 0}
              </span>
            </Button>
          ))}
          {searchable && (
            <div className="relative w-full sm:ml-auto sm:w-64">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                aria-label="Filter activity by member or proposal"
                className="h-9 pl-8"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter member or proposal"
                value={query}
              />
            </div>
          )}
        </div>
      )}

      {visibleCount === 0 ? (
        <p className="m-0 text-sm text-muted-foreground">
          {query.trim() || activeFilter !== "all"
            ? "No activity matches this filter."
            : emptyMessage}
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {visibleGroups.map((group) => (
            <div className="flex flex-col gap-4" key={group.label}>
              <div className="flex items-center gap-3">
                <span aria-hidden="true" className="h-px flex-1 bg-border" />
                <span className="text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
                  {group.label}
                </span>
                <span aria-hidden="true" className="h-px flex-1 bg-border" />
              </div>

              <ol className="relative m-0 flex list-none flex-col gap-5 p-0">
                <span
                  aria-hidden="true"
                  className="absolute top-3 bottom-3 left-4 w-px bg-border"
                />
                {group.events.map((event) => {
                  const Icon = icons[event.kind];
                  return (
                    <li
                      className="relative flex items-start gap-3"
                      data-event-kind={event.kind}
                      key={event.id}
                    >
                      <span className="relative shrink-0">
                        <Avatar className="size-9 border border-border">
                          <AvatarFallback className="text-xs">
                            {initialsOf(event.actor)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full border border-border bg-card text-muted-foreground">
                          <Icon aria-hidden="true" className="size-2.5" />
                        </span>
                      </span>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <p className="m-0 text-sm text-muted-foreground">
                            <span className="font-medium text-foreground">
                              {event.actor}
                            </span>{" "}
                            {event.action}{" "}
                            {event.href ? (
                              <a
                                className="font-medium text-foreground underline-offset-2 hover:underline"
                                href={event.href}
                              >
                                {event.target}
                              </a>
                            ) : (
                              <span className="font-medium text-foreground">
                                {event.target}
                              </span>
                            )}
                          </p>
                          {event.badge && (
                            <Badge
                              className="text-[10px]"
                              variant="outline"
                            >
                              {event.badge}
                            </Badge>
                          )}
                        </div>

                        {event.details && event.details.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                            {event.details.map((detail) =>
                              detail.href ? (
                                <a
                                  className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                                  href={detail.href}
                                  key={`${event.id}-${detail.label}`}
                                >
                                  {detail.label}
                                </a>
                              ) : (
                                <span
                                  className="text-muted-foreground"
                                  key={`${event.id}-${detail.label}`}
                                >
                                  {detail.label}
                                </span>
                              ),
                            )}
                          </div>
                        )}

                        {event.summary && (
                          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                            {event.summary}
                          </p>
                        )}
                      </div>

                      <time
                        className="shrink-0 text-xs text-muted-foreground tabular-nums"
                        dateTime={event.dateIso}
                      >
                        {event.time}
                      </time>
                    </li>
                  );
                })}
              </ol>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
