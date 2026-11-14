# Rendering performance audit — RFC 0001 Phase 2

**Status:** Current · **Measured:** 14 November 2026
**Branch:** merged into `feat/rfc0001-sprint1-integration` (PR #51) · **Baseline commit:** `1bd4fd1` · **Measured after commit:** `b25e385`
**Harness:** [`scripts/rendering-performance.mjs`](../../scripts/rendering-performance.mjs)
**Data:** [`rendering-performance-baseline.json`](rendering-performance-baseline.json) · [`rendering-performance-after.json`](rendering-performance-after.json)

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
- `/admin/proposals/` drops 75% of document database commands because the register read, unbound-revision read and amendment-revision read are batched instead of repeated per row. Its HTML remains ~1 MB; pagination is the next opportunity.
- Small increases on anonymous pages (for example `/policies/` TTFB 5.9 → 6.7 ms) are noise at this scale, not a regression caused by a code path on those pages.
- LCP in this local setup is dominated by local asset delivery and is close to noise. It is reported for completeness, not as evidence of a field improvement.

## Page-by-page data classification

**(a) required for a meaningful initial render** · **(b) safe after the first response** · **(c) interaction-only**

| Page | Required in the initial response | Deferred or secondary | Interaction-only |
|---|---|---|---|
| `/` | Session identity; visible proposal summaries and stage counts; open ballots for the signed-in member; next-action CTA; site configuration | Proposal highlights are derived from the same list; branch activity counts; prefetch hints | Infinite-scroll/filter behaviour does not exist here; service-worker registration; notification bell |
| `/proposals/` | Visible proposal summaries for the requested page; stage counts; active filters; member vote/outstanding state; branch names | Secondary sort metrics; pagination beyond the current page | Nothing beyond navigation; member focus cookie is written server-side |
| `/proposals/[slug]/` | Proposal wording, stage, bound revision, tally, the member's own vote/eligibility, ballot-open state, comments and amendment rows | Related proposals; full revision history; activity chain; evidence map; next-ballot recommendation | Ballot selection/submission; stance selector; comment composer |
| `/policies/` | Published/withdrawn/superseded registry rows, filters, branch names | None; no session data | Search/filter submit (normal GET) |
| `/member/` | Identity and verification status; immediate next action; eligible outstanding ballots; branch membership summary | Participation log; catch-up digest; governance change log; notification/push preferences; passkey count; authored-idea list | Settings forms; branch follow/leave; passkey enrolment/removal |
| `/admin/` | Authority check; attention queue; lifecycle counts; ballot progress; policy registry summary | **Recent member participation** (server island); activity timeline filtering | Timeline search/filter; sidebar collapse |
| `/admin/proposals/` | Authority check; register rows, counts and filters; the editor only when `edit`/`revise`/`new` is requested | Amendment history and resolution forms; unbound-revision choices | Quick stage/ballot controls; ballot binding; outcome recording |

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
| Member onboarding/settings/branch/activity islands | `client:load` | `client:visible` | Most render inside inactive CSS-selected views or below the fold. Active views hydrate on intersection; inactive views do not fetch their chunks. |
| Admin activity timelines | `client:load` | `client:visible` | Secondary panels/tabs. |
| Admin migrations | `client:load` | `client:idle` | Operational page, not a dashboard first-paint dependency. |
| Notification preferences centre | `client:load` | `client:idle` | Not required for the page's initial readable state. |

## Bundle findings

- Anonymous public pages load **15.4 KB** of JavaScript (baseline and after).
- Any signed-in page loads React because `NotificationBell` is a React island: **337 KB** on home/proposals, **345–347 KB** in admin, **451–462 KB** on `/member/`. This is the single largest client cost in the audit and is not reduced by moving hydration to idle.
- `/proposals/[slug]/` loads **322 KB anonymous / 387 KB member** because the ballot and stance islands require React.
- `client:visible` on inactive member views reduced `/member/` transferred JS by about 11 KB and avoids hydration work for those panels, but the shared React runtime still loads for the header bell.
- No new dependencies and no new client-side framework were added.

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

## Deliberately left alone

- **Per-vote decryption and full vote scans in `listProposals`.** List cards need approve/reject/abstain totals, and encrypted ballots can only be tallied after decryption. A tally read model is S4/I12 work, not a low-risk page change.
- **Full-collection proposal search.** `/proposals/` searches `details` client-side for consistency with the existing UX. Moving search into MongoDB with the same semantics needs its own change and index review.
- **Admin register pagination.** `/admin/proposals/` still renders all 78 rows (~1 MB HTML). Pagination changes an administrative workflow and was left as the top structural opportunity rather than slipped into this slice.
- **Ballot authority, eligibility and tally.** All remain server-computed and in the initial response. The ballot island is still server-rendered; hydration timing changed only.
- **Per-request session freshness.** No session caching across requests. No member-specific page or API caching was added.
- **No SPA, skeleton screen, CDN, ISR or client-side data grid** was introduced.

## Limitations

- Measurements come from one local machine, one Node process and a local single-node MongoDB, with no network latency, CDN, reverse proxy or production-like CPU limits.
- Data is synthetic: 78 proposals, 1,200 votes and 600 comments. Real distributions, encrypted ballots, large comment threads and attachment sizes will differ.
- Three runs per page/identity; medians are reported, but individual runs can vary. One earlier run showed an admin-proposals outlier (284 ms TTFB) that did not reproduce across five repeat runs (~91 ms). Treat small deltas as noise.
- LCP and the click-to-next-paint proxy are local indications, not field Core Web Vitals or field INP. INP is not available without real user monitoring.
- The harness runs without configured sign-in providers, so `/member/` reports a pre-existing `503` from `/api/auth/passkey/list-user-passkeys`. The same failure appears in the baseline and is a harness configuration limitation, not a rendering regression.
- The harness does not profile CPU, memory or database query plans. It counts driver commands and measures wall time.
- Server-island requests are asynchronous by design; the document-phase numbers intentionally exclude them.

## Top remaining opportunities, by expected value

1. **Remove React from the signed-in header path.** Replace `NotificationBell` with a lightweight native disclosure/popover that fetches on open, or hydrate it only on interaction. This removes ~330 KB of JavaScript from every signed-in page and is the largest client-side win available.
2. **Paginate or virtualise `/admin/proposals/`.** ~1 MB HTML and 78 interactive rows are sent for a register that administrators scan a page at a time. Pagination or a bounded "load more" would cut transfer, parse and DOM cost together.
3. **Tally/read model for list pages (S4/I12).** Store aggregate vote counts and comment counts per ballot/revision so list pages stop scanning every vote and decrypting every ballot. Pair with server-side filtering and pagination.
4. **Remove `details` from the admin register list.** The register does not render rationale; only the edit/revise form needs it. Load the editor's full text on demand instead of sending every proposal's rationale in the list response.
5. **Defer more `/member/` secondary data.** Notification inbox, passkey count, push subscriptions and branch profile can move behind small endpoints or server islands so the member's next action and outstanding ballots render without waiting for preference data.
6. **Short-TTL caching for public, non-governance reads.** Branch directory, published policy counts and similar stable public reads can use a short cache or ETag. Never cache member-specific authority or ballot state.
7. **Command layer and central route policy (S1).** A single request context would make session resolution, authorisation and query batching uniform rather than page-by-page.

## Verification

- `npm run check` — 0 errors, 0 warnings (22 pre-existing hints).
- `npm test` with `VOTING_TEST_MONGODB_URI` — 306 tests pass, 0 fail (includes new session-reuse, list-visibility and shared-vote-read tests).
- `npm run build` — production build succeeds.
- Harness run against the committed code, three runs per page/identity; before/after JSON committed under `docs/status/`.
- Browser verification: `/admin/` server island replaces its fallback and its nested activity timeline hydrates on scroll with no console errors; the proposal ballot hydrates and responds to a click on desktop (member click-to-next-paint proxy 97 ms in the measured run).
- Raw-control audit on changed files: no new raw `<button>`, `<select>`, `<input>`, `<textarea>`, `<table>` or `<dialog>` elements. The server island composes existing Card and timeline components.
- No new arbitrary palette values or undefined Horizon custom properties were introduced.
