# Known gaps, defects and open decisions

**Status:** Current · **Verified:** 17 November 2026

> **RFC 0001 programme status.** The Sprint 1 integrity, lifecycle, rendering
> performance and Turnstile slices were merged to `main` as `3b36947` (PR #51) on
> 14 November 2026. Items below marked "resolved" describe behaviour on `main`.
> The [programme tracker](rfc0001-programme-tracker.md) records what is done and
> what is still missing; the [decision register](../governance/decision-register.md)
> records which governance questions the maintainer has answered. Where they
> conflict, the decision register wins.

This is an honest register, not a task list with commitments. Items are grouped by risk. Each names the impact and the evidence; proposed fixes are directions, not approved governance.

**Do not silently "fix" a governance gap by inventing a rule.** Several items below are open decisions for Fusion.

## Priority 1 — correctness or authority risk

### 1. A re-opened ballot is not rebound to revised wording

**Impact:** A proposal can return to Deliberate after a ballot, have its wording edited (when no votes exist), then return to Decide while retaining the previous `ballotRevisionId`. The ballot remains frozen on superseded wording.

**Resolved on `feat/rfc0001-sprint1-integration`:** a zero-vote return clears the binding and emits `ballot.unbound`; re-entry binds the current revision; edits are refused once votes exist.

**Evidence:** `saveProposal` binds only when `ballotRevisionId` is unset (`src/lib/proposals-store.ts`). The field is never cleared.

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

### 7. Notification fan-out is partly wired

**Impact:** Opening a ballot did not create in-app notifications or push messages, despite the notification model and preferences implying it might. Only membership verification and digest email sent.

**Addressed on `feat/notification-outbox` (#33):** a durable `notification_outbox` (unique dedupe key, claim lease, bounded retry with backoff, retention TTL) is written after a committed governance transition and drained by `npm run notifications:drain` (dry-run by default, `--apply`). Two events are wired: a ballot opened by the lifecycle scheduler (`new_ballots`) and an open ballot inside the approved seven-day window (`closing_deadlines`). The audience is the voting electorate: candidates are confirmed with `getProposalEligibility` and `canViewProposal`, and eligibility is re-checked at drain, so a revoked membership is suppressed rather than notified. In-app is the baseline channel; Web Push remains strictly opt-in; the general-communications switch and email suppression do not hide a formal ballot notice.

**Still open:** `governance_outcomes` is not wired because the result route is being refactored elsewhere, and `contribution_responses` needs a product decision. Email fan-out from the outbox is deferred (the digest already emails outstanding ballots). No production scheduler is configured, so no notification is delivered there yet (item 21).

**Evidence:** `src/lib/notification-outbox.ts`, `scripts/drain-notification-outbox.ts`, `notification-outbox.test.ts`, `notification-outbox-mongo.test.ts`; [notifications and jobs](../architecture/notifications-and-jobs.md#governance-notification-events).

**Direction:** wire the remaining events when the result route and the comment-outcome decision land. Do not tell members that every governance event produces a notification.

### 8. Public supersession can link to an unpublished policy

**Impact:** A published policy may name a successor that is only `adopted`. The public policy page renders the successor link even when that successor has no public page, producing a dead end and disclosing that a successor exists.

**Evidence:** `supersede.ts` accepts an adopted successor; `/policies/[slug].astro` renders `supersededBy` without a visibility check. This contradicts `docs/governance/historical-access-policy.md`.

**Direction:** Either require the successor to be published, or suppress the link unless the viewer may see the target. Update the policy document.

## Priority 2 — data integrity, security and operations

### 9. No inter-amendment conflict detection

Two amendments can edit the same field and both be `ready`. Conflict detection compares an amendment against the proposal revision, not against other amendments. Applying them sequentially may produce an unintended combined wording.

**Partially addressed for reporting:** the member-facing decision record (#54) derives adopted wording only for zero or one applied amendment (D15/D16). Two or more applied amendments show an explicit collision-review-required state and produce no derived text. The administrator responsibility queue surfaces amendment decisions that already have an existing officer action, but there is no collision-review workflow and the collision rule itself is unbuilt.

**Direction:** Detect field overlap at resolution time and require an explicit precedence decision.

### 10. Results are checked against the tally but the voting rules are incomplete

**Resolved on `main` (`762f76c`, PR #86):** `recordFormalDecision` computes the outcome from the votes bound to the ballot and exact revision at certification. Certification requires a closed ballot (`BALLOT_NOT_CLOSED` for a live one, and for a ballot with no recorded close). Unbound or mismatched-revision votes refuse with `BALLOT_TALLY_UNBOUND_VOTES`; unreadable encrypted votes with `BALLOT_TALLY_UNREADABLE`; missing keys with `BALLOT_DECRYPTION_UNAVAILABLE`. A contradicting officer result is refused unless an explicit override with a written reason is recorded. The result stores the tally, `ruleBasis: "simple-majority-d9-v1"` and `computedResult`; the `decision.recorded` event carries the actor, reason, computed result and recorded result. Historical results are returned unchanged. Admin pages and the proposal PDF show the computed result and override. Terms of Use §9 describes the rule (version 1.1); the Privacy Policy needed no change. Tests: `ballot-outcome.test.ts`, `ballot-outcome-mongo.test.ts`, `proposal-pdf.test.ts`.

**Display tallies are a projection, not a result.** Public lists now read `ballot_tallies`, one aggregate row per `(ballotId, revisionId)` written after a committed vote, and show `Voting open — tally updating` when the row is missing or older than ten minutes. The projection stores no voter reference and is never read by certification, which still recomputes from the bound votes. Normal writes are single atomic increments and a revision move is transactional; the only recount path is absolute and compare-and-set on a row version, retrying if the row changed and abandoned at its deadline, so an increment is never skipped. A row that is internally inconsistent is displayed as tally pending, never as a number. Existing ballots are not backfilled at startup, so deployments must run `npm run ballots:tally-projection` once if they want immediate counts; the same tool reports and repairs any row a failed or abandoned write left behind.

**Quorum added 16 November 2026 (#122):** ballots closing on or after that date also pass the two-tier quorum in [../governance/ballot-quorum.md](../governance/ballot-quorum.md). The scheduler writes one immutable `ballot_quorum_records` snapshot in the closure transaction; certification refuses a missing snapshot (`BALLOT_QUORUM_SNAPSHOT_MISSING`), an unreadable closure tally (`BALLOT_QUORUM_UNAVAILABLE`), a participation mismatch (`BALLOT_QUORUM_PARTICIPATION_MISMATCH`) and any attempt to override a quorum failure into approval or rejection (`BALLOT_QUORUM_NOT_MET`). Earlier closures are `legacy-not-applied` and keep the approval-only rule.

**Still open:** the abstention denominator for approval (decision register O1), ranked choice (O2), confirmation ballots (O3), election rules, Committee/Operations Manual confirmation of the quorum adaptation (O11), and an in-product audited correction path for a defective closure record. A correction currently needs a reviewed code-level or database change plus a governance event; do not edit `ballot_quorum_records` directly. **Amendment endorsement ballots** (`src/pages/api/admin/amendments/close-ballot.ts`) remain officer-supplied and are not covered by this check, because the amendment-resolution method is undecided (O2/D18). Do not implement validation for them without that decision. Do not treat the computed check as a complete rule engine.

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

Comments can be deleted by staff, but there is no moderation state, reason or audit event. `comments.moderate` is declared but unused in the admin UI.

**Threading safeguard (implemented):** deleting a comment that still has replies clears the body, sets `deletedAt`/`deletedBy` and keeps a placeholder so the surviving replies keep their parent. A comment with no replies is still deleted outright. The stored body is never returned to readers once deleted. This is not a moderation record: the actor and time are stored on the placeholder, but there is no reason, review queue or audit event.

**Direction:** Decide whether moderation is deletion or a visible state. Record the actor, reason and time either way.

### 14a. Public profile limitations

**Implemented:** public profiles at `/members/<memberId>/` aggregate existing comments, proposals and amendments, with owner-editable biography and display-only comment score ([#113](https://github.com/Fusion-Party-Aus/Engage/issues/113)).

**Limits today:**

- Self-service account deletion is not implemented. Hiding a profile or disabling an account returns 404 for the profile and suppresses author links, but historic comments on visible proposals remain part of the discussion.
- Initials-only avatars are the current product decision. There is no image upload, storage or external image fetch.
- The default profile URL contains the opaque Better Auth `memberId`. It is not an email address. A CRM-identifier seam is implemented but off by default: `ENGAGE_PROFILE_CRM_IDENTIFIERS=on` makes an active CRM identity link canonical and 301s member-id paths. Leave it off until upstream CRM support is confirmed.
- Biography has no revision history. This is not required today.
- When the account document is gone but a visible contribution remains, the profile uses the author name stored on that contribution. A name that exists only on a private proposal does not create a profile.
- The comment score is display-only by design. It has no leaderboard, tier or permission effect.

### 15. Perimeter security is incomplete

**Addressed on `feat/security-headers-csrf` (issue #38), pending merge.** A
perimeter middleware now sets `X-Content-Type-Options`, `Referrer-Policy`,
`X-Frame-Options`, a minimal `Permissions-Policy`, conditional HSTS and a
hash-based Content Security Policy. Astro's form-post origin check is kept and
extended for every state-changing method: cross-site `Sec-Fetch-Site`, a
mismatched `Origin`, and an absent `Origin` with a session cookie are refused.
A real-browser check in CI covers the home, proposal, sign-in and Sense Box
pages, Turnstile, Plausible, same-origin writes and cross-origin rejection. See
[security/perimeter.md](../security/perimeter.md).

Before this slice, the application had no CSP, HSTS, frame or content-type
headers, CSRF/Origin coverage was partial, and many routes relied on
`SameSite=Lax` cookies. Cloudflare Turnstile and a shared MongoDB fixed-window
limiter protect the abuse-prone unauthenticated actions (Sense Box submission
and magic-link sign-in) — see [security/turnstile.md](../security/turnstile.md).

**Still missing:** general API rate limiting, per-request CSRF tokens, a CSP
violation reporting endpoint, and perimeter headers on static assets (served by
the Node adapter before middleware) and on Astro's own early cross-site 403. The
reverse proxy should add the same headers. Production headers have not been
observed through Cloudflare/Coolify.

**Direction:** Keep the unit tests and the CI browser harness as the regression
evidence. Add proxy headers for static assets, decide whether to add CSRF tokens
for same-origin script compromise, and verify the deployed header set.

### 16. The legal acceptance gate is inactive

The gate code is implemented, but the documents are `owner-authorised` with placeholder effective dates, so acceptance is not required.

**Direction:** Publish the legal documents and set `LEGAL_ACCEPTANCE_ENABLED` only after approval. Do not enable it as a shortcut.

### 17. The in-memory database is not faithful

Projections and indexes are no-ops and there are no transactions. Development and some tests can pass where production would behave differently.

**Partly improved:** the in-memory preview now applies `$and` filters and cursor `skip`, which the paginated admin register read needs. Projections are still ignored by the preview (tests that assert projection shape spy on the query instead), and indexes and transactions remain unsupported.

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

**Partially resolved (operational observability slice, #39):** authorised runs now record a durable `job_runs` ledger entry (90-day TTL) for the governance scheduler, digest and CRM verification, including failures, with no secrets or member data. `npm run ops:health` evaluates governance scheduling, ballot deadlines, digest cadence, verification backlog, recent email delivery and Turnstile, with named thresholds and exit codes `0` healthy, `2` degraded, `1` failing. `/api/health` publishes coarse `governanceScheduler` and `jobs` states and stays 200 when only a job is degraded.

**Operational tuning is now administrator settings ([#128](https://github.com/Fusion-Party-Aus/Engage/issues/128)):** the eight operational health thresholds, the CRM batch size, reconcile cadence, outage alert attempts, request timeout, and the digest and CRM enablement gates are stored in MongoDB, validated with bounds and audited with actor and before/after values. They are edited under **Platform settings → Operational thresholds**, **CRM verification** and **Scheduled jobs**, and are no longer environment variables. Public site settings use the same storage, validation and audit path and no longer read environment fallbacks. A missing setting defaults to off for both jobs, to the documented tuning values, and to the code defaults for public appearance. Production verification remains on #128.

**Still missing:** the external scheduler itself is not configured in Coolify production, no run has been observed in production, there is no metrics/tracing backend, no alert delivery and no admin health page (only the operational settings). `ops:health` is the input an external monitor would alert on.

**Direction:** Configure and monitor an external scheduler. Treat missing jobs as an operational incident.

## Priority 3 — product and documentation gaps

### 29. Story contributions have legal and operational obligations before launch

**Implemented (17 November 2026, #143):** a public collaboration matter (`/collaborate/<slug>/`) accepts stories and photographs from people with no account, with granular consent, private review, metadata-stripped media, a reviewer-only export and no automatic publication. See [public collaboration matters](../product/collaboration-matters.md).

**Retention and safeguards (implemented same day):** withdrawal deletes story text, name, reply address and photographs immediately and keeps only the review record. Declined material is cleared after 90 days, approved reply addresses 12 months after approval, via `npm run collaboration:retention` (dry-run by default; `npm run collaboration:retention -- --apply` to act). Each clear is conditional on the record still being in the expected state. A contributor can also correct, hide or withdraw with a private link; a lost link is recovered by email. An operational draft covering photographer credit, other identifiable people, minors, AI edits and mistaken publication is in [story and photograph safeguards](../guides/story-contribution-safeguards.md).

**Pilot rules adopted 17 November 2026:** adults only with a simple 18+ attestation; no publication of identifiable children, even with guardian permission; hide disputed material within 1 business day, resolve within 5 business days, and be explicit that copies distributed outside Engage cannot be recalled.

**Still open before public launch:**

- the privacy policy now describes this purpose, account linking and the aggregate counts (version 1.6) but remains owner-authorised with legal review outstanding;
- the correction inbox, escalation path and monthly retention sweep can now be assigned at `/admin/collaboration/operations/`, but no people are assigned yet; see [collaboration pilot operations](collaboration-pilot-operations.md);
- the credit format is not decided, and a single caption may not describe several individual photographs well enough;
- there is no derivative-approval step for an AI-edited photograph, and the production-image policy for edited photographs is undecided;

- invitation interest counts are aggregate events, not people, and an account step is not a registration; there is no per-channel or per-source attribution;
- no contributor email is sent automatically;
- the public gallery is a simple list with no moderation queue for reported content and no paging beyond 60 stories;
- approved material reaches Horizon through a manual JSON export. Consumer-neutral external synchronisation, including corrections, hiding and withdrawal, is tracked in #157 and is not implemented.

**Direction:** settle the legal and image-policy questions before promoting the invitation publicly. Do not describe a contribution as a verified membership testimonial.

### 22. The Policy Registry is empty on a fresh install

The seed contains 78 **proposals**, not adopted policy. There is no national baseline import and no administrative import flow.

**Partially resolved:** the Victorian branch registry can be imported with explicit branch-authority provenance, immutable `policy_revisions` and a dry-runnable reconciliation report (D34, [#89](https://github.com/Fusion-Party-Aus/Engage/issues/89), [runbook](../guides/branch-policy-import.md)). National Neon remains deferred (#36); a fresh install with no branch import still shows the explicit empty state.

### 23. Published policy cannot be amended or repealed from its own page

A member can draft a new proposal, but there is no `targetPolicyId` or change type that connects it to an existing policy. Supersession is administrative.

**Resolved:** a proposal may declare `targetPolicyId` and `changeType` (`amend`, `replace`, `repeal`). The policy page shows the authorised next action and lists linked proposals. Ratification binds the exact target revision; an amendment or replacement supersedes the predecessor when the successor is published, and a repeal records the deciding proposal as lineage. Drafts never alter published policy (D35, [#37](https://github.com/Fusion-Party-Aus/Engage/issues/37)).

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

### 28. Comment ranking and vote privacy have no operational controls

**Implemented:** comments now take upvotes and downvotes, one active vote per member, and the default **Best** order ranks sibling groups by the Wilson score lower bound over up and down votes. Identities are never returned in a DTO; a viewer sees aggregate counts, the upvote percentage and only their own choice ([#57](https://github.com/Fusion-Party-Aus/Engage/issues/57)).

**Residual risks:**

- Comment votes have no dedicated rate limit or audit trail. A member can toggle a vote repeatedly, and a changed vote leaves no audit record. This is different from formal ballots, which have their own integrity controls. Concurrent vote writes are atomic: each comment carries a `voteVersion` and an update only applies when that version is unchanged, so simultaneous votes are retried against the latest state rather than overwriting each other. Retries run on a 5 s time budget with exponential backoff and jitter, so a cold replica set or a burst of voters converges while a stuck write still fails in bounded time. Budget expiry logs the comment ID, attempt count and budget only, never voter identities or choices.
- The API returns aggregate `downvoteCount` to build the client-side ranking. Voter identities are not exposed, but an exact aggregate downvote tally is available to any viewer of the proposal. If the product should behave like Reddit's hidden downvote count, the DTO must expose only score and percentage and the client must rank from those.
- The Wilson constant (`z = 1.281551565545`), the score tie-break and the age tie-break are product defaults, not governance-approved rules. They are display ranking only and must never be presented as a measure of member support or a ballot signal.
- Reply depth is capped visually at four levels and stored at 20. That is a usability ceiling, not a moderation rule.

**Evidence:** `CommentRecord.upvotes`/`downvotes`, `voteOnComment`, `toCommentDto`, `src/lib/comment-thread.ts` (`commentConfidence`, `compareComments`), `src/lib/comment-replies.test.ts` and the discussion browser harness.

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
| **G9** Thresholds, quorum, ties, abstentions | **Mostly answered:** simple majority, tie fails (D9); two-tier quorum for ballots closing on or after 16 November 2026 (D37–D39); abstention denominator remains open (D10, O1), though abstentions now count towards quorum. |
| **G10** Early closure | **Deferred:** no irreversible-outcome early closure until a correct model exists (D12). |
| **G11** Preferential amendment method | **Direction only:** direct choice for two, ranked choice for three or more; method and tie handling unspecified (D18). |
| **G12** Delegated or automatic ratification | **Answered in principle:** automatic for zero or one amendment; collision review for two or more (D14–D20). |
| **G13** Ballot secrecy versus officer-identifiable ballots | **Answered:** encrypted by default; individual choices never publicly identifiable; identifiable access remains restricted (D26, D29). |
| **G17** Effective dates and notice | Still open (O3). |
| **G18–G21** Status and adoption of Reclaim/national records | Out of scope while the import is deferred. |

The full historical register is in `docs/engage-product-direction-governance-audit-2026-11-07.md`.
New open decisions are tracked as O1–O11 in the decision register.

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
| Public member profiles and contribution history | #113 |
| Ballot-results index migration safety — resolved 15 November 2026 | #55 |

Issue #36 is deferred to a separate provenance and reconciliation project and is not part of RFC 0001. Issues #28, #30 and #40 remain partly blocked on unresolved governance or legal decisions; implement only the parts the decision register settles. #28's Yes-versus-No computed check is implemented against D9; the two-tier quorum is implemented against D37–D39, while the abstention denominator (O1, D10) remains undecided.
