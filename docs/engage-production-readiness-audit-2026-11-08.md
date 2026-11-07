# Engage — Production Differential & Release-Candidate Audit

**Audit date:** 8 November 2026 (Australia/Melbourne)  
**Release candidate:** `0ad210b31435c986f24549f3cd67187aa6889ca6` (`proposal-ballot-integrity`)  
**Repository:** `Fusion-Party-Aus/Engage`  
**Audit type:** read-only production-readiness audit. No production writes, no deployment, no migrations, no policy imports, no corpus changes, no Git history changes.

---

## Executive summary

**Recommendation: NO-GO for replacing the deployed application with `0ad210b` as-is.**

The release candidate is functionally coherent and passes its full test suite against a real MongoDB replica set (70/70, including the eight previously skipped integrations). Security and privacy controls were verified. The public UI rendered cleanly at desktop, tablet and mobile sizes with no overflow and no browser console errors.

Two production-data gates prevent a safe cutover:

1. **All 36 existing open ballots are unbound.** Production has 194 current votes across 36 Decide-stage proposals, but none of those votes records a revision. The new application refuses further voting on an unbound ballot with existing votes until an administrator explicitly binds each ballot. The binding operation works, but 36 explicit review decisions are required before voting can continue.
2. **The Policy Registry is empty.** Production has no `policy_registry` documents. The current production `/policies/` redirects to `/proposals/`; the release candidate serves an empty “Official policy” page. The homepage and navigation still invite visitors to “Read official policy”.

There are also release-engineering blockers: GitHub CI on `main` is red, the RC CI still uses a MongoDB image that fails on the current GitHub runner kernel, production is a hand-built image with no Git SHA traceability, and the NUC deployment workflow is absent from the default branch. Staging Coolify MongoDB is currently crash-looping because of a compose bind-mount defect that the RC still contains (a later fix exists on `origin/main` but is not in the RC).

A conditional GO is achievable after the P0/P1 items in section 9 are closed.

---

## 1. Verified production baseline and release-candidate comparison

### 1.1 What is actually running

| Item | Evidence | Value |
| --- | --- | --- |
| Production host | SSH to `alpine` (`nuc-alpine-01`) | Alpine NUC |
| Application container | `docker ps` | `engage-app-1`, healthy, `127.0.0.1:4321->4321/tcp` |
| Running image | `docker inspect` | `fusion-engage:review-20261106` |
| Image ID | `docker image inspect` | `sha256:510b96807468a45e58771bbe5ab6333c9545fa61990f0cfa5e69444ecd3f4f58` |
| Image build time | `docker image inspect` | `2026-11-06T12:56:33+11:00` |
| Container start | `docker inspect` | `2026-11-06T01:58:30Z` (12:58:30 +11), restart count 0 |
| Active release directory | `/opt/engage/current` | `/opt/engage/releases/nuc-20261106-feedback` |
| Release image override | release `compose.nuc.yml` | hard-codes `image: fusion-engage:review-20261106` |
| Production database | `engage-mongo-1` | MongoDB 8.0, healthy, `engage_mongo_data` volume, 3 days uptime |
| Public endpoint | `https://engage.fusionparty.org.au/api/health` | HTTP 200, `{"ok":true,"status":"healthy"}` |

### 1.2 Exact production commit: not verifiable as a single Git commit

The release directory contains source files but no `.git` metadata and no image labels identifying a revision. File-by-file SHA-256 comparison against the repository shows:

- **62 of 66 comparable files match `c204f47`** (the pre-sprint tip of `proposal-ballot-integrity`).
- **4 files differ**:

| File | Production content matches |
| --- | --- |
| `compose.nuc.yml` | No commit; hand-edited to embed `fusion-engage:review-20261106` |
| `docker-compose.yml` | `99c5940` |
| `src/pages/index.astro` | `5065d00` |
| `src/pages/member/index.astro` | `748ede0` |

- The release snapshot omits `.github/workflows/nuc-cicd.yml` and `scripts/deploy-nuc.sh` that exist in `c204f47`.
- Four macOS AppleDouble metadata files (`._*`) are present in the release snapshot.

**Conclusion:** production is **not running an exact commit**. It is closest to `c204f47` plus four older/hand-edited file variants and a manually edited compose file. The release name `nuc-20261106-feedback`, the `review-20261106` image tag and the build timestamp indicate a manual review build, not a CI/deploy branch tip.

**Production branch:** not verifiable. The running tree does not match `main`, `proposal-ballot-integrity`, or any tag (the repository has no tags).

### 1.3 Release candidate

| Item | Value |
| --- | --- |
| Branch | `proposal-ballot-integrity` |
| HEAD | `0ad210b31435c986f24549f3cd67187aa6889ca6` |
| Sprint commits since production baseline | 6 (`19389e0` … `0ad210b`) |
| Diff from `c204f47` | 125 files, +16,796 / −3,388 lines |
| `origin/main` at audit time | `ef8e9a8` (moving; see §1.5) |
| RC vs `origin/main` | 8 commits ahead, 6 behind |

