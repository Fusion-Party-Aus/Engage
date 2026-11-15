import { it } from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");

it("the signed-in header no longer ships a React notification island", async () => {
  const header = await read("src/components/site/SiteHeader.astro");

  assert.doesNotMatch(header, /NotificationBell/);
  assert.doesNotMatch(header, /client:(idle|load|visible|only)/);
  assert.doesNotMatch(header, /\.tsx/);
  assert.doesNotMatch(header, /astro-island/);
  await assert.rejects(
    access(new URL("src/components/site/NotificationBell.tsx", root)),
    "NotificationBell.tsx should be removed",
  );
});

it("the notification panel is a native disclosure with a no-JavaScript link", async () => {
  const header = await read("src/components/site/SiteHeader.astro");

  assert.match(header, /<details class="site-notifications" data-notifications>/);
  assert.match(header, /<summary[\s\S]*?data-notifications-summary/);
  assert.match(
    header,
    /href="\/member\/\?view=notifications"[\s\S]*?data-notifications-link/,
    "the bell must link to the notification centre without JavaScript",
  );
  assert.match(header, /data-notifications-empty[^>]*>No notifications yet</);
  assert.match(header, /Couldn't load notifications\./);
  assert.match(header, /View all notifications/);
  assert.match(header, /data-notifications-retry/);
});

it("the inbox is fetched lazily and once per page without caching", async () => {
  const header = await read("src/components/site/SiteHeader.astro");

  assert.match(header, /const RECENT_LIMIT = 5;/);
  assert.match(header, /fetch\(`\/api\/notifications\/inbox\?limit=\$\{RECENT_LIMIT\}`/);
  assert.match(header, /cache: 'no-store'/);
  assert.match(header, /addEventListener\('toggle'/);
  assert.match(header, /requestIdleCallback/);

  // One network call, made from load(), which is only scheduled on open or idle.
  assert.equal((header.match(/fetch\(/g) ?? []).length, 1);
  assert.equal((header.match(/void load\(\)/g) ?? []).length, 4);
  assert.match(header, /if \(started\) return;/);

  // Nothing is fetched while rendering the header on the server.
  const template = header.slice(0, header.indexOf("<header"));
  assert.doesNotMatch(template, /notifications\/inbox/);
  assert.doesNotMatch(template, /fetch\(/);
});

it("the panel closes on Escape, restores summary focus and closes on outside clicks", async () => {
  const header = await read("src/components/site/SiteHeader.astro");

  assert.match(header, /event\.key !== 'Escape'/);
  assert.match(header, /closeNotifications\(\)/);
  assert.match(header, /\[data-notifications-summary\]'\)\?\.focus\(\)/);
  assert.match(header, /notifications\?\.open && !notifications\.contains\(target\)/);
});
