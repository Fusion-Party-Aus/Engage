# Federated authorisation: audit and migration design

13 November 2026. Status: initial audit and permission-resolution consolidation;
production migration is **not approved for execution** by this document.

## Findings

The user's three independent dimensions are the target specification. The current
implementation partly separates them, but does not enforce them consistently.

| Area | Current authoritative path | Finding |
| --- | --- | --- |
| Identity and sessions | `auth.ts`: Better Auth `user`, `session`; `memberships`; `application_roles` | Cookie cache disabled; account disablement and administrative facts reloaded per request. `role`, `isAdmin`, `isStaff` still come only from legacy roles. |
| Organisation | `branch-participation.ts`: `branches`, `branch_memberships`, `branch_subscriptions` | Active memberships establish branch eligibility; subscriptions establish discovery. A membership row also carries `branchRole: administrator`, coupling verified affiliation and administration. External/local source protection must survive migration. |
| National membership | `getSessionUser`, `ensureNationalMembership`, `getProposalEligibility` | Verified accounts gain National eligibility without a separate affiliation check. Session resolution can create National membership; rows are initially read before this write. Do not reinterpret existing National verification in a refactor. |
| Administrative catalogue | `rbac.ts`, `roles-store.ts` | Explicit permission catalogue already exists. Effective permissions add legacy national roles, active branch administrators, and custom assignments. Duplicated fallback and database legacy resolution had different grant identifiers. |
| Member Management | `admin/members.astro`, `api/admin/members.ts`, `store.ts:saveMember` | Displays only member/moderator/administrator. API accepts delegated member permissions but page and store still require legacy administrator. PATCH checks `roles.manage`; POST relies on the store's broader administrator gate. |
| Roles & Permissions | `admin/roles`, `api/admin/roles`, `roles-store.ts` | Shows three built-in roles plus custom roles, but built-in assignment is rejected and redirected to legacy management. Not one authoritative assignment workflow. |
| Branch management | `api/admin/branches/memberships`, `verifyBranchMember`, `revokeBranchMember` | GET uses scoped capability; mutation admission also checks legacy/derived flags. Delegating or changing an administrator requires `isAdmin`. Removing affiliation can remove administrative authority as a side effect. |
| Submission | `proposals/new`, `listAuthorisedProposalScopes`, `parseProposalScopeInput`, `saveProposal` | Page fetch and selector limited to administrators. Server independently rejects ordinary member state submissions and limits branch administrators to their own branch. This contradicts authorised cross-branch participation. Exact constituent branch IDs take a different path from geographic keys. |
| New proposal governance | `store.ts:saveProposal` | Origin, default publication, jurisdiction and authority depend on submitter administration. Opening only the selector would leave different governance defaults for otherwise identical proposals. |
| Proposal operations | `canManageBranchProposal`, `canViewProposal`, `canReviewArchivedProposal`, `saveProposal`, `deleteProposal` | Helpers partly use capabilities, while store mutations and visibility still use legacy flags/branch IDs. A custom editor does not necessarily receive the same workflow as a legacy editor. Visibility needs its own resource policy. |
| Amendments and ballots | `api/admin/amendments/*`, `api/admin/ballots/*`, `canManageBranchBallot` | Ballot routes check the operation capability and matching branch authority, but helper admission groups several ballot capabilities together. Resolve/apply retain legacy admission and generic proposal-manager checks rather than one exact operation capability. |
| Voting | `api/votes`, `store.ts:castVote`, `getProposalEligibility` | Verified participation plus active branch affiliation; administration is no eligibility bypass. National and missing-jurisdiction legacy cases permit verified accounts. Pending preference promotion duplicates eligibility logic. |
| Ballot identity and history | `ballots.ts`, `ballot-binding.ts`, `vote-storage.ts`, ballot migration modules | Separate ballot model coexists with legacy proposal ballot identity and inferred electorate. Electorate fallback uses publication/origin and a hardcoded National ID. Do not re-resolve old electorates from a changed hierarchy. |
| Privacy | `canViewIdentifiableBallots`, `ballot-privacy.ts` | Explicit National identifiable-ballot boundary exists. Keep separate from moderation, reports and branch ballot administration. |
| Reporting/navigation | `admin-reporting.ts`, admin pages/layouts | Scoped report filtering exists, but navigation/admission uses a mix of legacy flags and capabilities. Both must follow the same capability model while every endpoint enforces independently. |