The RC is an application-feature branch. `origin/main` currently contains the old application plus newer deployment-only commits. The two histories have diverged.

### 1.4 Deployment-specific configuration differences

- Production `.env` has `APP_MODE=production`, `MONGODB_DB_NAME=engage_production`, `APP_BIND_ADDRESS=127.0.0.1`, `APP_PORT=4321`.
- Production `.env` has **`APP_IMAGE_TAG=nuc-20261027-crud`**, which is stale; the running image is `review-20261106`. The release compose file overrides the tag.
- Production `.env` has **`FORMAL_BALLOTS_ENABLED=false`**. The application code does not read this variable; it is dead configuration.
- The RC adds Coolify production/staging compose files. The production file correctly reuses the existing external `engage_default` network and does not define or recreate MongoDB.
- The RC staging file still bind-mounts `./docker/mongo-start.sh`, which is the defect causing the current Coolify staging crash (see §8).

### 1.5 Concurrent workstream during the audit

The repository was not static during this audit:

- `origin/main` advanced from `6e2cc5e` to `ef8e9a8` (`docs(deploy): document Coolify staging, production cutover, and poller`) while the audit was running.
- The working tree gained two modified Coolify compose files and six untracked deployment files (`deploy/systemd/*`, `docker/mongo.Dockerfile`, `docs/coolify-cutover-checklist.md`, `docs/coolify-deployment.md`, `scripts/coolify-poll-deploy.sh`).

Those changes were **not made by this audit** and were left untouched. The audit is against RC HEAD `0ad210b`. The concurrent work confirms an active deployment workstream that is not represented in the RC.

---

## 2. Significant-change inventory

Classification vocabulary: **Compatible improvement**, **Intentional behavioural change**, **Requires migration**, **Potential regression**, **Release blocker**, **Insufficiently verified**.

| Area | Significant change | Classification |
| --- | --- | --- |
| Frontend architecture | React 19 + Astro React integration, Tailwind v4, shadcn/Radix primitives replace bespoke Astro components/CSS | Compatible improvement |
| Design system | Horizon tokens, typography, layout shells and admin components rebuilt | Compatible improvement |
| Portable text | New renderer with explicit HTML escaping and link handling | Compatible improvement; verify entity handling (see §7) |
| Public navigation | New task-first navigation, mobile disclosure menu, `/how-it-works/` | Compatible improvement |
| Public routes | New `/branches/`, `/proposals/new/`, `/policies/` library, `/api/v1/*`; `/policies` no longer redirects | Intentional behavioural change |
| Member account | Better Auth retained; dev sign-in gated to `development`/`test`/`preview` | Compatible improvement |
| Authz | Branch-admin roles and branch-scoped ballot permissions added | Compatible improvement; requires branch data |
| Proposals | Immutable proposal revisions, SHA-256 content hashes, revision diffs, edit locking | Requires migration (startup backfill) |
| Deliberation | Stance-based contributions retained; amendments become immutable revision records | Compatible improvement; no existing amendment data |
| Voting | Votes bind to a frozen revision; separate amendment ballots; immutable ballot results | Requires migration; **release blocker** for existing ballots |
| Ballot privacy | Identifiable ballots restricted to national administrators; member/anon redaction | Compatible improvement |
| Branch admin | Branch records, memberships, referrals, audit events, branch-scoped permissions | New feature; no existing data |
| Policy Registry | New `policy_registry`, publication/ratification/withdrawal/supersession/reconciliation events, public API v1 | New feature; **release blocker** because registry is empty |
| Database schema | Additive collections/indexes; legacy `votes` retained; `proposal_votes` extended with `revisionId` | Requires migration (additive, non-destructive) |
| Startup seeding | Every process start upserts 78 baseline proposals (updates `updatedAt`), backfills missing revisions, binds only unvoted ballots | Requires migration; writes on startup |
| Environment | New compose files; `FORMAL_BALLOTS_ENABLED` unused; stale `APP_IMAGE_TAG` | Potential regression / configuration debt |
| CI/CD | RC fixes test env names and removes obsolete scripts; still uses `mongo:8.0` | **Release blocker** (CI red) |
| Deployment | Production image is a manual review build; no Git SHA label; NUC workflow absent from `main`; no self-hosted runners | **Release blocker** (traceability/automation) |
| Staging | Coolify staging Mongo crash-loops on bind mount; RC config still affected | **Release blocker** for staging |

---

## 3. Feature and route regression matrix

Tested against an isolated clone of production data (81 proposals, 194 votes) using the RC build. HTTP status is from the RC server; production status is from the live public endpoint.

