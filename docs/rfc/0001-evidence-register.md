# RFC 0001 — Evidence register

Companion to [RFC 0001](0001-participatory-governance-platform-evolution.md). This register records what was inspected, what it supports, how confident the interpretation is, and what remains unverified.

- **Baseline:** `main` at `52ffaf6`, 14 November 2026.
- **Method:** repository inspection, targeted searches, baseline checks, official documentation review, and synthesis of the existing Engage research collection.
- **Status:** research evidence. It does not authorise implementation.

## 1. Evidence vocabulary

| Label | Meaning |
|---|---|
| **Observed** | Directly seen in the repository or command output. |
| **Documented** | Stated by an official external source. |
| **Inferred** | A reasoned interpretation not directly tested. |
| **Unverified** | Plausible but not established. |
| **Recommendation** | A proposed direction, not current behaviour. |

Confidence is recorded as high, medium or low. Confidence is about the interpretation, not the importance of the finding.

## 2. Repository evidence

### 2.1 Structural findings

| ID | Finding | Evidence inspected | Confidence | Notes |
|---|---|---|---|---|
| R1 | `store.ts` is the de facto domain service and is 2,944 lines. | `src/lib/store.ts`; `wc -l` | High | Spans proposals, comments, votes, ballots, members and RBAC checks. |
| R2 | The proposal page is 4,035 lines, including roughly 2,400 lines of inline client script. | `src/pages/proposals/[slug].astro` | High | The script starts around line 1,575 and includes stage controls, vote feedback and analytics. |
| R3 | Pages query MongoDB directly. | 31 files under `src/pages`; 92 `db.collection` calls | High | Includes home, proposal list, proposal detail, member, branches, policies and most admin pages. |
| R4 | There is no central route guard. | No `src/middleware.ts`; route-by-route checks | High | A new route inherits no policy. |
| R5 | Proposal lists scan the whole collection. | `listProposals` in `store.ts` | High | Reads all proposals, all comments and all votes, then filters in memory. |
| R6 | List paths can decrypt votes. | `loadBallotCryptoConfig(process.env)` in `listProposals` and `getProposalDetail` | High | `listProposals` decodes every vote to build tallies. |
| R7 | Session resolution writes. | `getSessionUser` calls `ensureNationalMembership` | High | The write happens for every verified session. |
| R8 | The national row conflicts with CRM assignment. | `assignGeographicBranch` treats any active row as a conflict | High | `ensureNationalMembership` creates an active `branch-nat` row. |
| R9 | Self-service branch switching bypasses the CRM source guard. | `chooseBranchMembership` in `branch-participation.ts` | High | It revokes active memberships in the same group without `assertLocalMembershipMutation`. |
| R10 | Ballot deadlines have no writer. | `rg ballotClosesAt`; `ballot-expiry-migration.ts` | High | Only the one-off migration writes a deadline. |
| R11 | Notification fan-out is unwired. | `dispatchMemberNotification` in `notifications.ts`; `rg` callers | High | Only tests call it; membership verification calls `createInAppNotification` directly. |
| R12 | Re-opened ballots are not rebound. | `saveProposal`; `ballotRevisionId` assignment | High | The field is set only when absent and is never cleared. |
| R13 | Result, certification and event are separate writes. | `recordFormalDecision`; `result.ts` | High | The service inserts the result and updates the ballot; the route writes the event. |
| R14 | Stage transitions have no governance event. | `saveProposal`; `rg recordGovernanceEvent` | High | Only result, binding, supersede and relationships call the event writer. |
| R15 | Amendment ballots have no governance event. | `open-ballot.ts`; `close-ballot.ts` | High | They update the amendment document only. |
| R16 | Hard deletion exists. | `deleteProposal`; `DELETE /api/proposals/:id` | High | Deletes the proposal and comments; no reason or event. |
| R17 | Nine permission keys are unused. | `PERMISSION_CATALOGUE`; `rg` counts | High | See the table in the RFC. |
| R18 | `saveProposal` does not check `proposals.edit`. | `saveProposal` | High | Gates on `isStaff` or branch administrator. |
| R19 | Branch referral checks `isAdmin`. | `src/pages/api/admin/branches/referrals.ts` | High | `branches.refer_proposals` is declared but not used. |
| R20 | Role editor uses raw keys and `window.prompt`. | `src/components/admin/RolesManager.tsx` | High | Effective-permission inspector renders `g.permission`; revocation uses `window.prompt`. |
| R21 | `ballot_results` is unique per proposal. | `src/lib/db.ts` index | High | Contradicts the 1-to-many ballot projection. |
| R22 | A unique branch membership index exists. | `src/lib/db.ts` `{branchId, memberId}` unique | High | Contradicts `known-gaps.md` item 12. |
| R23 | ADR 0003 claims transactional vote admission. | `docs/adr/0003-reclaim-mvp-node-mongodb.md`; `castVote` | High | No `startSession` or `withTransaction` in `castVote`. |
| R24 | Baseline checks pass. | `pnpm check`; `pnpm test` | High | 0 type errors; 291 tests, 275 pass, 16 skip, 0 fail. |
| R25 | Production has no scheduler configured. | `docs/architecture/notifications-and-jobs.md`; Coolify compose | High | The document states this explicitly. |
| R26 | The container limit is 256 MB. | `docker-compose.coolify-production.yml` | High | `mem_limit: 256m`, `cpus: 0.75`. |
| R27 | Hardcoded colours bypass Horizon tokens. | `index.astro`, `member/index.astro`, `changelog/index.astro` | High | Hex values in page-scoped CSS. |
| R28 | Inert flags exist. | `.env.example`; architecture doc | High | `FORMAL_BALLOTS_ENABLED` is not read; `ENGAGE_PUBLIC_PULSE_POLL` has no implementation. |

