# Engage — Product Direction, Provenance & Governance Architecture Audit

**Repository:** `/Users/ethan/Documents/Coding/reclaim-platform`  
**Branch:** `proposal-ballot-integrity`  
**HEAD:** `c204f47` (`feat(voting): migrate votes to proposal_votes collection with ballotId`)  
**Audit date:** 7 November 2026  
**Audit type:** read-only architecture, data and reconciliation audit

## Scope and method

I inspected the application, the national corpus, the reconciliation outputs and the
test suite. I ran only `pnpm test` and `pnpm check`. Tests use the in-memory database
unless a real MongoDB URI is supplied; no production database, dependency, deployment,
ballot, proposal revision or corpus source file was modified.

The working tree contains substantial uncommitted work: 46 tracked files modified and
many new untracked files, including the governance API, branch administration, policy
registry controls, amendments, public API v1, Astro/React UI and the entire `corpus/`
tree. This audit treats that work as the current system and does not recommend
discarding or resetting it.

Test result at audit time:

- `pnpm test`: **58 tests, 50 passed, 0 failed, 8 skipped**
- `pnpm check`: **0 errors, 0 warnings, 14 hints**
- Skipped locally: 7 real-MongoDB voting/migration tests and 1 real-MongoDB auth test

---

# A. Executive assessment

## What Engage already does

Engage is a credible **proposal, deliberation and ballot platform**. It is not yet a
credible **authoritative policy registry for existing adopted policy**.

The strongest verified capabilities are:

- Proposal creation, editing and a four-stage lifecycle (`propose`, `deliberate`,
  `decide`, `implement`, `archived`) with server-side transition guards.
- Immutable proposal revisions with parent links and SHA-256 content hashes.
- Ballot wording bound to a frozen proposal revision; votes carry that revision ID.
- Separate proposal and amendment ballots, with amendment wording stored in immutable
  `amendment_revisions`.
- Server-side locking of substantive proposal text once voting begins.
- Branch records, explicit branch memberships, delegated branch administrators,
  branch-scoped proposal authority, branch-scoped ballot control and audit events.
- Policy registry records, ratification for ballot-derived policy, publication
  outbox events with idempotency keys, withdrawal, supersession, and reconciliation.
- A read-only public policy API with ETags, canonical links, keyset pagination and
  version retrieval.
- Admin screens for proposals, members, branches and policy publication.

## What is incomplete

The core incompleteness is not cosmetic. It is structural:

1. **There is no legacy baseline import path.** On a fresh database,
   `src/data/policies.json` seeds 78 Reclaim proposals. `policy_registry` is empty.
   `/policies/` therefore says no policy has been authorised, even though the national
   website baseline is supposed to be presumed adopted.
2. **The existing ratification path cannot import a legacy policy.** `ratify` requires
   a successful ballot result bound to the exact revision and a proposal in `implement`
   (`src/pages/api/admin/policies/ratify.ts:39-65`). A legacy-published policy has no
   ballot and no decision event. Forcing it through `ratify` would fabricate the
   evidence the governance rule forbids fabricating.
3. **The publication path also assumes ratification.** `publish` requires
   `policy.ratification.decisionEventId` (`src/pages/api/admin/policies/publish.ts:27-35`).
   A legacy baseline record with an honest `ratification: null` cannot currently be
   published.
4. **There is no policy-level revision store independent of proposals.** The public
   version endpoints read `proposal_revisions` by `revisionIds`
   (`src/pages/api/v1/policies/[id]/versions/index.ts:16-19`). Imported baseline
   records have no proposal and therefore no version history unless a new registry
   revision store is added.
5. **The proposed governance lifecycle is largely not implemented.** There is no
   proposal seconding, 14-day deliberation clock, 30-day ballot window, early-closure
   rule, tie/abstention/non-voter rule, seven-day confirmation ballot, preferential
   amendment conflict resolution, or automatic ratification within delegated
   authority.
6. **Ballot outcomes are recorded manually, not computed.** An administrator supplies
   `successful`/`unsuccessful`/`inconclusive`; the endpoint does not check the tally
   (`src/pages/api/admin/ballots/result.ts:61-69`). Amendment closure computes a tally
   but still accepts an administrator-supplied result
   (`src/pages/api/admin/amendments/close-ballot.ts:65-93`).
7. **There is no eligibility snapshot and no ballot-instance model.** Eligibility is
   checked against current membership at vote time
   (`src/lib/store.ts:1249-1268`). A later membership change can alter the apparent
   electorate. `ballot_results` has a unique index on `proposalId` only
   (`src/lib/db.ts:161-163`), so a second confirmation ballot on the same proposal is
   blocked.
8. **There is no commitment-level supersession, partial replacement or repeal model.**
   Registry supersession is whole-policy only
   (`src/pages/api/admin/policies/supersede.ts:114-127`). `withdraw` removes publication
   but does not repeal the policy. `commitments` in the registry are plain strings with
   no stable IDs.
9. **The reconciliation corpus mislabels Reclaim status.** `scripts/reclaim-extract.mjs:182`
   hard-codes `status: "adopted"` for the 76 Reclaim policy files. The application
   treats all 78 Reclaim records as proposals: 40 in `deliberate`, 38 in `decide`.
   `SCHEMAS.md:109` says `reclaim_status` comes from the Engage record, which is not
   true. This is a provenance risk, not a cosmetic inconsistency.
10. **There is no Victorian policy corpus in the repository.** There are national
    announcements mentioning Victoria, but no Victorian branch policy baseline,
    adoption record, commitment structure or branch-authority evidence. Victorian
    import cannot be verified or implemented from the current repository.

## What would prevent safe rollout

The following are rollout blockers, not roadmap preferences:

- Importing national policy through the existing `ratify` path would fabricate
  ratification evidence.
- Publishing an honest legacy record is impossible without extending the publication
  contract.
- The `/policies/` experience is empty until a baseline import exists.
- A member cannot propose an amendment to an adopted policy or a repeal from the policy
  page; amendments only exist inside pre-Decide proposals.
- Ballot windows, early closure, ties, confirmation and automatic ratification cannot
  be enforced because the underlying ballot, eligibility and tally models are absent.
- The public/private access boundary is incomplete: private proposal revisions are
  readable without authentication, and comments, amendments and votes do not all check
  `canViewProposal`.
- The NUC CI workflow calls `pnpm test:cutoff` and `pnpm test:auth`, but those scripts
  do not exist in `package.json:9-15`; that pipeline will fail on `main`.
- The reconciliation's 40 supersession candidates are not safe to import: 31 combine
  `relationship: expands` with replacement-shaped scope, the single equivalent is
  recorded as a partial replacement, and only 6 of 40 are flagged for explicit
  authorisation.

## Bottom line

Engage should be extended, not rewritten. The proposal/revision/ballot-integrity core
and the publication outbox are reusable. The safe first move is a **separate,
explicit, idempotent national baseline import** that writes registry records and
registry revisions under `authority_basis: legacy_official_publication`, with no ballot,
no invented decision event and no supersession. Victorian import must wait for the
Victorian corpus and branch-authority decisions. The governance lifecycle should be
implemented in slices, with the ballot-instance and eligibility-snapshot schema
introduced before the rules that depend on them.

---

# B. Verified capability matrix

Status legend:

- **Verified** — implemented and covered by a passing test or directly exercised.
- **Implemented, not sufficiently tested** — code exists, but the important path is
  skipped or only in-memory.
- **Partial** — some pieces exist; material behaviour is missing.
- **Missing** — no implementation found.
- **Governance decision** — the repository cannot decide the rule; a human decision is
  required before implementation.

## B.1 Participation, proposals and ballots

