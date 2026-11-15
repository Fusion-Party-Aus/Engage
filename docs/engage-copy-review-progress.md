# Engage copy review — issue #97

Updated 15 November 2026. Source of truth: pushed branch and this document, not conversation history.

## Resume here

- Issue: https://github.com/Fusion-Party-Aus/Engage/issues/97
- Branch: `copy/97-editorial-review`, based on main `20dfa90`.
- PR: https://github.com/Fusion-Party-Aus/Engage/pull/98 (draft).
- Next task: batch 3b, proposal detail/ballot/amendment copy and discussion components. Public introductions, guide, browsing and creation are reviewed.
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
| 1 | Homepage introduction/lifecycle wording; discussion heading and cross-references; sign-in discussion intent | Delivered in `2d25398`; validated and published in PR #98 |
| 2a | Remaining homepage copy, its metadata and shared proposal highlights | Delivered in `8558e05`; remote tree verified |
| 2b | How-it-works guide, default metadata, shared layout/navigation/footer | Delivered in `17a0fac`; remote tree verified |
| 3a | Proposal browsing and new-proposal forms, scope/change selectors | Delivered in `0a4a86f`; remote tree verified |
| 3b | Proposal detail, seconding, comments, amendment and ballot interfaces | Next |
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
- Reclaim and legacy national provenance are separate (D33); never imply legacy national policies are being re-ratified. The guide now explains that references alone do not establish adoption.
- Review legal text carefully; do not silently change privacy promises or enable acceptance gates.
- Production deployment has not been performed.

## Batch 2a handover

Homepage member queues now invite discussion, explain vote changes and avoid implying voting is compulsory. The membership warning no longer assumes every non-participating account is awaiting verification (the condition also includes suspended accounts). The stage summary introduces seconding and separates ratification/publication from the vote. Proposal highlights call individual choices “votes”, and label the approval statistic as a share rather than an adopted result. Data, ranking formula, controls, CSS and permissions are unchanged.

Examples: “Open for stances” → “Join the discussion”; “Put an idea on the record” → “What would you like to change?”; “Most approved proposal” → “Highest approval share”.

Evidence checked: `getProposalDetail`, `secondProposal`, `listOutstandingDecisions` in `src/lib/store.ts`; `proposalMetrics`/`rankProposals`; decision register D3, D11, D13–D20. Public discussion is readable only after proposal visibility/archive gates. Earlier product docs contain stale claims; use code and decision register.

Validation: `pnpm check` passes, 324 files, zero errors/warnings, 23 existing hints. `pnpm build` passes. `git diff --check` and changed-file raw-control audit pass. No live signed-in/browser/mobile checks. Changelog regeneration exposed the known truncation in #96; preserve earlier entries when recording this batch rather than fixing the generator here.

## Batch 2b handover

Rewrote all guide prose and metadata, retained its existing sections, anchors, cards and CSS. Removed unsupported promises of instant transfer, atomic voting transactions and a working public poll. The pulse-poll flag is only stored/read in configuration: there is no poll interface or submission handler. Operating section now explains what must be protected and links the canonical guide instead of showing obsolete commands and secrets-transfer instructions. No environment/config values exposed. Footer copy and fallback metadata aligned; configured site copy remains administrator-controlled.

Accuracy checked against `secondProposal`, proposal/amendment stage gates, lifecycle scheduler, decision register D3–D20/D33–D35, policy-import docs and build/deploy operations. Formal amendments currently require Propose/Deliberate; later-stage amendments remain separate implementation work. Normal timing is described as usual, actual proposal dates take precedence; no hardcoded first-round promise.

Validation: `pnpm check` passes (0 errors/warnings, 20 hints), production build passes, diff whitespace and changed-markup raw-control audit pass. Browser launch was attempted but blocked by the environment’s socket permissions; no rendered/mobile/keyboard result is claimed. No CSS or controls changed. Shared header reviewed and retained. Default metadata in `site-config.ts` changed because it overrides the layout fallback. Existing persisted settings are not migrated.

## Batch 3a handover

Reviewed proposal list/search/filter/empty-state labels, submission form, selectors and inline submission errors. “Proposal scope” becomes “Who should consider this idea?”; optional details ask for background/evidence instead of design rationale. Replaced unverified submission speed claim with “New proposal”. The account warning no longer assumes every blocked account is pending verification. Voting is optional (“I haven’t voted yet”); list actions invite reading before voting. Approval share/split sorting labels reflect Approve/Reject-only minimums in `proposalMetrics`, not adoption. Repeal timing corrected against D35: ratification takes effect without a later publication step; amendments/replacements require publication. No form payload, constraints, links, gates or ranking changed.

Validation: `pnpm check`, `pnpm build` and whitespace audit pass; raw-control matches are existing hidden form inputs only. No rendered/mobile check: Chromium unavailable due socket permissions as recorded above. Existing native image/link prompts are retained; replacing controls is outside this editorial slice. API error text and other journeys remain batch 8.