This is a source audit, not proof that every endpoint has been exercised against
production. Existing `rbac-audit-and-permissions.md` records earlier work and must
not be interpreted as evidence that consolidation is already complete.

## Existing role semantics

- **Member** is the absence of a legacy administrative assignment. It does not
  establish verification or a branch electorate.
- **Legacy National administrator** grants all catalogue capabilities and direct
  legacy bypasses. It includes identifiable ballots, member verification, role
  management and policy authority. A capability migration must inventory the
  bypasses, not assume the catalogue fully describes observed access.
- **Legacy moderator** grants National proposal editing, archived access,
  supersession, comment moderation, contribution response and reports. Staff
  checks also allow some participation without verification. It does not grant
  formal ballot administration, ratification or identifiable ballot access.
- **Legacy branch administrator** is an active membership attribute. It grants
  proposal operations at origin and ballot operations only where branch authority
  matches jurisdiction, alongside branch verification and reporting. It is also
  a verified affiliation today; separate those facts without deleting either.
- **Custom roles** are capability bundles with National or exact branch scope.
  A matching display name does not make one equivalent to a built-in role.
- **System role definitions** describe legacy bundles, but currently are not an
  independent writable assignment mechanism. Preserve stable IDs, not names.

## Production evidence (read-only snapshot)

Queried the running Coolify production application's configured database through
its installed MongoDB client. No credentials, member identities, ballot choices,
or session tokens were emitted. No database writes or deployments were made.

| Fact | Observed |
| --- | ---: |
| Legacy administrator assignment rows | 5 |
| Legacy moderator assignment rows | 1 |
| Verified platform membership rows | 37 |
| Active branch membership rows | 8 (1 administrator, 7 members) |
| Recognised branches | 9 (National, 6 states, 2 territories) |
| Configurable role definitions / assignments | 0 / 0 |
| Stored sessions, including potentially expired sessions | 62 |
| Proposal stage Decide | 35 |
| Other proposal stages | 44 Deliberate, 1 Implement, 1 Archived |
| `proposal_votes` records | 341 |
| Separate `ballots` records | 0 |

All 35 Decide proposals have nonempty revision, authority and jurisdiction fields.
Presence is not proof of reference integrity or that deadlines are still open.
Duplicate groups were absent for application `(memberId, role)`, platform
`memberId`, branch membership `(memberId, branchId)` and branch `branchId`.
Membership source values include `engage-local` and `engage-legacy`.

The running service is healthy under Coolify. Older deployment documentation
saying production was not cut over is historical, not current deployment truth.
Further preflight must inspect orphan references, conflicting role rows per
member, indexes, expiry, amendment ballots, revision hashes, encrypted and legacy
vote storage, and assignment provenance. These counts are not migration clearance.

## Canonical model

1. **Membership facts:** platform verification and source-owned organisational
   affiliations. Active verified affiliations determine branch ballot eligibility.
   Following is independent. No role or capability creates an affiliation.
2. **Participation policy:** verified members may create a proposal for any
   recognised National/state/territory/constituent branch. No affiliation or
   administrative assignment is required in the destination. Creation grants no
   membership, ballot eligibility or branch management rights. Authors retain
   the existing draft-editing rights, separate from administration.
3. **Administration:** one capability catalogue, immutable/versioned role bundles,
   and audited assignments to a member at `national` or exact `branchId` scope.
   National scope is platform-wide authority for the named capability; there is
   no implicit parent-to-child branch inheritance. Labels never select scope.

Use `rbac_roles` and `rbac_assignments` as the eventual administrative source,
with schema/model version and role-version binding added by an expand migration.
Use explicit capability checks for each operation, not role names, booleans or
“any ballot permission”. Central resource policies resolve the correct origin,
authority or jurisdiction for that operation. Keep participation, visibility,
ballot eligibility and identifiable ballot access as distinct policies.

Both management screens should use one role/assignment read model. Member details
show verification, affiliations and administrative assignments separately. Roles
shows the same bundles and assignments. Both use the same mutation functions.
Remove the legacy platform-role select after migrated assignments are authoritative.
Do not display raw grants/JSON in routine administration.

## Governance decisions requiring explicit resolution

- **Existing National verification semantics:** current verified Engage status
  implies National eligibility; source comments explicitly distinguish it from
  independent party certification. Do not introduce a new certification
  prerequisite or revoke existing eligibility without a governance specification.
