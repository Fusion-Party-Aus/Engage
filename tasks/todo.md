# M1 delivery checkpoints

Plan and assessment: [plan.md](plan.md).

## Dependency

- [x] Inspect main, PR #9, roadmap and current API contracts.
- [x] Identify PR #9 dependency before creating an implementation branch.
- [x] Establish B1 branch `codex/m1-admin-workspace` from #9 head `a4de58f`; #9 is an explicit merge dependency.

## B1 — Shared shell and policy-centred operator UX

- [x] Add shared admin layout and five areas; preserve `/admin/` and `/admin/members/`; authorise before data reads and hide unavailable controls.
- [x] Add read-only Work projection with bounded existing-record queries, contextual links and honest empty/error states. Verify GET does not trigger ballot finalisation.
- [x] Add policy catalogue/creation and canonical workspace with four-layer wording, taxonomy/provenance, revision selectors/text comparison, consultation context and decision history.
- [x] Move existing moderation, scheduling, ballot, audit/health and membership controls into their areas; retain server safeguards and design loading/error/mobile/keyboard states.
- [x] Verify focused tests, `pnpm check`, `pnpm test`, replica-set cutoff/auth tests, build and SSR access boundaries; document partial native Chrome coverage and outstanding browser checks.
- [x] B1 checkpoint: draft [PR #10](https://github.com/Fusion-Party-Aus/Engage/pull/10) opened against #9; local checks pass, partial browser coverage documented. Independent review remains required before proceeding to B2.

Dependencies: reviewed PR #9. Likely files: `src/layouts/AdminLayout.astro`, `src/pages/admin/**`, focused admin components/scripts, context filters in moderation API and admin tests. Implement as small slices: navigation → Work → policy workspace → existing controls.

## B2 — Review independence and authorisation UX

- [ ] Add minimal named role assignments/capability checks and exact immutable-revision review/return; test unauthorised access and self-approval/separate-officer conflicts.
- [ ] Add officer preparation with approved wording selector, missing-prerequisite explanations and six blank evidence inputs; retain `FORMAL_BALLOTS_ENABLED` and existing production gates.
- [ ] Rehearse synthetic Reclaim through feedback, moderation, wording review, vote and finalised result; run full applicable Node/pnpm/replica-set/SSR/browser checks.
- [ ] B2 checkpoint: independent review and report before B3.

Dependencies: B1. Likely files: existing roles/auth/membership code, revision review API and records, ballot preparation/transition API, admin forms, focused governance tests. Do not create a workflow engine or identifiable-vote endpoint.

## B3 — Standalone consultations and organisational decisions

- [ ] Extend existing round/submission UI and contracts for standalone verified-member participation, supporting material, optional reference, window, closure and summary; retain policy-linked compatibility.
- [ ] Add immutable organisational proposition/version selection and ballot subject validation, reject authorised material changes, reuse voting engine and skip policy publication for organisational outcomes.
- [ ] Add synthetic Horizon UI journey without fake policy IDs, real motion/electorate/evidence or binding seeds; retain distinct platform-adoption question.
- [ ] Verify both complete UI journeys, legacy compatibility, discussion privacy, role conflicts, proposition immutability, cutoff/revotes/finalisation/audit, full Node/pnpm and replica-set checks plus SSR/browser checks.
- [ ] B3 checkpoint: independent review and final acceptance report distinguishing automated, browser, hosted CI and human acceptance.

Dependencies: B2. Likely files: existing consultation types/services/APIs/pages, proposition storage/API/forms, ballot subject types/validation and publication branch, synthetic fixtures/tests. No production migration or deployment is authorised.
