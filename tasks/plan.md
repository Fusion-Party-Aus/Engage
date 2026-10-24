# M1 administration and member participation

## Assessment checkpoint — 24 October 2026

This plan implements the supplied product brief in three independently reviewable deliverables. Engage supports policy development and organisational participation; a Horizon proposal must not masquerade as a policy. This checkpoint contains planning only, not a completed administration implementation.

GitHub main is `6ab7929c05f29c02f36e3d311e94de7128c9d71b`, the merge of PR #8. [PR #9](https://github.com/Fusion-Party-Aus/Engage/pull/9) remains OPEN at `a4de58fe8eb72b1d1969e8ab16c47574b7505cdd`. The current checkout is that head on `codex/m1-taxonomy-privacy`. No submitted GitHub reviews were returned. CodeRabbit reports success; that is not independent operator/security acceptance. The application checks report failure without running steps: GitHub's annotation says recent account payments failed or the spending limit needs increasing. Hosted checks have not validated the change.

**Dependency:** B1 depends on reviewed PR #9, including its taxonomy, discussion privacy and public catalogue projections. Preferred base is main after #9 merges. If B1 is explicitly developed before that merge, its branch/PR must declare #9 as its base dependency, remain separate, and be rebased after #9 merges. Do not repeat or modify #9's implementation as part of B1. No implementation branch was created at this assessment checkpoint.

The only pre-existing working-tree change is `.DS_Store`; leave it untouched. No member records, production database, migrations, deployments or formal-ballot settings were accessed.

## Existing contracts and implications

| Existing implementation | Consequence for delivery |
| --- | --- |
| `src/pages/admin/index.astro` combines queue, revision creation, policy creation, one hard-coded round schedule, ballot editing, health and audit | Extract working controls into contextual pages; preserve `/admin/` as Work and `/admin/members/` as membership verification. Do not merely hide the old long page behind tabs. |
| `adminPageDenial()` checks roles and current verification before protected page data loads | Keep this ordering on every route and apply equivalent gates to new APIs. Membership verification must remain accessible to authorised membership operators. Protected responses stay private/no-store. |
| Roles currently are member, moderator and administrator | B1 reflects existing capabilities honestly; B2 introduces only the accepted named responsibilities, with server-side checks on every writer. |
| Revision POST is `/api/admin/policies/:policyId/revisions`; revision GET takes `policyId` | Reuse immutable revision creation and a selector for revision history. Draft editing can remain local form state until saved as an immutable revision. A text comparison suffices. |
| Catalogue lifecycle views include revision history, rounds and a selected ballot, but no submission bodies | Retrieve discussion only through verified-member moderation boundaries, scoped to the selected policy. Query all associated decisions for workspace history rather than assuming the selected ballot is the complete history. |
| Both `loadPolicyCatalogue()` and `listBallots()` call automatic closure | A read-only Work aggregator must use bounded, allowlisted database reads directly; it must not accidentally finalise ballots while rendering the queue. Show elapsed/incomplete decisions as work for authorised operators. |
| Moderation GET returns at most 100 submissions, filtered by status and discussion audience | Add validated policy/round context filters before limiting; never fetch a global limited queue and pretend client filtering is complete history. Retain synthetic/Engage isolation. |
| Round POST rejects an empty `policyIds`; submission validation requires policy and revision IDs | B3 must explicitly support a standalone round/submission context. Merely permitting an empty policy list would not deliver the journey. |
| Ballot POST requires `proposalId` and `policyRevisionId`; PATCH pins a revision; finalisation publishes approved policy wording | B3 needs a small explicit subject distinction and an immutable organisational proposition. Existing policy ballots with no new discriminator remain readable as policy decisions. Organisational approval records an outcome without invoking policy publication. |
| Production opening requires six evidence references and `FORMAL_BALLOTS_ENABLED`; the UI cannot submit the evidence | B2 adds blank, labelled evidence fields with progressive disclosure, exact wording context and prerequisites. Do not invent evidence, schedules, rules or authority. |
| Vote admission and closure contend on the same ballot document using replica-set transactions | Preserve the shared engine, database-time admission cutoff, revotes, closure provenance, idempotent result/audit and retryable policy publication. No second voting path. |

Sources inspected: `docs/mvp-roadmap.md`, `docs/m1-taxonomy-privacy.md`, `.github/workflows/ci.yml`, admin pages and API routes, `types.ts`, `admin-access.ts`, `membership.ts`, `catalogue.ts`, `consultations.ts`, `ballots.ts`, ballot validation/evidence contracts, and existing test coverage.

## Delivery sequence

### B1 — Operator navigation and policy workspace

Keep Astro SSR, native forms/scripts and Horizon CSS. Create one admin layout with Work, Policies, Consultations, Decisions and Administration. Navigation and controls reflect current server-resolved permissions. Preserve existing URLs and deliberately map old in-page links to their new context.

Work is a bounded read-only projection of pending submissions, decisions requiring attention and (for authorised administrators only) membership/operational prerequisites. No task collection. Distinguish an empty queue from a failed query, identify list limits, and link each item to human-readable context. Never put protected data into HTML before authorisation.