- **Unverified staff participation:** current APIs sometimes exempt staff from
  membership verification. Recommend requiring verification for member submissions
  while retaining explicitly authorised administrative operations. Removing this
  exemption is a permission change and needs an explicit decision.
- **New branch proposal authority:** recommend destination branch jurisdiction
  and authority for all new branch submissions, independent of who submits, using
  existing matching-authority rules before ballot opening. National authority
  remains National. Do not backfill this onto existing proposals. If branch
  ratification/publication is desired, it needs an explicit specification; those
  capabilities are National-only today.
- **Delegation:** retain National-only role delegation initially. Branch
  administrators do not automatically gain rights to assign other administrators.

The cross-branch submission entitlement itself is already authorised. The above
questions concern verification exceptions and governance defaults, not whether
ordinary members may participate across branches.

## Phased implementation and rollback

1. **Behaviour-preserving resolution (this slice).** One pure legacy grant
   resolver feeds sessions and database resolution. Add parity and eligibility
   regression tests. No schema changes or production writes. Revert the code
   commit to roll back; no data rollback is needed.
2. **Repeatable preflight.** Add a read-only inventory with schema version,
   application revision and timestamp. Detect unknown roles, duplicate identities,
   ambiguous geography, source ownership, orphan members/branches/roles,
   malformed assignments and conflicting administrative facts. Emit protected
   review records for ambiguities; never infer mappings. Record per-member,
   per-operation effective-access comparisons, not only unioned permission sets.
3. **Participation correction.** Test ordinary members, branch administrators,
   National administrators and custom-role holders submitting National/state/local
   proposals, including unknown/unrecognised destinations. Keep origin immutable,
   reject governance-field injection and force member creations to Propose.
   Ensure author can read/edit the result without destination affiliation.
   Test that creation cannot create membership or grant voting rights. Ship this
   independently after new-record authority defaults are settled.
4. **Capability enforcement and management.** Replace guards operation by
   operation, test every page/API/store route and cross-branch denial. Separate
   account disablement, verification and role delegation explicitly. Ensure the
   common guard does not let an author advance stages or a branch verifier assign
   administrators. Update management UI with success/failure and keyboard/mobile
   verification. Preserve legacy access through a deterministic read adapter
   until migration parity is proven.
5. **Expand migration v1, rehearsal only first.** Snapshot and hash source rows;
   create versioned assignments using stable source-derived IDs with migration
   provenance. Preserve legacy source rows and memberships. Create no ballot,
   vote, revision or decision changes. Conditional writes/checkpoints make retries
   idempotent; concurrent source edits conflict and stop rather than overwrite.
   Quarantine ambiguous rows; migration cannot be marked complete with unresolved
   access-affecting ambiguities. Do not silently skip them.
6. **Rehearse cutover and rollback on a restored database.** Verify backup restore,
   row/hash/reference integrity, all five National administrators, the moderator,
   the branch administrator, ordinary members, live session refresh and revoked
   sessions. Compare effective resource decisions before/after. Preserve all 35
   Decide revision/authority/jurisdiction values and every historical vote.
   Verify failure halfway through migration and rerun. Rollback removes only
   unchanged migration-owned assignments by exact ID/hash and leaves membership
   facts intact; fail closed on post-migration edits. Never replace the whole
   database to roll back authorisation.
7. **Controlled production cutover.** Requires verified migration/rollback
   evidence and explicit high-risk approval. Back up and copy off-host; pause
   administrative assignment writes during the final inventory/migration window.
   Use an explicit authorization model version per deployment, not silent
   fallback on database errors. Refresh permission data on every request; no
   claims cached in existing sessions. Old/new server overlap must use compatible
   readers. Retain source rows throughout the rollback window.
8. **Contract later.** Remove legacy writes and compatibility reads only after
   the rollback window and parity monitoring. Role changes made after cutover
   require reverse projection/review before reverting to the old reader; otherwise
   old legacy grants could resurrect revoked access. Never auto-rollback to a
   legacy reader after new-model revocations. Historical governance data is not
   part of the contract migration.

## Acceptance evidence still required

Cross-branch submission integration/API tests; exact capability success and
failure tests for each mutation; API/page/store parity; migration ambiguity,
concurrency, retry and rollback tests; existing-session revocation tests; restored
production rehearsal; rendered member/management journeys at mobile and desktop;
private/archive and identifiable-ballot isolation. This document does not claim
those later phases are implemented or production-safe merely because phase 1 passes.
