import { it } from "node:test";
import assert from "node:assert/strict";
import {
  catchUpCookieOptions,
  catchUpSinceLabel,
  countCatchUpItems,
  filterCatchUpGroups,
  MEMBER_CATCHUP_COOKIE,
  resolveCatchUpWindow,
  safeCatchUpReturn,
} from "./member-catchup.ts";
import type { MemberCatchUpGroup } from "./member-activity.ts";

const now = new Date("2026-11-16T09:00:00Z");
const daysAgo = (days: number) =>
  new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

const item = (id: string, date: Date) => ({
  id,
  date,
  kind: "discussion" as const,
  actor: "Alex Member",
  action: "commented on",
  target: "Housing",
});

const groups: MemberCatchUpGroup[] = [
  {
    proposalId: "p1",
    title: "Housing",
    href: "/proposals/housing/",
    lastDate: daysAgo(1),
    items: [item("a", daysAgo(1)), item("b", daysAgo(2)), item("c", daysAgo(10))],
  },
  {
    proposalId: "p2",
    title: "Transport",
    href: "/proposals/transport/",
    lastDate: daysAgo(3),
    items: [item("d", daysAgo(3))],
  },
];

it("shows the seven-day window on a first visit", () => {
  const window = resolveCatchUpWindow(undefined, now);
  assert.equal(window.hasCursor, false);
  assert.equal(window.since.toISOString(), daysAgo(7).toISOString());
  assert.equal(
    catchUpSinceLabel(window),
    "Showing updates from the last seven days.",
  );
  assert.equal(countCatchUpItems(filterCatchUpGroups(groups, window.since)), 3);
});

it("keeps unread updates across navigation", () => {
  const cursor = daysAgo(4).toISOString();
  const firstRender = resolveCatchUpWindow(cursor, now);
  const afterNavigatingAwayAndBack = resolveCatchUpWindow(cursor, now);
  assert.deepEqual(firstRender, afterNavigatingAwayAndBack);
  assert.equal(
    countCatchUpItems(filterCatchUpGroups(groups, firstRender.since)),
    3,
  );
});

it("does not clear other updates when one item is opened", () => {
  const window = resolveCatchUpWindow(daysAgo(4).toISOString(), now);
  const visible = filterCatchUpGroups(groups, window.since);
  // Opening /proposals/housing/ is a separate page view and does not write the
  // cursor, so every item inside the window stays visible.
  assert.deepEqual(
    visible.flatMap((group) => group.items.map((entry) => entry.id)),
    ["a", "b", "d"],
  );
  assert.equal(countCatchUpItems(visible), 3);
});

it("empties the list when updates are explicitly dismissed", () => {
  const window = resolveCatchUpWindow(now.toISOString(), now);
  assert.equal(window.hasCursor, true);
  const visible = filterCatchUpGroups(groups, window.since);
  assert.deepEqual(visible, []);
  assert.equal(countCatchUpItems(visible), 0);
});

it("falls back to seven days for invalid or future cursors", () => {
  for (const raw of ["not-a-date", "2027-01-01T00:00:00Z"]) {
    const window = resolveCatchUpWindow(raw, now);
    assert.equal(window.hasCursor, false);
    assert.equal(window.since.toISOString(), daysAgo(7).toISOString());
  }
});

it("keeps the tab count and the list on the same rule", () => {
  const window = resolveCatchUpWindow(daysAgo(2.5).toISOString(), now);
  const visible = filterCatchUpGroups(groups, window.since);
  const listCount = visible.reduce(
    (total, group) => total + group.items.length,
    0,
  );
  assert.equal(countCatchUpItems(visible), listCount);
  assert.equal(listCount, 2);
  assert.equal(visible[0]!.lastDate.toISOString(), daysAgo(1).toISOString());
});

it("only returns My Engage as the dismissal destination", () => {
  assert.equal(safeCatchUpReturn("/member/"), "/member/");
  assert.equal(
    safeCatchUpReturn("/member/?view=notifications"),
    "/member/?view=notifications",
  );
  for (const unsafe of [
    "https://evil.example/member/",
    "//evil.example/member/",
    "/admin/",
    "/api/member/updates/dismiss",
    "/member/\\@evil.example",
    "",
  ]) {
    assert.equal(safeCatchUpReturn(unsafe), "/member/");
  }
});

it("scopes the cursor cookie to My Engage", () => {
  assert.equal(MEMBER_CATCHUP_COOKIE, "engage_member_last_seen");
  const options = catchUpCookieOptions(true);
  assert.equal(options.path, "/member");
  assert.equal(options.httpOnly, true);
  assert.equal(options.sameSite, "lax");
  assert.equal(options.secure, true);
  assert.ok(options.maxAge > 0);
});
