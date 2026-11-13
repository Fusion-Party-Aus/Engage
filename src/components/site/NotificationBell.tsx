import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { Bell } from "lucide-react";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.tsx";
import { cn } from "../../lib/utils.ts";

interface NotificationItem {
  notificationId: string;
  title: string;
  body: string;
  href: string;
  readAt: string | null;
  createdAt: string;
}

const INBOX_HREF = "/member/?view=notifications";
const RECENT_LIMIT = 10;
const STALE_AFTER_MS = 60_000;

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return days === 1 ? "Yesterday" : `${days} days ago`;
  return date.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedAt = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const res = await fetch(`/api/notifications/inbox?limit=${RECENT_LIMIT}`, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new Error("Request failed");
      const data = await res.json();
      setItems(Array.isArray(data.notifications) ? data.notifications : []);
      loadedAt.current = Date.now();
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!open || loading || loadFailed) return;
    if (Date.now() - loadedAt.current < STALE_AFTER_MS) return;
    void load();
  }, [open, loading, loadFailed, load]);

  const unreadCount = items.filter((item) => !item.readAt).length;

  async function markAllRead() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/notifications/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "mark_all_read" }),
      });
      if (!res.ok) throw new Error("Request failed");
      const nowIso = new Date().toISOString();
      setItems((current) =>
        current.map((item) => (item.readAt ? item : { ...item, readAt: nowIso })),
      );
    } catch {
      setError("Couldn't mark these as read. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleItemClick(
    event: MouseEvent<HTMLAnchorElement>,
    item: NotificationItem,
  ) {
    if (item.readAt) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();

    const nowIso = new Date().toISOString();
    setItems((current) =>
      current.map((entry) =>
        entry.notificationId === item.notificationId
          ? { ...entry, readAt: nowIso }
          : entry,
      ),
    );

    try {
      const res = await fetch("/api/notifications/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "mark_read", notificationId: item.notificationId }),
      });
      if (!res.ok) throw new Error("Request failed");
    } catch {
      // Navigation still continues; the inbox reconciles unread state on next load.
    }

    window.location.assign(item.href || INBOX_HREF);
  }

  const triggerLabel =
    unreadCount > 0
      ? `Notifications, ${unreadCount} unread`
      : "Notifications";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="relative size-9 rounded-full"
          aria-label={triggerLabel}
          title="Notifications"
        >
          <Bell aria-hidden="true" />
          {unreadCount > 0 && (
            <Badge
              variant="secondary"
              aria-hidden="true"
              className="absolute -top-1.5 -right-1.5 h-4 min-w-4 px-1 text-[0.625rem] leading-none tabular"
            >
              {unreadCount > 9 ? "9+" : unreadCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" aria-label="Notifications" className="w-[min(23rem,calc(100vw-1.5rem))] p-0">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <p className="m-0 text-sm font-semibold">Notifications</p>
            {unreadCount > 0 && (
              <Badge variant="info">
                {unreadCount} new
              </Badge>
            )}
          </div>
          {unreadCount > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={markAllRead}
            >
              {busy ? "Marking…" : "Mark all read"}
            </Button>
          )}
        </div>

        {error && (
          <p role="alert" className="m-0 px-4 py-2 text-xs text-destructive-foreground">
            {error}
          </p>
        )}

        <div className="max-h-[24rem] overflow-y-auto">
          {loading && items.length === 0 ? (
            <p className="m-0 px-4 py-6 text-sm text-muted-foreground">Loading…</p>
          ) : loadFailed ? (
            <div className="grid gap-3 px-4 py-6">
              <p className="m-0 text-sm text-muted-foreground">
                Couldn't load notifications.
              </p>
              <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => void load()}>
                Try again
              </Button>
            </div>
          ) : items.length === 0 ? (
            <p className="m-0 px-4 py-6 text-sm text-muted-foreground">
              You're up to date.
            </p>
          ) : (
            <ul className="m-0 grid list-none divide-y divide-border p-0">
              {items.map((item) => (
                <li key={item.notificationId}>
                  <a
                    href={item.href || INBOX_HREF}
                    onClick={(event) => void handleItemClick(event, item)}
                    className={cn(
                      "flex gap-3 px-4 py-3 no-underline transition-colors hover:bg-accent",
                      "focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:ring-inset",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "mt-1.5 size-2 shrink-0 rounded-full",
                        item.readAt ? "bg-transparent" : "bg-secondary",
                      )}
                    />
                    <span className="grid min-w-0 gap-0.5">
                      <span
                        className={cn(
                          "text-sm text-foreground",
                          item.readAt ? "font-medium" : "font-semibold",
                        )}
                      >
                        {!item.readAt && <span className="sr-only">Unread: </span>}
                        {item.title}
                      </span>
                      <span className="text-xs text-muted-foreground">{item.body}</span>
                      <time className="text-xs text-muted-foreground" dateTime={item.createdAt}>
                        {formatWhen(item.createdAt)}
                      </time>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border-t border-border p-2">
          <Button href={INBOX_HREF} variant="ghost" size="sm" className="w-full">
            View all notifications
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
