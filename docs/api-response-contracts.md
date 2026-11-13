# Engage API Response Contracts & Data Minimisation

All Engage API endpoints (`src/pages/api/**`) must expose deliberate application interfaces rather than internal MongoDB documents or domain objects.

## Core Conventions

1. **Explicit allowlist DTOs (`src/lib/api-contracts.ts`)**
   - Never return raw MongoDB documents (`findOne`, `find().toArray()`, or objects mutated by `insertOne`).
   - Never rely on `{ _id, ...rest }` object spreading to strip sensitive fields; use explicit allowlist mappers (`toSessionIdentityDto`, `toProposalListItemDto`, `toProposalDetailDto`, `toCommentDto`, `toBallotVoteDto`, `toAmendmentDto`, `toPublicRevisionDto`, `toBranchDto`, `toBranchReferralDto`, `toPublicationEventDto`, `toNotificationDto`, `toMemberAccountDto`).
   - Exclude MongoDB `_id`, internal actor IDs (`authorId`, `memberId` on comments/notifications, `updatedBy`, `referredBy`, `publishedBy`), `idempotencyKey`, and `upvotes` memberId arrays.

2. **Session minimisation (`/api/session`)**
   - Returns only `SessionIdentityDto` (`memberId`, `name`, `role`, `status`, `canParticipate`, `isStaff`, `isAdmin`, `isBranchAdmin`), `membershipStatus`, and `loginAvailable`.
   - Never returns `activity`, `votes`, `permissions` provenance, or branch membership arrays.

3. **Ballot confidentiality**
   - `ballotRecordsForViewer` (`src/lib/ballot-privacy.ts`) and `toBallotVoteDto` enforce strict separation:
     - Anonymous visitors receive `votesList: []`.
     - Ordinary members receive only their own vote record (without `_id`, `memberId`, or `authorName`).
     - Only national administrators (`canViewIdentifiableBallots`) receive identifiable `memberId` and `authorName` fields, still without `_id`.
   - `PATCH /api/comments` returns `{ count, endorsed, hasUpvoted }` and never exposes the `upvotes` array of endorser `memberId`s.

4. **Pagination & bounding**
   - Collection endpoints (`GET /api/proposals`, `GET /api/amendments`, `GET /api/admin/members`, `GET /api/admin/branches/referrals`, `GET /api/notifications/inbox`, `GET /api/v1/*`) bound page sizes via `parsePagination` (or explicit `limit` clamping) and return bounded slices.

5. **Caching & error safety**
   - All authenticated, session, and admin JSON responses use `privateJson(...)` (`cache-control: private, no-store`).
   - Public catalogue `/api/v1/*` endpoints use `publicJson(...)` with ETag and canonical `Link` headers, and only expose explicitly published, non-resolution records.
   - Unexpected internal errors must not leak stack traces or raw database error messages.

## Verification

Security and data-minimisation invariants are verified by `src/lib/api-security-minimisation.test.ts` alongside `src/lib/proposal-access.test.ts`, `src/lib/governance-api.test.ts`, and `src/lib/rbac.test.ts`.
