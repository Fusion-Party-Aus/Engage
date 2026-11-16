# Rendering performance audit — RFC 0001 Phase 2

**Status:** Current · **Measured:** 14 November 2026; register follow-up measured 15 November 2026; header follow-up measured 15 November 2026; public-list follow-up measured 16 November 2026
**Branch:** merged into `feat/rfc0001-sprint1-integration` (PR #51) · **Baseline commit:** `1bd4fd1` · **Measured after commit:** `b25e385`
**Harness:** [`scripts/rendering-performance.mjs`](../../scripts/rendering-performance.mjs)
**Data:** [`rendering-performance-baseline.json`](rendering-performance-baseline.json) · [`rendering-performance-after.json`](rendering-performance-after.json) · register follow-up: [`rendering-performance-register-before.json`](rendering-performance-register-before.json) · [`rendering-performance-register-after.json`](rendering-performance-register-after.json) · header follow-up: [`rendering-performance-header-before.json`](rendering-performance-header-before.json) · [`rendering-performance-header-after.json`](rendering-performance-header-after.json) · public-list follow-up: [`rendering-performance-public-before.json`](rendering-performance-public-before.json) · [`rendering-performance-public-after.json`](rendering-performance-public-after.json) · [`rendering-performance-public-before-proposals.json`](rendering-performance-public-before-proposals.json) · [`rendering-performance-public-after-proposals.json`](rendering-performance-public-after-proposals.json)

This audit measures the server render cost and client experience of representative public, member and administrator pages, then removes duplicated and render-blocking work that does not affect governance authority. Local measurements are **indicative, not production SLA evidence**. See [Limitations](#limitations).

Naming note: the RFC tracker calls the command layer and route policy work "Phase 2" (S1). This document covers the Phase 2 **rendering-performance** workstream only. It does not start the command-layer refactor.

## Method

- A production build (`dist/server/entry.mjs`) runs in `APP_MODE=development` against a disposable MongoDB database, created and dropped per harness run.
- Synthetic data is seeded into the disposable database: 78 baseline proposals, 1,200 synthetic votes, 600 synthetic comments and 10 bound open ballots. No production data is read.
- Identities are the development cookies only: anonymous, `engage_dev_user=member`, `engage_dev_user=administrator`.
- Driver command monitoring is opt-in (`ENGAGE_DB_COMMAND_MONITOR=1`, ignored in production) and exposed only through `/api/dev/render-metrics`.
- Each page is measured in two phases:
  - **Document phase** — a plain HTTP request with no JavaScript. Captures HTML bytes, server duration and database commands/time for the initial server response only.
  - **Browser phase** — Playwright at 1440×1000. Captures TTFB, LCP, CLS, long-task time, transferred JS/CSS/font bytes, request failures, console errors, total page database work (including deferred islands), and a click-to-next-paint proxy on the proposal ballot.
- Values below are medians of three runs after a warm-up pass. `npm run build` must precede a run.

## Measured result

| Page (identity) | TTFB ms | HTML KB | JS KB | LCP ms | DB commands | DB time ms |
|---|---|---|---|---|---|---|
| `/` (anonymous) | 26.4 → 22.2 | 50.7 → 50.7 | 15.4 → 15.4 | 96 → 100 | 7 → 7 | 18.7 → 20.8 |
| `/` (member) | 49.9 → 24.1 | 64.7 → 64.9 | 336.8 → 336.8 | 116 → 92 | 27 → **14** | 99.8 → **25.7** |
| `/proposals/` (anonymous) | 32.0 → 30.0 | 89.4 → 89.4 | 15.4 → 15.4 | 92 → 92 | 7 → 7 | 19.2 → 21.5 |
| `/proposals/` (member) | 39.9 → 33.6 | 99.8 → 99.9 | 336.8 → 336.8 | 108 → 64 | 22 → **15** | 29.8 → 28.4 |
| `/proposals/[slug]/` (anonymous) | 17.6 → 18.8 | 96.6 → 96.8 | 322.1 → 322.1 | 92 → 96 | 8 → 8 | 20.0 → 18.4 |
| `/proposals/[slug]/` (member) | 47.7 → 31.9 | 119.1 → 119.3 | 386.9 → 386.9 | 124 → 112 | 27 → **16** | 62.0 → **35.8** |
| `/policies/` (anonymous) | 5.9 → 6.7 | 38.8 → 38.8 | 15.4 → 15.4 | 68 → 68 | 3 → 3 | 6.3 → 7.1 |
| `/member/` (member) | 72.1 → 48.7 | 154.7 → 155.3 | 462.4 → 451.0 | 112 → 128 | 46 → **34** | 235.4 → **68.8** |
| `/admin/` (administrator) | 77.9 → 30.3 | 153.5 → 87.4 | 347.1 → 347.1 | 136 → 76 | 39 → **19** | 65.3 → **33.3** |
| `/admin/proposals/` (administrator) | 137.4 → 95.1 | 1048.2 → 1048.4 | 345.0 → 345.0 | 232 → 164 | 60 → **15** | 71.2 → **27.3** |

**Totals for the ten measured page/identity combinations:** 246 → 138 document DB commands (−44%); 628 ms → 287 ms document DB time (−54%).

Reading the table:

- The signed-in pages improve most because they previously resolved the same session in the layout and again in the page.
- `/admin/` drops 43% of HTML because the recent-participation panel is now a server island with a stable fallback.
- `/admin/proposals/` drops 75% of document database commands because the register read, unbound-revision read and amendment-revision read are batched instead of repeated per row. Its HTML was still ~1 MB at this point; a later slice paginated the register and removed its vote read (see [Register pagination and the tally-free list read](#register-pagination-and-the-tally-free-list-read-15-november-2026)).
- Small increases on anonymous pages (for example `/policies/` TTFB 5.9 → 6.7 ms) are noise at this scale, not a regression caused by a code path on those pages.
- LCP in this local setup is dominated by local asset delivery and is close to noise. It is reported for completeness, not as evidence of a field improvement.

## Page-by-page data classification

**(a) required for a meaningful initial render** · **(b) safe after the first response** · **(c) interaction-only**

| Page | Required in the initial response | Deferred or secondary | Interaction-only |
|---|---|---|---|
| `/` | Session identity; visible proposal summaries and stage counts; open ballots for the signed-in member; next-action CTA; site configuration | Proposal highlights are derived from the same list; branch activity counts; prefetch hints | Infinite-scroll/filter behaviour does not exist here; service-worker registration; native notification disclosure (fetches after idle or on first open) |
| `/proposals/` | Visible proposal summaries for the requested page; stage counts; active filters; member vote/outstanding state; branch names | Secondary sort metrics; pagination beyond the current page | Nothing beyond navigation; member focus cookie is written server-side |
| `/proposals/[slug]/` | Proposal wording, stage, bound revision, tally, the member's own vote/eligibility, ballot-open state, comments and amendment rows | Related proposals; full revision history; activity chain; evidence map; next-ballot recommendation | Ballot selection/submission; stance selector; comment composer |
| `/policies/` | Published/withdrawn/superseded registry rows, filters, branch names | None; no session data | Search/filter submit (normal GET) |
| `/member/` | Identity and verification status; immediate next action; eligible outstanding ballots; branch membership summary | Participation log; catch-up digest; governance change log; notification/push preferences; passkey count; authored-idea list | Settings forms; branch follow/leave; passkey enrolment/removal |
| `/admin/` | Authority check; attention queue; lifecycle counts; ballot progress; policy registry summary | **Recent member participation** (server island); activity timeline filtering | Timeline search/filter; sidebar collapse |
| `/admin/proposals/` | Authority check; the requested register page, stage counts and filters; certified tallies for rows with a recorded result; the editor only when `edit`/`revise`/`new` is requested | Later pages; amendment history and resolution forms; unbound-revision choices | Quick stage/ballot controls; ballot binding; outcome recording and the live ballot tally (workspace) |

Governance-critical data was **not** deferred: eligibility, voting authority, ballot binding, tally, the member's own vote, authorisation decisions and archived/private visibility all remain in the initial server response.

## What changed

### Session resolution

`getSessionUser` is still re-resolved on every HTTP request so role revocation is immediate. Within one request it now caches the in-flight promise against the `Request` object. A page and its layouts no longer perform the same Better Auth/session/branch/permission reads two or three times.

### List reads

- `listProposals` never returns `detailHtml` on list pages and can omit `details` where the page does not search on it (`includeDetails: false`). Visibility rules are unchanged and covered by a regression test.
- `/` no longer calls `listProposals` twice through `listOutstandingDecisions`; it passes the list it already loaded.
- `/proposals/` resolves member votes once and shares the promise with the outstanding-ballot calculation.
- `listOutstandingDecisions` can query only `stage: "decide"` with a projection when no list was supplied, instead of reading the whole proposal collection. It still applies `canViewProposal`.
- `/member/` loads the five shared participation sources once and passes them to both the activity stream and the catch-up digest. `listUserActivity` reuses the proposal list already loaded.

### Proposal detail

Supersede lookup, eligibility, related branches and contribution evidence now run in parallel with the existing detail batch instead of in two extra sequential waves. Only amendment-revision history remains a dependent follow-up read.

### Administrator overview and register

- The recent-participation panel is a `server:defer` island (`src/components/admin/ParticipationPanel.astro`) with a stable fallback card. It re-checks the session and `canViewIdentifiableBallots` inside the island; it does not trust client props for authority. Its own queries no longer block the dashboard response.
- The proposals register reads the proposal collection once. Search and stage filtering are applied in the page with the same semantics as `listProposals`. Amendment revisions are fetched with one `$in` query instead of one query per amendment; unbound-revision choices are fetched with one `$in` query instead of one query per proposal.
- The branches query now runs in parallel with the register read.

### Client hydration

| Island | Before | After | Why |
|---|---|---|---|
| `ProposalBallot` | `client:load` | `client:idle` | Voting is primary, but hydration need not block first paint. Idle hydration starts immediately after load and the SSR markup remains readable. |
| `StanceSelector` | `client:load` | `client:idle` | Composer control well below the fold; no critical-path interaction. |
| `NotificationBell` | `client:load` | `client:idle` | Secondary header control; still fetches unread state after load. |
| Header notifications | `client:idle` React island | Native `<details>` + vanilla module | Removed the React runtime from signed-in pages whose only island was the bell. See [Header notifications without React](#header-notifications-without-react-15-november-2026). |
| Member onboarding/settings/branch/activity islands | `client:load` | `client:visible` | Most render inside inactive CSS-selected views or below the fold. Active views hydrate on intersection; inactive views do not fetch their chunks. |
| Admin activity timelines | `client:load` | `client:visible` | Secondary panels/tabs. |
| Admin migrations | `client:load` | `client:idle` | Operational page, not a dashboard first-paint dependency. |
| Notification preferences centre | `client:load` | `client:idle` | Not required for the page's initial readable state. |

## Bundle findings

- Anonymous public pages load **15.4 KB** of JavaScript (baseline and after).
- Before the header follow-up, any signed-in page loaded React because `NotificationBell` was a React island: **337 KB** on home/proposals, **345–347 KB** in admin, **451–462 KB** on `/member/`. That was the single largest client cost in the audit and was not reduced by moving hydration to idle.
- After the header follow-up, signed-in `/`, `/proposals/`, `/policies/` and `/admin/proposals/` load **15.4–27 KB** and no React runtime at all. `/member/` (426 KB), `/admin/` (288 KB) and `/proposals/[slug]/` (332 KB) still ship React for their own islands but no longer pay for the header bell.
- `/proposals/[slug]/` loads **322 KB anonymous / 332 KB member** because the ballot and stance islands require React.
- `client:visible` on inactive member views reduced `/member/` transferred JS by about 11 KB and avoids hydration work for those panels.
- No new dependencies and no new client-side framework were added. The header panel is a native disclosure and one bundled vanilla module.

## Queries removed or deferred

Document-phase database commands per page (before → after):

| Page | Before | After | Main cause |
|---|---|---|---|
| `/` member | 27 | 14 | Session reuse; duplicate `listProposals` removed; vote read reused |
| `/proposals/` member | 22 | 15 | Session reuse; duplicate member-vote read removed |
| `/proposals/[slug]/` member | 27 | 16 | Session reuse; parallel reads; projected decide-only read |
| `/member/` | 46 | 34 | Session reuse; duplicated activity sources and proposal read removed |
| `/admin/` | 39 | 19 | Session reuse; participation panel deferred to a server island |
| `/admin/proposals/` | 60 | 15 | Session reuse; duplicate list read removed; per-row reads batched |

The server island's own commands still run, just after the document response. They are excluded from the document-phase count and included in the browser-phase total.

## Store/query-shape changes for the architecture workstream

These are narrow changes to `src/lib/store.ts` and `src/lib/member-activity.ts`. Rebase the command-layer/read-model work against them:

1. `listProposals(..., { includeDetails?: boolean })` — defaults to including `details`; always excludes `detailHtml` from list reads.
2. `listOutstandingDecisions(..., availableProposals?, memberVotes?)` — `memberVotes` accepts a value or an in-flight promise; when no proposals are supplied it reads only `stage: "decide"` with a projection and applies `canViewProposal`.
3. `listUserActivity(db, memberId, availableProposals?)` — optional preloaded proposal summaries.
4. `loadMemberActivityInputs(db, memberId)` plus optional `inputs` arguments on `listMemberActivityStream` and `buildMemberCatchUp`.

These changes do not implement S1 (command layer), S2/S4 (read models) or I12's full pagination/tally projection. They reduce duplicate reads inside the current shape.

## Register pagination and the tally-free list read (15 November 2026)

`/admin/proposals/` was the largest document in this audit: it rendered every
proposal, including its rationale, and decrypted every vote so the Decide rows
could show live tallies. A follow-up slice closed the two remaining register
opportunities from the first pass.

**Method.** Same harness and synthetic data, `--filter admin-proposals --runs 3`.
The before snapshot is the branch point `78c07c0`; the after snapshot records
`c1f72c0` in its `git` block. Snapshots:
[before](rendering-performance-register-before.json) ·
[after](rendering-performance-register-after.json).

| Metric | Before | After | Change |
|---|---|---|---|
| HTML bytes | 938,422 | 283,915 | −70% |
| Document DB commands | 19 | 16 | −16% |
| Document DB time | 28.7 ms | 15.0 ms | −48% |
| Document duration | 171.0 ms | 58.7 ms | −66% |
| TTFB | 103.1 ms | 56.1 ms | |
| LCP | 196 ms | 136 ms | |
| Transferred JS | 354.7 KB | 353.2 KB | unchanged |
| Browser-phase DB commands | 26 | 23 | −12% |

Reading the numbers:

- The page now sends 25 rows instead of all 78. The HTML fall is almost entirely
  rows and their inline management forms, not a change to the shell or styles.
- Database commands fall less than HTML because the page still resolves the
  session, branches, counts, one page of rows, page comment counts, certified
  results, ballot closures, page amendments and page revisions. The multi-batch
  vote cursor is gone: `getMore` batches fell from 4 to 1 (`find` 14 → 13).
- JS is unchanged. The ~353 KB is the shared React runtime pulled in by the
  header notification bell, not the register (opportunity 1 below).
- LCP in this local setup is dominated by local asset delivery; treat the
  difference as noise, as with the rest of this audit. Repeat runs of the same
  build measured 15.0–16.2 ms of document DB time and 56–61 ms TTFB, so read the
  deltas as direction, not precision.

**Profiler evidence for the vote read.** MongoDB profiling (`profile: 2`) around
the two reads on the same seeded database, with 1,200 synthetic votes:

| Read | Collections touched |
|---|---|
| The register request | `proposals` (2 queries + 1 count), `comments` (+1 `getMore`), `ballot_results`, `ballots`, `amendments`, `proposal_revisions`, `branches`, `rbac_assignments`, `rbac_roles`, `branch_memberships`, `branch_subscriptions`, `site_settings`. **No `proposal_votes`.** |
| The previous register read (`listProposals`) | `proposals`, `comments`, `proposal_votes` (1 query + 2 `getMore`) |

The unit suite also proves this without a database: a spy around the collection
factory asserts that `listProposalRegister` never asks for `proposal_votes` and
that both proposal reads exclude `details` and `detailHtml`
(`src/lib/proposal-register.test.ts`). Profiling is a local indication, not
production evidence.

**What the register shows now**

- **Certified ballot:** the tally, computed result, recorded result and rule
  basis stored on `ballot_results` at certification. An officer override is
  labelled with its written reason.
- **Open, uncertified ballot:** "Open — view ballot" with no vote numbers.
- **Closed, uncertified ballot:** "Closed — record outcome", linking to the
  workspace.
- **No ballot:** "No ballot yet" or "No certified ballot", plus the row's
  deliberation stance count.
- **Pagination:** 25 rows per page, previous/next, the current page and a status
  region announcing "Showing 1–25 of 78 proposals. Page 1 of 4." Filters stay in
  the pagination links and reset to page 1 when changed. Invalid or
  out-of-range pages clamp to the first or last page.

**Trade-offs and deliberate limits**

- Inline outcome recording was removed from the register. The workspace keeps
  the live bound tally and the only result form. Recording from the list would
  require decrypting every ballot on a list read, which is the cost this slice
  removes.
- "Open amendments" now counts the viewer's whole register rather than the
  filtered subset, so it does not change while paging. That matches the label's
  intent ("Across active records").
- Search now runs in MongoDB. It still covers the identifier, title, topic
  space, summary and rationale; rationale is matched in the query and never
  returned.
- Editing and revising load their one full record on demand, including
  rationale, with the same branch scope and integrity lock as before. The
  editor's vote count is a count query for that single proposal, not a
  decryption.

## Header notifications without React (15 November 2026)

The signed-in header rendered `NotificationBell`, a React island hydrated with
`client:idle`. It fetched the member's unread count and a short inbox after
load, which put the React runtime (~329 KB) on every signed-in page for one
small bell. This slice replaces it with a native `<details>` disclosure and a
small bundled vanilla module, without moving the inbox read into the document
response.

**Method.** The full harness with synthetic data and three runs per
page/identity before and after. The before snapshot records `b9286f4`; the after
snapshot records `ad34a17`. Snapshots:
[before](rendering-performance-header-before.json) ·
[after](rendering-performance-header-after.json).

| Page (identity) | JS KB | LCP ms | HTML KB | Script requests | Document DB commands |
|---|---|---|---|---|---|
| `/` (member) | 344.9 → **15.7** | 120 → 104 | 66.5 → 66.9 | 20 → **4** | 14 → 14 |
| `/proposals/` (member) | 344.9 → **15.7** | 312 → 108 | 102.3 → 102.7 | 20 → **4** | 15 → 15 |
| `/admin/proposals/` (administrator) | 356.9 → **27.7** | 148 → 144 | 284.4 → 284.7 | 22 → **6** | 17 → 17 |
| `/admin/` (administrator) | 355.4 → 288.0 | 88 → 84 | 90.0 → 90.4 | 27 → 21 | 19 → 19 |
| `/member/` (member) | 462.2 → 425.7 | 100 → 128 | 158.9 → 164.6 | 42 → 40 | 34 → 34 |
| `/proposals/[slug]/` (member) | 396.7 → 332.4 | 72 → 156 | 122.7 → 128.4 | 33 → 29 | 16 → 16 |
| `/policies/` (anonymous control) | 15.7 → 15.7 | 76 → 76 | 33.2 → 36.7 | 4 → 4 | 3 → 3 |

Reading the numbers:

- The measured signed-in pages whose only island was the bell (`/`,
  `/proposals/`, `/admin/proposals/`) lose the React runtime entirely: −95%,
  −95% and −92% transferred JavaScript. `/policies/` was checked separately in
  the signed-in browser comparison (344,862 → 15,728 bytes, 20 → 4 script
  requests, one `NotificationBell` island → none).
- `/member/`, `/admin/` and `/proposals/[slug]/` keep React for their own
  settings, timeline and ballot islands, but drop the header's chunk (−8%,
  −19% and −16%).
- Document database commands are identical everywhere, and the browser-phase
  count is unchanged too. The inbox is fetched client-side exactly as before;
  it is not read during the server render. The header does not add a database
  read to any page.
- LCP and TTFB are noise-dominated in this setup. The before run hit a loaded
  machine (proposals TTFB 275 ms; anonymous control pages moved by 20–100 ms
  without any code change), and the after run moved LCP in both directions on
  pages this change does not touch. The deterministic result is JavaScript
  bytes, script request count and island count, not an LCP claim.
- Signed-in HTML got slightly smaller because the old SSR'd island markup
  (props, wrapper and popover markup) was larger than the new panel. Anonymous
  HTML grew by ~3.4 KB because Astro inlines the shared header module script
  under the CSP hash policy: 507 → 3,741 bytes. There is no extra request and no
  change to anonymous JavaScript transfer.

**Panel behaviour**

- The summary is the bell. Its accessible name is `Notifications` and becomes
  `Notifications, N unread` once the count is known. It is keyboard operable,
  keeps the Horizon focus ring, and carries the unread count as a badge.
- The panel is read-only: it shows the latest five notifications with title,
  relative time and link, plus "View all notifications" to
  `/member/?view=notifications`. Empty (`No notifications yet`) and error
  (`Couldn't load notifications.` with a retry) states are explicit.
- The inbox is fetched with `cache: "no-store"` only after idle or on first open,
  once per page, and the same request serves the unread badge. There is no
  polling.
- Escape closes the panel and returns focus to the summary; outside clicks close
  it; the mobile navigation menu and the notification panel are mutually
  exclusive.
- Without JavaScript the summary's anchor opens the notification centre
  directly. With JavaScript the anchor's `href` is removed so the summary is the
  single disclosure control rather than a duplicate tab stop.
- Marking notifications as read was removed from the header. That stays in the
  member notification centre, so opening the panel no longer posts mutations.
  Clicking a notification now navigates to its target without a mark-read
  request; the centre reconciles unread state on the next load.

## Public list pagination and the tally projection (16 November 2026)

`/` and `/proposals/` still scanned every vote and decrypted every encrypted
ballot to show approve/abstain/reject totals. `/proposals/` also loaded every
proposal and filtered/sorted it in the page. This slice removes both costs from
the public lists.

**Method.** Same harness and synthetic data (78 proposals, 1,200 plaintext
votes, 10 bound open ballots), five runs per page/identity. The before snapshot
records `57402f0`; the after snapshot records `65ace21`. Snapshots:
[home before](rendering-performance-public-before.json) ·
[home after](rendering-performance-public-after.json) ·
[proposals before](rendering-performance-public-before-proposals.json) ·
[proposals after](rendering-performance-public-after-proposals.json).

| Page (identity) | HTML KB | Document DB commands | Document DB time ms | getMore batches | TTFB ms | Transferred JS KB |
|---|---|---|---|---|---|---|
| `/` (anonymous) | 55.5 → 56.0 | 7 → **6** | 29.7 → **15.6** | 3 → **1** | 35.1 → 29.6 | 15.7 → 15.7 |
| `/` (member) | 66.9 → 66.7 | 14 → **13** | 32.5 → **24.2** | 3 → **1** | 40.0 → 34.9 | 15.7 → 15.7 |
| `/proposals/` (anonymous) | 94.9 → 128.7 | 7 → 7 | 18.0 → 19.2 | 3 → **1** | 34.5 → 34.3 | 15.7 → 15.7 |
| `/proposals/` (member) | 102.7 → 136.5 | 15 → 15 | 27.3 → **21.1** | 3 → **1** | 37.5 → 32.9 | 15.7 → 15.7 |

Reading these numbers honestly:

- **The HTML grew on `/proposals/` because the page now renders 25 rows instead
  of 15.** The task specified 25 per page, so this is not a like-for-like row
  count. The added ~34 KB is ten rows at roughly 3.4 KB each; the shell, filters
  and pagination are unchanged. On `/` (which still renders every visible
  summary) HTML is flat.
- **The vote cursor is gone.** `getMore` fell from three batches to one on every
  measured page. The remaining batch is the comment count read, not votes.
- **Document DB time is the deterministic part of the win on `/`** (−47%
  anonymous, −26% member). On `/proposals/` the command count is unchanged
  because the page now performs two bounded proposal reads (candidates for
  counts and ordering, then one display page) instead of one full read plus a
  1,200-vote scan; the saving is in the removed decryption and the bounded
  display read, which driver command counts cannot express.
- TTFB and LCP in this local setup move by 1–8 ms between runs on unchanged
  pages. Treat them as noise, as everywhere else in this audit.

**Profiler evidence on the same seeded database.** With MongoDB profiling on
and the profile cleared after startup, one anonymous request per page:

| Request | Collections touched | `proposal_votes` operations |
|---|---|---|
| `/proposals/` before (`57402f0`) | `proposals`, `comments`, `branches`, `proposal_votes` (1 find + 2 `getMore`) | **3** |
| `/proposals/` after | `proposals` ×2, `comments` ×2, `ballot_tallies`, `ballot_results`, `branches` | **0** |
| `/` before | `proposals` ×2, `comments` ×4, `branches`, `policy_registry`, `proposal_votes` (2 finds + 4 `getMore`) | **6** |
| `/` after | `proposals` ×3, `comments` ×4, `branches`, `policy_registry`, `ballot_tallies` ×2, `ballot_results` ×2 | **0** |

The unit suites prove the same without a database, and without trusting a
profiler window: `public-proposals.test.ts` wraps the collection factory and
asserts that the candidate read, the page build and the home overlay never ask
for `proposal_votes`; `ballot-tallies-mongo.test.ts` asserts it through the real
`listProposals` option. The display query also asks MongoDB to exclude `details`
and `detailHtml`; search still matches rationale in the query without returning
it.

**What the public list does now**

- `/proposals/` reads a bounded 25-row display page. Search, stage, branch and
  topic filters, ordering and range are computed before the page is loaded;
  invalid or out-of-range pages clamp; equal sort keys break by proposal id.
- A **certified** ballot shows the tally stored on `ballot_results`. Otherwise a
  fresh `ballot_tallies` row is shown. A missing row, or one older than ten
  minutes, shows `Voting open — tally updating` (or `Voting closed — tally
  pending`) linked to the matter. No number is guessed and no vote is scanned.
- `/` overlays the same projection on the register it already reads. Matters
  without a trustworthy aggregate are omitted from the three highlight cards
  rather than showing a percentage from zero votes.
- Pagination keeps `q`, `stage`, `branch`, `space`, `sort`, `focus` and `joined`
  across pages; changing a filter submits without `page`. Each page
  self-references its canonical address and emits `rel="prev"`/`rel="next"`.
  The repository has no `noIndex` convention for parameterised lists, so none
  was invented; pages stay indexable with a self-canonical.
- The pagination controls use the existing `Button` primitive. Previous/next
  carry an accessible name, the current page is marked `aria-current="page"`,
  and the range is a `role="status"` live region.

**What the projection is, and why it cannot change a governance outcome**

`ballot_tallies` holds one document per `(ballotId, revisionId)` with `approve`,
`abstain`, `reject`, `total` and `updatedAt`. A unique compound index enforces
one row per ballot/revision. The row stores no member id, choice, reason,
envelope or blind index, so it cannot be joined back to a voter.

`castVote` applies the row **after** the vote transaction commits. The update is
best-effort: a failure, a write conflict or a write slower than 500 ms is logged
as an operational event (`ballot_tally_projection_failed`,
`ballot_tally_projection_conflict`, `ballot_tally_projection_timeout`) and the
vote still succeeds. The projection is not read by `recordFormalDecision`, which
continues to recompute the outcome from the votes bound to the ballot and
revision and refuses unbound or unreadable votes. Eligibility, ballot binding,
deadlines, the D9 comparison and D10 abstention treatment are untouched.

Writes are atomic and race-safe, because a read-then-write projection
double-counts under concurrent votes:

- **Normal votes are one upsert increment.** `approve`/`abstain`/`reject`/`total`
  are `$inc`ed and the row is created in the same operation, so two concurrent
  first votes cannot each create a row or lose one.
- **Vote changes move a count**, decrementing the previous choice and
  incrementing the new one; re-casting the same choice is a no-op.
- **A revision move is two transactional deltas** (old row −1, new row +1), so no
  row is ever half-moved.
- **Recounts are last-resort and guarded.** The only recount is for an unreadable
  prior vote and the repair CLI. It is compare-and-set on an internal `version`
  token, bounded by a watermark recorded in `appliedThrough`, and retries on a
  conflict. An increment for a vote the recount already counted is skipped, so
  the recount cannot be double counted either. At the write deadline the recount
  is abandoned rather than writing a stale absolute count, leaving the row for
  `npm run ballots:tally-projection`.
- **A row that is internally inconsistent** (negative, or a total that is not the
  sum of the choices) is never displayed; it reads as tally pending until
  repaired. This covers drift from a projection that was already missing.

Rows are revision-scoped, and encrypted votes are counted by the same decryption
path as certification. `npm run ballots:tally-projection` reports and rebuilds
rows; it never deletes, edits or rewrites a vote and never records a result.

An earlier revision of this slice used a read-then-write fallback whenever the
projection row was missing. The full suite exposed a double count under
concurrent votes, so that path was replaced by the atomic strategy above. The
race cases in `ballot-tallies-mongo.test.ts` reproduce the failure mode and
assert the row against the votes.

**Deliberate limits**

- The projection is eventually consistent. Within the ten-minute window it may
  lag a vote by one write; outside it the page says so instead of showing it. A
  stopped projection writer is therefore visible rather than silently wrong.
- Sorting by vote totals uses the displayed aggregate (certified, fresh
  projection, or zero while pending). A pending row can sort as zero.
- A ballot with no tally row yet shows `Voting open — tally updating` even when
  nobody has voted, because the page does not scan to prove a zero.
- The projection is not backfilled at startup. Run
  `npm run ballots:tally-projection -- --database <name> --apply` once after
  deployment if existing ballots should show counts immediately instead of the
  neutral state.
- A recount records the newest vote timestamp it actually counted. If a vote's
  transaction stamps an earlier `updatedAt` but commits after that recount, its
  increment can be skipped and the row under-counted. The normal increment path
  is unaffected and `npm run ballots:tally-projection` repairs the row; the
  alternative would be writing a stale absolute count, which is worse.
- The harness seeds votes directly and does not seed `ballot_tallies`, so its
  measured pages show the neutral state. That is deliberate: the harness
  measures the read path, and the browser check below seeds fresh, stale and
  certified rows explicitly.

## Deliberately left alone

- **Per-vote decryption on the proposal detail page.** `/proposals/[slug]/` still computes the live bound tally from the votes, because it is the surface that shows the ballot and its exact wording to a member. The public lists no longer do this; they read `ballot_tallies` and `ballot_results` instead (see the 16 November section).
- **Full-collection search semantics elsewhere.** `/proposals/` now searches in MongoDB because pagination requires it: the query covers the identifier, title, topic space, summary and rationale, and rationale is never returned. Other pages that need full-text semantics still load and match in the page.
- **Ballot authority, eligibility and tally.** All remain server-computed and in the initial response. The ballot island is still server-rendered; hydration timing changed only. The register shows certified tallies and the workspace keeps the live bound tally.
- **Per-request session freshness.** No session caching across requests. No member-specific page or API caching was added.
- **Remaining React islands.** `/member/`, `/admin/` and `/proposals/[slug]/` still use React for settings, timelines and the ballot. Their hydration timing was already tuned; replacing them is separate work.
- **No SPA, skeleton screen, CDN, ISR or client-side data grid** was introduced.

## Limitations

- Measurements come from one local machine, one Node process and a local single-node MongoDB, with no network latency, CDN, reverse proxy or production-like CPU limits.
- Data is synthetic: 78 proposals, 1,200 votes and 600 comments. Real distributions, encrypted ballots, large comment threads and attachment sizes will differ.
- Three runs per page/identity; medians are reported, but individual runs can vary. One earlier run showed an admin-proposals outlier (284 ms TTFB) that did not reproduce across five repeat runs (~91 ms). Treat small deltas as noise.
- LCP and the click-to-next-paint proxy are local indications, not field Core Web Vitals or field INP. INP is not available without real user monitoring.
- The harness runs without configured sign-in providers, so `/member/` reports a pre-existing `503` from `/api/auth/passkey/list-user-passkeys`. The same failure appears in the baseline and is a harness configuration limitation, not a rendering regression.
- The harness does not profile CPU, memory or database query plans. It counts driver commands and measures wall time.
- Server-island requests are asynchronous by design; the document-phase numbers intentionally exclude them.
- The register follow-up measures one page/identity pair on the same synthetic data. Its profiler window is a separate local run, not part of the harness output.
- The register's certified tally is only as complete as the stored `ballot_results` record. Legacy results recorded before tallies were stored show the outcome without counts.
- Authorisation and eligibility were not re-tested at scale; the register keeps the same branch scope and permission checks, covered by unit and browser checks rather than load testing.
- The header follow-up ran the full harness before and after on the same machine, but local load varied between the two invocations (the before run shows the higher TTFB). JavaScript bytes and script counts are deterministic; LCP and TTFB deltas are direction only. LCP moved on anonymous control pages the change does not affect.
- The header browser comparison used a scripted Playwright run against the before (`b9286f4`) and after (`ad34a17`) builds rather than the harness byte totals. It reports decoded body size for scripts, so its absolute KB values differ slightly from the harness transfer-size figures.
- The header panel was browser-tested with seeded notifications, intercepted empty and `500` responses, a no-JavaScript context and reduced motion. It was not exercised against a production-scale notification inbox or real push subscription state.
- The public-list follow-up's profiler window and before/after harness run used the harness's synthetic database (78 proposals, 1,200 plaintext votes). It establishes which collections are read, not a production CPU or I/O saving; encrypted ballots were exercised in the replica-set test, not the harness, which runs with `BALLOT_ENCRYPTION_MODE=off`.
- The public-list browser check seeded `ballot_tallies` directly rather than through votes, so it proves the display states, not the vote-to-projection write path (covered by `ballot-tallies-mongo.test.ts`).

## Top remaining opportunities, by expected value

1. **Defer more `/member/` secondary data.** Notification inbox, passkey count, push subscriptions and branch profile can move behind small endpoints or server islands so the member's next action and outstanding ballots render without waiting for preference data.
2. **Command layer and central route policy (S1).** A single request context would make session resolution, authorisation and query batching uniform rather than page-by-page.
3. **Live tally on the proposal detail page.** The detail page still decrypts the bound votes on every read. It is one ballot, so the cost is bounded, but it is the last public per-vote decryption path.

## Verification

- `npm run check` — 0 errors, 0 warnings (22 pre-existing hints at the time of the first pass; the public-list follow-up leaves 20 hints, none in the changed files).
- `npm test` with `VOTING_TEST_MONGODB_URI` — 306 tests passed for the first pass; the register follow-up runs the full suite at 532 tests, the header follow-up at 600 tests, and the public-list follow-up at 683 tests, 0 fail, run twice on the replica set (both runs 683/683). That includes `site-header-notifications.test.ts`, `proposal-register.test.ts`, `public-proposals.test.ts` (25-row pages, boundaries, invalid and out-of-range pages, filter preservation and reset, stable ordering, canonical and rel-link helpers, no `proposal_votes` access, fresh/stale/missing/inconsistent projection states, certified results from `ballot_results`, visibility narrowing, privacy) and `ballot-tallies.test.ts` / `ballot-tallies-mongo.test.ts` (delta arithmetic, same-choice re-cast, changed vote, many concurrent first votes, concurrent vote changes, concurrent revision moves, ten rebuild-versus-increment races, revision scoping, encrypted mode, a deadline that abandons a rebuild without writing, a corrupted projection not affecting certification, a failed projection write leaving the vote successful and logging, and the repair plan).
- Projection concurrency suite alone: `src/lib/ballot-tallies-mongo.test.ts` run 10 times, 11/11 tests passed each time.
- `npm run build` — production build succeeds.
- Harness run against the committed code; before/after JSON committed under `docs/status/`. The register follow-up ran `--filter admin-proposals --runs 3` against `78c07c0` (before) and `c1f72c0` (after). The header follow-up ran the full harness against `b9286f4` (before) and `ad34a17` (after). The public-list follow-up ran `--filter home` and `--filter "proposals /proposals/"` with five runs against `57402f0` (before) and `65ace21` (after), and ran the MongoDB profiler over one anonymous request per page on the same seeded database.
- Public-list follow-up browser verification at 1440×1000 and 390×844: 60 checks passed. Covered 25 rendered rows, the range status, self-referencing canonical with `rel="prev"`/`rel="next"` moving between pages, the active stage tab, filter preservation and reset to page 1, keyboard-only focus on the Next control with a visible ring, the fresh projection count, the stale `Voting open — tally updating` state linked to the matter, the certified tally from `ballot_results`, empty and out-of-range states, no horizontal overflow, and no console, page or 5xx errors. Run against a seeded database with one fresh, one stale and one certified tally; the remaining open ballots exercised the missing-row state.
- `npm run ballots:tally-projection` on a scratch database: dry run reported 7 scanned votes, 3 groups, 1 missing, 1 mismatch and 1 orphan row and exited 2; `--apply` wrote 2 rows and zeroed 1 orphan; `--verify` then exited 0 with `needsRepair=false`. A production apply without `--allow-production`/`--confirm-production engage_production` is refused before connecting.
- Header follow-up browser verification at 1440×1000 and 390×844: 42 checks passed. Covered seeded notifications (three items, two unread) rendering title and relative time, unread accessible name and badge, panel open/close, Escape restoring summary focus, outside-click close, keyboard-only reaching the summary with a visible 3 px focus ring and Enter opening the panel, intercepted empty and `500` states with a working retry, the panel fitting a 390 px viewport without horizontal overflow, no console/page errors or failed first-party requests, a JavaScript-disabled context where the bell navigates to the notification centre, and reduced-motion rendering.
- Header follow-up script comparison against both builds: `/`, `/proposals/` and `/policies/` served the `NotificationBell` island with 20 script requests before and no island with 4 script requests after; `/admin/proposals/` served no island after.
- Browser verification: `/admin/` server island replaces its fallback and its nested activity timeline hydrates on scroll with no console errors; the proposal ballot hydrates and responds to a click on desktop (member click-to-next-paint proxy 97 ms in the measured run).
- Raw-control audit on changed files: no new raw `<button>`, `<select>`, `<input>`, `<textarea>`, `<table>` or `<dialog>` elements. The notification list rows use plain anchors for navigation; the summary is a native `<details>/<summary>` disclosure; the retry and view-all controls use the existing `Button` primitive.
- No new arbitrary palette values or undefined Horizon custom properties were introduced.
