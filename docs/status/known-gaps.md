# Known gaps, defects and open decisions

**Status:** Current · **Verified:** 13 November 2026

> **RFC 0001 programme status.** Several Priority 1 items below are implemented on
> `feat/rfc0001-sprint1-integration` and awaiting merge. Do not treat this page as
> the merge state. The [programme tracker](rfc0001-programme-tracker.md) records
> what is integrated, tested and still missing; the
> [decision register](../governance/decision-register.md) records which governance
> questions the maintainer has now answered. Where they conflict, the decision
> register wins. This page continues to describe the defects that remain on `main`.

This is an honest register, not a task list with commitments. Items are grouped by risk. Each names the impact and the evidence; proposed fixes are directions, not approved governance.

**Do not silently "fix" a governance gap by inventing a rule.** Several items below are open decisions for Fusion.

## Priority 1 — correctness or authority risk

### 1. A re-opened ballot is not rebound to revised wording

**Impact:** A proposal can return to Deliberate after a ballot, have its wording edited (when no votes exist), then return to Decide while retaining the previous `ballotRevisionId`. The ballot remains frozen on superseded wording.

**Resolved on `feat/rfc0001-sprint1-integration`:** a zero-vote return clears the binding and emits `ballot.unbound`; re-entry binds the current revision; edits are refused once votes exist.

**Evidence:** `saveProposal` binds only when `ballotRevisionId` is unset (`src/lib/store.ts`). The field is never cleared.

**Direction:** On re-entry to Decide with zero votes, either rebind explicitly and record an event, or refuse the transition until an officer chooses. Never rebind silently when votes exist. This needs a governance decision about re-opening.

### 2. New ballots have no closing deadline

**Impact:** Only migrated ballots have a `ballotClosesAt`. No API writes a deadline for a newly opened ballot, so a new ballot remains open indefinitely. Closing-soon notifications and the attention queue cannot work correctly.

**Resolved on `feat/rfc0001-sprint1-integration`:** opening a ballot writes a future deadline (explicit or the approved 30-day default) and the scheduler closes it. Legacy ballots without deadlines are reported, not rewritten.

**Evidence:** `ballotClosesAt` is read and copied by binding/amendment opening, but no create/update path sets it. The only deadline constant is the one-off `2027-01-14T13:00:00Z` migration.

**Direction:** Add an explicit ballot scheduling act with a required close time, audit event and permission. The permitted duration is a governance decision.

### 3. A moderator can open or reopen the Decide stage

**Impact:** Moderators cannot bind a ballot or record a result, but they can move a matter into Decide through the ordinary stage transition. That blurs the operational/governance boundary described in the product.

**Resolved on `feat/rfc0001-sprint1-integration`:** entering Decide requires `ballots.bind`.

**Evidence:** `saveProposal` gates on `isStaff` (moderator or administrator). Only binding and result recording have separate ballot permissions.

**Direction:** Require a ballot-specific permission for transitions into Decide, and decide whether moderators should hold it.

### 4. Ratifying authority is not cross-checked

**Impact:** A national administrator may ratify using an `authorityBranchId` that differs from the authority recorded on the successful ballot result or the proposal's governance authority.

**Evidence:** `POST /api/admin/policies/ratify` validates that the branch is recognised but does not compare it with the ballot result.

**Direction:** Require equality with the recorded decision authority, or document an explicit override with an audit reason.

### 5. RBAC is only partly enforced

**Impact:** Several permission keys are declared but unused; some routes still use `isAdmin`/`isStaff`/`isBranchAdmin`. A custom role granted `proposals.edit` may still be unable to edit because `saveProposal` gates on branch-administrator status. Administrators may believe delegation works when it does not.

**Evidence:** `PERMISSION_CATALOGUE` in `src/lib/rbac.ts`; `saveProposal`; admin routes. Dead or partial keys include `proposals.delete`, `comments.moderate`, `proposals.view_archived`, `proposals.manage_supersession`, `amendments.resolve`, `amendments.apply`, `branches.manage`, `sense_box.review` and `proposals.edit` for custom roles.

