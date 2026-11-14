# API and authorisation

**Status:** Current · **Verified:** 13 November 2026

## Surface map

All routes are `prerender = false`. There is no `src/middleware.ts`; each route is responsible for authentication and authorisation.

| Group | Routes | Purpose |
|---|---|---|
| Auth | `POST/GET /api/auth/[...all]` | Better Auth catch-all: sign-in, callbacks, passkeys, sessions. Magic-link requests are Turnstile- and rate-limited. |
| Session | `GET/POST/DELETE /api/session` | Session identity; development sign-in |
| Health | `GET /api/health` | MongoDB ping and latency |
| Proposals | `GET/POST /api/proposals`, `GET/PATCH/DELETE /api/proposals/:id`, `GET /api/proposals/:id/revisions` | Matter CRUD and revision history |
| Policies (alias) | `GET/POST /api/policies`, `…/:id` | Compatibility aliases over the proposal handlers |
| Deliberation | `GET/POST/PATCH/PUT/DELETE /api/comments` | Comments, endorsements, contribution feedback |
| Amendments | `POST /api/amendments` | Submit an amendment |
| Votes | `GET/POST /api/votes` | Read and cast formal votes or save pending preferences |
| Sense Box | `POST /api/sense-box` | Public concern submission |
| Legal | `POST /api/legal/acceptance` | Record terms/privacy acceptance |
| Public v1 | `/api/v1/policies`, `/versions`, `/branches`, `/policy-categories`, `/openapi.json` | Read-only published catalogue |
| Member | `GET/POST /api/member/branches` | Following and branch membership self-service |
| Notifications | `/api/notifications/inbox`, `/preferences`, `/push-subscription` | Inbox, preferences, Web Push |
| Email | `/api/email/preferences`, `/unsubscribe`, `/webhook`, `/digest` | Email consent, unsubscribe, delivery events, digest job |
| Cron | `POST /api/cron/membership-verification` | CRM verification cycle |
| Admin: proposals | `/api/admin/amendments/*`, `/api/admin/ballots/*` | Resolve/apply amendments, open/close ballots, bind, record results |
| Admin: policy | `/api/admin/policies/ratify`, `publish`, `withdraw`, `supersede`, `reconcile` | Policy Registry operations |
| Admin: members | `/api/admin/members` | Verification, roles, account state |
| Admin: branches | `/api/admin/branches`, `/memberships`, `/referrals`, `/search` | Branch governance |
| Admin: roles | `/api/admin/roles` | Custom roles and assignments |
| Admin: settings | `/api/admin/settings` | Public configuration |
| Admin: operations | `/api/admin/migrations`, `/api/admin/email/*`, `/api/admin/reports/*` | Migrations, test email, CSV/PDF exports |

## Response conventions

### DTO allowlists

All JSON responses must go through an explicit mapper in `src/lib/api-contracts.ts`. Never spread a MongoDB document and never return `{ _id, ...rest }`.

| Mapper | Used for |
|---|---|
| `toSessionIdentityDto` | Current session |
| `toProposalListItemDto` | Proposal lists |
| `toProposalDetailDto` | Proposal detail |
| `toCommentDto` | Deliberation |
| `toBallotVoteDto` | Votes; adds `memberId`/`authorName` only for the identifiable-ballot boundary |
| `toAmendmentDto` | Amendments |
| `toPublicRevisionDto` | Public revisions |
| `toBranchDto`, `toBranchReferralDto` | Branch surfaces |
| `toPublicationEventDto` | Registry events |
| `toNotificationDto` | Inbox |
| `toMemberAccountDto` | Member management |
| `toRatifiedPolicyDto` | Ratification response |

`privateJson()` sets `cache-control: private, no-store`. `publicJson()` computes an ETag, answers `If-None-Match` with 304, and sets canonical `Link` and cache headers.

### Pagination

`parsePagination` caps `limit` at 100 and rejects a negative offset. Use it for list endpoints; do not accept unbounded queries from the client.

### Errors

Errors are `{ "error": "Human-readable message" }` with 400, 401, 403, 404, 409, 429 or 503. Some domain errors also carry a `code` (branch participation). There is no uniform error envelope and no global error handler.

Messages should tell a person what to do next. Do not leak stack traces, internal IDs or environment details.

### Idempotency

`Idempotency-Key` is required by ratification, publication, withdrawal and supersession. It is capped at 200 characters. The key is compared with prior state to make retries safe. Reconcile is state-filtered rather than keyed.

### CSRF and origin

Three layers exist:

