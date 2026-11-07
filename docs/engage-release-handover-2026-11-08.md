# Engage release handover — application verification

**Prepared:** 8 November 2026 (Australia/Melbourne)  
**Repository:** `Fusion-Party-Aus/Engage`  
**Branch:** `proposal-ballot-integrity`  
**Base commit:** `0ad210b31435c986f24549f3cd67187aa6889ca6`  
**Release state:** tested working tree on top of the base commit (application changes are uncommitted; see §10)  
**Recommendation:** **GO for application handover.** Production ballot migration and cutover remain separate Coolify operations.

This document separates application readiness from deployment. Coolify environments, container builds, production backups, cutover and post-deployment monitoring are owned by the separate Coolify agent.

---

## 1. What changed since the previous release candidate

| Area | Remediation |
| --- | --- |
| Legacy ballots | Added a deterministic, transactional bulk-binding migration with dry-run, apply and verify modes; 37 ballot records (36 open + 1 archived) and all 194 existing `proposal_votes` are covered. |
| Startup | Seeding is insert-only. Repeated startup no longer rewrites unchanged proposals or their `updatedAt`, and no ballot is bound automatically. Revision backfill remains deterministic and idempotent. |
| Policy registry | Empty registry is now an intentional, explicit state. `/policies/` remains accessible and explains that Fusion’s adopted policies exist outside Engage and that Engage proposals are not ratified policy. |
| Category labels | Removed Astro’s `experimentalReactChildren` option, which double-escaped slot text and caused literal `&amp;` labels. `Platform & Branding Review` now renders correctly. |
| Revision labels | Member ballots show “Original recorded wording · 27 Oct 2026” and similar labels instead of `legacy—…`. Exact identifiers remain in revision history, admin views and audit records. |
| Canonical URLs | Added trusted `PUBLIC_ORIGIN` handling (falling back to `BETTER_AUTH_URL`). Page canonicals and public API `Link` headers use the configured origin and ignore forwarded host headers. |
| SSR warnings | The same React children change removed the `stroke-*`, `selected`, controlled-value and `datetime` server warnings. Server logs are clean in verification. |
| Tests | Added startup-idempotency, bulk-migration, rollback, archived-ballot, canonical-origin, revision-label and rendering-regression coverage. |

The full application diff is in §10.

---

## 2. Verification results

### Build and checks

| Command | Result |
| --- | --- |
| `pnpm build` | Pass |
| `pnpm check` | Pass — 0 errors, 0 warnings, 14 hints (pre-existing research scripts) |
| `pnpm test` | **92 tests, 92 pass, 0 fail, 0 skipped** against a real MongoDB 8.0 single-node replica set |

The suite includes the eight previously skipped integration tests. GitHub Actions was not used and is not a release prerequisite for this handover.

### Production-data rehearsal

A fresh read-only export of `engage_production` was restored to an isolated MongoDB replica set. No production write was performed.

| Check | Result |
| --- | --- |
| Proposals preserved | 81 proposals; content, stage and titles unchanged |
| Startup idempotency | First and second startup leave all 81 `updatedAt` values unchanged; 81 revisions created once; no ballot bindings |
| Inventory | 37 ballots: 36 open Decide + 1 archived historical (`GOV-002`) |
| Existing votes | 194 — all present before and after migration |
| Wording evidence | 37 supported by deployment-baseline match; 0 ambiguous; 0 conflicting |
| Binding | 37/37 ballots bound; 194/194 votes carry the matching `revisionId`; 37 binding audit events |
| Vote preservation | 0 mismatches across ballot ID, proposal ID, member ID, choice, author name, reason and timestamp |
| Idempotent retry | Second apply returned 37 idempotent events; no duplicate revisions, votes or events |
| New votes | Bound ballots accepted new eligible votes; archived ballot correctly rejected a new vote |
| Fail-closed | Wording change, conflicting vote revision and planted inconsistent revision each aborted without writes; the transaction rollback test left zero bindings |
| Unbound ballot | Browser and API both rejected voting with the explicit binding error |

### Browser verification (headless Chrome 156)

| Check | Result |
| --- | --- |
| Proposal browsing and category text | Pass — single `&amp;` in HTML, displayed as `&` |
| Member voting on a bound legacy ballot | Pass — vote recorded, tally increased |
| Rejection on an unbound ballot | Pass — explicit error, no vote recorded |
| Ballot-binding administration | Pass — 36 review forms on the unbound clone |
| Official-policy empty state | Pass — accurate empty-registry explanation |
| Human-readable revision label | Pass — no `legacy—` label |
| Canonical URLs | Pass — `https://engage.fusionparty.org.au` in production mode |
| Authentication and visibility | Pass — anonymous admin redirects; admin workspace opens with admin session |

