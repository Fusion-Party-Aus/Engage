import type { MemberCatchUpGroup } from "./member-activity.ts";

/**
 * My Engage updates are dismissed explicitly, never by viewing the page.
 *
 * `engage_member_last_seen` is the cursor for updates the member has already
 * marked as seen. Rendering the page only reads it. The dismiss action writes
 * it to the dismissal time. A member who has never dismissed updates sees the
 * seven-day fallback window.
 */
export const MEMBER_CATCHUP_COOKIE = "engage_member_last_seen";
export const CATCHUP_FALLBACK_DAYS = 7;
export const CATCHUP_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;

export interface CatchUpWindow {
  /** Start of the window shown as unread updates. */
  since: Date;
  /** Whether a dismissal cursor exists (false means the seven-day fallback). */
  hasCursor: boolean;
}

/**
 * Resolve the unread-updates window from the dismissal cursor. This function
 * never writes the cursor: navigating away and back keeps the same window.
 */
export function resolveCatchUpWindow(
  rawCursor: string | null | undefined,
  now: Date,
  fallbackDays = CATCHUP_FALLBACK_DAYS,
): CatchUpWindow {
  const parsed = rawCursor ? new Date(rawCursor) : null;
  if (parsed && !Number.isNaN(parsed.getTime()) && parsed <= now) {
    return { since: parsed, hasCursor: true };
  }
  return {
    since: new Date(now.getTime() - fallbackDays * 24 * 60 * 60 * 1000),
    hasCursor: false,
  };
}

/** Keep the updates that fall inside the window, using one rule for the list and counts. */
export function filterCatchUpGroups(
  groups: MemberCatchUpGroup[],
  since: Date,
): MemberCatchUpGroup[] {
  return groups
    .map((group) => {
      const items = group.items.filter((item) => item.date >= since);
      return items.length
        ? { ...group, items, lastDate: items[0]!.date }
        : null;
    })
    .filter((group): group is MemberCatchUpGroup => Boolean(group));
}

/** Total unread updates. The tab badge and the list use this same figure. */
export function countCatchUpItems(groups: MemberCatchUpGroup[]): number {
  return groups.reduce((total, group) => total + group.items.length, 0);
}

export function catchUpSinceLabel(window: CatchUpWindow): string {
  return window.hasCursor
    ? `Since ${window.since.toLocaleDateString("en-AU", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })}.`
    : "Showing updates from the last seven days.";
}

/** Cookie attributes for the dismissal cursor. */
export function catchUpCookieOptions(secure: boolean) {
  return {
    path: "/member",
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    maxAge: CATCHUP_COOKIE_MAX_AGE_SECONDS,
  };
}

/** Only My Engage may be used as the post-dismissal destination. */
export function safeCatchUpReturn(raw: string | null | undefined): string {
  const fallback = "/member/";
  if (!raw || !raw.startsWith("/") || /[\\\u0000-\u0020]/.test(raw)) {
    return fallback;
  }
  try {
    const url = new URL(raw, "https://engage.invalid");
    if (url.origin !== "https://engage.invalid") return fallback;
    if (url.pathname !== "/member" && !url.pathname.startsWith("/member/")) {
      return fallback;
    }
    if (/^\/api(?:\/|$)/i.test(decodeURIComponent(url.pathname))) {
      return fallback;
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return fallback;
  }
}