1. Astro `security.checkOrigin: true` for form posts.
2. Explicit `Origin` equality against the resolved public origin in selected handlers (settings, roles, test email, email preferences, member branches, notifications, Sense Box).
3. Better Auth `trustedOrigins` limited to `BETTER_AUTH_URL`.

Coverage is partial. Most JSON APIs rely on `SameSite=Lax` cookies. Do not add a state-changing endpoint without an origin or CSRF check.

The abuse-prone unauthenticated routes (`POST /api/sense-box` and the Better Auth
email routes) also require Cloudflare Turnstile and a shared rate-limit slot. See
[security/turnstile.md](../security/turnstile.md).

### Rate limiting

There is no general API limiter. Rate limiting is scoped to abuse-prone
unauthenticated actions:

- Better Auth limits authentication in its own database-backed limiter (magic
  link 5 per 60 s).
- `src/lib/rate-limit.ts` adds a shared MongoDB fixed-window limiter:
  `sense-box-submit` 10 per 10 minutes and `auth-magic-link` 10 per 10 minutes
  per client address, plus `auth-sign-up` 5 per hour if email sign-up is enabled.
  It stores a keyed hash of the address with a TTL index, never the raw address.
- `src/lib/turnstile-guard.ts` combines that limiter with mandatory Cloudflare
  Turnstile verification on the same routes. See
  [security/turnstile.md](../security/turnstile.md).

Authenticated actions, including voting, endorsing, commenting and
administrative writes, are neither challenged nor limited by this gate. Do not
describe the platform as rate limited in general.

## Authentication

`getSessionUser(request, env)` returns a `SessionUser` with:

```ts
{
  memberId, name, email, role, roles[],
  status, canParticipate, isStaff, isAdmin,
  branchAdminIds?, isBranchAdmin?,
  activeBranchIds?, followedBranchIds?, verifiedBranchIds?,
  permissions?: EffectivePermissionsSnapshot
}
```

Session resolution:

1. Better Auth session, unless the account is disabled.
2. Development cookie, only when `APP_MODE` is `development`, `test` or `preview`.
3. `null`.

`canParticipate` is exactly `status === "verified"`. `isStaff` means moderator or administrator. `isAdmin` means national administrator. None of these implies ballot eligibility.

## Authorisation helpers

| Helper | Use |
|---|---|
| `requireApiPermission(user, key, { branchId })` | Returns a 401/403 `Response` or `null` |
| `hasPermission(user, key, branchId)` | Boolean; national grant satisfies branch check |
| `branchesWithPermission(user, key)` | Enumerates national or branch scope |
| `canAdministerBranch(user, branchId)` | Branch membership administration |
| `canManageBranchProposal(user, proposal)` | Proposal/amendment workflow at origin |
| `canManageBranchBallot(user, proposal)` | Requires matching authority **and** jurisdiction |
| `canViewIdentifiableBallots(user)` | National admin or `ballots.view_identifiable` |
| `canGrantPermissionSet(user, keys, branchId)` | Anti-escalation when creating roles |

Service functions must re-check consequential actions. A route-level check is not sufficient if another caller can invoke the service.

## Permission catalogue

The catalogue has 24 keys at national or branch scope.

| Group | Keys |
|---|---|
| Proposals & deliberation | `proposals.view_archived`, `proposals.edit`, `proposals.manage_supersession`, `proposals.delete`, `comments.moderate`, `contributions.respond` |
| Amendments & ballots | `amendments.resolve`, `amendments.apply`, `amendments.manage_ballot`, `ballots.bind`, `ballots.record_result`, `ballots.view_identifiable` |
| Policy Registry | `policies.ratify`, `policies.publish` |
| Members & branches | `members.view`, `members.verify`, `branches.manage`, `branches.verify_members`, `branches.refer_proposals` |
| Reporting & platform | `sense_box.review`, `reports.export`, `engagement.manage`, `settings.manage`, `roles.manage` |

National-only keys: `proposals.delete`, `comments.moderate`, `ballots.view_identifiable`, `policies.ratify`, `policies.publish`, `members.view`, `members.verify`, `branches.manage`, `branches.refer_proposals`, `engagement.manage`, `settings.manage`, `roles.manage`.

System role bundles:

| Role | Scope | Permissions |
|---|---|---|
| National Administrator | National | All 24 |
| Moderator | National | archived view, proposal edit, supersession, comment moderation, contribution response, reports |
| Branch Administrator | Branch | proposal edit/view, supersession, contribution response, amendment resolve/apply/ballot, ballot bind/result, branch verification, Sense Box, reports |

## Enforcement matrix for governance acts