### 2.2 Governance and domain findings

| ID | Finding | Evidence inspected | Confidence | Notes |
|---|---|---|---|---|
| R29 | Five authorities are separated in code and tests. | `auth.ts`; `rbac.ts`; `branch-participation.ts`; `federated-permissions.test.ts` | High | Tests prove branch membership is required independently of role. |
| R30 | Revisions are immutable and hashed. | `store.ts`; `proposal-revision.ts`; `data-and-persistence.md` | High | SHA-256 over the four substantive fields in fixed order. |
| R31 | Ballot binding is revision-bound and idempotent. | `ballot-binding.ts` | High | Decision-event reference and binding event. |
| R32 | Results are officer-supplied, not computed. | `ballots.ts`; `recordFormalDecision` | High | Deliberate while thresholds are absent. |
| R33 | Ratification is national-only and revision-matched. | `ratify.ts`; `governance-lifecycle.md` | High | Does not cross-check authority. |
| R34 | Publication is a separate act with an event. | `publish.ts`; `publication_events` | High | Idempotency key required. |
| R35 | Resolutions cannot be ratified or published. | `isGovernanceResolution`; `ratify.ts` | High | Returns 409. |
| R36 | Eligibility is checked at vote time. | `castVote`; `getProposalEligibility` | High | No snapshot. |
| R37 | Branch followers are explicitly ineligible. | `getProposalEligibility`; tests | High | The distinction is tested. |
| R38 | Identifiable ballots are restricted. | `canViewIdentifiableBallots`; `ballot-privacy.ts`; DTOs | High | National admin or delegated national permission. |
| R39 | Vote encryption exists but is off by default. | `ballot-crypto.ts`; `.env.example` | High | AES-256-GCM with blind index. |
| R40 | There is no election/returning officer role. | `rbac.ts`; `canViewIdentifiableBallots` | High | National administrator is the boundary. |

### 2.3 Operational findings

| ID | Finding | Evidence inspected | Confidence | Notes |
|---|---|---|---|---|
| R41 | CI runs a real MongoDB replica set, tests, build and one Playwright journey. | `.github/workflows/ci.yml` | High | 15-minute timeout. |
| R42 | The NUC workflow validates, builds, publishes and deploys with rollback. | `.github/workflows/nuc-cicd.yml`; `scripts/deploy-nuc.sh` | High | Health poll and rollback. |
| R43 | The in-memory database lacks projections, indexes and transactions. | `db.ts`; `data-and-persistence.md` | High | Documents the limitation. |
| R44 | There are no metrics, traces or alerting. | `logOperationalEvent`; `/api/health`; architecture doc | High | Logs and a database ping only. |
| R45 | Security headers are absent in the app. | architecture doc | High | Perimeter responsibility. |
| R46 | General API rate limiting is absent. | auth and Sense Box only | High | Documented. |
| R47 | The legal acceptance gate is inactive. | `LEGAL_ACCEPTANCE_ENABLED`; docs | High | Documents are placeholders. |