**Direction:** Consolidate on the catalogue, one domain at a time, with tests that prove delegation and denial. Do not add new legacy flags.

### 6. Self-service branch switching can revoke a CRM-sourced membership

**Impact:** A member switching branches could revoke an externally authoritative membership, which the admin paths explicitly forbid.

**Resolved on `feat/rfc0001-sprint1-integration`:** the self-service path applies the same source guard.

**Evidence:** `chooseBranchMembership` does not call `assertLocalMembershipMutation`, unlike admin mutation paths.

**Direction:** Apply the same source guard to self-service and add a test.

### 7. Notification fan-out is built but unwired

**Impact:** Opening a ballot or recording an outcome does not create in-app notifications or push messages, despite the notification model and preferences implying it might. Only membership verification and digest email send today.

**Evidence:** `dispatchMemberNotification` in `src/lib/notifications.ts` has no production caller.

**Direction:** Wire chosen governance events with dedupe, preferences and a delivery record. Decide which events are essential versus engagement.

### 8. Public supersession can link to an unpublished policy

**Impact:** A published policy may name a successor that is only `adopted`. The public policy page renders the successor link even when that successor has no public page, producing a dead end and disclosing that a successor exists.

**Evidence:** `supersede.ts` accepts an adopted successor; `/policies/[slug].astro` renders `supersededBy` without a visibility check. This contradicts `docs/governance/historical-access-policy.md`.

**Direction:** Either require the successor to be published, or suppress the link unless the viewer may see the target. Update the policy document.

## Priority 2 — data integrity, security and operations

### 9. No inter-amendment conflict detection

Two amendments can edit the same field and both be `ready`. Conflict detection compares an amendment against the proposal revision, not against other amendments. Applying them sequentially may produce an unintended combined wording.

**Direction:** Detect field overlap at resolution time and require an explicit precedence decision.

### 10. Results are officer-supplied and unvalidated against the tally

The result endpoint does not compare the tally, check turnout, or enforce a threshold. This is deliberate while rules are absent, but it means a recorded result can contradict the votes.

**Direction:** Keep manual recording until thresholds, quorum and ties are approved. Then add a computed check with an audit override.

### 11. National membership row can conflict with CRM assignment

`ensureNationalMembership` creates an active national `branch_memberships` row for verified sessions. CRM geographic assignment treats any other active row as a conflict, which can produce a `branch_conflict` review after sign-in.

**Direction:** Treat the national row as a subscription or exempt it from the conflict check. Confirm the intended model before changing data.

### 12. No unique index on branch membership

There is no unique `(branchId, memberId)` index; correctness relies on application upserts. Concurrent writes could duplicate a membership.

**Direction:** Add a partial unique index and a migration that resolves existing duplicates first.

### 13. Manual verification lacks provenance

Manual `saveMember` verification records `updatedBy` and `verifiedAt` but not `verifiedBy` or `verificationSource`, unlike CRM verification.

**Direction:** Record the verifying officer and source consistently.

### 14. Comment moderation has no record

Comments can be deleted by staff, but there is no moderation state, reason or audit event. `comments.moderate` is declared but unused.

**Direction:** Decide whether moderation is deletion or a visible state. Record the actor, reason and time either way.

### 15. Perimeter security is incomplete

No CSP, HSTS, `X-Frame-Options` or `X-Content-Type-Options`; no general API rate limiting; CSRF/Origin checks are partial. Cookies rely on `SameSite=Lax` for many routes.

Cloudflare Turnstile and a shared MongoDB fixed-window limiter now protect the abuse-prone unauthenticated actions (Sense Box submission and magic-link sign-in) — see [security/turnstile.md](../security/turnstile.md). Authenticated voting is deliberately not challenged. General API rate limiting, the security headers and complete CSRF coverage remain.