| Capability | Status | Evidence and key functions | Gap |
| --- | --- | --- | --- |
| Proposal CRUD | **Verified** | `src/lib/store.ts:278-381, 507-1100`; `src/pages/api/proposals/*`; `src/lib/store.test.ts:58-224` | None material for current scope. |
| Four-stage lifecycle | **Verified** | `normalizeStage`, `validateStageTransition` at `src/lib/store.ts:77-121`; stage tests at `src/lib/store.test.ts:663-787` | Stages are labels plus guards; no clocks or deadlines. |
| Proposal revisions and content hashes | **Verified** | `src/lib/store.ts:958-1025`; `proposal_revisions` index `src/lib/db.ts:145-151`; tests `src/lib/store.test.ts:788-897` | No policy-level revision store independent of proposals. |
| Ballot wording frozen to a revision | **Verified** | `src/lib/store.ts:1345-1420`; `src/pages/api/admin/ballots/bind.ts`; tests `src/lib/store.test.ts:826-897` | One ballot identity per proposal in practice; no ballot-instance collection. |
| Approve / Abstain / Reject | **Verified** | `castVote` at `src/lib/store.ts:1228-1469`; `src/components/ui/ProposalBallot.tsx`; store tests | No deadline, eligibility snapshot or computed result. |
| Vote change history | **Partial** | `proposal_votes` upserts the current selection; `updatedAt` only | No append-only vote-event audit; cannot reconstruct a member's earlier choices. |
| Amendment submission | **Partial** | `src/pages/api/amendments.ts`; `src/lib/amendments.ts`; tests `src/lib/store.test.ts:1141-1207` | UI only sends `title` and `summary` (`src/pages/proposals/[slug].astro:695-700`), while the API supports `details` and `outcomes`. No seconding. |
| Immutable amendment revisions | **Verified** | `amendment_revisions` with parent, hash and author; `createAmendmentRevision` | No first-class amendment discussion page. |
| Separate amendment ballots | **Verified (in-memory)** | `open-ballot`, `close-ballot`, `accept`, `apply`, `resolve`; `governance-api.test.ts:828-988` | Result is administrator-supplied; no threshold computation. Real-Mongo coverage absent. |
| Amendment conflict detection | **Partial** | `src/pages/api/amendments.ts:87-109`; `resolve.ts:72-131` | Field-overlap detection only; no preferential resolution and no cross-amendment ranking. |
| Proposal seconding | **Missing** | No `second`, `seconder` or equivalent in `src/` | Proposed rule cannot be enforced. |
| Fourteen-day deliberation | **Missing** | No stage timestamps or timers | Proposed rule cannot be enforced. |
| Thirty-day ballot window | **Missing** | No `opensAt`, `closesAt`, deadline or scheduler in `src/` | Proposed rule cannot be enforced. |
| Early closure guard | **Missing** | No participation denominator or irreversibility calculation | Proposed rule cannot be enforced. |
| Tie / abstention / non-voter treatment | **Governance decision** | Manual result only | Rule is undefined in the repository and must not be invented. |
| Seven-day confirmation ballot | **Missing** | No second-ballot type; `ballot_results` unique on `proposalId` (`src/lib/db.ts:161-163`) | Blocked by schema as well as process. |
| Preferential amendment resolution | **Governance decision** | No preferential model | Method must be chosen before implementation. |
| Automatic ratification | **Missing** | `ratify.ts` is national-admin-only and manual (`ratify.ts:10-14, 39-65`) | No delegated authority configuration. |
| Existing policy remains authoritative while change is considered | **Partial** | Published registry record remains; proposals are separate | No structured `targetPolicyId` or effect statement; no automatic unpublish. |

## B.2 Policy registry, provenance and supersession

| Capability | Status | Evidence and key functions | Gap |
| --- | --- | --- | --- |
| Registry collection and unique policy ID | **Verified** | `src/lib/db.ts:153-155`; `policy_registry` writes in `ratify.ts` | IDs are proposal IDs; no namespace for national/Victorian baselines. |
| Ratification for ballot-derived policy | **Verified** | `src/pages/api/admin/policies/ratify.ts`; `governance-api.test.ts:512-702` | Requires successful ballot result for the exact revision; unusable for legacy import without fabrication. |
| Legacy adopted policy import | **Missing** | No import service, script or admin screen | Primary blocker. |
| National policy authority | **Partial** | `governanceAuthorityBranchId`, `jurisdictionBranchId`, `publicationScope` fields on proposals and registry | No authority-policy configuration; `ratify` restricted to national administrators; no state ratification. |
| Victorian policy authority | **Missing** | No Victorian corpus, no branch adoption record, no branch operating-rule model | Cannot be verified from the repository. |
| Stable policy identifiers | **Partial** | `proposalId` / `policyId` exist and are unique | `POL-###` is already occupied by Reclaim; no `NAT-*` / `VIC-*` namespace. |
| Immutable adopted revisions | **Partial** | Proposal revisions are append-only; registry points to a revision | Registry revision history depends on `proposal_revisions`; no registry-level immutable store. |
| Historical revision retrieval | **Partial** | `/api/v1/policies/:id/versions` and `/:version` | Reads `proposal_revisions` only (`versions/index.ts:16-19`); imported baseline has none. |
| Predecessor relationships | **Partial** | Free-text `provenance.lineage`; whole-policy `supersededBy` | No structured `predecessorPolicyId`, no commitment-level predecessor. |
| Commitment-level supersession | **Missing** | Registry `commitments` is `string[]` | No stable commitment IDs or per-commitment status. |
| Partial replacement | **Partial** | Whole-policy `supersede` only | Cannot express “only these commitments cease”. |
| Complete replacement | **Partial** | `supersede` marks a whole registry entry | No repeal vs supersession distinction; no replacement-scope record. |
| Repeal | **Missing** | `withdraw` only changes publication status; `status` remains `adopted` | No repeal proposal type, event or status. |
| Ratification evidence | **Partial** | `ratification` object for ballots; `provenance` on proposals | No `authorityBasis`, `ratificationEvidence` or migration evidence fields in the registry. |
| Publication events | **Verified** | `publish`, `withdraw`, `supersede`, `reconcile`; `publication_events` index; `governance-api.test.ts:29-135, 454-511, 1072-1184` | Event + registry writes are not transactional; reconciliation is manual. |
| Public API consumption | **Verified for published records** | `src/pages/api/v1/*`; `src/lib/public-api.ts`; `src/lib/public-policy.ts`; OpenAPI test | Does not expose authority basis, instrument type, migration source or commitment IDs. |
| Transactional state changes | **Partial** | Proposal create/update uses a transaction when a real client is present (`store.ts:983-1025, 1085-1098`) | Votes, ratify, publish, supersede, branch events and amendment apply are not fully transactional. |
| Idempotent state changes | **Partial** | Publication/withdrawal/supersession require `Idempotency-Key`; ballot binding uses deterministic event IDs | Ballot result is not idempotent; ratify is keyed but not transactional. |

## B.3 Authority, branches and Victorian readiness

| Capability | Status | Evidence and key functions | Gap |
| --- | --- | --- | --- |
| Data-driven branches | **Verified** | `src/pages/api/admin/branches.ts`; `governance-api.test.ts:136-326` | No branch operating rules or authority scopes. |
| Explicit branch membership | **Verified** | `src/pages/api/admin/branches/memberships.ts`; `branch-access.test.ts` | Membership is checked at vote time only; no snapshot. |
| Delegated branch administration | **Verified** | `canAdministerBranch`, `canManageBranchProposal`, `canManageBranchBallot` in `src/lib/auth.ts:184-221`; `branch-access.test.ts` | Branch administrators cannot ratify/publish policy; only national administrators can. |
| Branch-scoped ballot authority | **Verified** | `canManageBranchBallot` requires authority and jurisdiction to match the assigned branch | This equality rule may be too rigid for cross-jurisdiction authority; governance question. |
| Branch operating-rule authority | **Missing** | No rule document, rule class or executive-authorisation concept | Cannot distinguish ordinary Victorian policy decisions from operating-rule changes. |
| Victorian adopted baseline | **Missing** | No Victorian corpus in `corpus/` or elsewhere in the repo | Import is blocked on source evidence, not just code. |
| National/Victorian publication scope | **Partial** | `publicationScope` supports `private`, `branch`, `national` | No policy effect analysis, no state-level ratification authority. |

## B.4 Member experience

| Journey | Status | Evidence | Functional gap |
| --- | --- | --- | --- |
| Find adopted national policy | **Partial** | `/policies/` exists (`src/pages/policies/index.astro`) | Registry is empty on a fresh install; no baseline import. |
| Find adopted Victorian policy | **Missing** | No Victorian records or corpus | Cannot be delivered. |
| Identify proposals awaiting their vote | **Partial** | `listOutstandingDecisions` (`src/lib/store.ts:1525-1536`); `/member/` | Does not filter by branch eligibility; members can be shown ballots they cannot vote on. |
| Understand proposed vs adopted wording | **Partial** | `/how-it-works/`; proposal and policy pages are separate | No side-by-side “current policy vs proposed change”; implement-stage proposal may have no registry record. |
| Propose a new policy | **Verified** | `/proposals/new/`; `POST /api/proposals` | Basic only; no policy target, no repeal, no seconding. |
| Propose an amendment to an adopted policy | **Missing** | No action on `/policies/[slug]`; amendments only for pre-Decide proposals (`src/pages/api/amendments.ts:74-78`) | Primary journey gap. |
| Propose a repeal | **Missing** | No repeal concept in UI or API | Primary journey gap. |
| Follow discussions | **Partial** | Comments, stances and endorsements; `src/pages/api/comments.ts`; proposal page | No notifications or subscription to a proposal; no “following” state. |
| Understand how participation affects outcomes | **Partial** | Tallies and percentages on proposal page | No electorate size, quorum, threshold, closing date or explanation of abstentions/non-voters. |

### Cosmetic issues (not rollout blockers)

- `src/pages/policies/index.astro` defines two overlapping `.policy-intro` and
  `.policy-grid` style blocks; the later block overrides the former. It is harmless but
  makes the page harder to maintain.
- `README.md:9` describes “76 baseline policies” and “Approve/Reject” voting; the data
  contains 78 proposals and also supports Abstain.
- Several admin screens use long inline client scripts and duplicated fetch/error
  handling. This is a maintainability issue, not a functional blocker.
- `docs/operations.md` still refers to removed endpoints/scripts and preview seeding
  that do not match the current CRUD application.

These should be cleaned up during Batch 4, after the functional gaps are closed.

## B.5 Administration