### 2.4 Documentation drift

| ID | Drift | Current code | Impact |
|---|---|---|---|
| D1 | ADR 0003 describes transactional vote admission | `castVote` has no transaction | A reviewer may rely on a guarantee that does not exist |
| D2 | Known-gaps #12 says there is no unique branch membership index | `db.ts` creates one | The gap register is stale |
| D3 | Docs verified at `d1a24af` | Baseline is `52ffaf6` | Some claims may predate changes |
| D4 | `docs/operations.md`, `coolify-deployment.md`, `member-engagement.md`, `engage-ux-journeys.md` are older | Various | They must be read with their dates |
| D5 | `FORMAL_BALLOTS_ENABLED` appears in local env | Not read by code | An operator may believe it does something |
| D6 | `ENGAGE_PUBLIC_PULSE_POLL` is a flag | No poll implementation | Roadmap label only |

## 3. External evidence

The following sources were accessed on 14 November 2026. Each entry states what it supports and its limits.

### X1 — OpenFGA concepts

- **URL:** https://openfga.dev/docs/concepts
- **Supports:** Relationship tuples, type definitions, direct/implied relationships, contextual tuples, conditions, `Check`/`ListObjects`/`ListUsers`.
- **Use in RFC:** The value of a single, explainable authorisation decision and the separation of policy from relationship data.
- **Limit:** OpenFGA is a service and a graph model. Engage's problem is a small role/scope model with constitutional constraints. The RFC borrows the decision discipline, not the engine.

### X2 — Keycloak server administration

- **URL:** https://www.keycloak.org/docs/latest/server_admin/index.html
- **Supports:** Realms, users, roles, composite roles, groups, identity brokering, session management, admin audit events, fine-grained admin permissions.
- **Use in RFC:** Identity and authorisation separation; session revocation; the cost of running a separate identity server.
- **Limit:** Keycloak is a general-purpose IdP. Engage does not need it for one application. The RFC uses it to justify an identity port, not an adoption.

### X3 — Authentik flows

- **URL:** https://docs.goauthentik.io/docs/flow/
- **Supports:** Flows as sequences of stages guarded by policies; designations for authentication, authorisation, enrolment, recovery and invalidation; policy engine modes.
- **Use in RFC:** The idea that authentication and authorisation are explicit, inspectable sequences; the separation of flow purposes.
- **Limit:** Authentik is a full identity platform. Engage's flows are simpler and local.

### X4 — Supabase Row Level Security

- **URL:** https://supabase.com/docs/guides/database/postgres/row-level-security
- **Supports:** Policies execute inside the database; grants and policies are separate; defence in depth; allow/deny tests per operation and role; views can bypass RLS.
- **Use in RFC:** The principle that authorisation needs more than one layer and must be tested for denial.
- **Limit:** MongoDB has no equivalent RLS. Engage must achieve the principle through a command layer and route policy, not database policies.

### X5 — Stripe idempotent requests

- **URL:** https://docs.stripe.com/api/idempotent_requests
- **Supports:** Client-generated idempotency keys; stored response; parameter comparison; retry safety; pruning after 24 hours for API v1.
- **Use in RFC:** Ratification/publication already use keys; the same discipline should apply to result recording and other protected acts.
- **Limit:** Stripe's retention and API-version semantics are specific to Stripe. Engage needs its own key scope and retention.

### X6 — Modern Treasury ledger guarantees

- **URL:** https://docs.moderntreasury.com/ledgers/docs/ledgers-guarantees
- **Supports:** Balanced entries, auditable versions, archival instead of deletion, ledger isolation, immutability, idempotency, atomic writes, read-committed isolation.
- **Use in RFC:** Append-only integrity, no hard deletion, versions and audit logs.
- **Limit:** A ledger balances money; a governance record balances authority. The analogy is useful for immutability and versions, not for double-entry semantics.

### X7 — Temporal workflows

- **URL:** https://docs.temporal.io/workflows
- **Supports:** Workflow definitions, event history, replay, durable execution, activities and recorded results.
- **Use in RFC:** The value of a durable event history and retry-safe activities.
- **Limit:** Temporal is a platform. Engage's outbox and cron worker provide the needed durability at a smaller scale.

### X8 — Transactional outbox

