# PR #17 requirements audit and design reset

Status: rejected implementation; design proposal only. No approval to implement or merge.
Visual baseline: 50a7710, before PR #17. Original screenshots remain the visual authority, not the PR's after screenshots.

## Requirements audit

“Solved” here means the narrow behaviour is evidenced; it does not mean the integrated experience is accepted.

| Original requirement | Status | Evidence / gap |
|---|---|---|
| Inspect routes, canonical content, votes and branch eligibility before design | Partially solved | Source inspected; original desktop/mobile experience was not adequately evaluated before structural edits. |
| Coherent reading-to-decision progression | Unsolved | Moving summary and ballot into the reading column did not demonstrate a better comprehension journey. |
| Preserve meaningful introduction beneath title | Unsolved | Hero summary removed: a regression. |
| Canonical summary near commitments and ballot | Partially solved | Same canonical field rendered near commitments, but introductory context lost and long commitments still separate summary from controls. |
| Preserve complete policy information | Solved | Rationale and other policy content retained. |
| Preserve immutable wording and voting permissions | Solved | Mutation rules unchanged; existing governance tests pass. |
| Next navigation before and after voting | Partially solved | Available, but buried below controls and links jump directly to the next ballot. |
| Skip without voting | Partially solved | Navigation does not submit; no explicit, discoverable skip affordance or journey context. |
| Prioritise eligible unvoted ballots | Solved | Existing canonical outstanding-decision selection retained. |
| Meaningful outstanding counts | Partially solved | Eligible counts exist; distinction between current ballot and ballots after it is unclear. |
| Completion and revisiting | Partially solved | Completion and all-ballots link exist; no strong route back to skipped or previously voted proposals. |
| Encounter next policy before its controls | Unsolved | `#proposal-vote` navigation bypasses explanation. |
| Distinguish lifecycle and personal filters | Partially solved | Duplicate stage dropdown removed, but personal actions hidden in a generic dropdown. |
| Voting defaults to eligible outstanding ballots | Solved | Default applied when URL has no explicit focus. |
| Disable default and retain explicit URL selection | Solved | Explicit focus=all preserved; tests exercise stage and browser navigation. |
| Predictable stage changes | Partially solved | Opt-out persists; enabled personal filters and inferred defaults need clearer behaviour. |
| Search, sorting, counts and deep links together | Partially solved | Server filtering retained; count semantics and visible personal-filter state need clearer design. |
| Discussions joined | Solved | Uses actual member comments instead of all discussion-stage proposals. |
| Preserve useful discovery functionality | Unsolved | Ranking panels and post-vote share/discussion actions removed rather than purposefully relocated. |
| Branch eligibility and active ballot status | Solved | Canonical eligibility retained; browser uses current revision for recorded-vote label. Branch permutations covered by tests, not visual journeys. |
| Distinct completion and no-results states | Solved | Separate states implemented. |
| Concise copy without loss of consequence | Partially solved | Confirmation improved; consequential context remains, but broad deletions are not a contextual editorial review. |
| Purposeful Horizon hierarchy and grouping | Unsolved | Removing borders and moving controls did not establish an approved visual hierarchy. |
| Accessible desktop/mobile experience | Partially solved | Radio semantics, status announcements and overflow checks retained; full keyboard, touch and assistive-technology journeys not demonstrated. |
| Zero reload, failure recovery and persisted updates | Solved | Browser exercises save, retry and change; hero refresh added. |
| Before/after evidence of meaningful improvement | Unsolved | Captures show changes and technical function, not improved comprehension or ease of discovery. |
| Atomic commits, changelog, typecheck, tests and build | Solved | Present; not evidence that the design meets the brief. |

## Regressions to undo in the revised design

1. Restore the canonical introduction beneath the title.
2. Restore the original desktop reading column and contextual ballot rail as the starting composition, then redesign their relationship deliberately.
3. Replace next-ballot deep links to voting controls with normal proposal entry at the title and explanation.
4. Restore discoverable personal filtering rather than burying it in a dropdown.
5. Restore access to popular/divisive/active discovery through a compact “Explore” disclosure using the existing ranking options; do not restore three oversized empty panels.
6. Restore optional Share and Join discussion actions in a secondary location. They must not compete with the next ballot.
7. Restore purposeful grouping, compact commitment rows and clear section hierarchy within Horizon.

## Engineering candidates to retain separately

Keep these as independently reviewable candidates, not automatic approval of PR #17: URL focus precedence and explicit opt-out tests; actual joined-discussion membership; reuse of the authorised proposal list; current-revision vote labels; canonical branch/deadline checks; failure-preserving mutations; successful-save hero refresh; browser verification harness. Existing vote endpoints and eligibility rules remain the authority.

