# RFC 0001 implementation tracker

**Status:** Living · **Updated:** 14 November 2026
**Source documents:** [RFC 0001](../rfc/0001-participatory-governance-platform-evolution.md) · [Decision register](../governance/decision-register.md) · [Known gaps](known-gaps.md)

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
| 1 | Integrity, deadlines, automatic advancement, outcome correctness | **Integrated** — deadlines, seconding, advancement and closure on PR #51; outcome validation next |
| 2 | Command layer, route policy, read models, jobs, Turnstile, notifications | **In progress** — rendering-performance and Turnstile slices integrated; command layer (#53), read models (#54) and notifications (#33) pending |
| 3 | Decision records, following, admin queues, role UX, Horizon consistency | Planned |
| 4 | Durable jobs, identity/CRM ports, observability, audit viewer, encryption hardening | Planned |
| 5 | Automatic ratification, collision resolution, amend/repeal, public APIs, elections | Partly blocked on O1–O8 |

## Programme workstreams

| Workstream | Branch | Issue | State |
|---|---|---|---|
| Phase 1 lifecycle scheduling | `feat/rfc0001-sprint1-integration` | #26, #30 | **Integrated** — seconding, 30/30 deadlines, system advancement, automatic closure, scheduler, read-only migration report |
| Rendering performance | `feat/rfc0001-sprint1-integration` | #52 | **Integrated** — harness, audit, projections, session reuse, query batching, deferred secondary panels, hydration changes |
| Turnstile and abuse protection | `feat/rfc0001-sprint1-integration` | #38 (part) | **Integrated** — server verification, protected unauthenticated actions, durable rate limiting. Headers/CSRF remain. |
| Ballot-results migration safety | — | #55 | Planned — preflight, observability, recovery |
| Governance command layer | — | #53 | Planned — next Phase 2 slice |
| Decision record and responsibility queue | — | #54 | Planned — depends on #53 |

Sprint 1 and the above slices are in PR #51 (draft, not merged).

## Immediate recommendations

| ID | Recommendation | Issue | State | Evidence / remaining work |
|---|---|---|---|---|
| I1 | Remove hard deletion of governance records | #50 | **Integrated** | `deleteProposal` refuses matters with revisions beyond the initial draft, votes, ballots, decisions, registry records, or a consequential stage. Branch-scoped `proposals.delete` cannot confer authority (national-only in the catalogue). Tests: `governance-integrity-sprint1.test.ts`, `rbac-authority-sprint1.test.ts`. |
| I2 | Make ballot deadlines mandatory and audited | #26 | **Integrated** | Seconding starts a 30-day deliberation clock and performs Propose → Deliberate. The scheduler advances at the deadline as `system:lifecycle-scheduler`, binds the latest revision and sets a 60-day-from-seconding ballot close. Officer-opened ballots default to 30 days; an explicit future date wins. Due ballots are closed once with a `ballot.closed` event. Idempotent events, dry-run/apply CLI, and a read-only legacy deadline report. Tests: `lifecycle-scheduler.test.ts`, `lifecycle-scheduler-mongo.test.ts`. Remaining: production cron wiring and notification fan-out. |
| I3 | Stop writes during session resolution; fix CRM national-row conflict | #32 | **Partial** | CRM-sourced memberships cannot be overwritten by self-service; the national row is exempt from the geographic conflict check; manual verification records source and verifier. Tests: `membership-crm-sprint1.test.ts`. Missing: unique `(branchId, memberId)` index + duplicate-resolving migration, and branch-model documentation. |
| I4 | Enforce the permission catalogue | #31 | **Partial** | `ballots.bind`, `proposals.delete`, `proposals.manage_supersession`, `proposals.view_archived`, `comments.moderate`, `amendments.*`, `branches.manage`, `branches.refer_proposals`, `sense_box.review` are enforced in the domain or route. Branch grants for national-only permissions are ignored (defence in depth). Remaining: role administration UX (#41), any dead keys found by the catalogue audit. |
| I5 | Make result recording atomic, idempotent and audited | #26, #50 | **Integrated** | `recordFormalDecision` writes result, ballot certification and governance event in one transaction; repeated identical payloads are idempotent; conflicting payloads are refused. Tests use the real-MongoDB replica set for the voting suite; the governance-integrity suite still needs a real-MongoDB atomicity case. |
| I6 | Record every lifecycle and ballot act | #50 | **Integrated** | Stage transitions (including seconding and scheduled advancement), ballot bind/unbind, decision recording, ballot closure and amendment open/close/accept write governance events. Remaining: notification fan-out (#33), audit viewer (S8). |
| I7 | Rebind re-opened ballots explicitly | #26 | **Integrated** | Returning a zero-vote ballot to Deliberate unbinds the revision and emits `ballot.unbound`; re-entry binds the current revision. Substantive edits are refused once votes exist. Tests: `governance-integrity-sprint1.test.ts`. |
| I8 | Close the small high-risk defects | #27, #32, #35, #42 | **Partial** | Ratification authority is cross-checked against the governance authority and the recorded ballot decision. Remaining: public supersession visibility (#35), comment moderation state and audit trail (#42), moderation UX. |
| I9 | Wire essential notifications through an outbox | #33 | **Planned** | `dispatchMemberNotification` still has no production caller. |
| I10 | Security and operations baseline | #38, #39 | **Partial** | Turnstile server verification for magic-link, sign-up (if enabled) and public priority submission; shared MongoDB fixed-window rate limiting with hashed identifiers; authenticated voting unchallenged. Remaining: CSP/HSTS/frame/content-type headers, full CSRF/Origin coverage, metrics and alerting. |
| I11 | Documentation truth pass | #44, #46 | **Partial** | Canonical documentation set exists; RFC, decision register and this tracker added. Older dated documents remain stale. |
| I12 | Replace full-collection proposal list reads | #52 | **Partial** | Measured −44% document DB commands and −54% DB time across ten page/identity combinations. Session resolved once per request; list reads projected and deduplicated; secondary admin panel is a server island; unnecessary `client:load` deferred. Remaining: paginate `/admin/proposals/` (~1 MB HTML), remove per-vote decryption and full vote scans via a tally read model, drop `details` from the admin register. See `docs/status/rendering-performance-audit.md`. |

## Strategic recommendations

| ID | Recommendation | Issue | State | Notes |
|---|---|---|---|---|
| S1 | Governance command layer and central route policy | #53 | **Planned** | Issue opened. Coordinate read queries with #52. |
| S2 | Decision record and lineage read model | #54 | **Planned** | Depends on I12/S1. |
| S3 | Ballot lifecycle: open, close, certify | #26 | **Partial** | Open, revision binding and scheduled close exist; certification remains an explicit officer act. Automated certification/ratification is Phase 5. |
| S4 | Read models and tally projections | — | **Planned** | Depends on I12/S1. |
| S5 | Durable outbox and job runner | #33, #39 | **Planned** | Notification and scheduler infrastructure. |
| S6 | Identity and membership ports | #32 | **Partial** | CRM membership port exists in `membership-verification.ts`; identity port is deferred (D31). |
| S7 | Administrative responsibility queue and role legibility | #41, #54 | **Planned** | Queue and decision-record view tracked in #54; role legibility in #41. |
| S8 | Observability and audit viewer | #39 | **Planned** | Audit events are now written; no viewer or metrics. |

## Long-term opportunities

| ID | Recommendation | Issue | State | Notes |
|---|---|---|---|---|
| L1 | Threshold, quorum and turnout rule engine | #28 | **Partial** | D8/D9 settle simple majority and the absence of quorum. A computed Yes-versus-No check with an audited override is implementable. Abstention denominator (O1) remains open; no rule engine yet. |
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
3. **Index migration is one-way.** The `ballot_results` unique index moved from `proposalId` to `ballotId`. Rollback requires deleting later results. A preflight and dry-run migration is required before production (#55).
4. **Real-MongoDB coverage of governance writes.** The voting suite runs on MongoDB; the governance-integrity suite uses the in-memory database. Add replica-set cases for the atomic result, deletion guard and transition events in Phase 1.
5. **Historical records.** Existing open ballots without deadlines and historical CRM verification reviews are not migrated by this branch. No unique branch-membership index exists yet, so concurrent membership writes still rely on application upserts.
6. **Performance evidence is local.** The rendering audit measures a production build against synthetic data on one machine. It is indicative, not field or production SLA evidence; server-island work still consumes database time after the response.
7. **Turnstile is unexercised against Cloudflare.** Siteverify was stubbed in all tests. Production requires both keys or protected routes correctly return 503.

## Next workstream

Phase 1, in this order:

1. ~~Proposal lifecycle scheduling~~ — integrated: seconding, deliberation and ballot deadlines, system advancement, automatic closure, idempotent scheduler.
2. Computed outcome validation (Yes versus No, tie fails) with an audited officer override; do not decide abstentions.
3. Real-MongoDB concurrency and crash-recovery tests for the remaining governance writes (deletion guard, transition events, result atomicity).
4. `ballot_results` migration preflight and recovery procedure (#55).
5. Notification outbox foundation, so scheduled transitions produce durable notices.