| Route / feature | Production now | RC result | Assessment |
| --- | --- | --- | --- |
| `/` | 200 | 200; visitor/member variants; 0 overflow | Pass |
| `/how-it-works/` | 404 | 200; rendered guide | Pass (new route) |
| `/proposals/` | 200; 80 proposals | 200; 80 proposals (81 including archived for staff); filters and pagination | Pass, with entity-escaping issue (§7) |
| `/proposals/[slug]/` | 200 | 200; revision history, discussion, ballot; React island hydrates | Pass |
| `/proposals/new/` | 404 | 200; form renders; `POST /api/proposals` returned 201 | Pass |
| Deliberation / amendment form | N/A | API returned 201; amendment list returned 1 record | Pass |
| `/policies/` | 301 → `/proposals/` | 200; **empty registry** | **Gap / release blocker** |
| `/policies/[slug]/` | 301 → proposal | Only new registry records; none exist | **Gap** |
| `/branches/` | 404 | 200; empty state, no branches | Pass, but no branch data |
| `/member/` | 200 | 200; sign-in and account UI | Pass |
| `/admin/` | 302 | 200 with admin session; 36 unbound ballots shown as review items (35 after one test bind) | Pass |
| `/admin/proposals/` | N/A | 200; 35 bind forms on the clone after one test bind; 1 MiB HTML | Pass |
| `/admin/members/` | N/A | 200; 31 member forms | Pass |
| `/admin/branches/` | N/A | 200; branch creation form; `POST /api/admin/branches` 201 | Pass |
| `/admin/policies/` | N/A | 200; empty registry | Pass UI, gap in data |
| `GET /api/health` | 200 | 200 | Pass |
| `GET /api/proposals` | 200; 80 | 200; 80 | Pass |
| `GET /api/proposals/:id` | 200 | 200; ballot redaction verified | Pass |
| `POST /api/votes` | 200 | 200 on bound ballot; 400 with explicit binding error on unbound ballot | **Blocked for 36 existing ballots** |
| `POST /api/amendments` | N/A | 201; amendment created | Pass |
| `POST /api/admin/ballots/bind` | N/A | 201; 8 existing votes rebound; subsequent vote 200 | Pass (remediation path) |
| `GET /api/v1/policies` | 404 | 200; published filter verified with synthetic records | Pass, canonical header issue (§6) |
| `GET /api/v1/openapi.json` | 404 | 200 | Pass |
| `GET /api/session` | 200 | 200 | Pass |
| `POST /api/session` (dev login) | N/A | 403 under `APP_MODE=production` | Pass |
| Redirects (`/ballots`, `/consultations`, `/reviews`, etc.) | Active | Retained except `/policies` | Intentional change |

### Forms and submission regressions

The shadcn migration did not produce a form that renders but cannot submit in the paths tested:

- Proposal creation: rendered and API returned 201.
- Amendment submission: rendered and API returned 201.
- Member ballot submission: rendered as a hydrated React island and `POST /api/votes` returned 200 on a bound ballot.
- Admin ballot binding: form rendered; API returned 201 and preserved 8 existing votes.
- Branch creation: form rendered; API returned 201.

Not exercised end-to-end in a browser: member verification/role changes, branch membership assignment/revocation, amendment open/close/accept, ballot result recording, policy ratification/publication/withdrawal/supersession. Their API-level behaviour is covered by the real-MongoDB test suite (70/70 pass), but browser form wiring for those specific admin flows is **insufficiently verified**.

---

## 4. Production-data compatibility assessment

### 4.1 Production data inventory (read-only)

| Collection | Documents | Notes |
| --- | ---: | --- |
| `proposals` | 81 | 1 archived, 36 decide, 43 deliberate, 1 propose |
| `proposal_votes` | 194 | 183 approve, 7 abstain, 4 reject; 0 with `revisionId`; all `ballotId = proposal:<id>` |
| `votes` | 4 | Legacy records, no `ballotId`; retained |
| `schema_migrations` | 1 | `proposal-votes-v1` completed 2026-10-28; 4 copied |
| `user` | 31 | Existing Better Auth users |
| `account` | 6 | Existing Better Auth accounts |
| `session` | 42 | Existing sessions |
| `memberships` | 31 | All `verified` |
| `application_roles` | 5 | All `administrator` |
| `comments` | 10 | Proposal-linked |
| `policies` / `policy_revisions` | 0 / 0 | Legacy collections empty |
| `policy_registry` | 0 | **New registry has no data** |
| `branches` / `branch_memberships` | 0 / 0 | **New branch model has no data** |
| `amendments` / `amendment_revisions` | 0 / 0 | New model has no data |
| `ballot_binding_events` / `ballot_results` / `publication_events` | 0 / 0 / 0 | New governance records absent |

