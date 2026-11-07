# Engage governance and policy API

Engage remains an Astro application backed by MongoDB. The existing proposal CRUD API remains the authoring interface. New revision, branch, ballot result, policy registry and publication documents extend that data model; they do not replace it.

## Public API

OpenAPI 3.1 is served at `/api/v1/openapi.json`. Public reads are:

- `GET /api/v1/policies` with optional `branch`, `jurisdiction`, `limit` (maximum 100), and `cursor` filters.
- `GET /api/v1/policies/:id`
- `GET /api/v1/policies/:id/versions` and `/:version`
- `GET /api/v1/branches` (recognised branches only) and `/api/v1/branches/:id/policies`
- `GET /api/v1/policy-categories`

Policy reads include only registry entries explicitly marked `publicationStatus: published`. Successful GET responses include ETags, a canonical `Link` header, and public caching; immutable revision responses use long-lived immutable caching. List responses use keyset cursors. Internal proposal reads remain under `/api/proposals` and are not authoritative policy reads.

## Governance operations

Proposal edits append immutable content snapshots to `proposal_revisions`, linked by `parentRevisionId` and identified by a SHA-256 content hash. Opening the Decide stage binds the proposal to the exact revision being voted on; each vote stores that revision ID. Proposal text is locked after voting begins.

Legacy ballots with a single consistent revision are backfilled to that reference. Ambiguous legacy ballots remain available for review and are not assigned a guessed revision. Proposal pages expose saved revision diffs and let verified members submit amendments against an exact revision. Amendment wording is stored in immutable `amendment_revisions` documents with parent, author, timestamp, snapshot and SHA-256 hash; the amendment record points to its current revision. Separate amendment ballots bind both the frozen proposal revision and amendment wording revision. Endorsement, formal approval and policy ratification are distinct; ratification records the exact formally approved amendment revision in its composite policy wording. Proposal text is never silently changed.

For an ambiguous legacy ballot, an administrator must use the review control in Proposals & Decisions and submit an explicit revision, decision event reference and evidence-based reason. The operation binds previously unversioned current votes to the selected revision and appends a `ballot_binding_events` audit record; it never reassigns votes that already identify conflicting wording. Voting remains blocked while the recorded votes and frozen revision do not agree.

Identifiable ballot records are returned only to national administrators. `GET /api/proposals/:id` redacts every other member's choice, reason, member ID and display name; anonymous reads expose only aggregate tallies. Moderators are generic staff and do not receive identifiable ballots. The governance commitment to an Election Officer role is not yet modelled in application roles, so administrators are the conservative authorised boundary until that role is explicitly defined.

An administrator records a ballot result with `POST /api/admin/ballots/result`, providing `proposalId`, `result` (`successful`, `unsuccessful`, or `inconclusive`) and an externally meaningful `decisionEventId`. The result is immutable and bound to the ballot revision. This records the administrator's determination; Engage currently does not calculate or define a passing threshold. Administrators must apply the organisation's authorised rules when recording it.

`POST /api/admin/policies/ratify` requires a successful result for the exact revision and an authority branch and decision event reference. Formally accepted amendments must be supplied explicitly; when present, ratification creates an immutable composite policy revision linked to the frozen ballot revision and lists the adopted amendments. Proposal text is never silently changed. `POST /api/admin/policies/publish` creates a MongoDB publication event and marks that registry revision published. Send an `Idempotency-Key` header to make a retry refer to the same publication event. Withdrawal, supersession and reconciliation are admin operations backed by publication events.

Existing imported proposals and provenance are not automatically considered adopted or published. Branch records and parent-child relationships are data-driven. Administrators can assign and revoke explicit branch memberships, and branch-scoped ballots require active membership in that exact branch; membership does not inherit from a parent. Branch-scoped proposals carry separate originating branch, authority, jurisdiction and publication-scope fields. Admin APIs manage branches and referrals. These controls do not define which authority or membership rules the organisation should adopt.

The public `/policies/` registry and policy detail pages include published policies, plus withdrawn or superseded status records that were previously public. They show exact approved wording only while a policy remains published; historical pages identify the status and successor without presenting retired text as current policy. Policy API v1 reads current published entries only.

Administration is grouped into Overview, Proposals & Decisions, Members & Access, Branches, and Policy Registry. The overview lists outstanding ballot, amendment, ratification, publication and membership actions. Its last-seven-days participation summary separates votes, deliberation contributions and first-time participants; adjacent votes by the same member are grouped into one time-bounded entry. Identifiable vote participation is shown only to national administrators; non-administrator staff keep deliberation and proposal activity. Proposal, member and branch work is handled in searchable/filterable sections. Existing global roles remain authoritative, with explicit branch-level delegation for scoped membership, proposal and ballot administration as described below.

Branch membership changes update the current membership row and append an audit event recording the actor, action, branch and member. Repeating an assignment for an already active membership is idempotent and does not create a duplicate assignment event. A national administrator can explicitly assign a verified branch member the branch administrator role on that membership. This operational permission is branch-scoped: it enables branch membership management and proposal/amendment workflow actions, but cannot create branches, change a proposal's authority or jurisdiction, ratify/publish policy, or manage another branch. Ballot opening and outcome recording require the proposal's governance authority and jurisdiction to both explicitly match the assigned branch.

Branch creation and edits append branch audit events with before/after snapshots. National administrators can change recognition or parent relationships, and the endpoint rejects self-ancestry and cyclic hierarchies. Membership role changes are also included in the branch membership audit trail.

## Governance decisions still required

The organisation must determine what rules define ballot success, which authorities may ratify each jurisdiction, which memberships qualify for each ballot, and what notice or effective-date rules apply. Engage requires an explicitly delegated branch administrator to record outcomes only for ballots whose governance authority and jurisdiction match their assigned branch. Formal policy ratification remains restricted to national administrators until branch ratification authority is explicitly decided and configured. Engage does not infer constitutional thresholds or cross-branch eligibility.
