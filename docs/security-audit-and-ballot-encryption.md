# Engage — Application Security Audit, Threat Model & Encrypted Ballot Architecture

## 1. Threat Model & Trust Boundaries

Engage operates across five primary trust boundaries:

1. **Public / Anonymous Web Boundary**: Unauthenticated visitors accessing SSR pages, public policy/proposal read endpoints (`/api/proposals`, `/api/v1/*`), and Sense Box submission (`/api/sense-box`).
2. **Authenticated Member Boundary**: Verified and pending members via Better Auth (Google OAuth, Magic Link, Passkeys) or explicit development-mode sign-in (`APP_MODE` ∈ `development | test | preview`).
3. **Delegated Branch & Custom RBAC Boundary**: Branch administrators and custom-role holders scoped to specific branches (`branches`, `rbac_roles`, `rbac_assignments`).
4. **National Governance & Platform Administration Boundary**: National administrators, moderators, and returning officers (`policies.ratify`, `policies.publish`, `roles.manage`, `members.verify`, `ballots.view_identifiable`).
5. **Infrastructure & Storage Boundary**: Coolify-managed Node.js container (`node:24-alpine`, non-root `node` user, `cap_drop: ALL`, loopback port `127.0.0.1:4321`), Cloudflare Tunnel, MongoDB 7 replica set (`engage_mongo_data`), Resend email API/webhooks, and Web Push VAPID keys.

---

## 2. Confirmed Findings & Remediation Evidence

| Severity | Finding | Remediation | Verification |
|---|---|---|---|
| **High (P0)** | `canManageBranchBallot` allowed any `isStaff` (including `moderator`) to pass branch-ballot checks; a hybrid moderator + Branch A admin could manage Branch B amendment ballots. | Removed `user.isStaff` override from `canManageBranchBallot` in `src/lib/auth.ts`; enforced explicit `amendments.manage_ballot` / `ballots.record_result` permissions in `open-ballot.ts`, `close-ballot.ts`, `accept.ts`, and `result.ts`. | `security-audit-regression.test.ts` |
| **High (P0)** | `PATCH /api/admin/members` checked `user.isAdmin` only and constructed `new ObjectId(memberId)` without validation, leaking `BSONError` messages and bypassing granular `members.verify` / `roles.manage` separation. | Enforced `requireApiPermission(user, "members.verify")`, required `roles.manage` for `body.role` changes, validated `ObjectId.isValid(memberId)`, and switched responses to `privateJson`. | `security-audit-regression.test.ts` |
| **High (P0)** | `PATCH/POST /api/admin/settings` trusted client-supplied `x-forwarded-origin` header for CSRF origin validation. | Removed `x-forwarded-origin` trust; validated against `resolvePublicOrigin({ env, requestUrl: request.url })`. | `security-audit-regression.test.ts` |
| **Medium (P0)** | Branch membership and report endpoints (`branches/memberships.ts`, `branches/search.ts`, `reports/proposal-pdf.ts`, `reports/proposals.csv.ts`) checked generic `isBranchAdmin` rather than specific `branches.verify_members` / `reports.export` permissions. | Migrated to `branchesWithPermission(...)` and `hasPermission(...)` checks. | `security-audit-regression.test.ts` |
| **Medium (P0)** | `renderPortableText` allowed protocol-relative markdown links (`[text](//evil.example)`). | Restricted relative markdown links to single-slash paths (`/(?!\/)`). | `security-audit-regression.test.ts` |
| **Medium (P1)** | Better Auth rate limiter lacked `cf-connecting-ip` / `x-real-ip` header configuration behind Cloudflare Tunnel, collapsing all users into one shared rate-limit bucket. | Configured `advanced.ipAddress.ipAddressHeaders: ["cf-connecting-ip", "x-real-ip"]` in `src/lib/auth.ts`. | `auth.test.ts` |
| **Medium (P1)** | Manual `origin !== url.origin` checks in `admin/roles/index.ts` and `notifications/push-subscription.ts` could reject valid requests behind an internal HTTP reverse proxy. | Switched to `resolvePublicOrigin({ env, requestUrl: url })`. | Type-check + code review |

### API Hardening (`9c27e4b`) Verification

Independently verified `src/lib/api-contracts.ts` and route callers:
- `/api/session` returns only `SessionIdentityDto` (`memberId`, `name`, `role`, `status`, `canParticipate`, `isStaff`, `isAdmin`, `isBranchAdmin`) with `Cache-Control: private, no-store`.
- Comments, proposals, amendments, revisions, branches, referrals, publication events, notifications, and member directory entries use explicit allowlist DTOs stripping `_id` and internal actor IDs.
- Pagination is bounded via `parsePagination`.

---

## 3. Ballot Integrity & Confidentiality Assessment

### Who Can Associate a Member With Their Vote?

1. **Before Encryption (`BALLOT_ENCRYPTION_MODE=off`, legacy plaintext)**:
   - MongoDB operators, backup holders, and anyone with DB read access can read `memberId`, `authorName`, `choice`, and `reason` in `proposal_votes`.
   - National administrators (`user.isAdmin` or `ballots.view_identifiable`) can view `memberId` and `authorName` via `canViewIdentifiableBallots` on `/admin/` and `GET /api/proposals/[proposalId]`.