Proposal kinds are 78 `policy`, 1 `resolution`, 2 `proposal`. `normalizeKind` reads the two `proposal` rows as policy; no data rewrite is required.

### 4.2 What startup does to the clone

The new `initializeDatabase()` runs on first database access. Against the isolated clone it:

- created all new indexes;
- backfilled **81 proposal_revisions** with `legacy-<sha256>` IDs and content hashes;
- updated **`updatedAt` on 78 baseline proposals**;
- did **not** change stages, titles, summaries, details, outcomes, kinds, or provenance;
- did **not** set `ballotRevisionId` on any of the 36 Decide ballots;
- did **not** create `policy_registry` or branch documents.

The `updatedAt` write repeats on every new process/container start because the baseline upsert uses `$set: { updatedAt: now }`. This is non-destructive but is an automatic production write on restart.

### 4.3 Ballot compatibility: the critical gate

All **36/36** Decide-stage proposals have existing votes and **none** has `ballotRevisionId`. The new `castVote()` path refuses to continue:

> “This existing ballot has votes without one consistent revision reference. An administrator must review and bind the wording before voting can continue.”

The startup backfill deliberately does not guess a revision for these ballots. The admin UI exposes a review control per ballot (36 initially; 35 after the test bind). The binding endpoint was tested against the clone:

- selected a proposal revision;
- recorded a decision-event reference and reason;
- rebound 8 existing votes to the revision;
- wrote a `ballot_binding_events` record;
- a subsequent member vote succeeded and the tally increased.

This is a safe remediation path, but it is **an explicit 36-ballot migration operation**, not something the release performs automatically. Until it is done, existing members cannot vote on any of the current open ballots.

### 4.4 Registry compatibility: the content gate

The public policy library reads only `policy_registry` entries with `publicationStatus` in `published`/`withdrawn`/`superseded`. Production has zero such entries. The RC therefore shows:

- “No current policies found” on `/policies/`;
- zero results from `/api/v1/policies`;
- no `/policies/[slug]` pages for the existing 76 baseline policies.

The current production `/policies/` redirects to `/proposals/`, so this changes a working (if indirect) public path into an empty official-library page. The RC’s empty-state copy says the library “is being prepared”, which suggests this may be intentional staging, but the homepage and navigation still present “Read official policy” as a primary action. **A content/publication decision is required before release.**

Existing proposals, votes, discussions and member accounts remain readable. No proposal text, vote choice, membership status or role was lost in the clone test.

### 4.5 Compatibility summary

| Area | Assessment |
| --- | --- |
| Member accounts and sessions | Compatible in code; Better Auth version and collections unchanged. Existing session cookies were not replayed (untested with the production secret). |
| Existing proposals and stages | Compatible; reads and normalizes correctly. |
| Historical/active votes | Readable; tallies correct. **Writes blocked** on all 36 existing Decide ballots until binding. |
| Ballot identities/results | Existing vote identities preserved; no results existed. Binding path works. |
| Revision backfill | Works: 81 revisions created, idempotent by proposal ID. |
| Amendment records | No existing records; no migration needed. |
| Branch membership | No existing branch data; branch features start empty. |
| Startup seeding | Automatic, additive, but writes `updatedAt` on 78 proposals each process start. |
| Policy registry | **No migration/import**; empty public library. |

---

## 5. Real MongoDB integration results

### 5.1 Isolated replica set

A disposable MongoDB 8.0 single-node replica set was started locally in the `engage-verification` Colima profile on `127.0.0.1:27018`, with `--replSet engage-audit`. No production database was contacted by the tests.

Command:

```text
VOTING_TEST_MONGODB_URI=mongodb://127.0.0.1:27018/?directConnection=true
AUTH_TEST_MONGODB_URI=mongodb://127.0.0.1:27018/?directConnection=true
pnpm test
```

### 5.2 Results

| Metric | Result |
| --- | ---: |
| Tests | 70 |
| Suites | 2 |
| Passed | **70** |
| Failed | 0 |
| Cancelled | 0 |
| Skipped | **0** |
| Duration | ~5.2 s (final run) |

The eight tests skipped in the previous local verification all ran and passed:

1. Google links a pre-created account only when its email is verified.
2. Real MongoDB startup seeds baseline policies without conflicting update paths.
3. Proposal content and its immutable revisions commit together on MongoDB.
4. One member can vote on two independent policies despite the legacy ballot index.
5. Migration preserves mixed legacy ballots and current votes, is read-only by default and restartable.
6. NUC record shape migrates without changing originals, totals or content locks.
7. Migration resumes a partial copy and startup fails if uniqueness cannot be installed.
8. Ambiguous, duplicate and conflicting records block migration without choosing or overwriting votes.

### 5.3 Transaction, index, uniqueness and concurrency coverage