- **URL:** https://microservices.io/patterns/data/transactional-outbox.html
- **Supports:** Write the message in the same transaction as the business change; a relay publishes it; delivery is at-least-once; consumers must be idempotent.
- **Use in RFC:** The design for reliable notifications and audit side effects without a broker.
- **Limit:** The pattern assumes a message broker. Engage can implement the same idea with a collection and a leased worker.

### X9 — GitHub protected branches

- **URL:** https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
- **Supports:** Required reviews, required status checks, conversation resolution, stale-approval dismissal when the diff changes, "do not allow bypassing", linear history, lock branch.
- **Use in RFC:** Protected transitions, prerequisites, stale approval and explicit bypass policy.
- **Limit:** GitHub protects code, not governance decisions. The stale-approval analogy is strong for ballot rebinding, but the authority model is different.

### X10 — Wagtail workflows

- **URL:** https://guide.wagtail.org/en/how-to-guides/configure-workflows-for-moderation/
- **Supports:** Workflows as ordered tasks; group approval; submission bound to a revision; approve/reject/resume/cancel; workflow history; immutable task names to preserve history.
- **Use in RFC:** Revision-bound review, personal queues, task age and audit.
- **Limit:** Wagtail is a CMS. Its workflow is configurable; Engage's lifecycle is constitutional and must remain code-defined.

### X11 — Sanity Content Releases

- **URL:** https://www.sanity.io/docs/content-releases
- **Supports:** Releases group document changes; versions; preview and validation; scheduling; locking while scheduled; publish as one unit; release history.
- **Use in RFC:** Atomic publication, version pinning and scheduled release discipline.
- **Limit:** Engage should not group unrelated decisions into a bulk release. The transferable idea is exact-version atomic publication, not a release-management UI.

### X12 — Decidim versions

- **URL:** https://docs.decidim.org/en/develop/admin/features/transparency/versions.html
- **Supports:** Version history with author, time and exact differences; side-by-side and unified views; HTML escaping options.
- **Use in RFC:** Human-readable revision history and exact-version review.
- **Limit:** Decidim's version feature is a CMS-style audit; Engage's revision chain is stronger because it binds a ballot.

### X13 — Decidim fingerprint

- **URL:** https://docs.decidim.org/en/develop/admin/features/transparency/fingerprint.html
- **Supports:** SHA-256 fingerprint of important fields; a participant can independently verify content; the stated threat is direct database editing by an administrator.
- **Use in RFC:** A member-visible wording fingerprint as a receipt, not a blockchain.
- **Limit:** A hash proves integrity relative to a published value, not authorship or organisational authority. It must be described accurately.

### X14 — Decidim amendments

- **URL:** https://docs.decidim.org/en/develop/admin/components/proposals/special_configurations/amendments.html
- **Supports:** Amendments reviewed and accepted or rejected by the author; version history; promotion of a rejected amendment to a proposal; phase-level controls.
- **Use in RFC:** The amendment review loop and the separation of amendment from proposal.
- **Limit:** Decidim's author-acceptance model is not Engage's formal amendment ballot. Engage's process is stronger for governance and should not be simplified to author acceptance.

### X15 — Loomio repository

- **URL:** https://github.com/loomio/loomio
- **Supports:** Discussion, reasons and outcomes kept together; a searchable record of what was decided and why; use by cooperatives, boards, unions and membership organisations.
- **Use in RFC:** The product principle that a decision record should read as a narrative, not a database.
- **Limit:** Loomio is a general collaborative decision tool. It does not model Engage's five authorities or policy registry.

### X16 — Existing Engage cross-industry research

- **URLs:** [platform evidence](../research/cross-industry/01-platform-evidence.md), [synthesis](../research/cross-industry/02-synthesis.md), [opportunity backlog](../research/cross-industry/03-opportunity-backlog.md), [UX concepts](../research/cross-industry/04-ux-concepts.md), [implementation sequence](../research/cross-industry/05-implementation-sequence.md)
- **Supports:** Twelve-platform evidence on roles, queues, lineage, notifications, review and accessibility; a prioritised backlog (OB-01–OB-37); five implementable UX concepts; a dependency-aware sequence.
- **Use in RFC:** The product/UX findings and the S2/S7 recommendations build on this work rather than repeating it.
- **Limit:** The research records that authenticated commercial surfaces were not inspected and no Engage member research was run. Its UX claims are hypotheses.

### X17 — Existing Engage participatory research

