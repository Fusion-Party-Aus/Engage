# Engage UI refinement — proposal record, Admin CP and My Engage

**Date:** 9 November 2026  
**Scope:** Member proposal detail, Administration Control Panel, My Engage  
**References:** Issue Detail 2, Project Detail 1, and the Application Pro activity patterns (Approvals Queue, Catch Up Digest, Status Change Log, Filtered Activity Log).

## Outcome

The three workspaces now share one Horizon/shadcn record language: a breadcrumb and record header, a hairline status and property grid, a clear primary action, and supporting detail held back until it is useful.

- **Proposal detail** leads with governance status, ballot state, eligibility and recorded votes. The exact wording, discussion, amendments, revision history and provenance remain on the page, but are grouped as record sections rather than a flat stack of cards.
- **Admin CP** gains a dedicated proposal record workspace at `/admin/proposals/[slug]/` with overview, decision, amendments, discussion and activity sections, plus a scope/authority rail, contextual actions and permission notes. The overview now groups 38 repetitive “ballot wording” alerts into one review group.
- **My Engage** answers “what needs my attention, what changed, where can I contribute?” with an approvals queue, a catch-up digest, a status-change log, and the existing activity timeline. Long ballot lists use progressive disclosure.

Governance semantics were not changed. No voting, quorum, eligibility, adoption or authority rule was added, removed or reinterpreted. Server-side permissions remain the authority; the new admin record route also re-checks delegated branch scope.

## Screenshots

All screenshots were captured into `docs/screenshots/engage-ui-refinement-2026-11-09/`, which is not committed to this repository. The “before” images retain the Astro development toolbar; the “after” images were captured with the development toolbar removed.

| Surface | Before | After |
| --- | --- | --- |
| Proposal detail | `before/proposal-detail.png`, `before/proposal-detail-mobile.png` | `after/proposal-detail.png`, `after/proposal-detail-mobile.png` |
| Proposal with formal amendment | — | `after/proposal-detail-amendment.png` |
| Admin overview | `before/admin-overview.png` | `after/admin-overview.png` |
| Admin proposals register | `before/admin-proposals.png` | `after/admin-proposals.png` |
| Admin proposal record (new) | — | `after/admin-proposal-detail.png`, `after/admin-proposal-detail-mobile.png` |
| Policy registry | `before/admin-policies.png` | `after/admin-policies.png` |
| My Engage overview | `before/my-engage-overview.png` | `after/my-engage-overview.png`, `after/my-engage-mobile.png` |
| My Engage activity | `before/my-engage-activity.png` | `after/my-engage-activity.png` |

Local screenshots use the in-memory seeded database. The registry is empty in that seed, so the policy screen shows its empty state; registry record, property grid and publication-audit code paths are in place for an adopted policy.

## What changed

### Member proposal detail — `src/pages/proposals/[slug].astro`

- Record header with stage/kind/space/identifier, a four-part status grid (stage, ballot, eligibility, recorded votes), a visible lifecycle stepper and an in-page section nav.
- Decision sidebar now states eligibility, ballot wording and recorded votes before the ballot control.
- Sidebar “Record status” and “Proposal facts” cards replace the old flat metadata rows; duplicate stage/classification rows were removed.
- Discussion uses consistent stance icons, contributor initials, stance badges and a clearer endorsement control.
- Formal amendments render as structured record cards with status, base/current revision, conflicts, history and diff disclosures.
- Revision history marks the latest revision and the ballot-bound revision.
- Staff controls link to the new admin record workspace as well as the existing editor.

### Administration Control Panel

- New server-rendered record workspace: `src/pages/admin/proposals/[slug].astro`.
  - Saved record stats: votes, contributions, amendments, wording revisions.
  - Sections: proposal brief, ballot and recorded outcome, amendments, discussion, activity/audit history.
  - Rail: record status and next action, scope and authority, linked records, permissions.
  - Activity is built only from persisted proposal, revision, contribution, amendment, ballot-result and policy events. No stage transitions are inferred.
  - Delegated branch scope is re-checked server-side before the record is rendered.
- Admin overview groups attention items by decision, with counts and the first three affected records instead of one row per ballot.
- Proposal register titles link to the record workspace; a hash link opens the matching “Manage proposal” disclosure.
- Policy registry rows gain a property grid (jurisdiction, authority, ratified revision/date, publication date, supersession), linked public/proposal/ballot actions, and a `publication_events` audit disclosure.
- Policy empty state now distinguishes “no policy ratified yet” from “no search match”.

### My Engage — `src/pages/member/index.astro` and member components

- Header converted to a record header with underline view tabs and a four-stat hairline strip.
- New approvals queue (`src/components/member/AttentionQueue.astro`): eligible outstanding ballots, branch label where relevant, three visible rows and a disclosure for the rest.
- New catch-up digest (`src/components/member/CatchUpDigest.astro`): persisted discussion, wording, amendment, ballot-result and policy events on proposals the member voted on, discussed, endorsed, amended or authored.
- New status change log (`src/components/member/GovernanceLog.astro`) on the Activity tab: recorded decisions, amendment milestones and policy events.
- Activity tab keeps the existing action timeline and adds the digest and governance log above it.
- Last-visit tracking uses a first-party functional cookie (`engage_member_last_seen`) that advances at most once every 30 minutes. With no prior visit it reads “In the last seven days”; nothing is presented as a notification.

### Library and tests

- `src/lib/member-activity.ts`: `buildMemberCatchUp` groups real persisted events by engaged proposal and filters by proposal visibility.
- `src/lib/member-activity.test.ts`: new in-memory test for catch-up grouping, self/old/unrelated exclusion, amendment milestones, ballot results, policy events and private-proposal visibility.

## Verification

- `pnpm check`: **0 errors** (157 files).
- `pnpm test`: **107 tests, 93 passed, 14 skipped, 0 failed**. Skipped tests require real MongoDB and remain unchanged.
- Manual route checks with the development administrator/member session:
  - `/proposals/[slug]/` — 200, ballot and discussion render.
  - `/member/` and `/member/?view=activity` — 200, queue/digest/log/timeline render.
  - `/admin/`, `/admin/proposals/`, `/admin/proposals/[slug]/`, `/admin/policies/` — 200 for an administrator.
- Desktop (1440px) and mobile (390px) screenshots captured for the main surfaces.

## Remaining issues

1. **No ballot deadline model.** The data model still has no `opensAt`/`closesAt` fields. The queue deliberately shows recorded eligibility and the last update date rather than inventing a closing date or age. Adding genuine deadlines requires the ballot-instance work already identified in the governance audit.
2. **Last-visit storage is a functional cookie.** It is not a notification service and stores only a timestamp, but the privacy notice should mention it if the organisation treats functional cookies as requiring disclosure.
3. **Admin management forms remain in the register.** The new record workspace links to the existing ballot/amendment controls and auto-opens the matching row. Moving those forms into the detail route would duplicate a large amount of working script and was left as a separate change.
4. **No stage-transition audit exists.** The admin activity section shows revisions, contributions, amendments, results and publication events, but not stage moves, because no stage-history records are persisted. It does not fabricate them.
5. **Policy registry screenshots show the seeded empty state.** The seeded local database has no ratified registry records; the new property/audit UI is exercised only when a policy exists.
6. **Automated accessibility tooling was not run.** The pages were checked for heading order, labels, keyboard-reachable controls, `aria-current`, focus styles and mobile layout, but no axe/Lighthouse pass was executed.
7. **Real-Mongo integration tests remain skipped locally** (14), as before this change.
