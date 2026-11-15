# Engage copy review — issue #97

Updated 15 November 2026. Source of truth: pushed branch and this document, not conversation history.

## Resume here

- Issue: https://github.com/Fusion-Party-Aus/Engage/issues/97
- Branch: `copy/97-editorial-review`, based on main `20dfa90`.
- PR: pending creation; find the single draft PR from this branch.
- Next task: batch 2, rewrite `/how-it-works/` against the decision register and current lifecycle. Seconding and scheduling are implemented, not future features. D13–D20 distinguish member authority from officer certification; automatic ratification remains incomplete. Check the first-round exception before publishing dates. Do not repeat batch 1.
- This is an incomplete site-wide review. Keep #97 open. Never mark a batch delivered until its commit is remotely visible and validation is recorded.

## Recovery and scope

Recovered #97 with no comments, clean working tree and no editorial implementation branch found among fetched remote refs. No prior changes were assumed. Read `AGENTS.md`, canonical product, governance and agent docs, known gaps and decision register before editing.

Deliver one independently reviewable batch at a time. Inspect functionality, edit strings, check accuracy, validate, commit/publish, then update #97 and this document. Use this single PR; no unrelated refactoring, design changes or governance changes.

## Editorial decisions

- Natural Australian English; invite people to contribute to political decisions. Explain actions and consequences rather than software architecture.
- Retain legitimate terms: proposal, deliberation, amendment, seconder, ballot, ratification. Explain exact wording without hashes or revision IDs unless needed for evidence.
- Members decide policy; officers certify procedure and publish. Do not imply an executive policy veto. Separate voting, certification, ratification and publication; do not promise unfinished automation.
- Maintainer clarification (15 November): proposals, discussion, amendments, revisions and decision records should be publicly readable. Membership determines contribution and voting rights, not readership. Use **Discussion**, not **Member discussion**, as the section heading. Preserve individual ballot confidentiality (D26/D29) and personal account security.
- **Implementation mismatch:** `canViewProposal` in `src/lib/store.ts` still restricts private and branch scopes; `getProposalDetail` additionally restricts archived records. Comments are returned after those gates, with no extra membership-only read gate on public proposals. Do not claim all records are already public or silently change permissions in this editorial PR. Historical #2 also requests member-only deliberation; this conflicts with the maintainer's new direction and must be reconciled in access-policy work.

## Coverage / batches

| Batch | Area | State |
|---|---|---|
| 1 | Homepage introduction/lifecycle wording; discussion heading and cross-references; sign-in discussion intent | Validated; delivery confirmed in #97 after publication |
| 2 | How-it-works guide, public metadata, shared layout/navigation/footer and remaining homepage copy | Next |
| 3 | Proposal browse/create/detail, seconding, comments, forms, amendment and ballot interfaces | Not reviewed beyond batch 1 strings |
| 4 | Policy registry, policy detail, provenance and change proposals; branch journeys and Sense Box | Not reviewed |
| 5 | Onboarding, membership, My Engage, account, branch preferences, notifications | Not reviewed beyond discussion intent |
| 6 | Emails, push, digests and unsubscribe flows | Not reviewed |
| 7 | Administration, roles, membership, governance, moderation, integrations and operational errors | Not reviewed |
| 8 | API/form error responses shown to users, legal-copy consistency, metadata, empty/loading states and whole-site terminology sweep | Not reviewed |

A page touched in batch 1 has NOT been reviewed in full. Audit `src/pages`, `src/components`, email libraries, legal/config data and API errors in later batches; do not rewrite policy motion text or imported adopted wording as interface copy.

## Actual examples (batch 1)

| Before | After |
|---|---|
| Member discussion | Discussion |
| Eligible verified members vote on an immutable bound wording snapshot. | Eligible members vote on the exact wording shown on the ballot. |
| Successful ballots proceed to formal party ratification and registry publication. | Members decide the policy. Officers certify the process and publish the adopted wording. |
| Engage is where Fusion members propose ideas, deliberate on policy wording, and vote on bound revisions. Anyone can inspect every proposal, revision, and ballot tally publicly. | Bring an idea, help improve a policy, or vote on what Fusion should do next. You can read public proposals and discussions without an account. Verified members can contribute and vote where eligible. |

## Validation

Batch 1: `pnpm install --frozen-lockfile`; `pnpm check` passes (324 files, zero errors/warnings, 23 existing hints); `pnpm build` passes; `git diff --check` passes; changed-page raw-control audit has no matches. Only text changed: no controls, CSS, permissions, data or governance behaviour. Changelog generated after editorial commit. No browser/mobile or live signed-in journey verification performed. No new tests for static text substitutions.

## Outstanding questions

- All-public access direction needs an explicit migration/access-policy implementation, including previously restricted records and archived records; this PR does not expose them.
- Guide has stale procedural, provenance and roadmap claims: inspect each against code, not old copy. Do not describe the existing national platform as being re-ratified; Reclaim and legacy national provenance are separate (D33).
- Review legal text carefully; do not silently change privacy promises or enable acceptance gates.
- Production deployment has not been performed.