2. **With Encrypted Ballot Storage (`BALLOT_ENCRYPTION_MODE=encrypt`)**:
   - `proposal_votes` documents **omit** plaintext `memberId`, `authorName`, `choice`, and `reason`.
   - Each document stores `voterBlindIndex` (HMAC-SHA-256) and `voteEnvelope` (AES-256-GCM ciphertext).

### Assessment of `ballots.view_identifiable`

Currently, `ALL_NATIONAL_PERMISSIONS` includes `ballots.view_identifiable`, and `canViewIdentifiableBallots(user)` returns `true` for any `user.isAdmin`. Routine national administrators do not need individual ballot choices for day-to-day operations. **Recommendation**: Separate Returning Officer / Audit authority (`ballots.view_identifiable`) from routine `administrator` in a future governance-approved RBAC change, and audit every identifiable access event.

### What Encryption Protects vs. What It Cannot Prevent

| Threat Scenario | Protected? | Technical Guarantee / Residual Risk |
|---|---|---|
| 1. Stolen database snapshot | **Yes** | `choice`, `reason`, `memberId`, `authorName` are absent in plaintext; `voterBlindIndex` is keyed HMAC-SHA-256 per `(ballotId, memberId)`. |
| 2. Unauthorised MongoDB operator | **Yes** | Same as snapshot; additionally, AAD prevents cross-ballot, cross-revision, or cross-voter ciphertext substitution. |
| 3. Backup disclosure | **Yes** | Keys are stored in runtime environment/secrets manager, never in MongoDB. |
| 4. App credentials compromised (DB + app env) | **No** | An attacker with both `MONGODB_URI` and `BALLOT_*` keys can decrypt `voteEnvelope` and test candidate `memberId`s against `voterBlindIndex`. |
| 5. Encryption key compromised alone (without blind-index key) | **Partial** | Attacker can decrypt `{ choice, reason }` but cannot link votes to `memberId` unless `reason` free-text self-identifies the voter. |
| 6. Privileged admin abusing legitimate UI | **Partial** | With encrypted storage, `proposal_votes` has no `memberId`/`authorName`; however, small-electorate inference and timing correlation remain possible. |

**Explicit Non-Claims**: Engage's encrypted ballot storage is **not** end-to-end encrypted (the server decrypts to tally) and **not** cryptographically anonymous (metadata such as `updatedAt`, electorate size, and small-branch participation can still enable statistical/timing inference).

---

## 4. Encrypted Ballot Storage & Key Management Runbook

### Cryptographic Design (`src/lib/ballot-crypto.ts`)

- **Cipher**: AES-256-GCM (`96-bit` random IV per write, `128-bit` auth tag).
- **AAD Binding**: `v1\0<kid>\0<ballotId>\0<proposalId>\0<revisionId>\0<amendmentRevisionId>\0<voterBlindIndex>`.
- **Blind Index**: `HMAC-SHA-256(blindIndexKey, "engage-vote-blind-index-v1\0" + ballotId + "\0" + memberId)`.
- **Key Separation**: `loadBallotCryptoConfig` enforces distinct 256-bit keys for encryption vs. blind indexing.
- **Uniqueness**: Partial unique indexes on `{ ballotId: 1, memberId: 1 }` (legacy) and `{ ballotId: 1, voterBlindIndex: 1 }` (encrypted).

### Key Generation & Storage

Generate two independent 256-bit hex keys:
```sh
node -e "const c=require('crypto'); console.log('ENC:', c.randomBytes(32).toString('hex')); console.log('BI:', c.randomBytes(32).toString('hex'));"
```
Store in Coolify / secrets manager (never in Git or MongoDB):
- `BALLOT_ENCRYPTION_KEYS=v1:<64-hex>`
- `BALLOT_ENCRYPTION_ACTIVE_KEY_ID=v1`
- `BALLOT_BLIND_INDEX_KEY=bi-v1:<64-hex>`
- `BALLOT_BLIND_INDEX_ACTIVE_KEY_ID=bi-v1`
- `BALLOT_ENCRYPTION_MODE=off` (keep `off` until migration dry-run & key recovery are verified)

### Migration & Key Rotation (`scripts/migrate-encrypted-votes.ts`)

1. **Take a verified MongoDB backup** before any write migration.
2. **Dry-run inventory & tally baseline**:
   ```sh
   npm run ballots:encrypt-migrate
   ```
   Verify `errors: []`, `totalCount`, and per-ballot `tallies`.
3. **Apply migration** (idempotent, restartable, checks concurrent updates):
   ```sh
   npm run ballots:encrypt-migrate -- --apply
   ```
   Verify `after.plaintextCount === 0` and `before.tallies === after.tallies`.
4. **Activate encryption** in Coolify: set `BALLOT_ENCRYPTION_MODE=encrypt` and redeploy.
5. **Key rotation**: Add `v2:<new-hex>` to `BALLOT_ENCRYPTION_KEYS=v2:<new>,v1:<old>`, set `BALLOT_ENCRYPTION_ACTIVE_KEY_ID=v2`, and run:
   ```sh
   npm run ballots:encrypt-migrate -- --apply --rotate
   ```
   Keep `v1` in `BALLOT_ENCRYPTION_KEYS` until all records are confirmed on `v2`.
6. **Rollback / Recovery**: Restore from the pre-migration MongoDB backup (encrypted alongside key backup in offline/secret storage) if keys are lost; never discard old backups until retention policy permits.