| Capability | Status | Evidence | Gap |
| --- | --- | --- | --- |
| Proposal management | **Verified** | `/admin/proposals/`; stage selector; ballot binding and result controls | No deadline/window controls; no seconding view. |
| Member verification and roles | **Verified** | `/admin/members/`; `src/pages/api/admin/members.ts`; `member-notification.test.ts` | Real-Mongo auth link test skipped locally. |
| Branch governance | **Partial** | `/admin/branches/`; branch creation/editing, memberships, referrals | No operating-rule authorisation or branch policy workflow. |
| Policy registry administration | **Partial** | `/admin/policies/`; ratify, publish, withdraw, supersede, reconcile | No baseline import; no repeal; no commitment-level supersession. |
| Baseline import administration | **Missing** | No screen, route or script | Primary blocker. |
| Provenance editing | **Partial** | Proposal provenance editor in `/admin/proposals/` | Registry provenance is display-only; no import evidence fields. |

## B.6 Security, access and data boundaries

| Finding | Severity | Evidence | Consequence |
| --- | --- | --- | --- |
| Private proposal revisions are unauthenticated | **High** | `src/pages/api/proposals/[proposalId]/revisions.ts:4-30` has no `getSessionUser` and no `canViewProposal` check | Anyone who knows a proposal ID or slug can read its revision history, including private/branch-only proposals. |
| Amendment listing does not check proposal visibility | **High** | `src/pages/api/amendments.ts:7-27` only requires sign-in | Any signed-in user can list amendments for a private proposal if they know its ID. |
| Comments do not check proposal visibility | **High** | `addComment` at `src/lib/store.ts:1126-1175` checks archived status only | A verified member can comment on a private proposal if they know its ID. |
| Votes do not check proposal visibility | **Medium** | `castVote` checks stage and branch membership, not `publicationScope` | A branch member could vote on a private branch proposal if they know its ID and are in the jurisdiction branch. |
| Ballot identities visible to moderators | **Governance decision** | `GET /api/proposals/[proposalId]` returns full `votesList` when `user.isStaff` (`src/pages/api/proposals/[proposalId].ts:22-28`) | Moderators, not just administrators, can see member identities and reasons. The ADR refers to officer-restricted identifiable ballots; confirm the intended role boundary. |
| No vote-change audit | **Medium** | `proposal_votes` upsert; no event log | Cannot prove the sequence of a member's choices or detect anomalies. |
| Development login bypass if `APP_MODE` is wrong | **Medium** | `getSessionUser` accepts `engage_dev_user` whenever `APP_MODE !== "production"` (`src/lib/auth.ts:223-241`) | A production misconfiguration could grant administrator access. Deployment docs mitigate, but fail-closed would be safer. |

## B.7 Tests, CI and migration verification

| Item | Status | Evidence | Gap |
| --- | --- | --- | --- |
| Unit/API suite | **Verified** | `pnpm test`: 50 pass, 8 skip | Governance API tests run against in-memory DB, not real MongoDB. |
| Real MongoDB voting tests | **Implemented, not sufficiently tested locally** | `src/lib/voting-mongo.test.ts`; skip when `VOTING_TEST_MONGODB_URI` is absent | CI `ci.yml` runs them; local run does not. |
| Real MongoDB auth test | **Implemented, not sufficiently tested locally** | `src/lib/auth.test.ts`; skip when `AUTH_TEST_MONGODB_URI` is absent | Same. |
| Governance API real-Mongo coverage | **Missing** | `src/lib/governance-api.test.ts` uses `getDatabase({ APP_MODE: "development" })` | No transaction or duplicate-key exercise for ratify/publish/supersede/amendments on real MongoDB. |
| NUC CI workflow | **Broken** | `.github/workflows/nuc-cicd.yml:68,74` run `pnpm test:cutoff` and `pnpm test:auth`; `package.json:9-15` has neither | Pipeline fails on `main` after install and before deploy. |
| NUC real-Mongo vote tests | **Broken** | `nuc-cicd.yml:29` sets `GOVERNANCE_TEST_MONGODB_URI`, but `voting-mongo.test.ts` reads `VOTING_TEST_MONGODB_URI` | The NUC pipeline would skip the real voting tests even if the missing scripts were fixed. |
| Migration safety | **Partial** | Vote migration is explicit, dry-run-first and has a completion marker (`src/lib/vote-storage.ts`, `docs/voting-storage-migration.md`) | Application startup still performs implicit seeding, revision backfill and ballot binding (`src/lib/db.ts:267-391`). Baseline import must not repeat this pattern. |
| Documentation accuracy | **Partial** | `docs/engage-governance-api.md` is largely accurate; `docs/voting-storage-migration.md:141-142` says the workflow no longer calls removed scripts, but it does | Docs and CI disagree. `README.md:9` says 76 baseline policies; data has 78 proposals. |

---

# C. Reconciliation assessment

## C.1 What the pipeline actually produced

The reconciliation is a **staging map**, not an import. Its own handover is explicit:
nothing was imported, ratified or superseded (`corpus/reconciliation/HANDOVER.md:1-8`),
and every supersession row carries `approved: false` and `ratified: false`
(`corpus/reconciliation/supersession-candidates.jsonl`).

Verified headline numbers from `corpus/reconciliation/stats.json` and `SUMMARY.md`:

| Metric | Value |
| --- | --- |
| Neon commitments extracted | 370 |
| Neon documents with extracted commitments | 16 of 17 examined |
| Reclaim records | 78 (76 policy + 2 governance proposals) |
| Classified candidate pairs | 165 (145 appear as predecessor/successor rows) |
| Reclaim records with at least one Neon predecessor | 55 |
| Reclaim records with no Neon predecessor candidate | 23 |
| Neon commitments with a Reclaim counterpart | 75 |
| Neon commitments with no successor candidate | 257 |
| Proposed supersession relationships | 40 |
| Supersession rows flagged for explicit authorisation | 6 |
| Review queue items | 343 |

The 165 classified pairs include 20 pairs whose answer was
`no_successor_identified`; those do not appear in the predecessor/successor arrays,
which is why the arrays contain 145 rows. This is internally consistent but the
headline “165 classified pairs” should not be read as 165 positive relationships.

## C.2 The single equivalent relationship

**Pair:** `POL-005` “End Forced Indue Cards” ↔ `p-c142a3169cc1-007`

- Neon: “Fusion strongly opposes forcing people who receive income support onto
  cashless welfare… any Centrelink recipient should have the option to receive their
  benefits via a cashless welfare card.”
- Reclaim: “Welfare payment recipients will no longer be required to use Indue cards,
  with the option remaining voluntary.”

**Assessment:** the wording is semantically equivalent. This is the most defensible
semantic match in the corpus.

**But the record is not safe as written:**

- `relationship_confidence` is only **0.29**.
- `supersession_scope` is **`partial_replacement`**, which is inconsistent with
  equivalence. If the commitment is equivalent and does not remove or narrow the Neon
  wording, the scope should be `additional_independent_commitment` or
  `related_no_effect`.
- The pair appears in `supersession-candidates.jsonl` as an equivalent/partial
  replacement. That would let an automated consumer treat equivalence as a reason to
  stop the Neon wording being authoritative. The task explicitly forbids an
  equivalence-based ratification shortcut.
- The Neon source is an FAQ answer in `/policy_faq`, not a numbered commitment. It is
  classified `authoritative_baseline` in v2, but its instrument type should be
  confirmed as a published position rather than a policy commitment.

**Recommendation:** keep the semantic equivalence as evidence, set
`supersession_scope: related_no_effect`, and require human confirmation of the FAQ
instrument type before using it in any registry decision.

## C.3 The single reported contradiction

**Pair:** `POL-018` “Guarantee Secure and Safe Renting” ↔ `p-ac04500f9de9-047`

- Neon: “We do not recommend banning no-grounds evictions… Instead, we recommend that
  no-grounds evictions must come with 12 months' notice.”
- Reclaim: “Establish National Rental Security Standards that prohibit no-grounds
  evictions…”

**Assessment:** this is a genuine policy contradiction, not a granularity error. The
Reclaim position reverses the Neon recommendation. It is correctly identified as
`contradicts` with confidence 0.89 and `supersession_scope: full_replacement`.

**However:**

- The pair's `needs_human_review` is **false**, even though the review queue separately
  contains a `contradiction` item at high severity. The review-queue flag, not the pair
  flag, is doing the safety work. `needs_human_review` is not a reliable gate.
- It is one of the six rows flagged `requires_explicit_authorisation: true`, which is
  correct.

**Recommendation:** preserve both texts. Do not import Reclaim as superseding the
Neon rental position without an explicit, recorded decision. This is exactly the kind
of change that must not be inferred from semantic similarity.

## C.4 The six supersession-authorisation concerns

The six rows flagged `supersession_requires_explicit_authorisation` are:

| Reclaim | Neon commitment | Relationship | Scope |
| --- | --- | --- | --- |
| `POL-011` | `p-ac04500f9de9-031` | `materially_changes` | `partial_replacement` |
| `POL-011` | `p-ac04500f9de9-032` | `materially_changes` | `full_replacement` |
| `POL-011` | `p-ac04500f9de9-033` | `materially_changes` | `full_replacement` |
| `POL-018` | `p-ac04500f9de9-038` | `materially_changes` | `full_replacement` |
| `POL-018` | `p-ac04500f9de9-047` | `contradicts` | `full_replacement` |
| `POL-036` | `p-9f494d4dacbf-020` | `materially_changes` | `partial_replacement` |