The passing suite covers MongoDB transactions for proposal + revision writes, the `proposal_votes` unique index, legacy ballot isolation, migration idempotency/resume, stale-write rejection, and branch ballot eligibility. No failures were observed.

### 5.4 CI environment incompatibility

The GitHub-hosted CI cannot start `mongo:8.0`:

> “MongoDB cannot start: Linux kernel versions 6.19 and newer has a known incompatibility with this version of MongoDB. See https://jira.mongodb.org/browse/SERVER-121912”

All observed recent `main` application-check runs are red; the latest application-check run observed in this audit was for `6e2cc5e`, and deployment-only commits pushed during the audit were not independently re-run. The RC’s `ci.yml` fixes the test environment variable names and removes obsolete package scripts, but it **still uses `mongo:8.0`**, so it will hit the same runner-kernel failure. This is a CI release gate, not an application-code failure.

---

## 6. Security and privacy verification

All checks were performed against the isolated clone or the production-mode RC server. No production writes.

| Control | Method | Result |
| --- | --- | --- |
| Anonymous ballot disclosure | `GET /api/proposals/POL-010` without cookie | `votesList` length 0; no member IDs or names |
| Ordinary member disclosure | `GET /api/proposals/POL-010` as member | Only the member’s own vote; `memberId`/`authorName` redacted |
| Administrator disclosure | Same as national admin | 10 identifiable votes, including `memberId`/`authorName` |
| Private proposal visibility | Inserted private proposal in clone | Anonymous list excluded; anonymous detail `null`; author and admin could read |
| Proposal revision access | `listProposalRevisions` tests | Pass; archived/private rules applied |
| Comment/amendment visibility | Existing tests | Pass |
| Development auth bypass in production | `APP_MODE=production`; `POST /api/session` | **403** |
| Forged dev cookie in production | `GET /api/session` with `engage_dev_user=administrator` | `identity: null` |
| Forged dev cookie on admin route | `GET /admin/` | 302 to `/member/` |
| Public API publication filter | Synthetic published/withdrawn/draft registry records | Only `published` returned; withdrawn direct read 404 |
| Public API cache/ETag | `GET /api/v1/policies` | ETag, `public, max-age=60`, `stale-while-revalidate` |
| Branch voting | Real-MongoDB tests | Pass; explicit active branch membership required |
| Secrets in committed diff | Scan of `c204f47..0ad210b` | No private keys, tokens or connection strings found |
| `.env` handling | Repository status | Ignored; not committed |

### 6.1 Security finding: canonical URLs use localhost and HTTP

The RC’s canonical metadata and API `Link` headers resolve to `http://localhost:<port>` even when the request carries the public `Host` header:

- RC home: `<link rel="canonical" href="http://localhost:4402/">`
- RC proposal: `<link rel="canonical" href="http://localhost:4402/proposals/.../">`
- RC API: `link: <http://localhost:4402/api/v1/policies>; rel="canonical"`

This is **pre-existing** on production pages (`http://localhost:4321/`), but the RC extends it to the new public API. It is an SEO/API correctness defect, not a data-leak. It should be fixed by deriving the public origin from a configured `ORIGIN`/`BETTER_AUTH_URL` or trusted forwarded headers.

No unresolved authentication bypass or sensitive-data leak was found.

---

## 7. Responsive and functional UX findings

### 7.1 Method

The built RC was served against the production-data clone and driven with headless Chrome 156 via CDP. Twenty page/viewport combinations were captured:

- desktop 1440×1000;
- tablet 820×1180;
- mobile 390×844.

Pages covered: `/`, `/how-it-works/`, `/proposals/`, member proposal detail, `/policies/`, `/branches/`, `/member/`, `/admin/`, `/admin/proposals/`, `/admin/members/`, `/admin/branches/`, `/admin/policies/`.

### 7.2 Results

| Check | Result |
| --- | --- |
| Horizontal overflow | **0 px on all 20 combinations** |
| Browser console errors | **0 on all 20 combinations** |
| React hydration | 1 island on member proposal detail; `ProposalBallot` hydrated and vote POST succeeded |
| Unlabelled inputs | **0** on all tested pages |
| Document language | `lang="en-AU"` |
| Skip link | Present and focusable |
| Image alt text | Hero image has descriptive alt; decorative logos use empty alt |
| Focus indicator | Global 3 px `:focus-visible` outline; controls also have focus rings |
| Contrast | All tested text/background pairs ≥ 6.37:1 (WCAG AA) |
| Buttons/selects/text inputs < 32 px on mobile | None found on tested pages |
| Native radio inputs | 16×16 px; associated labels provide the hit area |
| Inline text links | 20–23 px high; WCAG 2.5.8 inline-text exception applies, but mobile tap comfort could improve |

Contrast results:

