# Reporting Privacy & Confidentiality Model

> **Document status: Current** for the confidentiality model and threat model.
> The small-electorate suppression rules in section 4 remain **Design-only**
> pending governance approval. The "Controls implemented in PR #23" section is a
> historical record of that change. The canonical API and permission boundary is
> [architecture/api-and-authorisation.md](../architecture/api-and-authorisation.md).

Status: **Confidentiality policy & threat model** (PR #23). Scope and archive enforcement fixes in CSV/PDF/admin reporting were implemented alongside this document. Quantitative small-cell suppression thresholds are documented here as a policy proposal requiring governance sign-off before altering tally visibility.

## 1. Current confidentiality model

Engage operates a **role-restricted confidentiality model**, not cryptographic or detached anonymous voting:

- **Identifiable ballot records (`votes` / `proposal_votes`):**
  - Stored with `memberId`, `authorName`, `choice`, `reason`, `revisionId`, and `updatedAt` so verified members can review and update their own ballot while voting is open, and so audit/migration integrity checks can verify eligibility.
  - Access is governed by `canViewIdentifiableBallots(user)` in `src/lib/auth.ts`: `true` only for a national administrator (`user.isAdmin`) or a holder of the national-scope `ballots.view_identifiable` permission. No branch-scoped grant conveys it.
  - `ballotRecordsForViewer(votes, user)` in `src/lib/ballot-privacy.ts` strips all other members' records (and strips `memberId` / `authorName` from the viewer's own returned record) for viewers without that boundary on `/api/proposals/[proposalId]`.
  - Moderators (`isStaff && !isAdmin`) and branch administrators (`isBranchAdmin && !isAdmin`) **must not** receive identifiable ballot choices unless they also hold the national permission. The permission must not be delegated at branch scope.
- **Aggregate reporting surfaces:**
  - **Admin overview (`/admin/`):** Recent vote activity feed is gated on `canViewIdentifiableBallots(user)`; branch admins and moderators see only aggregate counts and non-ballot deliberation/proposal activity.
  - **Admin ballots (`/admin/ballots/`) & reports (`/admin/reports/`):** Display aggregate `approve`, `abstain`, `reject`, and `total` counts.
  - **CSV export (`/api/admin/reports/proposals.csv`):** Exports aggregate counts only (`approveVotes`, `abstainVotes`, `rejectVotes`, `totalVotes`, `commentCount`), escapes formula-injection prefixes (`=`, `+`, `-`, `@`, `\t`, `\r`), sets `Cache-Control: private, no-store`, and restricts branch admins to their authorised branch scope.
  - **Proposal PDF report (`/api/admin/reports/proposal-pdf`):** Exports proposal metadata, aggregate ballot totals (explicitly distinguishing open interim totals from completed outcomes), and deliberation comments with display names only (no member IDs, emails, or individual votes).
  - **Public/member proposal pages (`/proposals/[slug]/`):** Show aggregate tally bars and the signed-in member's own vote.

## 2. Threat model: small electorates and aggregate inference

Aggregate counts are **not automatically anonymous**. Even without member names or IDs, individual choices can be inferred through:

1. **Unanimous or near-unanimous results:** If 5 members vote and all 5 vote `approve`, anyone who knows a member voted (e.g. from a participation feed or small branch meeting) knows their choice.
2. **Small electorates / low turnout:** In a constituent or regional branch with 1–4 active voters, aggregate counts (`1 approve, 0 reject`) directly expose individual choices.
3. **Before/after differencing:** Comparing two successive CSV exports or dashboard views taken before and after a single known member votes reveals that member's choice.
4. **Overlapping filter differencing:** Filtering reports by narrow criteria (e.g. `stage` + `branch` + search query) or cross-referencing total votes against `verifiedMembers` in branch summaries can isolate a single voter.
5. **Activity-feed correlation:** A non-admin who sees "Member X participated" in a feed at timestamp `T` and sees `approve` increment by 1 in an open ballot can correlate identity with choice.

## 3. Controls introduced in PR #23 (historical)

Reporting access has since moved to the permission catalogue: the CSV export requires `reports.export` (`branchesWithPermission`), scopes rows through `canIncludeProposalInAdminReport` (`src/lib/admin-reporting.ts`) and shows aggregate counts only. Treat the role-flag descriptions below as the state at that change.

1. **Consistent branch-admin scope across all reporting surfaces:**
   - Branch administrators (`!isStaff && !isAdmin`) are restricted to proposals where `originatingBranchId` is in `user.branchAdminIds`, matching `canManageBranchProposal` and `proposal-pdf.ts`, and `canViewProposal` + `canReviewArchivedProposal` are enforced consistently across `admin/index.astro`, `admin/ballots/index.astro`, `admin/reports/index.astro`, `proposals.csv.ts`, and `proposal-pdf.ts`.
   - Previously, `proposals.csv.ts` and the admin dashboard pages matched `jurisdictionBranchId` / `governanceAuthorityBranchId` without `canReviewArchivedProposal`, which could expose private or archived proposals from another branch.
2. **Audience, confidentiality, and data currency disclosures:**
   - Proposal PDF reports explicitly state their intended audience (authorised governance review), confidentiality boundary (aggregate totals only; individual votes omitted), data currency (generation timestamp), and whether ballot figures are interim or finalised.
   - CSV and admin report views clearly distinguish open interim tallies from finalised ballot outcomes.

## 4. Proposed small-electorate suppression policy (requires governance approval)

Before hiding or delaying aggregate tallies in the UI or exports, the party should ratify explicit rules for:

- **Minimum turnout threshold (`k`-anonymity):** Suppress per-choice breakdown (`approve` / `abstain` / `reject`) when `totalVotes < k` (e.g. `k = 5`), showing only `totalVotes` or `"Fewer than 5 ballots cast — breakdown withheld"`.
- **Unanimity / dominance rule:** Suppress exact per-choice breakdown when a single choice accounts for all cast ballots in a small electorate (`totalVotes < 10`), to prevent trivial inference.
- **Interim vs closed tallies:** Decide whether open-ballot per-choice counts should be hidden from non-admins until the ballot closes (reducing before/after differencing and bandwagon effects).

Until these thresholds are formally approved, Engage preserves existing tally visibility while ensuring no identifiable ballot data leaks outside `canViewIdentifiableBallots`.
