# Engage — RBAC Audit & Configurable Permissions Specification

Date: 13 November 2026.

## 1. Actual Permission Model

Engage evaluates access from four orthogonal sources on `SessionUser` (`src/lib/auth.ts`):

1. **Platform role (`application_roles`):** `administrator` (`isAdmin`, `isStaff`), `moderator` (`isStaff`), or default `member`.
2. **Platform membership (`memberships`):** `pending`, `verified` (`canParticipate: true`), or `suspended`.
3. **Branch participation (`branch_memberships`, `branch_subscriptions`):**
   - Verified active branch memberships (`verifiedBranchIds`) grant branch voting eligibility and branch-scoped proposal visibility.
   - `branchRole: "administrator"` (`branchAdminIds`, `isBranchAdmin`) grants branch-scoped operational administration.
   - Subscriptions (`followedBranchIds`) grant discovery visibility only—never voting eligibility.
4. **Configurable roles (`rbac_roles`, `rbac_assignments` — added in PR #23):**
   - Reusable National- or Branch-scoped role definitions with explicit permission keys from `PERMISSION_CATALOGUE` (`src/lib/rbac.ts`).
   - Combined additively with legacy roles and branch-admin delegations, with per-grant origin tracking.

### Resource-Permission Matrix

| Capability | Anonymous | Unverified Member | Verified Member | Proposal Author | Moderator (`isStaff`) | Branch Admin | National Admin |
|---|---|---|---|---|---|---|---|
| View `national` active proposal | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| View `branch` active proposal | No | Branch follower/member | Branch follower/member | Yes | Yes | Yes | Yes |
| View `private` proposal | No | No | No | Yes | Yes | Originating branch only | Yes |
| View `archived` proposal & revisions | No | No | No | Own proposal | Yes | Originating branch only | Yes |
| Create proposal / comment / amendment | No | No | Yes | Yes | Yes | Yes | Yes |
| Edit proposal (before Decide lock) | No | No | No | `propose` stage only | Yes | Originating branch only | Yes |
| Delete proposal | No | No | No | `propose` stage only | No | No | Yes |
| Respond to contributions | No | No | No | Own proposal | Yes | Originating branch only | Yes |
| Cast vote | No | Pending preference only | Eligible electorate & open ballot | If eligible | If eligible (not automatic) | If eligible (not automatic) | If eligible (not automatic) |
| Resolve / apply amendments | No | No | No | No | No | Originating branch only | Yes |
| Bind ballot / record ballot result | No | No | No | No | No | Matching authority & jurisdiction | Yes |
| View identifiable ballots | No | No | No | No | No | No | **Yes (`ballots.view_identifiable`)** |
| Ratify / publish / withdraw / supersede policy | No | No | No | No | No | No | Yes |
| Verify / suspend platform member | No | No | No | No | No | No | Yes |
| Verify / revoke branch member | No | No | No | No | No | Assigned branch only | Yes |
| Delegate branch admin / manage custom roles | No | No | No | No | No | No | Yes |
| Export aggregate CSV / proposal PDF | No | No | No | No | Yes | Originating branch only | Yes |

## 2. Inventory of Protected Pages & APIs

- **Admin UI (`src/pages/admin/`):** `index.astro`, `proposals/index.astro`, `proposals/[slug].astro`, `ballots/index.astro`, `policies/index.astro`, `members.astro`, `roles/index.astro`, `branches/index.astro`, `sense-box/index.astro`, `reports/index.astro`, `engagement.astro`, `settings/index.astro`, `migrations/index.astro`. All set `Cache-Control: private, no-store`.
- **Member & Proposal APIs:** `/api/proposals`, `/api/proposals/[proposalId]`, `/api/proposals/[proposalId]/revisions`, `/api/amendments`, `/api/comments`, `/api/votes`, `/api/member/branches`, `/api/sense-box`, `/api/legal/acceptance`, `/api/email/preferences`.
- **Admin APIs:** `/api/admin/members`, `/api/admin/roles`, `/api/admin/branches`, `/api/admin/branches/memberships`, `/api/admin/branches/referrals`, `/api/admin/branches/search`, `/api/admin/ballots/bind`, `/api/admin/ballots/result`, `/api/admin/amendments/{resolve,open-ballot,close-ballot,accept,apply}`, `/api/admin/policies/{ratify,publish,withdraw,supersede,reconcile}`, `/api/admin/reports/{proposals.csv,proposal-pdf}`, `/api/admin/email/{test,reengagement}`, `/api/admin/settings`, `/api/admin/migrations`.
- **Cron & Webhook APIs:** `/api/email/digest` (`ENGAGE_CRON_SECRET` constant-time bearer check), `/api/email/webhook` (`RESEND_WEBHOOK_SECRET` signature check), `/api/email/unsubscribe` (signed HMAC token).

## 3. Audit Findings & Fixes

| Severity | Finding | Location | Resolution |
|---|---|---|---|
| **High** | `GET /api/amendments?proposalId=...` checked `canViewProposal` but did not check `canReviewArchivedProposal` when `proposal.stage === "archived"`, allowing signed-in members with a `proposalId` to read amendments of archived proposals. | `src/pages/api/amendments.ts` | **Fixed:** Added `canReviewArchivedProposal` check for archived proposals, returning `404` to unauthorised viewers. |
| **High** | Admin reporting pages (`admin/reports/index.astro`, `admin/ballots/index.astro`, `admin/index.astro`) and `proposals.csv.ts` scoped branch admins by `jurisdictionBranchId` / `governanceAuthorityBranchId` without `canReviewArchivedProposal`, risking cross-branch exposure of private/archived proposals. | `src/lib/admin-reporting.ts`, `proposals.csv.ts`, `admin/*.astro` | **Fixed:** Unified all reporting surfaces on `canIncludeProposalInAdminReport`. |
| **Low / Inconsistency** | `moderator` (`isStaff && !isAdmin`) can edit proposals, view archived proposals, and export reports, yet is blocked from `/api/admin/amendments/*` and `/api/admin/ballots/*` (`isAdmin \|\| isBranchAdmin`). | `src/pages/api/admin/amendments/*.ts`, `ballots/*.ts` | **Documented:** Preserved current boundary; configurable roles allow explicit delegation if desired. |

## 4. Governance Questions Deferred

1. **Moderator role retirement:** Should the legacy `moderator` role be migrated to a configurable role with explicit deliberation-only permissions?
2. **Branch-level role delegation:** Currently only National administrators (`roles.manage`) can create and assign custom roles. Should branch administrators be permitted to assign pre-approved branch-scoped roles within their own branch?

## 5. Residual Risk Assessment

- **CSRF on legacy endpoints:** Several JSON API endpoints rely on `SameSite=Lax` session cookies rather than explicit `Origin` header checks (`/api/admin/roles` and `/api/member/branches` enforce `Origin` checks). Adding uniform `Origin` validation middleware across all state-changing routes is recommended as a follow-up.
- **Session revocation:** `session.cookieCache` is disabled and `getSessionUser` queries `application_roles`, `branch_memberships`, and `rbac_assignments` on every request, so revocations take effect immediately.