| Pair | Ratio |
| --- | ---: |
| Horizon purple on white | 15.47:1 |
| Muted text on white | 8.68:1 |
| Accent ink on cyan | 8.22:1 |
| White on purple | 15.47:1 |
| Voting ink on voting background | 9.01:1 |
| Warning ink on warning background | 9.04:1 |
| Danger ink on danger background | 10.16:1 |
| Focus colour on white | 6.37:1 |
| Muted text on lavender | 7.60:1 |

### 7.3 UX defects observed

1. **Literal `&amp;` in category labels.** The RC renders `Platform &amp; Branding Review` in proposal cards, filters and admin rows. Production renders `Platform & Branding Review` correctly. Raw HTML on the RC shows `Platform &amp;amp; Branding Review`; this is a double-escaping regression in the new rendering path. It affects at least GOV-001 and GOV-002.
2. **Technical revision label on member ballots.** A bound legacy ballot displays “Voting on wording revision legacy—0”. The truncated internal revision ID is not meaningful to members. Use a human-readable revision label.
3. **Empty official policy library.** The page is visually polished but has no content; the primary “Read official policy” journey ends in an empty state.
4. **Admin review queue is large.** The overview shows 36 ballot-binding review items (35 after one test bind). The UI handles them, but there is no bulk or guided migration path.
5. **Non-fatal SSR React warnings.** Server logs contain React DOM attribute warnings:
   - `stroke-width`/`stroke-linecap`/`stroke-linejoin` from lucide icons rendered through React in Astro pages;
   - `datetime` on the proposal page;
   - `selected` on `<option>` and a controlled `value` without `onChange` on the proposals list.

   Browser console was clean and hydration worked, so these are hygiene issues rather than functional failures.

### 7.4 Screenshot review

The desktop home, proposal browser, member proposal detail, admin overview, admin proposal queue, official policy empty state, mobile home, mobile proposal and mobile/tablet admin screenshots were reviewed. The Horizon layout, responsive navigation, typography, button hierarchy and admin rail/menu behaviour are coherent and readable. The main visual defect is the literal `&amp;` label; the main product defect is the empty policy library.

---

## 8. Deployment and rollback assessment

### 8.1 Production topology and persistence

| Requirement | Finding |
| --- | --- |
| Existing production MongoDB preserved | Yes: `engage-mongo-1` is separate; production compose defines only the app and reuses external `engage_default` |
| Persistent volume preserved | Yes: `engage_mongo_data` mounts `/data/db` |
| App replacement does not recreate DB | Yes: app container has no database volume; no Mongo service in production compose |
| Public endpoint preserved | Yes: app binds `127.0.0.1:4321`; Cloudflare Tunnel is healthy; public `/api/health` 200 |
| Environment/secrets supplied | Production `.env` contains the required keys; Coolify production compose requires `MONGODB_URI` and `MONGODB_DB_NAME` |
| Resource headroom | App 68.5 MiB / 256 MiB (26.8%); Mongo 327.9 MiB / 512 MiB (64%) |

### 8.2 Coolify configuration

- **Production compose** is structurally sound: reuses the existing network, does not manage MongoDB, has a health check, drops capabilities and binds loopback.
- **Staging compose is not deployable as committed.** The Coolify staging Mongo container is crash-looping with:

  > `/usr/local/bin/engage-mongo-start.sh: Is a directory` (exit 126)

  The compose file bind-mounts `./docker/mongo-start.sh` to `/usr/local/bin/engage-mongo-start.sh`; in the Coolify deployment that path became a directory. `origin/main` already contains a newer fix (`docker/mongo.Dockerfile` builds the helpers into `fusion-engage-mongo` and removes the bind mounts), but that fix is **not in the RC**.

### 8.3 CI/CD and image traceability

| Requirement | Finding |
| --- | --- |
| CI green | **No.** Recent `main` application-check runs are red; root cause is MongoDB 8.0 on GitHub runner kernel 6.19 |
| RC CI workflow correct | Partially: env names/scripts fixed, but still uses `mongo:8.0`, so it will fail on the same runner |
| NUC deployment workflow on default branch | **No.** `gh workflow list` shows only “Application checks”; `nuc-cicd.yml` exists on the RC/history but not on `origin/main` |
| Self-hosted runner available | **No.** GitHub API reports 0 runners |
| Image references intended commit | **No.** Production image is `fusion-engage:review-20261106`; no OCI revision label; `APP_IMAGE_TAG` in `.env` is stale |
| Health check detects failed release | Partially: `/api/health` only pings MongoDB. It will return 200 with an empty registry or 36 blocked ballots |
| Rollback procedure tested | Procedure exists in `scripts/deploy-nuc.sh` (health-failure rollback to previous release). Previous release images exist, but rollback has not been tested with post-release data. |

### 8.4 Rollback compatibility

Available application images on the NUC:

- `fusion-engage:review-20261106` (current)
- `fusion-engage:nuc-20261028-vote-fix`
- `fusion-engage:nuc-20261027-crud`
- `fusion-engage:nuc-20261027-public-login`
- `fusion-engage:nuc-20261027-email`
- `fusion-engage:nuc-20261027`

Database changes from the RC are additive:

- new collections (`proposal_revisions`, `policy_registry`, `branches`, `branch_memberships`, `amendments`, `amendment_revisions`, `ballot_binding_events`, `ballot_results`, `publication_events`);
- new indexes;
- `ballotRevisionId` on proposals;
- `revisionId` on `proposal_votes`.

The deployed `c204f47` code ignores those fields/collections. Its vote write path does not unset `revisionId`, so rebound votes remain valid. A code rollback is therefore **likely compatible**, but it has not been rehearsed. After rollback:

- published registry policies disappear from the old app (it does not read `policy_registry`);
- new branch/amendment data becomes invisible;
- new `ballotRevisionId` fields are ignored;
- the 78 baseline `updatedAt` writes remain.

No destructive schema change or dropped collection was found, so rollback should not corrupt existing proposals, votes or accounts.

---

## 9. Release blockers ranked by severity

| Severity | Blocker | Evidence | Consequence if released as-is |
| --- | --- | --- | --- |
| **P0** | All 36 existing Decide ballots are unbound | 36/36 Decide proposals have votes; 0 have `ballotRevisionId`; `castVote` rejects | No existing member can vote on any current open ballot until 36 ballots are manually bound |
| **P0** | Policy Registry is empty | `policy_registry` = 0; `/policies/` shows empty state; `/api/v1/policies` empty | “Read official policy” leads to an empty library; public policy API has no content |
| **P1** | CI is red; RC CI still uses incompatible MongoDB | GitHub kernel 6.19 vs `mongo:8.0`; recent `main` runs failed | No green CI evidence for the release; automated gate cannot pass |
| **P1** | Deployment is not traceable or automated | Production is a manual review image; no SHA label; `APP_IMAGE_TAG` stale; `nuc-cicd.yml` absent from `main`; 0 runners | Cannot prove which commit is deployed or reproduce the release; no automated deploy path |
| **P1** | Coolify staging MongoDB crash-loops | `/usr/local/bin/engage-mongo-start.sh: Is a directory`; RC still bind-mounts it | Staging cannot be used for release rehearsal; RC staging config is defective |
| **P2** | Canonical URLs point to `localhost`/HTTP | RC pages and API `Link` headers; pre-existing on production pages | Wrong canonical metadata and API links; SEO/integration defect |
| **P2** | Literal `&amp;` in category labels | RC `/proposals/`, admin queue; production renders correctly | Visible text-quality regression |
| **P2** | Member ballot shows `legacy—0` revision label | RC member proposal screenshot | Confusing technical jargon at the point of voting |
| **P3** | SSR React DOM warnings | `stroke-*`, `datetime`, `selected`, controlled `value` | Non-fatal console/server noise; possible hydration hygiene risk |
| **P3** | Dead `FORMAL_BALLOTS_ENABLED` config | Present in production `.env` and RC compose; no code reads it | Operational confusion; no runtime effect |
| **P3** | Compact inline tap targets | 20–23 px text links at mobile widths | Minor mobile ergonomics issue |

---

## 10. Recommended remediation actions

### Before any production cutover (P0/P1)

1. **Bind all 36 existing ballots.**
   - Use the reviewed admin control (`POST /api/admin/ballots/bind`) or an approved, audited script.
   - Each binding needs an exact `revisionId`, an explicit decision-event reference and a review reason.
   - Verify every Decide proposal has `ballotRevisionId`, every existing vote has a matching `revisionId`, and `ballot_binding_events` has one event per ballot.
   - Do this on a restored production copy first, then on production during a controlled window.
   - Do not bulk-guess revisions; the code deliberately refuses inconsistent ballots.

2. **Decide the Policy Registry release position.**
   - Either import/publish the existing adopted policy set into `policy_registry` through the governed ratification/publication path, or explicitly accept an empty official library and remove/relabel the “Read official policy” CTAs until content is ready.
   - If publishing, preserve provenance and exact approved wording; do not infer adoption from the existing proposals.
   - Verify `/policies/`, `/policies/<id>/` and `/api/v1/policies` after import.

3. **Fix CI.**
   - Change the CI MongoDB image from `mongo:8.0` to a version compatible with GitHub runner kernel 6.19 (for example a current 8.2+ image) or pin a compatible runner image.
   - Re-run the full real-MongoDB suite in CI.
   - Require a green run on the exact RC commit before release.