These are genuine authorisation concerns. The problems are:

- The flag is computed only when the relationship is
  `materially_changes`, `contradicts` or `narrows` and the scope is replacement-shaped
  (`SCHEMAS.md:147`).
- **31 other rows combine `relationship: expands` with `full_replacement` or
  `partial_replacement`.** That is logically inconsistent: `expands` means the Neon
  commitment remains intact, while replacement scope means it ceases to be
  authoritative. Even if the semantic label is accepted, the scope would remove or
  alter published wording.
- The single `equivalent` pair is also given `partial_replacement`.

**Assessment:** the authorisation flag is too narrow. For any registry decision, the
safe rule is:

> Any `supersession_scope` of `full_replacement` or `partial_replacement` requires
> explicit human authorisation, regardless of the semantic relationship label.

That means **all 40 supersession candidates** are approval-required. The “six” is a
useful high-severity subset, not the full set.

## C.5 The unresolved replacement scope

**Pair:** `POL-054` “Put Essential Services Back in Public Hands” ↔
`p-c142a3169cc1-017`

- Neon: a FAQ bullet about large IT projects holding personal data.
- Reclaim: a broad commitment that essential services, including major public data
  systems, remain, return to, or are placed under public ownership.

**Assessment:** the relationship is classed `expands` with
`supersession_scope: unresolved_scope`. That is correct to leave unresolved. The Neon
text is a list item inside an FAQ about privatisation, not a discrete commitment that
can be switched off. The Reclaim text is much broader. There is no textual basis for
saying the Neon bullet ceases to be authoritative.

**Recommendation:** treat as `related_only`/`additional_independent_commitment` unless a
human decides the FAQ bullet is replaced. Do not use this row to mark any Neon text
superseded.

## C.6 Representative sample of materially changed and expanded commitments

The semantic labels are only as good as the candidate retrieval. Several top-ranked
pairs are clearly wrong or too weak to be treated as predecessors:

| Reclaim | Top Neon predecessor | Why it is problematic |
| --- | --- | --- |
| `POL-004` Simplify Access to Supplementary Supports | `p-55f10b7b36ee-004` whistleblower “simplified, strengthened and standardised across all sectors” | Different subject; “standardised” lexical overlap only. Confidence 0.49. |
| `POL-009` Deliver Free or Affordable Childcare | `p-9dece50c179e-013` “Ensure publicly funded research is open-access” | Unrelated subjects; “publicly funded” overlap. Confidence 0.47. |
| `POL-015` Create a Housing Approval Fast-Track | `p-451c2a7bc300-099` “Implement changes in building codes and land use policies” | Loosely related at best; not a predecessor commitment. Confidence 0.33. |
| `POL-026` Enforce Prompt Payment of Small Business | `p-ac04500f9de9-068` stamp duty/land tax | Different policy domain. Confidence 0.33. |
| `POL-030` Simplify Unfair Contract Disputes | `p-55f10b7b36ee-021` whistleblower protections | Different domain. Confidence 0.34. |
| `POL-036` Help Farms Profit More & Emit Less | `p-9f494d4dacbf-030` climate/carbon passage | Top pair confidence 0.33; a later `materially_changes` pair at 0.63 is the one flagged. Candidate ranking is unstable. |

There are also credible matches:

| Reclaim | Neon | Assessment |
| --- | --- | --- |
| `POL-001` UBI / Citizen's Dividend | `p-016ad5941ffe-014` “direct payments increased to at least $500/week” | Semantically credible expansion, confidence 0.89. Scope is `full_replacement`, which is too strong. |
| `POL-006` Dental and Mental Health into Medicare | `p-016ad5941ffe-009` “Add basic mental and dental health to medicare” | Credible expansion, confidence 0.87. Scope should not automatically be full replacement. |
| `POL-010` Make It Easier to Buy and Move Home | `p-ac04500f9de9-068` “Replacing stamp duty with land tax…” | Credible, confidence 0.99. Still a policy expansion, not a repeal of the Neon commitment. |
| `POL-043` Reward Whistleblowers | multiple whistleblower passages | Credible area match, high confidence on some pairs, but 10 separate supersession rows show fragmentation. |

**Overall:** only **3 of 55** top-ranked predecessor pairs have both
`relationship_confidence >= 0.8` and retrieval score `>= 0.3`. **52 of 55** top
predecessors have retrieval score below 0.3; **32 of 55** have relationship confidence
below 0.6; **21 of 55** are both below 0.5 confidence and below 0.2 retrieval. The
map contains useful evidence, but it is not a verified predecessor set.

## C.7 The 257 unmatched Neon commitments

The unmatched set is **not** evidence of rejection, repeal or deliberate omission.

Verified characteristics:

- **184 of 257** unmatched commitments share a heading with at least one commitment
  that did have a Reclaim counterpart. This is strong evidence of extraction
  fragmentation or a consolidation at a different granularity, not automatic absence.
- **92** are short list items (under 140 characters), often sub-bullets beneath a
  heading whose parent was matched.
- **96 of 118** commitments from the Principles document are unmatched. This document
  is values-oriented; Reclaim restructures the platform into actionable commitments.
  Values statements are the least likely to have one-to-one successors.
- **21** of the Housing “Conclusion” passages are unmatched. Conclusions and
  explanations are not necessarily commitments.
- **26 of 48** Whistleblower commitments are unmatched even though Reclaim has a
  whistleblower policy (`POL-043`) with 10 supersession candidates. This is a clear
  consolidation/fragmentation case: Reclaim's single policy covers a broader area,
  while Neon has many sub-plans.
- **22 of 27** Climate Rescue commitments are unmatched, including numeric targets
  and implementation details. Some may be genuinely dropped; others may be folded into
  Reclaim's broader climate policies.
- The two Israel–Palestine documents each contribute one unmatched commitment and are
  separately flagged as unresolved. They are not evidence of a successor.

**Conclusion:** the 257 should be recorded as
`no_successor_candidate_identified`, not `dropped_by_reclaim`. The current field name
`dropped_by_reclaim` and the review-queue wording “candidate dropped commitment if the
Reclaim platform is adopted as the sole programme” overstate what the pipeline knows.
They also presume a “sole programme” decision that has not been made.

## C.8 Is Reclaim a reset-and-rebuild?

The data is consistent with a **selective reset-and-rebuild**, not a line-by-line
successor platform:

- Reclaim has 76 policy documents against 16 Neon documents with extracted
  commitments. The granularity is fundamentally different: Neon is broad and
  values-oriented; Reclaim is a catalogue of individually actionable commitments.
- 23 Reclaim policies have no Neon predecessor candidate. Several are clearly new
  directions (drug law reform, online gambling harm, migration, animal welfare, marine
  protection, invasive species).
- 55 Reclaim policies have at least one candidate predecessor, but 21 of the top pairs
  are very weak and several are obviously wrong. The “covered” count overstates real
  continuity.
- 257 Neon commitments have no successor candidate, but 184 share a heading with a
  matched commitment and 96 come from the Principles document. Much of the apparent
  drop is granularity, not necessarily policy reversal.
- The corpus's own migration rule treats currently published national positions as
  presumed adopted, not as repealed by the existence of Reclaim.

**What the evidence does not prove:** that Reclaim is intended to replace the entire
Neon platform, that unmatched Neon policies are repealed, or that Reclaim's 76 policies
are themselves adopted. The manifest's hard-coded `status: "adopted"` is especially
dangerous here: it can make a reset look like an accomplished fact.

**Product-direction finding:** treat “Reclaim as successor” vs “Reclaim as a new
programme alongside the national baseline” as an explicit governance decision
(decision G4/G5). Do not encode either interpretation in the registry until that
decision is recorded.

## C.9 Pipeline defects to correct before any import

These are correctness issues in the reconciliation artefacts, separate from the
question of what policy should be adopted:

1. **Hard-coded Reclaim status.** `scripts/reclaim-extract.mjs:182` writes
   `status: "adopted"` for the 76 policy records. `SCHEMAS.md:109` says the field comes
   from the Engage record. It does not. The Engage records are 40 `open` and 38
   `voting`; the two governance proposals are `voting`.
2. **Misleading `dropped_by_reclaim`.** Rename to
   `no_successor_candidate_identified` or keep the boolean but document it as a
   candidate-retrieval outcome, never a decision.
3. **Inconsistent relationship/scope combinations.** 31 rows are `expands` plus
   replacement scope; 1 is `equivalent` plus `partial_replacement`. Recompute or flag
   these for human review.
4. **Authorisation flag too narrow.** All replacement-shaped scopes require explicit
   authorisation, not only `materially_changes`/`contradicts`/`narrows`.
5. **`needs_human_review` not reliable.** The contradiction pair has
   `needs_human_review: false`; the equivalent pair has `material_change: true`.
   Derive review flags from relationship, scope and material change, not only the
   model's noul answer.
6. **Low retrieval quality.** 52 of 55 top predecessors have retrieval score < 0.3.
   The deterministic retrieval is a candidate generator, not a matcher.
7. **No Victorian data.** There is no Victorian corpus, adoption record or branch
   authority evidence in the repository.

## C.10 Minimum additional human review before import