Public API `Link` headers were also checked in production mode:

```text
link: <https://engage.fusionparty.org.au/api/v1/policies>; rel="canonical"
```

No React SSR warnings appeared in the server log during these checks.

---

## 3. Required environment variables

| Variable | Requirement |
| --- | --- |
| `MONGODB_URI` | Required. Production replica set connection string. |
| `MONGODB_DB_NAME` | Required. Production database name (`engage_production`). |
| `BETTER_AUTH_URL` | Required. `https://engage.fusionparty.org.au`. |
| `PUBLIC_ORIGIN` | **New.** `https://engage.fusionparty.org.au`. Trusted canonical/API origin. Falls back to `BETTER_AUTH_URL` if omitted. |
| `BETTER_AUTH_SECRET` | Required for existing sessions/OAuth. |
| `SESSION_SECRET` | Required. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Required only for Google sign-in. |
| `RESEND_API_KEY`, `AUTH_EMAIL_FROM` | Required only for email sign-in. |
| `FORMAL_BALLOTS_ENABLED` | Not read by the application. Remove from operational assumptions; it is not a release control. |

No new database service, cache or external dependency was added.

---

## 4. Database compatibility and migration prerequisites

### Compatibility

- Additive only: new collections/indexes, `ballotRevisionId` on proposals, `revisionId` on `proposal_votes`, and `ballot_binding_events`.
- No collection is dropped and no existing field is removed.
- The previous application ignores the new fields and collections, so a code rollback remains readable.
- Existing sessions, memberships, roles, comments, proposal content and stages are unchanged.

### Migration prerequisites

1. MongoDB must run as a replica set. The apply step uses one transaction and fails if transactions are unavailable.
2. A fresh backup must exist before application startup or migration.
3. Run the migration only after the production inventory matches the reviewed inventory: **37 ballots, 194 votes, 37 supported, 0 ambiguous, 0 conflicting**.
4. The operator must supply `--database engage_production` explicitly; the tool never infers the database from the URI.
5. Production writes require all of: `--apply`, `--allow-production`, `--confirm-production engage_production`, plus an operator identity.

Full procedure: `docs/engage-ballot-migration-procedure.md`.

### Ballot inventory

- Machine-readable: `docs/ballot-migration-inventory-2026-11-08.json`
- Human-readable: `docs/ballot-migration-inventory-2026-11-08.md`

Summary:

| Category | Ballots | Votes |
| --- | ---: | ---: |
| Open Decide ballots | 36 | 191 |
| Archived historical ballot (`GOV-002`) | 1 | 3 |
| **Total** | **37** | **194** |

**Ballots requiring individual human adjudication:** none. All 37 match the deployment baseline wording and have consistent vote records. The binding basis is explicitly retrospective because no vote-time immutable snapshot existed.

The three `GOV-002` votes are included because they are existing `proposal_votes` records. They are historical, not an open ballot; the migration binds them for audit integrity but does not reopen voting.

The four records in the legacy `votes` collection are outside this operation; they were already handled by `proposal-votes-v1`.

---

## 5. Backup and restore requirements

Before any application startup or migration:

- take a full `mongodump` of `engage_production` (gzip/archive or equivalent);
- record the backup checksum and storage location;
- verify the backup can be restored into an isolated database;
- keep the previous application image available for rollback.

The migration itself creates new audit and revision records. If the cutover must be reversed after new votes are cast, restore the pre-cutover database backup rather than attempting to reverse individual ballot bindings.

---

## 6. Recommended order of operations

Application-level sequence; infrastructure and orchestration are the Coolify agent’s decision:

1. Back up production and confirm restore capability.
2. Deploy the release candidate and wait for startup to finish.
3. Confirm `/api/health` and basic public pages.
4. Run the production inventory read-only and compare it with the reviewed inventory.
5. Run the production plan read-only; require zero blockers.
6. Apply the bulk binding with explicit production confirmations.
7. Run the migration verification (expected 37/37, zero failures).
8. Run the application smoke tests in §7.
9. Keep monitoring through the first post-cutover voting window.

Do not run the migration before the backup. Do not apply if the inventory differs from the reviewed counts or if any blocker is reported.

---

## 7. Post-deployment application smoke tests