## Proposed complete journey

### Discovery

Keep lifecycle tabs: All / Ideas / Discussion / Voting / Implementation. Under them, a visibly separate “For me” row exposes a checkbox “Needs my vote · 23” and “Discussions I’ve joined”. Search remains prominent; branch/topic and sort retain their established controls. Recently updated remains a sort choice, not a second overlapping personal filter. Explore opens existing most-divisive, most-approved and most-active options without permanently occupying the page.

On first entering Voting with no explicit/restored preference, enable Needs my vote. Switching it off writes focus=all. Search, sort and branch changes never re-enable it. Leaving Voting suspends its default rather than carrying a vote-only filter into Ideas; returning restores the last explicit Voting choice. Explicit URL state wins over restoration, which wins over defaults. Joined discussions can apply across stages. Counts distinguish lifecycle totals from “23 eligible ballots need your vote”; result count reflects all applied filters. Personal filters are visible checkboxes. If both are selected, their intersection is explicit and the result count updates; neither silently selects the other.

### Reading and decision

Retain title and meaningful canonical summary in the hero. Show “Review proposal · about 2 min” plus “23 ballots need your vote” and a secondary “Skip for now →”. Time is an estimate for reading, not a promise that an informed decision takes 30 seconds. Hero actions reflect eligibility.

Desktop: retain the original two-column composition. The main reading surface contains summary, commitments, rationale and discussion. A sticky contextual ballot rail begins with a compact canonical-summary disclosure titled “What you’re deciding”, open when the ballot is the focal area. This deliberate contextual reuse does not create a separately maintained summary. Keep commitments directly alongside it; link “Review commitments” to their heading. The disclosure starts closed while the introduction is visible. Choosing “Review & vote” opens it and lands at the start of the decision area, with commitments alongside. Members can also open it directly. Do not add automatic scroll observers or scroll-driven focus changes.

Mobile: hero introduction, summary/commitments reading section, rationale link/preview, then ballot. Keep full rationale and discussion reachable; do not place the ballot after history. A compact bottom “Review & vote” anchor takes the member to the beginning of the decision section (summary and commitments), not past it. No vote-choice controls in a floating bar. Full rationale remains available before deciding.

### Vote, skip, revisit, finish

Before voting: visible “Skip for now →” in the hero and beside the ballot progression footer. Footer reads “23 need your vote” (includes current); next link reads “Next proposal: [title]”. Both navigate to the next proposal's title/summary, never #proposal-vote. Skipping records no vote and removes nothing from the outstanding list. The skipped proposal remains discoverable; returning to Needs my vote shows it again. A compact “All ballots” link preserves access to browse out of sequence.

After confirmed save: “Vote saved: Approve” and “You can change your vote until [deadline]”. Show “22 need your vote” and a primary “Read next proposal →”. Share and Join discussion are secondary text actions under a disclosure/quiet action row. Updating an existing vote keeps the member on the proposal and does not auto-advance. Save failure preserves choice/reason and offers retry; the outstanding count does not decrease.

Completion: “You’re up to date” with “Review your votes” and “Browse active ballots”. If current ballot is still unvoted and no others remain: “This is your last outstanding ballot”, with a browse exit. Ineligible branch members see a readable eligibility explanation and relevant branch/account action; their count includes only eligible ballots, while broader discovery remains available.

## Approval scope

Approve or correct the composition and journey before application changes. The high-fidelity images illustrate the direction; this document defines exact filter precedence, count semantics and navigation. They are design mockups, not screenshots of an implemented or validated product. A subsequent implementation must verify real content lengths, mobile touch targets, keyboard/focus behaviour, eligibility states and server-confirmed feedback.

## Mockup reading notes

The desktop board shows the Voting scope and the decision context expanded, plus a separate saved-state inset. Mobile boards show successive journey states, not a mandatory wizard. Generated mockup text is illustrative: existing canonical summary and governance wording must be used verbatim in implementation. The repeated commitment subtitle and technical “Formal ballot” list label visible in the desktop mockup should be omitted; they are image-generation artefacts, not approved copy. Retain full privacy wording at the point of voting; a privacy link alone is insufficient.

The mobile Explore disclosure is shown expanded to demonstrate retained discovery. It starts collapsed in the proposed normal browsing state; empty ranking panels should not occupy permanent space. The mobile completion inset should use the heading “You’re up to date” and the precise supporting line “No eligible ballots need your vote.” The screens are states within ordinary pages, not separate wizard steps.