### Before national baseline import (blocking)

1. Approve the legacy-publication rule as an organisational decision (G1).
2. Confirm the instrument classification of the 15 `authoritative_baseline` documents:
   which are policies, which are platform principles, which are position statements,
   and whether `/policy_faq` and `/policy_overview` should create records at all (G2).
3. Decide the Israel–Palestine treatment: position material with unresolved
   supersession, or hold out of the baseline (G3).
4. Approve the policy ID namespace and the national authority branch (G4/T1).
5. Confirm exact body boundaries for each source document and verify the source
   SHA-256 against `inventory.jsonl` (T4).
6. Confirm that import is unpublished until an explicit batch publication action
   (G20).

### Before any supersession import (blocking)

1. Review **all 40** supersession candidates, not just the 6 flagged.
2. Resolve the 31 `expands` + replacement-scope contradictions and the
   `equivalent` + `partial_replacement` row.
3. Review the contradiction (`POL-018`), unresolved scope (`POL-054`) and the two
   Israel–Palestine items.
4. Review the 21 very-low-confidence top predecessor pairs and the 23
   “no Neon predecessor” Reclaim policies.
5. Decide whether unmatched Neon commitments remain authoritative (G5). If the
   decision is “Reclaim replaces the platform”, that is a separate repeal/reset
   decision, not an import side effect.

### Before Victorian import (blocking)

1. Supply the Victorian policy corpus and exact source evidence.
2. Confirm each policy's adopted/ratified status and the branch adoption record.
3. Confirm the Victorian branch authority, jurisdiction and publication scope.
4. Decide how branch operating-rule changes require executive authorisation while
   ordinary policy decisions are delegated to members (G15).

---

# D. Recommended development roadmap

## D.0 Sequencing decision

The preferred order is correct and should be retained:

1. Provenance and existing-policy baseline import.
2. Policy amendments and proposal lifecycle.
3. Ballot rules, conflict resolution and automatic ratification.
4. End-to-end verification and stabilisation.
5. Reassessment of subsequent product priorities.

One dependency adjustment is necessary: **the ballot-instance model and eligibility
snapshot schema must be introduced in Batch 2**, not Batch 3, because the seven-day
confirmation ballot and thirty-day window cannot be represented without them. Batch 3
then implements the counting and authorisation rules on top of that model. This is a
schema prerequisite, not a reordering of the governance decisions.

A second adjustment: **Batch 1 is split into 1A (national) and 1B (Victorian)**.
1B is blocked until the Victorian corpus and branch-authority evidence exist.

---

## Batch 1A — National legacy baseline import and provenance

### Objective

Make the national authoritative baseline visible and auditable in Engage as
legacy-published policy, without inventing ballots, decision events or ratification
dates, and without importing Reclaim or superseding anything.

### Existing capabilities to reuse

- `policy_registry` collection and unique `policyId` index (`src/lib/db.ts:153-155`).
- `publication_events` outbox, idempotency keys and reconcile endpoint.
- `branches`, `branch_memberships`, `getSessionUser`, admin layout.
- Public API patterns in `src/lib/public-api.ts` and `src/lib/public-policy.ts`.
- The reviewed national artefacts:
  - `corpus/national/candidates/reviewed-baseline.v2.jsonl`
  - `corpus/national/analysis/inventory.jsonl`
  - `corpus/reconciliation/neon-commitments.jsonl`
  - `national-neon-site/` exact source files.

### Implementation changes

1. **Identity and instrument type.**
   - Introduce `NAT-<slug>` policy IDs. Do not reuse `POL-###`.
   - Add `instrumentType`: `policy`, `platform_principle`, `position_statement`,
     `reference`.
   - Recommended initial mapping (subject to G2):
     - 12 `policy`: ten pillars + housing + whistleblower.
     - 1 `platform_principle`: policy principles.
     - 2 `position_statement`: both Israel–Palestine documents.
     - 2 `reference`: `/policy_overview` and `/policy_faq` (preserve source, do not
       publish as standalone policy).
2. **Registry revision store.**
   - Add `policy_revisions` keyed by `policyId` + `revisionId`, with
     `snapshot`, `contentHash`, `source` (file, URL, SHA-256, line range),
     `authorityBasis`, `createdAt`, `createdBy`.
   - Use `snapshot = { title, summary, outcomes, details }` so the existing version API
     shape remains stable. For baseline records, `details` is the exact reviewed body
     and `outcomes` is a reviewed commitment list (empty in the first cut unless
     explicitly approved).
   - Update version endpoints to read `policy_revisions` first and fall back to
     `proposal_revisions` for existing ratified policies.
3. **Authority fields.**
   - Add to registry records:
     `authorityBasis`, `ratificationEvidence`, `migration` (batch ID, rule version,
     source URL/file/SHA-256, body line range, imported by/at, reviewed by/at),
     `supersessionStatus`.
   - `ratification` stays `null`. Do not create `ballot_results`.
   - `effectiveAt` stays `null`. Do not use the WebSync export timestamp as a
     publication date.
4. **Import service and admin control.**
   - Add a shared service (for example `src/lib/policy-import.ts`) with
     `planNationalBaselineImport` and `applyNationalBaselineImport`.
   - Add a dry-run/apply admin route and a small panel in `/admin/policies/`.
   - Add `scripts/import-national-baseline.mjs` for operators, supporting
     `--dry-run` and `--apply --batch=<id>`.
   - Require an approved import manifest with per-document `instrumentType`,
     `bodyStartLine`, `bodyEndLine`, `include`, `reviewedBy`. Fail closed if the
     manifest is missing or unapproved.
   - Verify every source file hash against `inventory.jsonl` before writing.
   - Use one MongoDB transaction per apply; write an import-batch record and audit
     event.
5. **Publication.**
   - Import as `publicationStatus: "unpublished"`.
   - Extend `publish` to allow `authorityBasis: "legacy_official_publication"` with a
     migration batch and no decision event. Require `Idempotency-Key`.
   - Record `eventType: "legacy_baseline_publish"`, `authorityBasis`,
     `migrationBatchId`, `sourceUrl`, `sourceSha256` on the publication event. Keep
     `transition: "published"` so `reconcile` continues to work.
   - Do not allow a legacy record to be published without a batch.
6. **Public reads and UI.**
   - `publicPolicy` exposes `authorityBasis`, `ratificationEvidence`,
     `instrumentType`, `migration` source fields, `supersessionStatus`.
   - `/policies/` shows a “Legacy publication (official national website)” badge.
   - `/policies/[slug]` shows authority basis, source URL, source hash and migration
     batch; it must not present a fabricated ratification date or decision event.
7. **Seeding separation.**
   - Do not add baseline records to `src/data/policies.json`.
   - Do not import at application startup.
   - Keep the existing Reclaim proposal seed untouched in this batch.

### Dependencies

- G1 legacy-publication rule.
- G2 instrument classification and FAQ/overview treatment.
- G3 Israel–Palestine treatment.
- G4 ID namespace and national branch.
- G20 baseline publication step.
- Human-reviewed body boundaries and source hashes (T4).

### Acceptance criteria

- A dry run selects exactly the 15 `authoritative_baseline` plus 2
  `official_position_material` rows, excludes the 10 non-adopted items and the
  `/policy` alias, and reports per-document hashes and line ranges.
- Apply writes the expected registry records, `policy_revisions` and one
  `policy_import_batches` record, and is idempotent on rerun.
- No `proposals`, `proposal_votes`, `ballot_results`, `publication_events` or
  supersession records are created except the explicit legacy publication event.
- `ratification` is `null` and no `decisionEventId` exists on imported records.
- After an authorised batch publication, `/policies/` and `/api/v1/policies` expose
  the records with `authorityBasis: legacy_official_publication`.
- Exact wording matches the human-reviewed body and source hash.
- Existing Reclaim proposals, votes, ballots, amendments and revisions are
  byte-for-byte unchanged.
- `pnpm test` and `pnpm check` pass.

### Required tests

- Import planner: selection, exclusion, alias handling, deterministic IDs.
- Hash mismatch and unapproved manifest fail closed.
- Apply idempotency and transaction rollback on injected failure.
- Unauthorised import/publish rejected.
- Legacy publish without ratification succeeds only with a batch; ordinary publish
  path still requires ratification.
- Version API reads baseline revisions and still reads proposal-derived revisions.
- Public API contract includes authority fields and does not leak member IDs.
- No writes to proposal/vote/ballot collections.
- Real-Mongo transaction integration test.

### Risks

- Misclassifying a hub/FAQ page as a policy.
- Including navigation/footer text in `approvedWording`.
- Duplicating an existing Reclaim record or reusing its ID.
- Overstating authority: “presumed adopted” must not read as “ballot-ratified”.
- Startup seeding or a rerun duplicating records.
- Public confusion while Reclaim proposals remain in `open`/`voting`.

---

## Batch 1B — Victorian baseline import (blocked)

### Objective

Import Fusion Victoria's already-adopted commitment-oriented policies as an adopted
Victorian baseline, without fresh ratification, and prepare branch-scoped authority.

### Status

**Blocked.** There is no Victorian policy corpus in the repository. Existing Victorian
material in `national-neon-site/` is national announcement/commentary, not a branch
policy baseline.