**Direction:** Add headers at the reverse proxy or app boundary, then extend origin checks to every state-changing route. Document residual risk.

### 16. The legal acceptance gate is inactive

The gate code is implemented, but the documents are `owner-authorised` with placeholder effective dates, so acceptance is not required.

**Direction:** Publish the legal documents and set `LEGAL_ACCEPTANCE_ENABLED` only after approval. Do not enable it as a shortcut.

### 17. The in-memory database is not faithful

Projections and indexes are no-ops and there are no transactions. Development and some tests can pass where production would behave differently.

**Direction:** Run persistence-sensitive tests against real MongoDB. Do not rely on in-memory behaviour for uniqueness or minimisation.

### 18. Amendments can open a ballot without being resolved

`open-ballot` accepts `proposed` as well as `ready`. A proposed amendment can therefore skip the review/rebind step.

**Direction:** Require `ready`, or document why an unreviewed amendment is permitted in the ballot.

### 19. Branch referral creation skips the permission catalogue

`POST /api/admin/branches/referrals` checks `isAdmin`, not `branches.refer_proposals`.

**Direction:** Use the catalogue; test delegation.

### 20. Role administration still exposes implementation detail

`RolesManager.tsx` renders raw permission keys and uses `window.prompt`, contrary to `AGENTS.md`.

**Direction:** Present grouped, human-readable permissions and a proper dialog flow.

### 21. No scheduled jobs are enabled in Coolify production

Digest and CRM verification endpoints exist, but no scheduler is configured. No email digest or verification cycle runs by default.

**Direction:** Configure and monitor an external scheduler. Treat missing jobs as an operational incident.

## Priority 3 — product and documentation gaps

### 22. The Policy Registry is empty on a fresh install

The seed contains 78 **proposals**, not adopted policy. There is no national baseline import, no `policy_revisions` for legacy adopted policy and no administrative import flow. This is the largest gap between the product story and the shipped state.

**Direction:** A reviewed baseline import with explicit provenance and publication authority. This is a governance decision, not only an engineering task.

### 23. Published policy cannot be amended or repealed from its own page

A member can draft a new proposal, but there is no `targetPolicyId` or change type that connects it to an existing policy. Supersession is administrative.

**Direction:** Add an explicit amend/repeal relationship with lineage and a ballot path.

### 24. Notice periods and confirmation ballots remain undefined

**Resolved on `feat/rfc0001-sprint1-integration`:** policy proposals require a seconder; seconding opens a 30-day deliberation clock; the scheduler advances and closes ballots automatically. Eligibility is evaluated at vote time by decision, so there is no electorate snapshot.

Still open: notice periods, scheduled opening, confirmation ballots, and whether staff may create directly in a later stage. See decision register O3, O9 and O10.

### 25. Documentation drift remains in older files

Known stale or contradictory documents:

- `docs/operations.md` — removed endpoints and scripts.
- `docs/engage-legal-privacy-review-2026-11-08.md` — predates CRM verification and Plausible.
- `docs/coolify-deployment.md` — stale status banner.
- `docs/member-engagement.md` — older ballot deadline.
- `docs/engage-ux-journeys.md` — old test counts.
- `docs/adr/0003-reclaim-mvp-node-mongodb.md` — describes a transactional ballot-admission protocol not implemented; references missing ADR 0001/0002.
- `docs/governance/reporting-confidentiality-policy.md` — says identifiable ballots are restricted to `isAdmin`, while code also permits a delegated national permission.
- `README.md` — corrected in this documentation pass to distinguish proposals from published policy.

### 26. No observability beyond logs and health

There are no metrics, traces or alerting. Failures in email, cron or verification are visible only through admin screens and logs.

### 27. No election/returning officer role

The identifiable-ballot boundary is national administrator or a delegated national permission. A dedicated election-officer role is recommended but not modelled.

## Governance decisions

The maintainer answered the RFC 0001 questionnaire on 14 November 2026. The
[decision register](../governance/decision-register.md) is now canonical; the
list below is retained only to show which questions are settled and which remain.

