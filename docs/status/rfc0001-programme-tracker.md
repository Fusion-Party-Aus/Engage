# RFC 0001 implementation tracker

**Status:** Living · **Updated:** 16 November 2026
**Source documents:** [RFC 0001](../rfc/0001-participatory-governance-platform-evolution.md) · [Decision register](../governance/decision-register.md) · [Known gaps](known-gaps.md) · [Orchestrator handover](orchestrator-handover.md)

This is the authoritative progress record for the RFC 0001 programme. Each recommendation maps to an issue, a state, and the evidence that justifies that state. An entry is only **Done** when the behaviour is enforced by code, covered by tests that run against a real MongoDB replica set where persistence is involved, and reflected in the documentation.

Status values:

| Value | Meaning |
|---|---|
| **Done** | Implemented, tested, documented, merged. |
| **Integrated** | Implemented and tested on an integration branch; not merged. |
| **Partial** | Some behaviour exists; the named gate or guarantee is missing. |
| **Planned** | Committed to the programme; no implementation started. |
| **Deferred** | Out of this programme or blocked on a maintainer decision. |

## Programme phases

| Phase | Scope | State |
|---|---|---|
| Integration | Combine Sprint 1 branches, reconcile with decisions, verify | **Integrated** — see [integration report](sprint1-integration-report.md) |
| 1 | Integrity, deadlines, automatic advancement, outcome correctness | **Done** — deadlines, seconding, advancement, closure and computed outcome validation merged to `main`; replica-set governance coverage added |
| 2 | Command layer, route policy, read models, jobs, Turnstile, notifications | **In progress** — rendering-performance, Turnstile and notification slices merged; ballot command layer and route policy extracted (#53, partial); decision record and administrator responsibility queue built (#54, multi-amendment derivation outstanding); admin register paginated with a vote-free read (#52, merged); public lists paginated and vote-free (#52, `feat/public-read-models`) |
| 3 | Decision records, following, admin queues, role UX, Horizon consistency | Planned |
| 4 | Durable jobs, identity/CRM ports, observability, audit viewer, encryption hardening | Planned |
| 5 | Automatic ratification, collision resolution, amend/repeal, public APIs, elections | Partly blocked on O1–O8 |

## Programme workstreams

| Workstream | Branch | Issue | State |
|---|---|---|---|
| Phase 1 lifecycle scheduling | `feat/rfc0001-sprint1-integration` | #26, #30 | **Integrated** — seconding, 30/30 deadlines, system advancement, automatic closure, scheduler, read-only migration report |
| Rendering performance | `main` (#51, #103, #111) | #52 | **Partial** — harness, audit, projections, session reuse, query batching, deferred secondary panels and hydration changes merged; admin register paginated with a vote-free, rationale-free list read; public lists paginated and vote-free (`feat/public-read-models`). Remaining: the proposal detail page's own live tally |
| Turnstile and abuse protection | `feat/rfc0001-sprint1-integration` | #38 (part) | **Integrated** — server verification, protected unauthenticated actions, durable rate limiting. |
| Perimeter headers, CSP and origin coverage | `feat/security-headers-csrf` | #38 (part) | **Integrated** — `src/middleware.ts` header set with conditional HSTS; Astro hash-based CSP with Turnstile and Plausible hosts; cross-site rule for every state-changing method. Real-browser evidence and 19 unit tests. See [perimeter security](../security/perimeter.md). Remaining: proxy headers for static assets, CSP reporting endpoint, CSRF tokens, production header observation. |
| Ballot-results migration safety | `fix/ballot-results-index-migration` | #55 | **Done** — read-only preflight, backup, verified apply, loud failure, recovery report, replica-set tests. See [procedure](../ballot-results-index-migration.md). |
| Computed ballot outcome validation | `main` (`762f76c`, PR #86) | #28 | **Done for the decided part** — Yes-versus-No comparison (D9), no quorum or turnout (D8), abstentions excluded without a denominator (D10/O1), versioned rule basis, stored tally, closed-ballot requirement, bound-set refusal, audited override and legal-text update. Replica-set tests. Abstention denominator, ranked choice and a computed check for amendment endorsement ballots remain open. |
| Governance command layer | `main` (#94) | #53 (part) | **Partial** — typed ballot commands (`ballot.bind`, `ballot.record_result`) and central route policy extracted; routes are thin and the domain functions are unchanged. Proposals, amendments and membership remain |
| Decision record and responsibility queue | `main` (#105, #106) | #54 | **Partial** — member-facing decision record for zero- and one-amendment matters (voted wording, revision history, amendment outcomes, certified result, publication state, explicit collision-review state), plus the administrator responsibility queue at `/admin/responsibilities/` with server-side permission and branch filtering; tests incl. replica set. Outstanding: multi-amendment derivation (D17–D18) |

Sprint 1 and the slices above were merged to `main` as `3b36947` (PR #51) on 14 November 2026. The [handover brief](orchestrator-handover.md) predates that merge; Phase 2 work now branches from `main`.

## Immediate recommendations

| ID | Recommendation | Issue | State | Evidence / remaining work |
|---|---|---|---|---|
| I1 | Remove hard deletion of governance records | #50 | **Integrated** | `deleteProposal` refuses matters with revisions beyond the initial draft, votes, ballots, decisions, registry records, or a consequential stage. Branch-scoped `proposals.delete` cannot confer authority (national-only in the catalogue). Tests: `governance-integrity-sprint1.test.ts`, `rbac-authority-sprint1.test.ts`. |
| I2 | Make ballot deadlines mandatory and audited | #26 | **Integrated** | Seconding starts a 30-day deliberation clock and performs Propose → Deliberate. The scheduler advances at the deadline as `system:lifecycle-scheduler`, binds the latest revision and sets a 60-day-from-seconding ballot close. Officer-opened ballots default to 30 days; an explicit future date wins. Due ballots are closed once with a `ballot.closed` event. Idempotent events, dry-run/apply CLI, and a read-only legacy deadline report. Tests: `lifecycle-scheduler.test.ts`, `lifecycle-scheduler-mongo.test.ts`. Remaining: production cron wiring and notification fan-out. |
| I3 | Stop writes during session resolution; fix CRM national-row conflict | #32 | **Partial** | CRM-sourced memberships cannot be overwritten by self-service; the national row is exempt from the geographic conflict check; manual verification records source and verifier. Tests: `membership-crm-sprint1.test.ts`. Missing: unique `(branchId, memberId)` index + duplicate-resolving migration, and branch-model documentation. |
| I4 | Enforce the permission catalogue | #31 | **Partial** | `ballots.bind`, `proposals.delete`, `proposals.manage_supersession`, `proposals.view_archived`, `comments.moderate`, `amendments.*`, `branches.manage`, `branches.refer_proposals`, `sense_box.review` are enforced in the domain or route. Branch grants for national-only permissions are ignored (defence in depth). Remaining: role administration UX (#41), any dead keys found by the catalogue audit. |
| I5 | Make result recording atomic, idempotent and audited | #26, #50 | **Integrated** | `recordFormalDecision` writes result, ballot certification and governance event in one transaction; repeated identical payloads are idempotent; conflicting payloads and changed override reasons are refused; a live or closed-without-evidence ballot is refused. Tests use the real-MongoDB replica set for the voting suite; `ballot-outcome-mongo.test.ts` runs the result, certification and audit writes on the replica set with the computed tally, bound-set refusal and audited override. |
| I6 | Record every lifecycle and ballot act | #50 | **Integrated** | Stage transitions (including seconding and scheduled advancement), ballot bind/unbind, decision recording, ballot closure and amendment open/close/accept write governance events. Remaining: notification fan-out (#33), audit viewer (S8). |
| I7 | Rebind re-opened ballots explicitly | #26 | **Integrated** | Returning a zero-vote ballot to Deliberate unbinds the revision and emits `ballot.unbound`; re-entry binds the current revision. Substantive edits are refused once votes exist. Tests: `governance-integrity-sprint1.test.ts`. |
| I8 | Close the small high-risk defects | #27, #32, #35, #42 | **Partial** | Ratification authority is cross-checked against the governance authority and the recorded ballot decision. Remaining: public supersession visibility (#35), comment moderation state and audit trail (#42), moderation UX. |
| I9 | Wire essential notifications through an outbox | #33 | **Partial** | `notification_outbox` with a unique `dedupeKey`, claim lease, bounded retry with backoff and a two-year retention TTL on terminal rows. Wired for `new_ballots` (scheduler advancement into Decide) and `closing_deadlines` (approved seven-day window). The audience is `getProposalEligibility` plus `canViewProposal`, re-checked at drain; a revoked membership is suppressed. `npm run notifications:drain` is dry-run by default and `--apply` records a `job_runs` entry. Tests: `notification-outbox.test.ts`, `notification-outbox-mongo.test.ts`. Remaining: `governance_outcomes` (result route refactor), `contribution_responses` (product decision), the email channel and production scheduler wiring. |
| I10 | Security and operations baseline | #38, #39 | **Partial** | Turnstile server verification for magic-link, sign-up (if enabled) and public priority submission; shared MongoDB fixed-window rate limiting with hashed identifiers; authenticated voting unchallenged. Perimeter headers with conditional HSTS, a hash-based CSP allowing only Turnstile and the first-party Plausible host, and a cross-site rule for every state-changing method on `feat/security-headers-csrf` (#38), with a real-browser check. A durable `job_runs` ledger (90-day TTL), authorised-run recording for the scheduler/digest/verification, `npm run ops:health` with exit codes 0/2/1, per-check thresholds and a runbook in `docs/architecture/build-deploy-operations.md`. Remaining: proxy headers for static assets and Astro's early 403, CSP violation reporting, CSRF tokens, production cron wiring and observed production runs, metrics/tracing, alert delivery, admin health view. |
| I11 | Documentation truth pass | #44, #46 | **Partial** | Canonical documentation set exists; RFC, decision register and this tracker added. Older dated documents remain stale. |
| I12 | Replace full-collection proposal list reads | #52 | **Partial** | Measured −44% document DB commands and −54% DB time across ten page/identity combinations. Session resolved once per request; list reads projected and deduplicated; secondary admin panel is a server island; unnecessary `client:load` deferred. The admin register (merged in #103, measured at `c1f72c0`) now reads one 25-row projected page in MongoDB, never reads `proposal_votes`, and shows the certified tally from `ballot_results`: HTML 938 KB → 284 KB (−70%), document DB time 28.7 → 15.0 ms, commands 19 → 16, TTFB 103 → 56 ms. The signed-in header no longer ships React (`perf/header-no-react`, measured at `ad34a17`): the notification bell is a native disclosure that fetches after idle or first open, so `/`, `/proposals/`, `/policies/` and `/admin/proposals/` drop from ~345–357 KB to 16–28 KB of JavaScript with document and browser DB commands unchanged. `/proposals/` is now server-paginated at 25 rows with filters and canonical/rel links, and both public lists read the display-only `ballot_tallies` projection and `ballot_results` instead of scanning and decrypting votes (`feat/public-read-models`, before `57402f0`, after `65ace21`). A profiler window records 3 → 0 `proposal_votes` operations on `/proposals/` and 6 → 0 on `/`; `getMore` batches fall from 3 to 1 on every measured public page; document DB time on `/` falls 29.7 → 15.6 ms anonymous and 32.5 → 24.2 ms member. `/proposals/` HTML grows from 94.9 KB to 128.7 KB because it renders 25 rows instead of 15 (the specified page size), not because of added markup per row. Remaining: the proposal detail page still computes its single live bound tally from votes. See `docs/status/rendering-performance-audit.md`. |

## Strategic recommendations

| ID | Recommendation | Issue | State | Notes |
|---|---|---|---|---|
| S1 | Governance command layer and central route policy | #53 | **Partial** | Ballot lifecycle extracted: typed `ballot.bind` and `ballot.record_result` commands, central `GOVERNANCE_ROUTE_POLICY` table and drift tests. Proposals, amendments and membership remain route-local. |
| S2 | Decision record and lineage read model | #54 | **Partial** | `buildDecisionRecord` and `/proposals/<slug>/record/` compose the voted wording, immutable revision history, amendment outcomes, certified result and publication state, and derive adopted wording under D15/D16 only. `/admin/responsibilities/` adds the permission- and branch-filtered administrator queue. Two or more applied amendments show an explicit collision-review state (D17–D18); multi-amendment derivation is still outstanding. Replica-set coverage in `decision-record-mongo.test.ts` and `responsibility-queue-mongo.test.ts`. |
| S3 | Ballot lifecycle: open, close, certify | #26 | **Partial** | Open, revision binding and scheduled close exist; certification remains an explicit officer act. Automated certification/ratification is Phase 5. |
| S4 | Read models and tally projections | #52 | **Partial** | Display-only `ballot_tallies` projection per `(ballotId, revisionId)`, written best-effort after a committed vote and never read by certification. Public lists (`/`, `/proposals/`) and the admin register read it or the certified `ballot_results`; missing or older-than-ten-minute rows render as a neutral tally-updating state. `npm run ballots:tally-projection` reports, rebuilds and verifies rows. Remaining: the proposal detail page's live bound tally and any read model for member-private views. |
| S5 | Durable outbox and job runner | #33, #39 | **Partial** | The governance notification outbox and drain exist for two events (ballot opened, closing soon); scheduler and drain runs record `job_runs` entries. Remaining: the other governance events, an email channel and a general command/job runner. |
| S6 | Identity and membership ports | #32 | **Partial** | CRM membership port exists in `membership-verification.ts`; identity port is deferred (D31). |
| S7 | Administrative responsibility queue and role legibility | #41, #54 | **Partial** | `/admin/responsibilities/` and `buildResponsibilityQueue` group ballot outcomes, closing ballots, ballot binding, overdue advancement, amendment decisions, member verification and publication. Items are filtered server-side by the acting permission and branch scope; member verification is a count only. An overdue advancement that a blocking amendment prevents points to the amendment rather than inviting a bypass. Publication failures are not queued because `publication_events` has no durable failed state; ratified-but-unpublished records are. Tests: `responsibility-queue.test.ts`, `responsibility-queue-mongo.test.ts`. Role legibility (#41) remains outstanding. |
| S8 | Observability and audit viewer | #39 | **Partial** | Audit events are now written. Scheduled runs record a `job_runs` ledger entry (90-day TTL) and `npm run ops:health` reports governance scheduling, ballot deadlines, digest, verification backlog, email delivery and Turnstile with exit-coded states. No metrics backend, alert delivery, admin view or audit viewer yet. |

## Long-term opportunities

| ID | Recommendation | Issue | State | Notes |
|---|---|---|---|---|
| L1 | Threshold, quorum and turnout rule engine | #28 | **Partial** | Computed Yes-versus-No validation with a written, audited override is implemented (`simple-majority-d9-v1`); certification requires a closed ballot, unbound votes are refused, a tie and zero votes are not successful, and no quorum or turnout applies (D8, D9). The Terms of Use §9 now describes the rule (version 1.1; publication and the acceptance gate remain #40). Still open: the abstention denominator (O1/D10), ranked choice (O2) and any computed check for amendment endorsement ballots, which remain officer-supplied. |
| L2 | Amend or repeal from a published policy | #37 | **Planned** | Governance dependency: whether a normal proposal suffices. |
| L3 | Confirmation ballots and multiple ballot instances | #30 | **Partial** | Result cardinality is corrected (one result per ballot, multiple ballots per matter possible). Confirmation ballots are not specified (O3). |
| L4 | Shared Fusion identity / OIDC | — | **Deferred** | D31: seam only. |
| L5 | Public API expansion and deprecation policy | — | **Planned** | D27 approves a full public proposal API; versioning, visibility and confidentiality model still need specification. |
| — | National Neon policy baseline import | #36 | **Deferred** | D33 excludes import, mapping, backfill and publication from this programme. |

## Integrity findings from RFC §7.2

| Finding | State | Evidence |
|---|---|---|
| G1 Hard deletion of a voted matter | **Integrated** | I1 |
| G2 Re-opened ballot not rebound | **Integrated** | I7 |
| G3 Result, certification and audit are separate writes | **Integrated** | I5 |
| G4 Stage transitions not audited | **Integrated** | I6 |
| G5 Amendment ballots not audited | **Integrated** | I6; amendment routes now emit events |
| G6 Moderators can open Decide | **Integrated** | D5; `ballots.bind` required |
| G7 Ratifying authority not cross-checked | **Integrated** | I8; `ratify.ts` compares both authorities |
| G8 Self-service branch switching revokes CRM membership | **Integrated** | I3 |
| G9 National row conflicts with CRM assignment | **Integrated** | I3 |
| G10 Permission delegation is untrue | **Partial** | I4; remaining keys and #41 |
| G11 No eligibility snapshot | **Resolved by decision** | D2: eligibility at vote time, no snapshot |
| G12 Vote admission not transactional | **Integrated** | Transactional `castVote` with revision consistency checks |
| G13 Hard deletion of comments, no moderation record | **Partial** | #42 |
| G14 Public supersession links to unpublished policy | **Planned** | #35 |

## Cross-slice risks carried by the integration

1. **Deadline semantics are scheduled, but not yet operated.** The code creates and enforces deadlines and ships a dry-run/apply scheduler. Production cron wiring, alerting on missed runs, and notification fan-out are still required.
2. **Automatic advancement uses a system actor.** It does not grant `ballots.bind` to the scheduler. A late run past the 60-day ceiling is refused and reported rather than opening an unusable ballot; this needs operational monitoring.
3. **Index migration is explicit and recoverable.** The `ballot_results` unique index moved from `proposalId` to `ballotId`. Startup now reports a legacy collection instead of reshaping it; `npm run ballots:results-index` performs preflight, backup, verified apply and a recovery report (#55).
4. **Real-MongoDB coverage of governance writes.** Resolved in `src/lib/governance-integrity-mongo.test.ts` (PR #91): the deletion guard, transition-event atomicity, result idempotency/atomicity and conditional-write concurrency now run against a replica set, plus a closed-ballot certification case. Crash/rollback injection mid-transaction remains untested.
5. **Historical records.** Existing open ballots without deadlines and historical CRM verification reviews are not migrated by this branch. No unique branch-membership index exists yet, so concurrent membership writes still rely on application upserts.
6. **Performance evidence is local.** The rendering audit measures a production build against synthetic data on one machine. It is indicative, not field or production SLA evidence; server-island work still consumes database time after the response.
7. **Turnstile is unexercised against Cloudflare.** Siteverify was stubbed in all tests. Production requires both keys or protected routes correctly return 503.

## Next workstream

Phase 1, in this order:

1. ~~Proposal lifecycle scheduling~~ — integrated: seconding, deliberation and ballot deadlines, system advancement, automatic closure, idempotent scheduler.
2. ~~Computed outcome validation (Yes versus No, tie fails) with an audited officer override; do not decide abstentions~~ — merged on `main` (`762f76c`, `simple-majority-d9-v1`). Abstentions remain recorded but outside the comparison, and no denominator is encoded.
3. ~~Real-MongoDB concurrency and crash-recovery tests for the remaining governance writes~~ — deletion guard, transition events, result atomicity and closed-ballot certification now run on a replica set (PR #91). Crash/rollback injection is still untested.
4. ~~`ballot_results` migration preflight and recovery procedure~~ — done (#55).
5. Notification outbox foundation, so scheduled transitions produce durable notices.