### Required inputs

- Exact Victorian policy source files with hashes and line ranges.
- Evidence of adoption/ratification and the adopting branch authority.
- The Victorian branch record and jurisdiction.
- A decision on which documents are policies vs position statements.
- The branch operating-rule boundary and executive-authorisation requirement.

### Reuse and changes

Reuse the Batch 1A import service with a `victorian` source adapter, `VIC-<slug>` IDs,
`authorityBasis: legacy_branch_adoption` (or an agreed equivalent),
`jurisdiction: "Victoria"`, and a Victorian branch authority. Do not send these
records through `ratify`.

### Acceptance criteria

- Import is idempotent and source-linked.
- Records show Victorian branch authority, not national presumed adoption.
- No fresh ballot or fabricated ratification is created.
- Branch administrators can see the records; national administrators retain oversight.
- The ordinary policy decision workflow is distinguishable from branch operating-rule
  changes.

---

## Batch 2 — Policy amendments and proposal lifecycle

### Objective

Implement the member-facing lifecycle for new policies, amendments and repeals:

**Propose → Deliberate → Decide → Implement**

with seconding, minimum deliberation, first-class amendments, ballot windows and
confirmation, while preserving existing ballots.

### Existing capabilities to reuse

- `proposals`, `proposal_revisions`, `amendments`, `amendment_revisions`.
- `proposal_votes` with `(ballotId, memberId)` uniqueness.
- Ballot binding, ballot result, amendment ballot and acceptance flows.
- Branch access and eligibility checks.

### Implementation changes

1. **Seconding.**
   - G6 is decided as a governance design principle: **every formal motion requires
     one independent eligible seconder**, including new policy proposals, formal
     amendments and repeal proposals. The author cannot second their own motion.
   - A seconder supports formal consideration, not necessarily approval. Minor
     editorial corrections need not restart seconding. Material changes to formally
     seconded wording require renewed seconding.
   - Add a `proposal_seconds` collection (or `seconders` array) with unique
     `(proposalId, memberId)`.
   - Require a seconder from a different eligible member before a proposal can enter
     `decide`, and before a formal amendment enters its formal decision process.
   - Show seconders and the remaining requirement in the UI.
   - Do not describe seconding as operational until the lifecycle implementation and
     its tests are complete. This decision does not create a new voting restriction
     in the current interface.
2. **Stage clocks.**
   - Add `stageEnteredAt`, `deliberationOpensAt`, `deliberationClosesAt`.
   - Enforce the 14-day minimum on transition to `decide` if G7 enables it. Existing
     proposals get `null` timestamps; do not invent historical dates.
3. **Ballot instances.**
   - Add a `ballots` collection with `ballotId`, `proposalId`, `type`
     (`proposal`, `amendment`, `confirmation`), `revisionId`, `opensAt`, `closesAt`,
     `status`, `resultPolicy`, `eligibilitySnapshotId`, `createdBy`.
   - Map existing `proposal:<proposalId>` vote identities to a legacy ballot record by
     reference; do not rewrite `proposal_votes`.
   - Replace the `ballot_results` unique index on `proposalId` with
     `(proposalId, ballotId)` after a safe migration. Keep legacy records readable.
4. **Thirty-day ballot window.**
   - Add `opensAt`/`closesAt`; enforce `opensAt <= now < closesAt` in vote admission.
   - Add a close action; do not rely on a client timer.
5. **Seven-day confirmation.**
   - When an amended proposal requires final approval, create a separate
     `confirmation` ballot on the same proposal. The new ballot-instance model makes
     this possible; the old unique index does not.
6. **Policy linkage.**
   - Add `targetPolicyId`, `changeType: new | amend | repeal` and
     `targetRevisionId` to proposals.
   - On `/policies/[slug]`, add “Propose an amendment” and “Propose a repeal” actions.
   - Show the current adopted wording and the proposed effect separately.
7. **Repeal.**
   - A repeal proposal is a proposal with `changeType: "repeal"` and a target policy.
   - Do not unpublish the policy when the proposal is created or voted on. Repeal takes
     effect only through the authorised decision and publication/supersession path.
8. **Amendment UX.**
   - Let the UI submit `title`, `summary`, `details` and `outcomes`, not only title and
     summary.
   - Add an amendment detail view with immutable revision history and a clear
     “endorsement vote ≠ formal approval” distinction.

### Dependencies

- G6 seconding.
- G7 deliberation and ballot periods.
- G8 eligibility rules.
- G9 confirmation requirement.
- G10 repeal semantics.
- T5 ballot-instance model.
- T6 eligibility snapshot schema (storage only; counting rules in Batch 3).

### Acceptance criteria

- Existing ballots and votes remain readable and unchanged.
- A formal motion cannot enter its formal decision process without one independent
  eligible seconder.
- The author cannot second their own motion; a seconder supports formal consideration,
  not necessarily approval.
- Minor editorial corrections do not restart seconding; material changes to formally
  seconded wording require renewed seconding.
- A proposal cannot enter `decide` before the minimum deliberation period when enabled.
- Votes are rejected before `opensAt` and at/after `closesAt`.
- An amended proposal can have a separate confirmation ballot.
- A repeal proposal does not remove current policy until the authorised decision.
- Members can propose amendments to adopted policy from the policy page.
- All amendment fields are available in the UI.

### Required tests

- Real-Mongo ballot creation, window admission and closure.
- Legacy ballot identity mapping.
- Seconding uniqueness, eligibility, author exclusion and renewed seconding after a
  material wording change.
- Minimum deliberation guard.
- Confirmation ballot separation.
- Repeal proposal lifecycle.
- Private proposal access checks for comments, amendments and votes.
- Existing suite regression.

### Risks

- Migrating `ballot_results` without losing legacy results.
- Retroactively enforcing periods on existing proposals.
- Confusing amendment endorsement with policy adoption.
- Repeal semantics accidentally unpublishing current policy.

---

## Batch 3 — Ballot rules, eligibility snapshots, conflict resolution and automatic ratification

### Objective

Make outcomes computed and auditable, not administrator-asserted, and implement the
remaining proposed rules.

### Existing capabilities to reuse

- `ballots`, `proposal_votes`, `ballot_results`, branch memberships.
- `policy_registry`, `publication_events`, `ratify` service.
- Amendment ballots and formal acceptance.

### Implementation changes

1. **Eligibility snapshots.**
   - Add `ballot_eligibility` with `ballotId`, `snapshotHash`, `capturedAt`,
     `ruleVersion`, `eligibleCount`, and a restricted member-ID list or a verifiable
     commitment.
   - Capture at ballot open, not at vote time. Preserve the snapshot for audit.
   - Do not expose member IDs through public APIs.
2. **Tally and result computation.**
   - Add a tally service that computes approve/abstain/reject, turnout, participation
     and the result under a configured rule.
   - Store a computed result and the rule version. Do not allow an arbitrary manual
     `successful` override without an audited exception.
3. **Early closure.**
   - Implement only after G9/G10 define majority participation, the denominator,
     tie handling and abstention treatment.
   - Test mathematical irreversibility: remaining eligible non-voters cannot change
     the outcome.
4. **Tie / abstention / non-voter handling.**
   - Encode the approved rule explicitly in a versioned policy object. Do not bury it
     in code constants.
5. **Preferential conflict resolution.**
   - Implement only after G11 selects a method. The existing field-overlap conflict
     detection remains the first pass; preferential resolution is separate.
6. **Automatic ratification.**
   - Add a delegated-authority configuration with scope, jurisdiction, instrument type
     and limits.
   - Auto-ratify only within that scope, only after a computed successful result, with
     a `system:auto-ratification` actor and an audit event.
   - Manual ratification remains available for out-of-scope decisions.
7. **Ballot secrecy.**
   - Implement the decision from G13. If officer-identifiable ballots are retained,
     enforce role boundaries and log access. If secret ballots are required, separate
     the ballot record from member identity and provide a verification receipt.

### Dependencies

- G9 thresholds, quorum, ties, abstentions, non-voters.
- G10 early closure.
- G11 preferential method.
- G12 auto-ratification delegation.
- G13 ballot secrecy.
- T5/T6/T7.
- Real MongoDB replica set and concurrency tests.

### Acceptance criteria

- Results are computed from stored votes and the approved rule, not manually asserted.
- A tie is handled exactly as decided, not by default pass.
- Abstentions and non-voters are counted exactly as decided.
- Early closure is allowed only when the outcome is mathematically irreversible.
- Eligibility is stable from the snapshot and auditable after the ballot.
- Concurrent vote and close operations are serialized; no vote is admitted after close.
- Auto-ratification is scoped, audited and reversible only by a subsequent authorised
  decision.
- Ballot secrecy meets the approved policy.

### Required tests

- Real-Mongo concurrency: vote vs close, duplicate vote, late vote, retry.
- Snapshot stability after membership changes.
- Threshold, quorum, tie, abstention and non-voter matrices.
- Early-closure irreversibility property tests.
- Preferential resolution fixtures.
- Auto-ratification scope and audit.
- Access-control tests for ballot identity visibility.

### Risks

- Wrong denominator disenfranchises members.
- A race admits a vote after closure.
- Auto-ratification exceeds delegated authority.
- Secrecy design conflicts with audit requirements.