- **URLs:** [comparison](../research/participatory-platforms-engage-comparison.md), [evidence](../research/participatory-platforms-evidence.md)
- **Supports:** Decidim, CONSUL and Loomio governance semantics; separation of subject, decision and authority; response loops with evidence; historical access; privacy boundaries.
- **Use in RFC:** The governance framing and the warning not to collapse deliberation, decision and publication.
- **Limit:** It predates the current CRM integration and some lifecycle changes.

## 4. Open issue alignment

The issue register was checked with `gh issue list --state open` on 14 November 2026. The RFC does not duplicate these commitments. It sequences them and identifies gaps.

| Issue | RFC sections | Coverage |
|---|---|---|
| #26 Ballot lifecycle | I2, I7, S3 | Rebinding, deadlines, close act, eligibility snapshot |
| #27 Governance authority | I8, Q3, Q4 | Decide authority, ratification authority, amendment ballots |
| #28 Outcome rules | L1 | Thresholds, quorum, ties |
| #29 Election officer | Q6, L1 | Separation of duties, identifiable ballots |
| #30 Procedure | L3 | Seconding, notice, scheduled opening, confirmation ballots |
| #31 Permission catalogue | I4 | Enforcement and delegation |
| #32 Branch membership | I3, I8 | Source guard, national row, uniqueness, provenance |
| #33 Notifications | I9, S5 | Inbox and push fan-out |
| #34 Amendment conflicts | I8 | Inter-amendment conflict and ready state |
| #35 Supersession link | I8 | Public visibility |
| #36 Policy baseline | Q5, Phase 5 | Import with provenance |
| #37 Amend/repeal | L2 | Published policy lifecycle |
| #38 Security | I10 | Headers, rate limits, CSRF |
| #39 Operations | I10, S8 | Jobs, observability, alerting |
| #40 Legal gate | Phase 5 / separate compliance decision | Activate only after documents are approved |
| #41 Role UX | S7 | Raw keys and prompt |
| #42 Comment moderation | I8, Q14 | State and audit |
| #43 In-memory DB | Phase 4 | Fidelity or gating |
| #44 Documentation | I11 | Stale historical docs |
| #5 Implementation tracking | S2, Phase 5 | Lineage and evidence |
| #6 Participation pilot | Phase 5 | Consultation and eligibility |
| #4 Signal intake | Phase 5 | Future integration |

## 5. New findings not covered by an open issue

These were discovered during this review. They need an issue before implementation, per the repository rules.

| ID | Finding | Severity | Suggested issue scope |
|---|---|---|---|
| N1 | Hard deletion of a matter after votes or a result | Critical | Replace with archive/withdraw; restrict draft deletion; audit |
| N2 | Result, certification and audit are not atomic | High | One transaction; idempotency; crash test |
| N3 | Stage transitions and amendment ballots have no governance events | High | Event taxonomy and completeness test |
| N4 | `ballot_results` cardinality contradicts the 1-to-many ballot model | Medium | Decide the ballot instance model; migrate the index |
| N5 | ADR 0003 claims a vote transaction the code does not implement | High | Implement or correct the ADR |
| N6 | Proposal list reads and decrypts every vote | High | Aggregation/projection; remove decryption from lists |
| N7 | Architectural concentration and no central route policy | High | Command layer; route manifest; page extraction |
| N8 | `canManageBranchBallot` accepts any ballot permission | Medium | Require the specific permission or split the helper |
| N9 | Design-token drift and dark-theme inconsistency | Medium | Replace hardcoded colours; add a token audit |
| N10 | Decision-record and admin-queue read models are absent | Medium | Read models; validate with maintainers |

## 6. Confidence assessment

