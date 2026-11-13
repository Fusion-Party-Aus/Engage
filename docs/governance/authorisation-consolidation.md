# Authorisation consolidation

Status: implemented in phases. This document records the audit findings, the
canonical model, and the migration constraints for Engage's federated
membership, participation, voting, and administrative permissions.

## Three independent dimensions

| Dimension | Source of truth | Grants |
|---|---|---|
| Membership & voting eligibility | `memberships`, `branch_memberships` | Whether a verified member may vote in a specific ballot |
| Participation | Verified platform membership + recognised branch records | Whether a member may submit a proposal to a destination branch |
| Administrative permissions | `application_roles`, `branch_memberships.branchRole`, `rbac_assignments` + `rbac_roles` | Explicitly scoped moderation, verification, ballot, governance, and platform capabilities |

The dimensions must not imply one another:

- Submitting to a branch creates no membership fact, no voting eligibility, and
  no administrative authority in that branch.
- Administrative authority does not expand voting eligibility. Ballot
  eligibility is read from branch membership, never from a role.
- Branch administrator status does not restrict where a member may submit.
  Submission destinations are all recognised branches for every verified
  member.

## Canonical permission model

`src/lib/rbac.ts` is the single capability catalogue. Each permission declares
its allowed scopes (`national`, `branch`) and sensitivity. System roles are:

- **Member** — no administrative permissions (`application_roles` absent).
- **Moderator** — `LEGACY_MODERATOR_PERMISSIONS`.
- **National Administrator** — `ALL_NATIONAL_PERMISSIONS`.
- **Branch Administrator** — `LEGACY_BRANCH_ADMIN_PERMISSIONS` for one branch.

Custom roles are explicit permission sets with a scope. Effective permissions
are the union of legitimate sources, resolved per request by
`resolveMemberEffectivePermissions`. National grants satisfy branch checks;
branch grants do not satisfy national checks.

Role assignment surfaces:

- Platform system roles: Member Management (`application_roles`).
- Branch Administrator: branch People management (`branch_memberships.branchRole`).
- Custom roles: Roles & permissions (`rbac_assignments`).

Member Management now displays branch-administrator and custom-role grants on
the same member record so the three surfaces do not look like different role
sets.

### Anti-escalation

- A delegated role manager cannot grant a system role whose permissions they do
  not hold.
- Only a national administrator (all national permissions) can change a national
  administrator account.
- Self-demotion from administrator is blocked.
- Role managers still cannot assign built-in roles through the custom-role API;
  legacy system roles are assigned in Member Management.

## Submission destinations

`listProposalSubmissionScopes` returns every recognised branch, independent of
the caller. The proposal form presents National and all eight states and
territories, then reveals constituent/local branches behind a disclosure. The
member's verified or active branch is preselected when it is a recognised
destination; the preselection never restricts the list.

Server-side, any verified member may set an originating branch to any recognised
branch. Governance authority, jurisdiction, and publication scope remain
national-administrator fields. Branch administrators continue to receive
automatic branch authority only for branches they administer. Ordinary member
submissions start under national governance until an authorised administrator
assigns otherwise.

## Migration and production safety

No destructive migration is required for the implemented model.

- Legacy `application_roles`, `branchRole`, and custom RBAC assignments remain
  valid sources and are canonicalised at read time.
- Existing proposal branch identifiers and historical votes are untouched.
- `scope` is additive; legacy records resolve through
  `storedProposalScopeKey`.
- Sessions resolve permissions on every request (`cookieCache` disabled), so
  permission changes take effect immediately without session invalidation.
- A future projection of legacy assignments into `rbac_assignments` must be
  previewed, idempotent, reversible, and must report ambiguous duplicates rather
  than guess. It must not delete legacy sources until effective permissions have
  been reconciled.

## Remaining work

Administrative pages and APIs still mix legacy `isAdmin` / `isBranchAdmin` /
`isStaff` gates with capability checks. Member Management, Roles & permissions,
proposal submission, and member APIs now use capabilities. The remaining sweep
should move dashboards, branch workspaces, ballots, policies, migrations,
settings, and Sense Box to explicit capabilities, preserving legacy equivalence
with characterisation tests at each step.