| Question | State |
|---|---|
| **G1** Authority to treat legacy national policy as published | Deferred with the National Neon import (D33, #36). No import or mapping may occur. |
| **G2** Instrument classification | Still open. Do not infer. |
| **G4** Relationship between Reclaim and the national platform | Still open. |
| **G6** Whether seconding is required | **Answered:** required before Deliberate (D3). Mechanism not yet implemented. |
| **G7** Deliberation and ballot periods | **Answered:** 30 days deliberation, 30 days ballot, 60-day ceiling (D4–D7). |
| **G8** Qualifying membership for each ballot class | **Answered in principle:** eligibility at vote time; one geographic and one constituent branch; National for all (D2, D21). |
| **G9** Thresholds, quorum, ties, abstentions | **Partly answered:** simple majority, tie fails, no quorum (D8, D9). Abstention denominator remains open (D10, O1). |
| **G10** Early closure | **Deferred:** no irreversible-outcome early closure until a correct model exists (D12). |
| **G11** Preferential amendment method | **Direction only:** direct choice for two, ranked choice for three or more; method and tie handling unspecified (D18). |
| **G12** Delegated or automatic ratification | **Answered in principle:** automatic for zero or one amendment; collision review for two or more (D14–D20). |
| **G13** Ballot secrecy versus officer-identifiable ballots | **Answered:** encrypted by default; individual choices never publicly identifiable; identifiable access remains restricted (D26, D29). |
| **G17** Effective dates and notice | Still open (O3). |
| **G18–G21** Status and adoption of Reclaim/national records | Out of scope while the import is deferred. |

The full historical register is in `docs/engage-product-direction-governance-audit-2026-11-07.md`.
New open decisions are tracked as O1–O8 in the decision register.

## Verification limitations

This documentation set was verified by source inspection, targeted `rg` checks, existing tests and dated audits. The Sprint 1 integration additionally ran the full suite against a real MongoDB 8.0 replica set and executed two browser journeys (see [the integration report](sprint1-integration-report.md)). The following were still not performed:

- load or performance testing;
- delegated-role browser journeys;
- a production deployment;
- migration rehearsal on production-shaped data;
- legal or constitutional review.

Claims that depend on those activities are labelled as gaps or left out.

## GitHub tracking

The actionable gaps were opened as GitHub issues on 13 November 2026. This page remains the canonical description; issues track implementation.

| Gap | Issue |
|---|---|
| 1–2 Ballot rebinding, deadlines, closure, eligibility snapshot | #26 |
| 3–4 Decide authority, ratification authority, amendment ballot readiness | #27 |
| 5, 19 RBAC enforcement and branch referrals | #31 |
| 6, 11–13 Branch membership source, national row, uniqueness, provenance | #32 |
| 7 Notification fan-out | #33 |
| 8 Public supersession visibility | #35 |
| 9, 18 Inter-amendment conflicts and ready state | #34 |
| 10 Ballot outcome rules | #28 |
| 14 Comment moderation audit | #42 |
| 15 Perimeter security | #38 |
| 16 Legal acceptance gate | #40 |
| 17 In-memory database fidelity | #43 |
| 20 Role administration UX | #41 |
| 21, 26 Scheduling and observability | #39 |
| 22 National policy baseline import | #36 |
| 23 Amend/repeal from published policy | #37 |
| 24 Seconding, notice, scheduled opening, confirmation ballots | #30 |
| 25 Stale historical documentation | #44 |
| 27 Election/Returning Officer role | #29 |
| Rendering performance and list read path | #52 |
| Governance command layer and route policy | #53 |
| Decision record and responsibility queue | #54 |
| Ballot-results index migration safety | #55 |

Issue #36 is deferred to a separate provenance and reconciliation project and is not part of RFC 0001. Issues #28, #30 and #40 remain blocked on unresolved governance or legal decisions; implement only the parts the decision register settles.