```text
GET /api/health                         -> 200
GET /proposals/                         -> 200; proposals visible
GET /proposals/<bound-legacy-slug>/     -> human-readable revision label
POST /api/votes (eligible member)       -> 200; tally increases
POST /api/votes (unbound ballot)        -> 400 with binding error
GET /admin/proposals/?stage=decide      -> no unbound binding forms after migration
GET /policies/                          -> explicit empty-registry explanation
GET /                                   -> canonical = https://engage.fusionparty.org.au/
GET /api/v1/policies                    -> 200; Link header uses public origin
GET /admin/ (anonymous)                 -> redirect to /member/
```

The same checks can be repeated with the browser script used for this verification. No production migration command was run by this release candidate.

---

## 8. Rollback compatibility and limitations

- Code rollback is readable because the schema is additive.
- Published registry records, branch data and amendment data are invisible to the old application; that does not corrupt them.
- **Limitation:** votes cast through the old application after rollback do not carry `revisionId`. If the new application is restored later, those records may look like mixed bound/unbound history and will fail closed. Restore the pre-cutover backup before re-upgrading, or plan an explicit reconciliation.
- The safest rollback is stop writes, restore the pre-cutover database backup, redeploy the previous image.

---

## 9. Known issues accepted for this release

1. **Policy registry is intentionally empty.** No policy records were imported. `/policies/` and `/api/v1/policies` accurately explain the empty Engage registry. This is accepted for the release candidate; it is not a reason to fabricate records.
2. **No production ballot migration has been executed.** The migration was rehearsed on an isolated clone. Production execution is a Coolify cutover step.
3. **Existing sessions were not replayed against the production secret.** Better Auth and its collections are unchanged, so continuity is expected but not proven end-to-end.
4. **Google OAuth and Resend delivery were not exercised against live providers.**
5. **GitHub Actions is not green or required.** Verification is local and reproducible; no CI repair was attempted.
6. **Production `updatedAt` values may already reflect earlier startup writes.** The inventory does not rely on them; content comparison against the deployment baseline and vote timing are the evidence.
7. A small number of inline mobile text links remain below the 44 px comfort target; this is a pre-existing minor ergonomics issue, not a release blocker.
8. The four legacy `votes` documents remain in the legacy collection and are not migrated a second time.

---

## 10. Exact release state and changed files

**Base:** `0ad210b31435c986f24549f3cd67187aa6889ca6`  
**State:** application remediation exists in the working tree on top of that commit; it has not been committed, pushed or merged.

Changed tracked files:

```text
.env.example
astro.config.mjs
package.json
src/components/ui/ProposalBallot.tsx
src/layouts/SiteLayout.astro
src/lib/db.ts
src/lib/public-api.ts
src/lib/types.ts
src/pages/admin/proposals/index.astro
src/pages/api/admin/ballots/bind.ts
src/pages/api/v1/branches/[id]/policies.ts
src/pages/api/v1/branches/index.ts
src/pages/api/v1/policies/[id].ts
src/pages/api/v1/policies/[id]/versions/[version].ts
src/pages/api/v1/policies/[id]/versions/index.ts
src/pages/api/v1/policies/index.ts
src/pages/api/v1/policy-categories.ts
src/pages/branches/index.astro
src/pages/how-it-works/index.astro
src/pages/index.astro
src/pages/policies/[slug].astro
src/pages/policies/index.astro
src/pages/proposals/[slug].astro
src/pages/proposals/index.astro
```

New application files:

```text
scripts/ballot-migration.ts
src/lib/ballot-binding.ts
src/lib/ballot-migration.ts
src/lib/ballot-migration.test.ts
src/lib/proposal-revision.ts
src/lib/public-origin.ts
src/lib/public-origin.test.ts
src/lib/rendering-regression.test.ts
src/lib/revision-label.ts
src/lib/revision-label.test.ts
docs/ballot-migration-inventory-2026-11-08.json
docs/ballot-migration-inventory-2026-11-08.md
docs/ballot-migration-rehearsal-2026-11-08.md
docs/engage-ballot-migration-procedure.md
docs/engage-release-handover-2026-11-08.md
```

The modified `docker-compose.coolify-production.yml` and `docker-compose.coolify-staging.yml`, the untracked deployment files, the research corpus and reconciliation artefacts belong to other workstreams and were not edited by this remediation.

---

## 11. Recommendation

**GO for application handover.**

All application-level blockers from the production-readiness audit are addressed and verified against a fresh isolated production-data clone. The remaining actions are controlled deployment operations: backup, deploy, inventory, plan, apply, verify and smoke test. Production ballots have **not** been migrated, and the Policy Registry remains intentionally empty.