| Claim | Confidence | Basis | What would raise confidence |
|---|---|---|---|
| Governance semantics are strong and should be preserved | High | Code, tests, docs | A governance review by Fusion |
| Permission enforcement is inconsistent | High | `rg` counts, routes, services | A route-by-route allow/deny matrix |
| Ballot deadlines are not written for new ballots | High | No writer in code | A runtime reproduction |
| Notifications are unwired | High | No production caller | A production log review |
| The proposal list is O(all votes) | High | Query shape | A load test with realistic data |
| Session resolution writes on every verified request | High | Code path | A MongoDB profiler trace |
| CRM branch assignment conflicts with the national row | High | Code path | A staging reproduction with CRM data |
| A re-opened ballot can keep stale wording | High | Code path | A staging reproduction |
| Result and event are not atomic | High | Code path | A crash-injection test |
| Hard deletion can remove a voted matter | High | Code path | A staging test with an admin |
| The command layer is the right next architecture | Medium | Comparative evidence and code structure | A small pilot on one act |
| Per-matter follow improves relevance | Medium | Discourse/Linear patterns; no Engage research | Member interviews or a pilot |
| A decision record improves comprehension | Medium–high | Wikipedia/Decidim/Loomio patterns; no usability test | A usability test with 5–8 members |
| Thresholds should wait for governance rules | High | Product docs; open issue #28 | A Fusion decision |
| A shared identity should wait | Medium | No second consumer | A Fusion platform roadmap |
| Vote encryption should be default | Medium | Threat model; operational cost | A key-custody and election-officer decision |

## 7. Research log

Commands and checks run during this review:

```sh
git status --short
git log --oneline -20
git branch -a
find src -type d
find src -type f | wc -l
wc -l src/lib/*.ts | sort -rn
rg -n "db.collection" src/pages
rg -n "dispatchMemberNotification|createInAppNotification" src
rg -n "ballotClosesAt" src
rg -n "withTransaction|startSession" src
rg -n "recordGovernanceEvent\\(" src
rg -n "<(button|select|input|textarea|table|dialog)\\b" src
rg -n "text-(amber|red|green|blue|slate|gray|zinc|emerald|rose|yellow|orange)-[0-9]|#[0-9a-fA-F]{3,6}" src
pnpm check
pnpm test
gh issue list --state open --limit 100
gh issue view 26
gh issue view 31
gh issue view 32
```

The test run was a local run without the real MongoDB suites. CI is configured to run them but was not executed as part of this review.

## 8. Contradictions and drift register

| ID | Contradiction | Where | Resolution proposed |
|---|---|---|---|
| C1 | ADR 0003 says votes are admitted in a transaction; code does not | ADR vs `castVote` | Implement or correct the ADR (N5) |
| C2 | Known-gaps says no unique branch membership index; code creates one | `known-gaps.md` vs `db.ts` | Update the gap register |
| C3 | Docs say notifications are built; no caller exists | `notifications-and-jobs.md` vs code | Wire or label as unwired |
| C4 | Docs say every governance act is audited; transitions are not | `domain-model.md` vs `store.ts` | Complete the event chain or correct the claim |
| C5 | `ballots` supports 1-to-many; `ballot_results` is unique per proposal | `ballots.ts` vs `db.ts` | Decide the model (N4) |
| C6 | `FORMAL_BALLOTS_ENABLED` exists in env; code does not read it | `.env` vs code | Remove or implement |
| C7 | `ENGAGE_PUBLIC_PULSE_POLL` is a flag; no poll exists | `.env` vs code | Label as roadmap only |
| C8 | Manual verification and CRM verification record different provenance | `saveMember` vs `membership-verification.ts` | Standardise (issue #32) |
| C9 | Docs verified at an older commit | `docs/README.md` | Update after this RFC |
| C10 | Role editor exposes raw keys despite the design rules | `RolesManager.tsx` vs `AGENTS.md` | Issue #41 |

## 9. Questions the evidence cannot answer

- Which governance rules Fusion actually intends.
- The expected member, proposal and vote volume.
- Whether members want per-matter following.
- Whether administrators want operational assignment.
- Whether the organisation will fund a scheduler, observability and a restore rehearsal.
- Whether vote encryption can be operated with adequate key custody.
- Whether a shared identity is planned.
- The legal retention policy for votes, audit logs and archived matters.
- Whether the policy baseline has authority to be published.
- Whether branch administrators should delegate roles.

These are recorded as open questions in the RFC, not guessed.

## 10. Source access notes

- Official documentation pages were fetched on 14 November 2026. Documentation can change; re-check before implementation.
- The Keycloak administration guide is large; only the concepts relevant to realms, roles, identity brokering, sessions and audit were read.
- The Decidim documentation paths are versioned; the "develop" paths were used. The content may differ in a released version.
- The Sanity Content Releases feature is plan-gated. The RFC uses the pattern, not the product.
- No proprietary code was copied. No authenticated commercial surface was reverse-engineered.
- The existing Engage research is cited as internal secondary evidence. Its limitations apply here too.