---

## Batch 4 — End-to-end verification and stabilisation

### Objective

Prove the full journey works on real MongoDB and in the browser, and make the
operational pipeline trustworthy.

### Existing capabilities to reuse

- Current test suite and CI MongoDB setup.
- Proposal, branch, policy registry and public API flows.
- Publication outbox and reconcile endpoint.

### Implementation changes

1. Fix `package.json` scripts and the NUC workflow:
   - Either restore `test:cutoff`/`test:auth` or remove those steps.
   - Set `VOTING_TEST_MONGODB_URI` in the NUC workflow; `GOVERNANCE_TEST_MONGODB_URI`
     alone does not run the voting tests.
2. Add real-Mongo governance tests for ratify, publish, supersede, amendment apply,
   ballot bind and import.
3. Add browser journeys for:
   - visitor reads published policy;
   - member finds an eligible ballot;
   - member proposes an amendment to adopted policy;
   - member proposes a repeal;
   - admin imports/publishes baseline;
   - admin runs a ballot and records/auto-computes a result.
4. Add accessibility checks for policy, proposal, ballot and admin screens.
5. Add structured logging and health checks for import/ballot operations.
6. Rehearse baseline import on a restored copy; verify rollback and idempotency.
7. Update `docs/operations.md`, `docs/voting-storage-migration.md`,
   `docs/engage-governance-api.md` and `README.md` to match the actual system.

### Acceptance criteria

- CI is green on `main`; no skipped test hides a critical path.
- Real-Mongo governance and voting tests run.
- Browser journeys pass on desktop and mobile.
- Import rehearsal is reversible and documented.
- No stale endpoint or script is referenced in operations docs.

---

## Batch 5 — Reassessment of subsequent priorities

### Objective

After the baseline and lifecycle are stable, reassess:

- whether Reclaim replaces, supplements or resets the national platform;
- whether to import any supersession relationships;
- Victorian branch governance and operating-rule delegation;
- external API consumers and additional integrations;
- notification/following features;
- commitment-level registry enrichment.

### Acceptance criteria

- A human decision record exists for G4/G5 and any supersession.
- No automatic supersession or repeal is inferred from the reconciliation.
- Victorian policy workflow is authorised and tested before launch.
- New product priorities are justified by verified user needs, not by pipeline
  enthusiasm.

---

# E. Decision register

## E.1 Technical implementation questions

| ID | Question | Current evidence | Recommended default | Blocks |
| --- | --- | --- | --- | --- |
| T1 | Policy ID namespace | `POL-###` already used by Reclaim | `NAT-<slug>` and `VIC-<slug>`; never reuse `POL-###` | Batch 1 |
| T2 | Registry revision store | Versions read `proposal_revisions` | Add `policy_revisions`; keep `proposal_revisions` fallback | Batch 1 |
| T3 | Legacy publication event | `publish` requires ratification decision event | Allow legacy basis + batch; record `eventType` and source hash | Batch 1 |
| T4 | Baseline body extraction | Source files include nav/footer; no cleaned body | Human-reviewed start/end lines + source hash; fail closed | Batch 1 |
| T5 | Ballot-instance model | One implicit ballot per proposal; `ballot_results` unique on proposalId | Add `ballots`; migrate results to `(proposalId, ballotId)` | Batch 2 |
| T6 | Eligibility snapshot | Checked at vote time only | Snapshot at ballot open; restricted storage | Batch 2/3 |
| T7 | Transaction boundaries | Proposal writes transactional; votes/ratify/publish not | Transactional import; transactional close; outbox for publication | Batch 1/3 |
| T8 | Real-Mongo test environment | 8 tests skipped locally; governance tests in memory | Add governance Mongo tests; fix CI env | Batch 4 |
| T9 | Public API schema | v1 lacks authority fields | Additive fields; no breaking change | Batch 1 |
| T10 | Seeding separation | `src/data/policies.json` seeds proposals at startup | Keep Reclaim seed; separate baseline import; no startup import | Batch 1 |
| T11 | Private revision/comment access | Revisions unauthenticated; comments/amendments lack visibility checks | Enforce `canViewProposal` consistently | Batch 2/4 |
| T12 | Commitment records | `commitments` are strings | Add `policy_commitments` only when commitment-level supersession is authorised | Batch 5 |
| T13 | Supersession data model | Whole-policy `supersededBy` only | Add structured successor/source revision + scope; no auto-apply | Batch 5 |
| T14 | Vote-change audit | Latest selection only | Append-only choice-free vote event if audit requires it | Batch 3 |
| T15 | Ballot secrecy implementation | Member IDs visible to staff; public tally only | Implement G13 decision; log access | Batch 3 |

## E.2 Organisational governance decisions

| ID | Decision | Why it cannot be inferred from the repository | Safe default until decided |
| --- | --- | --- | --- |
| G1 | Adopt the legacy-publication authority rule | Requires organisational authorisation | Do not import |
| G2 | Classify the 15 national documents: policy, principle, position, reference; decide FAQ/overview treatment | The corpus classification is model-assisted; the repository cannot decide instrument status | Import only after review |
| G3 | Israel–Palestine current status | Original and Feb 2024 update coexist; no supersession notice | Preserve both; do not supersede |
| G4 | Is Reclaim a successor platform or a new programme? | The reconciliation is semantic evidence, not a decision | Do not encode replacement |
| G5 | Do unmatched Neon commitments remain authoritative? | 257 unmatched is not a repeal decision | Preserve; do not repeal |
| G6 | Is a seconder required for formal motions? | **Decided as a governance design principle; not implemented.** Every formal motion requires one independent eligible seconder, including new policy proposals, formal amendments and repeal proposals. The author cannot second their own motion. A seconder supports formal consideration, not necessarily approval. Minor editorial corrections need not restart seconding; material changes to formally seconded wording require renewed seconding. | Record and test in Batch 2; do not enforce or describe seconding as operational before implementation |
| G7 | Deliberation 14 days, ballot 30 days, confirmation 7 days | Proposed rules, not adopted | Implement configurable; default off/unknown |
| G8 | Qualifying membership for each ballot | No constitutional/eligibility rule in repo | Keep current verified/branch checks; do not invent |
| G9 | Majority/quorum/tie/abstention/non-voter rules | No thresholds in repo | Do not compute a result until decided |
| G10 | Early closure after 7 days with majority participation | No rule | Do not allow early closure |
| G11 | Preferential method for incompatible amendments | No rule | Keep field-overlap conflict only |
| G12 | Delegated automatic ratification scope | No authority delegation model | Manual national-admin ratification only |
| G13 | Ballot secrecy vs officer-identifiable ballots | ADR references officer-restricted identifiable ballots; current API exposes identities to staff | Restrict to authorised roles; decide before launch |
| G14 | Victorian adopted status and corpus | No Victorian corpus in repo | Do not import |
| G15 | Victorian branch operating-rule authority vs ordinary policy delegation | No branch rule model | Do not implement branch rule changes |
| G16 | May a branch ratify/publish its own policy? | Current ratify is national-admin-only | Keep national-admin-only |
| G17 | Effective dates and notice rules | No rule | `effectiveAt: null`; do not invent |
| G18 | Does GOV-001 adopt only the structure, not every Reclaim policy? | Text supports structure adoption; it is a separate proposal | Do not treat GOV-001 as ratification of Reclaim policies |
| G19 | Are the 76 Reclaim records adopted or still under deliberation/voting? | Manifest says adopted; app says 40 open/38 voting | Treat them as live proposals; do not import as adopted |
| G20 | Is the national baseline published automatically or by explicit batch action? | Authority rule presumes adoption, not publication ceremony | Import unpublished; explicit batch publish |
| G21 | Document-level vs commitment-level adoption | Corpus extracts 370 commitments; some are values/explanations | Document-level first; commitment records later |

---

# F. First implementation brief for Codex

> **Status:** ready to start only after G1–G5, T1, T4 and the national branch are
> confirmed. Implement with fixtures and fail-closed defaults. Do not import production
> data, do not modify the corpus, and do not touch existing Reclaim ballots.

## F.1 Objective

Implement the **national legacy baseline import foundation**:

- a source-linked import of the 15 national `authoritative_baseline` documents and 2
  `official_position_material` documents;
- an immutable registry revision store;
- a legacy-publication authority basis that is honest about the absence of a ballot;
- an explicit, idempotent, admin-authorised publish step;
- public/API provenance visibility.

This batch must not implement Victorian import, supersession, repeal, seconding,
ballot windows, eligibility snapshots, tally computation or automatic ratification.

## F.2 Inputs

Use only these reviewed artefacts as inputs:

- `corpus/national/candidates/reviewed-baseline.v2.jsonl` — select
  `migration_status in {authoritative_baseline, official_position_material}`.
- `corpus/national/analysis/inventory.jsonl` — join on document ID for `sha256`,
  `canonical_url`, `source_file`, `url_path`, `title`.
- `national-neon-site/` — exact source files; read-only.
- A checked-in import manifest (new, reviewed) containing per-document:
  `docId`, `policyId`, `instrumentType`, `include`, `bodyStartLine`, `bodyEndLine`,
  `reviewedBy`, `reviewedAt`, `notes`.