| Endpoint | Permission | Additional gate |
|---|---|---|
| `PATCH /api/proposals/:id` (stage/content) | None via catalogue; `isStaff` or origin branch admin | Stage table; author only in Propose; authority/jurisdiction match for branch actor entering Decide; successful result for Decide → Implement |
| `POST /api/amendments` | Participation | Verified member or staff; matter in Propose/Deliberate |
| `POST /api/admin/amendments/resolve` | `amendments.resolve` is declared but **not checked** | `isAdmin` or `isBranchAdmin` + `canManageBranchProposal` |
| `POST /api/admin/amendments/apply` | `amendments.apply` is declared but **not checked** | Same |
| `POST /api/admin/amendments/open-ballot` | `amendments.manage_ballot` | Matching authority/jurisdiction, matter in Decide, base revision match |
| `POST /api/admin/amendments/close-ballot` | `amendments.manage_ballot` | Officer-supplied result |
| `POST /api/admin/amendments/accept` | `amendments.manage_ballot` | Amendment `endorsed`, revisions match |
| `POST /api/admin/ballots/bind` | `ballots.bind` | Matter in Decide, matching authority/jurisdiction |
| `POST /api/admin/ballots/result` | `ballots.record_result` | Matter in Decide, bound revision, matching authority/jurisdiction |
| `POST /api/admin/policies/ratify` | `policies.ratify` | Implement stage, successful exact revision, matching decision event, non-resolution, idempotency |
| `POST /api/admin/policies/publish` | `policies.publish` | Adopted + ratification event, non-resolution, idempotency |
| `POST /api/admin/policies/withdraw` | `policies.publish` | Published, reason, idempotency |
| `POST /api/admin/policies/supersede` | `policies.publish` | Published source, adopted successor, no cycle |
| Identifiable vote reads | `ballots.view_identifiable` | National scope |

## Public API v1

The public API is read-only and serves **published policy only**.

| Endpoint | Returns |
|---|---|
| `GET /api/v1/policies` | Cursor-paginated published policy summaries |
| `GET /api/v1/policies/:id` | One published policy |
| `GET /api/v1/policies/:id/versions` | Published revision list |
| `GET /api/v1/policies/:id/versions/:version` | One published revision (immutable cache) |
| `GET /api/v1/branches` | Recognised branch catalogue |
| `GET /api/v1/branches/:id/policies` | Published policy for a branch |
| `GET /api/v1/policy-categories` | Categories derived from the registry |
| `GET /api/v1/openapi.json` | OpenAPI 3.1 description |

Conventions:

- ETag and `If-None-Match` → 304.
- Canonical `Link` header.
- `stale-while-revalidate=300` for catalogue reads; immutable caching for revisions.
- No authentication, no rate limiting, no v2 and no deprecation policy.
- Resolutions are excluded from the policy catalogue.

A consumer must not infer that a 404 means a policy never existed; it may be unpublished or withdrawn.

## Known authorisation inconsistencies

These are current defects, not intended design:

- `proposals.edit`, `proposals.delete`, `comments.moderate`, `proposals.view_archived`, `proposals.manage_supersession`, `amendments.resolve`, `amendments.apply`, `branches.manage` and `sense_box.review` are declared but several routes still use `isAdmin`/`isStaff`/`isBranchAdmin`.
- A custom-role holder with `proposals.edit` may still be unable to edit because `saveProposal` gates on staff/branch-administrator status.
- Stage transitions do not check the declared `requiredPermission`.
- A moderator can open or reopen the Decide stage even though they cannot bind or record a result.
- `POST /api/admin/policies/ratify` does not verify that the ratifying authority matches the ballot result's authority.

Fix these by consolidating on the catalogue and service-level checks, with tests. Do not add a new legacy flag.

## Adding an endpoint

1. Decide the audience: public, member, admin, cron or integration.
2. Write the route under the correct `src/pages/api/...` group with `export const prerender = false`.
3. Resolve the session with `getSessionUser`.
4. Authorise with `requireApiPermission` or a specific helper; re-check in the service.
5. Validate the body explicitly. Do not trust client-supplied IDs, roles or scope.
6. Call a domain service. Do not put governance rules in the route.
7. If the route is an unauthenticated action that sends email, spends money or
   publishes content, add it to `src/lib/turnstile-guard.ts` and
   `RATE_LIMITS`; see [security/turnstile.md](../security/turnstile.md).
8. Return an allowlist DTO through `privateJson` or `publicJson`.
9. Map domain errors to a human-readable status.
10. Add a test for the unauthorised, invalid, failure and success paths.
11. Update this page and the capability matrix if behaviour changed.
