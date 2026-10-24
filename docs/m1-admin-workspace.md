# B1 — administration workspace checkpoint

Draft review: [PR #10](https://github.com/Fusion-Party-Aus/Engage/pull/10).

B1 is developed on `codex/m1-admin-workspace`, based on PR #9 head `a4de58f`. PR #9 remains a merge dependency; this change does not merge or repeat its taxonomy/privacy work. Main at the initial check is `6ab7929` (PR #8). Rebase onto reviewed main after #9 merges, and review only B1's diff against #9 until then.

## Operator navigation

- `/admin/` is Work: a read-only, bounded projection of pending contributions, draft decisions, elapsed voting windows and incomplete outcomes. Reading Work does not run ballot closure or create task records. Each group shows up to 20 items and indicates additional records.
- `/admin/policies/` provides title/programme/subject search and policy draft creation. `/admin/policies/:policyId/` is the canonical workspace for four-layer wording, taxonomy, provenance, consultation history, moderation, immutable revision preparation, text comparison and decision history.
- `/admin/consultations/` hosts scoped/paginated moderation, consultation creation, draft scheduling and existing lifecycle controls. `?roundId=` selects a consultation context.
- `/admin/decisions/` provides status filtering/pagination, policy/revision selectors, draft preparation, existing preview opening, closure/finalisation and outcomes. It explains missing pinned wording and production opening prerequisites. Closed ballots cannot be reopened from this interface.
- `/admin/administration/` hosts membership access, permission limitations, health and audit. `/admin/members/` remains the verification page. Synthetic sessions cannot retrieve real membership records and receive an explicit explanation.

The old `/admin/` route remains valid. Its former queue, revision, creation, schedule, ballots, operations and audit fragment links are mapped deliberately to their new areas by the Work page script. Protected pages authorise before loading operator records, remain private/no-store, and provide a sign-in/verification denial page. Navigation and action visibility use today's roles; API permissions remain authoritative.

No frontend framework, task collection, collaborative editor or general permission/workflow engine was added. Ballot admission, revotes, database-time cutoff, transactional closure, tally, publication and vote audit code are unchanged. Forms reuse existing APIs, generate new record IDs internally, use selectors for references, submit with POST rather than putting content into fallback query strings, and announce saving/error/success states. Dates in records are labelled UTC; scheduling controls use the operator's device timezone.

## Explicit remaining scope

B1 does not implement editor/reviewer/Election Officer separation or the production evidence form. Those are B2. Opening binding ballots remains unavailable through B1 UI; it does not bypass the API's evidence or `FORMAL_BALLOTS_ENABLED` gates. Existing unresolved organisational ballot references are shown as blocked, not manufactured into policy records. Standalone consultations/propositions and the complete Horizon journey remain B3.

An existing acceptance gap was confirmed while rehearsing: the member consultation selector uses the public catalogue projection, so assigning an unpublished new policy to a round does not make it selectable by members. B1 explains this on the policy form. The remaining M1 work must provide deliberate verified-member access to selected consultation wording without accidentally publishing private drafts to the public. It must not solve this by automatically publishing every new policy.

## Verification

Use pinned Node `24.22.1` and pnpm `10.28.0`.

- `pnpm check`: zero errors, warnings or hints.
- `pnpm test`: 31 Node tests, including real MongoDB governance tests, plus four policy-migration and three backup-safety checks; no skipped Node tests.
- `pnpm test:cutoff`: seven real replica-set regressions, including cutoff boundaries, stalled eligibility, revotes, concurrency and audit rollback.
- `pnpm build`: Astro Node SSR build passes.
- `AUTH_TEST_SSR=true pnpm test:auth`: controlled provider and disposable MongoDB sessions, membership verification, existing voting, public/member privacy, new operator routes and latest working revision SSR. Signed-out users and ordinary/pending/suspended accounts cannot read protected operator pages; verified moderators can read participation areas but cannot administer membership. This does not claim live Google/HTTPS testing.
- Synthetic HTTP smoke: all seven admin routes render the protected shell, mutation forms use POST, bundled scripts return 200, and Work returns bounded actionable records.

The real database checks use disposable databases on a separately started local MongoDB replica set on port 27039, not the existing application database on port 27017. No production migration, member access, deployment or formal-ballot activation was performed.

Chrome native UI checks confirmed synthetic administrator sign-in, Work loading/empty states and visual hierarchy, policy creation with a title-based consultation selection, canonical workspace navigation, immutable revision saving, and side-by-side original/revised wording. The rehearsal found and fixed the same-fragment refresh-link bug. Additional browser verification status is recorded at the final checkpoint below. Native Chrome input shares the user's active window; no isolated browser/DevTools connector was available at the first check.

Hosted application checks on PR #9 had not run: GitHub reported account billing/spending-limit failure. Local passing checks are not a substitute for hosted CI or independent security/human acceptance.

### Browser checkpoint limits

The browser was subsequently available through Chrome's native desktop controls. Synthetic create/revise/compare operations were exercised, but ballot creation/opening, moderation, mobile viewport, complete keyboard navigation and DevTools console/network checks were not completed. The active Chrome tab repeatedly changed during native keyboard actions, so input was paused to avoid interacting with unrelated tabs. The refresh-link correction is covered by source review and the final rebuilt bundle; its corrected click behaviour still needs browser confirmation. Full Reclaim independent-review and Horizon journeys remain later-deliverable acceptance work.