- Do **not** use `src/data/policies.json` as a baseline source. It is the Reclaim
  proposal catalogue.

Explicit exclusions:

- the 10 `excluded_non_adopted` rows;
- the `/policy` alias (`reference_only_alias`);
- the one-year-on Israel–Palestine evidence-only document;
- all 76 Reclaim policy records and GOV-001/GOV-002;
- all supersession candidates.

## F.3 Required changes

### 1. Data model

Add indexes in `src/lib/db.ts`:

- `policy_revisions`: unique `revisionId`; `{ policyId: 1, createdAt: 1 }`.
- `policy_import_batches`: unique `batchId`.
- `policy_registry`: keep unique `policyId`; add `{ authorityBasis: 1, status: 1 }`
  if useful.

Do **not** add a second policy engine. Extend `policy_registry` and add the revision
store.

Registry record shape (minimum):

```ts
{
  policyId: "NAT-climate-rescue",
  slug: "climate-rescue",
  instrumentType: "policy" | "platform_principle" | "position_statement" | "reference",
  title: string,
  summary: string,
  category: null | string,
  commitments: string[],              // [] unless a human approved a list
  approvedWording: string,            // exact reviewed body
  revisionId: string,                 // "legacy-" + sha256(policyId + "\0" + body)
  revisionIds: string[],
  status: "adopted",
  publicationStatus: "unpublished",
  authorityBasis: "legacy_official_publication",
  ratificationEvidence: "migration_presumption_only" | "documented_human_confirmation",
  ratification: null,
  migration: {
    batchId: string,
    ruleVersion: string,
    sourceFile: string,
    sourceUrl: string | null,
    sourceSha256: string,
    bodyStartLine: number,
    bodyEndLine: number,
    importedAt: Date,
    importedBy: string,
    reviewedBy: string,
    reviewedAt: Date
  },
  supersessionStatus: "not_asserted" | "unresolved_commitment_level_review_required",
  jurisdiction: "National",
  jurisdictionBranchId: string,
  governanceAuthorityBranchId: string,
  effectiveAt: null,
  publishedAt: null
}
```

`policy_revisions` record shape:

```ts
{
  policyId: string,
  revisionId: string,
  parentRevisionId: null,
  revisionType: "legacy-publication",
  snapshot: {
    title: string,
    summary: string,
    outcomes: string[],
    details: string                 // exact approved wording
  },
  contentHash: string,
  source: {
    file: string,
    url: string | null,
    sha256: string,
    startLine: number,
    endLine: number
  },
  authorityBasis: "legacy_official_publication",
  createdAt: Date,
  createdBy: string,
  provenanceNote: string,
  extractedCommitments?: Array<{
    commitmentId: string,
    text: string,
    lineStart: number,
    lineEnd: number,
    textSha256: string,
    reviewStatus: "extracted_unreviewed"
  }>
}
```

`policy_import_batches` record shape:

```ts
{
  batchId: string,
  kind: "national_baseline",
  ruleVersion: string,
  status: "planned" | "applied" | "published",
  selections: Array<{ docId: string, policyId: string, include: boolean, reason: string }>,
  counts: { selected: number, excluded: number, alias: number },
  createdBy: string,
  createdAt: Date,
  appliedAt?: Date,
  publicationEventId?: string
}
```

### 2. Import service

Create `src/lib/policy-import.ts` with pure planning and an apply function:

- `planNationalBaselineImport({ manifest, baselineV2, inventory })`
  returns selected/excluded rows, computed IDs, source hashes and validation errors.
- `applyNationalBaselineImport({ db, actor, batch, manifest })`
  verifies the manifest is approved, verifies all hashes, starts one MongoDB session
  and transaction, writes the batch, the registry records, the policy revisions and
  an audit event; aborts on any mismatch.
- Fail closed if:
  - the manifest is missing/unapproved;
  - a selected document is not in `authoritative_baseline` or
    `official_position_material`;
  - a source file hash does not match `inventory.jsonl`;
  - a body range is invalid or empty;
  - the national branch is missing or not recognised;
  - a `policyId` already exists with a different revision;
  - the batch already exists with different content.
- Do not write to `proposals`, `proposal_votes`, `ballot_results`, `amendments`,
  `publication_events` (except the explicit publish step) or any supersession file.

### 3. Admin route and UI

Add:

- `src/pages/api/admin/policies/imports.ts`
  - `GET` — plan/preview; admin only.
  - `POST` — apply; admin only; require `Idempotency-Key` and `batchId`.
- A “Baseline imports” panel in `src/pages/admin/policies/index.astro`
  - shows counts, exclusions, hash status and validation errors;
  - apply button disabled until the manifest is approved;
  - shows the import batch and its publication status.

### 4. Publication extension

Modify `src/pages/api/admin/policies/publish.ts`:

- Keep the existing ratified-policy path unchanged.
- Allow `policy.authorityBasis === "legacy_official_publication"` with a valid
  `policy.migration.batchId` and `policy.status === "adopted"`.
- Refuse to publish `instrumentType: "reference"` records; they are preserved source
  aliases, not standalone policy.
- Require `Idempotency-Key`.
- Record a publication event with:
  `eventId: pub-<key>`, `transition: "published"`,
  `eventType: "legacy_baseline_publish"`, `authorityBasis`,
  `migrationBatchId`, `sourceUrl`, `sourceSha256`, `policyId`, `revisionId`,
  `actorId`, `publishedAt`.
- Do not require `ratification.decisionEventId` for this path.
- Reject legacy records without a batch.
- `reconcile` must continue to work unchanged.

### 5. Public API and UI

Modify `src/lib/public-policy.ts` to add:

- `authorityBasis`
- `ratificationEvidence`
- `instrumentType`
- `migration: { batchId, sourceUrl, sourceSha256, importedAt }`
- `supersessionStatus`

Modify version endpoints to read `policy_revisions` first, then fall back to
`proposal_revisions`. Return the same snapshot shape.

Modify `/policies/` and `/policies/[slug]` to display:

- “Legacy publication — official national website”;
- source URL and source hash;
- migration batch;
- “No ballot or decision event is recorded for this legacy publication”;
- exact approved wording only when published.

Do not display a fabricated “Ratified” date, ballot ID or decision event.

### 6. Tests

Add `src/lib/policy-import.test.ts` (memory) and
`src/lib/policy-import-mongo.test.ts` (real Mongo, skip when no URI):

- selection counts: 15 baseline + 2 position = 17; 10 excluded; 1 alias;
- deterministic `NAT-*` IDs;
- hash mismatch, missing manifest, unapproved manifest and missing branch fail closed;
- apply is idempotent; rerun does not duplicate;
- transaction rollback leaves no partial batch;
- unauthorised user cannot import or publish;
- legacy publish succeeds only with a batch; ratified publish path still requires a
  decision event;
- version API returns baseline revisions and still returns proposal revisions;
- public API includes authority fields and does not expose member IDs;
- no writes to `proposals`, `proposal_votes`, `ballot_results`, `amendments`;
- existing Reclaim proposal counts and votes are unchanged.

Run:

```sh
pnpm test
pnpm check
```

### 7. Guardrails

- Do not edit `corpus/` or `national-neon-site/`.
- Do not modify `src/data/policies.json`.
- Do not import at application startup.
- Do not create `ballot_results`, `decisionEventId`, ratification dates or ballots.
- Do not mark any Neon commitment superseded.
- Do not touch existing Reclaim proposals, votes, ballots, amendments or revisions.
- Preserve uncommitted work; branch from the current tree; do not reset or clean.
- If a governance decision is missing, fail closed rather than inventing a default.

### 8. Stop conditions

Stop and ask for a human decision if any of the following is true:

- G1–G5 are unanswered.
- The import manifest has no `reviewedBy`/`reviewedAt` or `approved: true`.
- A source hash does not match.
- A body boundary is ambiguous.
- The national branch does not exist or is not recognised.
- A selected document would be imported with `instrumentType: "policy"` but is a hub,
  FAQ, commentary or evidence-only page.
- A requested change would touch an existing ballot or Reclaim proposal record.
- Victorian data is requested; it is out of scope for this batch.

---

## Appendix — Key verification evidence

- `pnpm test`: 50 pass, 8 skip, 0 fail.
- `pnpm check`: 0 errors, 0 warnings, 14 hints.
- `src/lib/store.test.ts`: lifecycle, locking, revision binding, branch scope,
  concurrent stale edit, amendment separation.
- `src/lib/governance-api.test.ts`: public API, branches, vote privacy, withdrawal,
  ratification, composite revision, versions, OpenAPI, amendment ballot, legacy bind,
  reconcile, supersede, conflict resolution.
- `src/lib/voting-mongo.test.ts`: real Mongo startup, revisions, vote migration; skipped
  locally.
- `src/lib/auth.test.ts`: Google account linking; skipped locally.
- `src/lib/branch-access.test.ts`: branch-scoped permissions.
- `corpus/national/candidates/BASELINE.md`: 15 primary + 2 position + 1 alias +
  10 non-adopted.
- `corpus/reconciliation/SUMMARY.md`, `SCHEMAS.md`, `HANDOVER.md`: reconciliation
  counts and caveats.
- `corpus/reconciliation/stats.json`: exact pipeline counts.