Policies provides catalogue/search and creation. A canonical `/admin/policies/:policyId/` workspace shows current wording, all four layers, taxonomy, provenance, consultation history, contextual moderation, revision selection/comparison and associated decisions/outcomes. Keep raw IDs in optional technical detail. Use selectors for policy/revision/round references. Existing APIs remain authoritative. B1 labels independent review and evidence entry as pending B2 rather than implying governance readiness.

Move existing consultation scheduling, decision administration, membership verification, audit and health to their named areas. Explain the existing production opening prerequisite; do not present unsupported transitions or actions the operator cannot perform. Keep public pages outside scope.

**Checkpoint:** review B1 diff, run established checks and synthetic SSR/browser verification, report limitations, and stop before adding B2 behaviour.

### B2 — Independent wording review and officer authorisation

Add explicit policy editor, wording reviewer, Election Officer, moderator and membership administrator responsibilities using the existing role storage and small direct capability checks. Document how existing administrator assignments transition; broad administrator status must not silently grant independent review or officer approval. Operators may hold several roles. An editor cannot approve their own revision; preserve the roadmap's separate Election Officer requirement for the exact decision. Validate these conflicts on the server, not just in navigation.

Record approval/return against the exact immutable revision with reviewer, time and rationale. New wording requires new review. Officer ballot preparation selects approved wording and displays missing prerequisites. Add the existing six evidence inputs, blank by default, with exact ballot context and server validation. Retain formal-ballot gating and existing safeguards. Role administration, if needed for the journey, is a small restricted assignment surface, not a general RBAC engine. No identifiable-vote retrieval endpoint.

**Checkpoint:** review B2 independently with denial/self-approval tests and the synthetic Reclaim journey; stop before B3 schema extensions.

### B3 — Standalone consultation and organisational decision

Extend the current round/submission contract with a standalone subject while retaining policy-linked records and moderation. Provide title, explanation/supporting material, verified-member audience, window, optional reference, closure and recorded summary. Separate public introduction/material from verified-member deliberation; do not infer permission to publish submissions from a public consultation introduction. A closed consultation accepts no new submissions. Avoid form builders and a new participation framework.

Add an immutable organisational proposition record containing the exact question and supporting material references. A ballot chooses either an exact policy revision or an exact proposition version. Editing authorisation-relevant content must fail after authorisation or create a new version requiring fresh authorisation. Ensure referenced assets are stable application assets, not mutable material silently changing the proposition. Keep the distinct Reclaim-platform adoption question unchanged.

Reuse existing ballot admission, revote, finalisation, tally and audit code for both subjects. Branch only the subject validation and policy-publication effect. No fake policy IDs. A consultation does not create a ballot; a ballot does not require a consultation. Provide complete native operator/member forms and synthetic Horizon material clearly marked as fixtures. Obtain actual motion/rules/material/authority from operators; no binding records or fabricated attestations are seeded.

**Checkpoint:** complete both synthetic journeys and compatibility/security verification before claiming the brief's overall acceptance.

## Verification contract

Use the repository's pinned Node/pnpm versions and locked dependencies. Execute `pnpm check`, `pnpm test`, `pnpm test:cutoff`, `pnpm build`, then `AUTH_TEST_SSR=true pnpm test:auth`, with disposable replica-set URLs in `GOVERNANCE_TEST_MONGODB_URI` and `AUTH_TEST_MONGODB_URI`. MongoDB absence/skips must not be reported as passing integration coverage. Run each deliverable's focused tests during development and the complete applicable checks at its checkpoint.

Add meaningful coverage for read-only Work aggregation; role and verification denials before data loading; context-scoped moderation; independent exact-revision review; role conflicts; blank/missing evidence and formal-ballot gates; immutable authorised propositions/assets; legacy policy ballots and publication; standalone decisions without policy IDs; optional consultation; revotes, cutoff, closure retries and audit secrecy.

Rehearse Reclaim: feedback → moderated amendment → immutable revised wording → independent approval → non-binding synthetic vote → finalised result. Rehearse Horizon: standalone proposition → optional consultation → authorisation using explicitly synthetic evidence → vote → result. Verify all steps through operator/member UI without manually constructing JSON or editing records.

Use browser checks for desktop/mobile, keyboard/focus, loading/error/empty states and permissions. Verify signed-out, pending, suspended, verified member and each operator role, including protected SSR response bodies. Report unavailable hosted CI/browser verification honestly. No deployment, production migration, real membership access or enabling binding voting.

## Decisions deliberately left to governance operators

Actual Horizon motion, visual material, electorate, threshold, schedule and approval evidence are not provided. They are not needed to implement synthetic UI and contract tests, but must not be fabricated as real decisions. Independent review/security acceptance, hosted CI runner availability and human pilot remain external acceptance requirements, not software defaults.

## B1 implementation checkpoint — 25 October 2026

Created `codex/m1-admin-workspace` directly from PR #9 head `a4de58f`, with #9 explicitly declared as a dependency before branching. B1 now implements the shared shell, read-only Work, canonical policy workspace, contextual/paginated moderation, and focused consultation/decision/administration controls using existing APIs. See [B1 implementation and verification](../docs/m1-admin-workspace.md).

B2 and B3 remain unimplemented at this checkpoint. The existing new-policy consultation visibility gap is recorded there as a required remaining M1 acceptance item, not permission to bypass #9's public draft boundary.
