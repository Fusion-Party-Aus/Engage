# Engage copy review — issue #97

Updated 15 November 2026. Resume from the pushed repository and GitHub, not conversation history.

- Issue: https://github.com/Fusion-Party-Aus/Engage/issues/97
- Branch: `copy/97-editorial-review` (started from main `20dfa90`).
- Single review PR: https://github.com/Fusion-Party-Aus/Engage/pull/98
- Next concrete task: confirm batch 8 is remotely visible, integrate latest main if needed, run final checks and update PR/#97. Do not repeat completed journeys. Do not close #97 before final delivery is verified.

## Editorial principles and decisions

- Natural Australian English. Explain what people can do and why it matters; avoid SaaS promotion, artificial enthusiasm and descriptions of software internals.
- Keep useful political terms: proposal, seconder, deliberation, amendment, ballot, ratification. Explain exact ballot wording in ordinary language; retain identifiers where officers need evidence.
- Members decide policy. Officers certify procedure and record adoption/publication; these are separate acts, not discretionary policy vetoes. Do not promise unfinished automatic ratification or amendment-collision handling (D13–D20).
- Use **Discussion**, not **Member discussion**, as the public section heading. Readership, contribution permissions, branch membership and ballot eligibility are separate facts.
- Maintainer direction (D36): participation records should be publicly readable. **Sense Box becomes public after authorised review, never immediately on submission. Its visibility change is explicitly out of scope for this copy PR**; #101 owns implementation. Historical private-review promises must be respected.
- Individual identifiable ballot choices and private account/security data remain restricted. Notices must mention national administrators and specifically authorised national identifiable-ballot access; branch administration/moderation alone does not grant it.
- Do not rewrite imported policy wording, motions, historical events or commit history as interface copy. D33 defers legacy National Neon import; references to earlier policy do not prove adoption. Authorised branch imports are distinct from Engage ballots (D34/D35).

## Coverage and delivery

A touched page was not assumed reviewed in full until its journey batch below. All work is in PR #98; checkpoints also update generated changelog history.

| Batch | Reviewed area | Delivery |
|---|---|---|
| 1 | Homepage introduction; discussion heading/cross-references; sign-in discussion intent | `2d25398` |
| 2a | Remaining homepage/member queues, metadata, proposal highlights | `8558e05` |
| 2b | Full how-it-works prose, shared header/footer/layout/default metadata | `17a0fac` |
| 3a | Proposal browsing/search/filters/empty states; new-proposal form and scope/change selectors | `0a4a86f` |
| 3b | Proposal detail, seconding, discussion, amendments, ballot widget and wording/source history | `1f4ca17` |
| 4 | Public policy registry/detail, branch imports/change notices, branch directory and Sense Box | `7314b06` |
| 5a | Sign-in, My Engage shell/activity/queues and lifecycle guidance | `515cf47` + assertion checkpoint `59c2745` |
| 5b | Onboarding, profile/passkeys/sessions, branch membership/following and notification controls/bell | `9515e90` |
| 6 | Six email renderers (subjects/HTML/plain text), sign-in/verification notices, push/digest messages, preferences/unsubscribe | `6a52a2a` |
| 7a | Admin dashboard, proposal registers/detail, ballot certification and policy ratification/publication | `7308475` |
| 7b | Roles/members/branches/reports/settings/migrations/Sense Box/engagement admin; shared operational components | `bd0f204` |
| 8 | Final legal/privacy, API/form-error, metadata, error/changelog pages, shared-helper and terminology sweep | Validated; publishing checkpoint |

No journey area remains unreviewed once batch 8 is verified remotely. Already-clear strings were retained, including standard primitive labels, auth messages, source/API references and actionable validation. Protocol field names and diagnostic identifiers remain where integrators/officers need them. Existing independent product/UX issues are not solved by copy changes.

## Important changes and evidence

| Before | After / correction |
|---|---|
| Member discussion | Discussion |
| Vote on an immutable bound wording snapshot | Vote on the exact wording shown on the ballot |
| Proposal scope | Who should consider this idea? |
| Put idea on the record | Submit proposal |
| Most approved | Highest approval share (ranking unchanged; Approve/Reject-only minimum made explicit) |
| Inspect ballot | Read ballot |
| Ballot success and ratification are separate decisions | Members decide policy; ratification records the adopted wording |
| Prior approval / constitutional lineage headings | Sources/background, with uncertainty and adoption provenance kept distinct |
| Guaranteed one-tap/setup/voting times | Practical actions without guessed completion times |
| Pending votes will count after verification | Only if verified/eligible, still open and on matching ballot wording |

Accuracy checked against `store.ts` (visibility, seconding, voting and pending-preference promotion), amendment routes, lifecycle scheduler, branch participation, policy import/change/registry, RBAC, notification/email preferences and the decision register. Undated email items no longer assume discussion. The pulse-poll flag is inert: guide and settings now say the poll is not available. Backup/handover text no longer promises instant transfer, encryption guarantees or that secrets are in Git.

Legal drafts advance to version 1.2, still **owner-authorised/publication pending**, with unchanged effective-date placeholders and acceptance gate. Factual descriptions corrected for CRM/manual verification, implemented seconding/timing, delegated national identifiable-ballot access, vote changes and member authority. No new legal authority, privacy access or ballot control is implemented. Operator/registration/legal-framework assertions were retained; this was not an external legal review.

## Validation

- Latest full suite before final integration: **391 passed, 35 skipped, 426 total**; no failures. Skipped suites require optional persistence infrastructure. Focused batch suites also passed (policy/Sense Box 37; member shell/auth 27 + 3 skipped; preferences 15; email 40 + 1 skipped; governance admin 40; remaining admin 35).
- `pnpm check`: 324 files, zero errors/warnings, 20 existing hints. Production build passes.
- `pnpm docs:check-links`: 183 relative links in 80 files, zero broken. `git diff --check` passes.
- Existing source assertions pinned to old accessible labels/CTA/legal wording were updated without removing behavioural checks. Legal acceptance tests confirm publication gating remains inactive for these drafts.
- Raw-control audit: ordinary changed pages use primitives/hidden inputs. Deliberately retained existing Share button in ProposalBallot, standalone unsubscribe confirmation button and email HTML presentation tables; this copy PR preserves those interactions/email compatibility. Native confirmation/revocation/image/link prompts remain separate UX work.
- No CSS/palette/design-system changes. No payload, permission, ranking/reporting formula, consent category, migration, delivery or governance-command changes. Closed-ballot header/caption now reflects the existing deadline check; SSR fallback deadline correctly labels Melbourne time before browser localisation.
- Chromium launch attempted but blocked by environment socket permissions. No rendered/mobile/keyboard, live signed-in, real-inbox or production deployment verification is claimed.
- Changelog generator still truncates history (#96). Regenerate after meaningful commits, then preserve prior real entries rather than silently deleting older history. Do not fabricate hashes or regenerate recursively for snapshot-only commits.

## Remaining issues outside the editorial changes

- Public Sense Box after review: #101. Current form/consent/API remain private; do not falsely describe a shipped public listing or expose historical private entries.
- Private/branch-scoped/archived proposal gates and unpublished policy records still restrict reads; D36 describes direction, not shipped access behaviour. Historical #2’s member-only deliberation requirement conflicts with the new direction.
- Automatic ratification and competing-amendment rules remain incomplete (#27/#34); template capability is not completed notification fan-out (#33).
- Existing raw permission-key UI/native prompts remain #41/#59. No account/authority redesign here.
- Legal publication/effective dates and operational recovery/key-custody questions remain release-owner work (#40); acceptance was not enabled.
