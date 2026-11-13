# Engage — Extensibility & Architecture Hardening

This document describes the extensible governance foundations implemented in Engage.

## 1. Governance Matter Model (`src/lib/matters.ts`)

Matters are registered in `MatterRegistry` (`DEFAULT_MATTER_REGISTRY` supports `"policy"` and `"resolution"`).
Each matter type declares:

- **Capabilities** (`supportsDeliberation`, `supportsAmendments`, `supportsBallots`, `supportsRatification`, `supportsPolicyPublication`, `supportsSupersession`, `allowedStages`, `compatibleSupersessionTargets`).
- **Type-aware lifecycle transitions** (`transitions`), each declaring `from`, `to`, `requiredPermission`, and `authorityKind` (`"workflow"` vs `"governance"`).
- **Runtime validation**: `normalizeMatterType` maps legacy `"governance"` / `"GOV-*"` and `"proposal"` conventions while rejecting unknown non-empty matter types (`MatterValidationError`, HTTP 400) so invalid types cannot enter policy workflows.
- **Extensibility**: Future matter types (e.g., consultations, constitutional amendments, petitions) are added by registering a `MatterTypeDefinition` without modifying central dispatch logic.

## 2. Decoupled Ballots & Formal Decisions (`src/lib/ballots.ts`)

- Ballots are represented by `BallotRecord` in the `ballots` collection, keyed by `ballotId` with `matterId`, `purpose`, immutable `revisionId`, `electorate` (`scope`, `branchId`), `status`, and `closesAt`.
- Supports a 1-to-many `matterId -> ballots` relationship while remaining 100% compatible with legacy `proposals.ballotRevisionId` and `proposal_votes` (`{ ballotId, memberId }` unique index).
- `FormalDecisionRecord` (`ballot_results`) records immutable outcomes (`successful`, `unsuccessful`, `inconclusive`) tied to `ballotId`, `revisionId`, and `decisionEventId`.

## 3. Governance Provenance & Relationships (`src/lib/governance-relationships.ts`)

- Explicit typed relationships (`supersedes`, `amends`, `implements`, `derives_from`) are validated for target existence, matter type compatibility, and circular supersession (`detectCircularSupersession`).
- Append-only audit events are recorded in `governance_events` preserving actor, authority branch, revision, decision event, timestamp, and reason.

## 4. Authorisation Boundaries (`src/lib/rbac.ts`, `src/lib/roles-store.ts`)

- Protected admin API routes enforce `hasPermission(user, permission, branchId)` / `requireApiPermission`.
- Constitutional governance checks (`canManageBranchBallot`, `canParticipate`) remain independent of configurable administrative roles.

## 5. Integration, Read Models & Operational Resilience

- **Integrations** (`src/lib/integrations.ts`): `MembershipAuthorityAdapter` (`StandaloneMembershipAuthority` default) decouples voting from synchronous external CRM availability.
- **Read models** (`src/lib/read-models.ts`): `buildAuthorizedMatterBriefing` provides permission-scoped, confidentiality-safe access to bound wording and decisions for reporting, PDFs, and future AI briefings.
- **Resilience** (`src/lib/resilience.ts`, `src/pages/api/health.ts`): bounded pagination (`parsePaginationParams`), redacted structured operational logging (`logOperationalEvent`), MongoDB indexes in `src/lib/db.ts`, and structured `/api/health` checks.

## 6. Open Ballot Expiry Migration (`src/lib/ballot-expiry-migration.ts`)

- Assigns `2027-01-14T13:00:00.000Z` (Thursday, 14 January 2027 at 11:59 pm AEDT, Australia/Melbourne) to open formal ballots (`proposals` in `decide` and `amendments` in `voting`) without an existing closing deadline.
- Preserves existing configured deadlines, excludes closed/archived/inactive ballots, flags malformed records as conflicts, and uses atomic conditional updates so concurrent edits are never overwritten.
- Available via `/admin/migrations/` and `npm run ballots:schedule` (dry-run by default; `--apply` to execute).