4. **Make deployment traceable and executable.**
   - Merge/rebase the deployment fixes currently on `origin/main` (Coolify staging Mongo image, poller, cutover docs) into the release line.
   - Add OCI labels or a deployment manifest recording the Git SHA.
   - Set `APP_IMAGE_TAG` to the actual release image and stop hard-coding image tags in `compose.nuc.yml`.
   - Put `nuc-cicd.yml` on the default branch and provision a self-hosted runner, or document and test the manual `deploy-nuc.sh` release procedure explicitly.

5. **Repair Coolify staging.**
   - Use the newer `docker/mongo.Dockerfile` model that bakes `mongo-start.sh`, `mongo-healthcheck.js` and `mongo-init.js` into the Mongo image; remove the bind mounts that produced the directory.
   - Rehearse the full cutover on staging against a restored production copy.

### Before or immediately after cutover (P2/P3)

6. Fix canonical origin handling. Derive the public origin from a configured value (or trusted forwarded headers) so page canonicals and API `Link` headers use `https://engage.fusionparty.org.au`.
7. Decode HTML entities in category/space labels so `&amp;` renders as `&`.
8. Replace the raw `legacy—0` ballot revision label with a human-readable revision name/date.
9. Clean up React DOM attribute warnings (`stroke-*` from lucide SSR, `datetime`, controlled select/input props).
10. Remove or implement `FORMAL_BALLOTS_ENABLED`; do not leave a dead production flag in deployment docs.
11. Extend the release smoke test beyond `/api/health`:
    - `/proposals/` returns proposals;
    - `/policies/` returns the expected policy count;
    - admin bind queue count is known;
    - a test member can vote on a bound ballot.
12. Rehearse rollback with post-release data: bind a ballot, publish a policy, then roll back and confirm the old app still reads proposals/votes and the data is not corrupted.

---

## 11. Recommendation

### **NO-GO** for replacing production with `0ad210b` as-is.

Supporting evidence:

- The application is well tested (70/70 with real MongoDB), secure in the checked paths, and visually sound across desktop/tablet/mobile.
- Existing proposals, accounts, sessions and votes are readable and no destructive migration was found.
- However, **all 36 existing open ballots are blocked from further voting** until an explicit 36-ballot binding operation is performed.
- The **public policy library is empty** in the RC while the deployed application redirects `/policies/` to proposals; the primary “Read official policy” journey regresses.
- CI is red and the RC CI still uses an incompatible MongoDB image.
- Production is a manual review image with no commit traceability, and the NUC deployment workflow is not on the default branch.
- Staging Coolify is currently crash-looping on a defect the RC still contains.

### Path to CONDITIONAL GO

A conditional GO is appropriate once:

1. all 36 ballots are bound and verified on a production-data copy, with an approved production operation plan;
2. the policy-library decision is implemented (published content or explicit empty-library product decision and CTA changes);
3. CI is green on the exact RC commit with real MongoDB;
4. deployment traceability and the NUC/staging deployment path are fixed;
5. staging has successfully run the cutover and rollback rehearsal against restored production data.

Until then, deploying this RC would create a visible participation outage on every existing open ballot and an empty official policy library.

---

## Appendix A — Verification commands and limits

**Run against the RC (working tree, app source unchanged):**

```text
pnpm build        # pass
pnpm check        # 0 errors, 0 warnings, 14 hints (research scripts)
pnpm test         # 70 tests, 70 pass, 0 fail, 0 skipped (real MongoDB)
```

**Isolated integration environment:** local MongoDB 8.0 single-node replica set on `127.0.0.1:27018`, Colima `engage-verification` profile, removed after the audit.

**Production-data clone:** 357 documents from 8 collections exported read-only from `engage_production` via the running app container, restored to a disposable local database, then exercised with the RC build. No production write, migration, deployment or policy import was performed.

**Limits and untested areas:**

- Existing production session cookies were not replayed (the production `BETTER_AUTH_SECRET` was not used); session continuity is inferred from the unchanged Better Auth version and collections, not proven end-to-end.
- Google OAuth and Resend email delivery were not exercised against live providers.
- Member verification, branch membership assignment/revocation, amendment ballot open/close/accept, ballot result recording, and policy ratification/publication were not exercised through the browser UI; their APIs are covered by the passing real-MongoDB tests.
- Rollback was not executed against post-release data.
- Production browser rendering was not re-captured; production was compared by route status and HTML, while the RC was rendered in headless Chrome.
- `origin/main` and the working tree changed during the audit (concurrent deployment workstream); this report is pinned to RC HEAD `0ad210b` and records the concurrent files as outside the audit.

## Appendix B — Evidence artefacts retained outside the repository

The following temporary artefacts were used for the audit and are not part of the repository:

- production file hash inventory and comparison;
- production-data export (`prod-export.ndjson`);
- compatibility, visibility and HTTP probe outputs;
- 20 screenshots at desktop/tablet/mobile sizes;
- isolated test logs.

No corpus file, research artefact or concurrent deployment file was modified.
