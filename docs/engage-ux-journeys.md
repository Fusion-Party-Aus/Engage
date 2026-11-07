# Engage journeys and verification

This document records the implemented entry points and what remains to be validated. It does not treat a successful build as evidence of usability.

| Journey | Entry point | Main task | Detail kept available | Verification status |
| --- | --- | --- | --- | --- |
| First visitor | `/` | Explore ideas, open votes or official policy without signing in | `/how-it-works/` explains process and eligibility | Build passes; current browser review is incomplete |
| Signed-in member | `/member/` | See eligible ballots, contributions, ideas and activity in assigned branches | Account settings and recorded vote history remain available | Tests cover branch ballot eligibility; the member screen was captured at mobile, tablet and desktop sizes. New branch activity section needs a fresh browser check. |
| Contributor | `/proposals/` and `/proposals/[slug]/` | Suggest an idea, discuss it or propose replacement wording | Amendment comparisons and revision history remain on the proposal page | Store tests cover contributions and amendment ballots; full browser workflow not verified |
| Voting member | `/proposals/[slug]/` | Read exact wording, then vote on the original or a separate amendment ballot | Frozen revision references and separate ballot records | Store and API tests pass; browser vote workflow and real MongoDB tests remain unverified |
| Branch officer | `/admin/` and `/admin/branches/` | Review work within assigned authority; find and assign members | Ballot wording, amendment resolution and outcome controls remain available | Branch permission tests pass. A supplied screenshot exposed a collapsed proposal row; the row sizing fix builds, but has not been recaptured in a browser. |
| National officer | `/admin/` | Review ballots, pending members, ratification and publication work | Registry, provenance and durable publication controls remain available | Governance API tests pass; browser workflows remain unverified |
| Public policy reader | `/policies/` | Read current published policy and find past records | Withdrawn and superseded records remain separate; policy detail keeps versions and provenance | Public API tests pass; current browser review is incomplete |

## Information architecture

The public navigation is organised around ideas, open votes and official policy. Signed-in members get a separate task-oriented homepage. The proposal browse page puts open votes first when no stage is selected, and retains topic, branch and lifecycle filters for deeper exploration. A proposal page offers direct links to its wording, discussion, suggested changes, revision history and ballot. Administrative work requiring action appears before stage totals; branch and national controls are separated by existing permissions.

The policy library defaults to current published records. Withdrawn and superseded records remain discoverable through a separate past-records view, so historical wording cannot read as a current Fusion position.

The public branch directory lists recognised bodies and links to visible activity. A signed-in member sees their branches first. This directory does not grant membership or voting rights.

The interface uses plain language at entry points. Exact revision IDs, provenance, branch authority and formal decision references remain where governance actions and audits need them. The backend still determines eligibility and protects immutable records; a UI label never grants a right.

## Validation limits

- `pnpm check`, `pnpm build` and `pnpm test` pass after the current changes. The test run reports 51 passing and 8 skipped tests.
- The skipped tests include real MongoDB startup, transactions and legacy vote migration. Those paths are not verified by the unit test run.
- The member overview and proposal index were checked in an isolated browser at 390, 820 and 1440 CSS pixels in the previous pass. The browser host is unavailable for a fresh capture in this pass; the supplied admin screenshot remains the visual evidence for the row-collapse defect.
- The current admin row fix and member branch activity addition are build-checked, not browser-verified. Full contributor, ballot, branch officer, ratification and publication workflows still need end-to-end review.
- No production data was migrated or modified in this UX pass.

## Storyboard implementation pass

The November 2026 storyboard is the visual reference for the shared Horizon header, visitor and member homepages, proposal browser and reading pages, task-oriented admin workspace, policy library, and the separate proposal composition page. The proposal browser shows twelve results per page and retains active filters while paging. Administrative and governance details remain available in their existing task screens and proposal disclosures. The storyboard's illustrative names, counts, dates, and activity entries are not seeded into production data; every count shown in Engage is calculated from the existing records.

This pass was checked with `pnpm check`, `pnpm build`, and `pnpm test`. Browser inspection covered the member homepage and the tablet admin overview. The eight MongoDB integration tests remain skipped in the local test run, so the visual checks do not establish a full production workflow or migration rehearsal.
