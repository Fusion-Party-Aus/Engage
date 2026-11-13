# Data and persistence

**Status:** Current · **Verified:** 13 November 2026

## Connection model

`src/lib/db.ts` owns MongoDB access.

- `getDatabase(env)` requires `MONGODB_URI`; `MONGODB_DB_NAME` defaults to `engage`.
- Production without a URI throws. It does not fall back silently.
- In development or test, a missing or unreachable database uses a process-wide in-memory database so pages and most tests run without infrastructure.
- A 60-second circuit breaker prevents repeated failed connection attempts in development.
- The client pool is 10; connect/selection timeouts are 3 s in production and 400 ms in development.
- `initializeDatabase()` is idempotent. It runs on each new `Db` object and creates indexes, backfills legacy revisions and seeds baseline proposals.

**Important limitation.** `createMemoryDb()` implements only a subset of the driver: basic filters, sort, limit, `findOne`, `insertOne`, `updateOne` with `$set`/`$setOnInsert`/`$unset`, and delete. `project()` is a no-op, `createIndex()` is a no-op, and there are no sessions or transactions. A test that depends on projection, uniqueness or atomicity is meaningful only against real MongoDB.

## Collections

### Governance content

| Collection | Purpose |
|---|---|
| `proposals` | Matters: wording, stage, type, scope, authority, ballot binding |
| `proposal_revisions` | Immutable wording snapshots with hashes and parent chain |
| `comments` | Deliberation contributions, stances, endorsements, feedback |
| `amendments` | Amendment records and their lifecycle state |
| `amendment_revisions` | Immutable amendment wording snapshots |
| `proposal_votes` | Current vote per member per ballot, plaintext or encrypted |
| `ballots` | Ballot projection: purpose, electorate, revision, status, close time |
| `ballot_results` | Immutable formal decision records |
| `ballot_binding_events` | Audit of ballot-to-revision binding |
| `ballot_schedule_events` | Audit of deadline/scheduling changes |
| `governance_events` | Append-only governance audit events |
| `governance_relationships` | Provenance/supersession/related-matter links |
| `policy_registry` | Ratified and published policy records |
| `publication_events` | Publish, withdraw and supersede events |
| `pending_vote_preferences` | Votes saved by unverified members |
| `votes` | Legacy vote collection, retained for migration/history |

### Identity and membership

| Collection | Purpose |
|---|---|
| `user`, `session`, `account` | Better Auth documents; `user._id` is `memberId` |
| `memberships` | Platform membership status and verification provenance |
| `application_roles` | Legacy platform roles (`administrator`, `moderator`) |
| `members` | Legacy member records retained for compatibility |
| `branches` | National, state, territory and constituent branches |
| `branch_memberships` | Organisational branch membership facts |
| `branch_subscriptions` | Following preferences |
| `branch_membership_events` | Membership audit trail |
| `branch_subscription_events` | Following audit trail |
| `branch_events` | Branch lifecycle audit |
| `branch_referrals` | Proposal referrals between branches |
| `rbac_roles` | System and custom role definitions |
| `rbac_assignments` | Member-to-role assignments with scope |
| `rbac_audit_log` | Role create/update/delete/assign/revoke events |
| `legal_acceptances` | Terms/privacy acceptance per member and document hash |
| `crm_identity_links` | Durable member-to-CRM-UUID links |
| `membership_verification_attempts` | CRM verification queue and results |
| `membership_verification_reviews` | Ambiguity/conflict review items |
| `membership_verification_events` | Verification audit |

### Engagement and operations

| Collection | Purpose |
|---|---|
| `engagement_lifecycle_events` | Member lifecycle events |
| `engagement_email_preferences` | Email topic consent |
| `engagement_email_outbox` | Outbound email records |
| `engagement_email_events` | Delivery, bounce, complaint events |
| `engagement_email_rollouts` | Digest cohort assignment |
| `engagement_notification_events` | Notification preference/activity events |
| `engagement_reengagement_campaigns` | Approval-gated re-engagement batches |
| `push_subscriptions` | Web Push endpoints and keys |
| `member_notifications` | In-app inbox items |
| `notification_deliveries` | Dedupe and delivery state |
| `sense_submissions` | Public Sense Box concerns |
| `sense_limits` | TTL-based submission rate limits |
| `site_settings`, `site_settings_events` | Public configuration and its audit |
| `operational_audit` | Operational actions |
| `data_migrations`, `schema_migrations` | Migration state and one-off markers |

## Key document shapes

### Proposal

```ts
{
  proposalId: "PROP-…" | "GOV-…",
  slug, title, summary, outcomes[], details,
  stage: "propose" | "deliberate" | "decide" | "implement" | "archived",
  kind: "policy" | "resolution",
  originatingBranchId?, governanceAuthorityBranchId?, jurisdictionBranchId?,
  scope?, publicationScope?: "private" | "branch" | "national",
  ballotRevisionId?, ballotClosesAt?,
  attachmentUrl?, attachmentDescription?, provenance?,
  authorId?, authorName?, createdAt, updatedAt,
  implementationNote?, supersededByProposalId?, supersededByNote?
}
```

The `proposals` collection also accepts legacy aliases (`policyId`, `category`, `statement`, `status`, `division`). Normalisation happens at read time. New code should use the canonical fields.

### Revision

```ts
{
  revisionId, proposalId, parentRevisionId: string | null,
  authorId, createdAt,
  snapshot: { title, summary, outcomes[], details },
  contentHash,                  // SHA-256 of JSON.stringify(snapshot)
  provenance?,
  revisionType?: "ratified-policy",
  adoptedAmendmentIds?: string[]
}
```

Only the four snapshot fields are hashed. Attachment, kind, space and provenance changes do not create a revision. A new revision is appended only when the hash changes.

### Vote

```ts
{
  ballotId: "proposal:<id>" | "amendment:<id>",
  proposalId, revisionId?, amendmentId?, amendmentRevisionId?,
  memberId?, authorName?,     // absent when encrypted
  choice: "approve" | "abstain" | "reject",
  reason?, updatedAt,
  voterBlindIndex?,           // encrypted mode
  voteEnvelope?               // encrypted mode
}
```

Legacy `do-not-approve` is normalised to `reject`. Votes are upserted while the ballot is open.

### Ballot result

```ts
{
  ballotId, proposalId, revisionId,
  result: "successful" | "unsuccessful" | "inconclusive",
  decisionEventId, authorityBranchId?, recordedBy, recordedAt
}
```

One immutable record per ballot. It is not derived from the tally.

### Policy registry record

```ts
{
  policyId, status: "adopted",
  publicationStatus: "unpublished" | "published" | "withdrawn" | "superseded",
  revisionIds[], ratification: { decisionEventId, authorityBranchId, ratifiedBy, ratifiedAt, … },
  adoptedAmendmentIds?, effectiveAt?,
  publishedAt?, withdrawnAt?, supersededBy?, supersessionNote?,
  idempotencyKey
}
```

Only `publicationStatus: "published"` is authoritative public policy.

### Branch membership

```ts
{
  branchId, memberId, status: "active" | "revoked",
  branchRole?: "member" | "administrator",
  source: "engage-local" | "engage-legacy" | "underground-crm",
  verifiedBy?, verifiedAt?, revokedBy?, revokedAt?, revocationReason?,
  externalMemberId?, version?, verification?
}
```

External-source records cannot be edited or revoked locally.

## Indexes and uniqueness

`initializeDatabase()` creates roughly forty indexes in two batches. The important uniqueness constraints are:

- one proposal per `proposalId` and per `slug`;
- one revision per `(proposalId, revisionId)`;
- one current proposal vote per `(ballotId, memberId)` via a **partial** unique index where `memberId` is a string;
- one encrypted vote per `(ballotId, voterBlindIndex)` via a partial unique index;
- one branch subscription per `(memberId, branchId)`;
- one CRM identity link per member/application;
- one notification delivery per dedupe ID;
- unique role assignments and RBAC role IDs where applicable;
- TTL index for Sense Box rate limits.

A known gap: there is no unique `(branchId, memberId)` index on `branch_memberships`; correctness relies on application upserts.

Index creation is idempotent but is not a migration system. Changing an index requires an explicit migration or a startup upgrade path, as `ensureProposalVoteIndex` does for the legacy vote index.

## Transactions

Transactions are used for proposal writes and the associated revision (`saveProposal`). Most other writes are single-document updates or conditional updates. There is no global transaction wrapper.

`recordFormalDecision` is guarded by a unique/conditional insert so a ballot cannot be certified twice. `bindBallotToRevision` uses conditional updates and refuses conflicting state.

## Vote encryption

`BALLOT_ENCRYPTION_MODE=encrypt` enables AES-256-GCM envelopes with a keyring and a blind index derived from a separate key. In encrypted mode:

- `choice` and `reason` are encrypted;
- plaintext `memberId` and `authorName` are removed from the vote document;
- the voter blind index supports uniqueness without revealing identity;
- tallying requires the server keyring.

Default is `off`. A default deployment stores votes in plaintext. The threat model and key rotation procedure are in [security-audit-and-ballot-encryption.md](../security-audit-and-ballot-encryption.md). Migration tooling: `scripts/migrate-encrypted-votes.ts` and `scripts/migrate-proposal-votes.mjs`.

Identifiable ballot access is a separate control from encryption. Even in plaintext mode, API DTOs strip member identity unless the caller holds the national identifiable-ballot boundary.

## Seeding

`initializeDatabase()` seeds `src/data/policies.json` with `$setOnInsert` only. The file contains 78 records: 76 policy proposals and 2 governance resolutions (`GOV-001`, `GOV-002`).

Consequences:

- A fresh deployment has 78 proposals at `/proposals/` and an **empty** `/policies/` registry.
- Restarting does not overwrite edits, `updatedAt`, votes or revisions.
- Seeded content is **not adopted policy**. It is the Reclaim baseline represented as proposals.
- `GOV-*` IDs normalise to the `resolution` matter type even when the raw `kind` is `proposal`.

Legacy starting revisions are backfilled deterministically from the content hash. Ballots are never bound during seeding; binding requires an explicit migration or officer action.

## Migrations

Two mechanisms exist:

1. **Admin migrations** (`src/lib/migrations.ts`, `/admin/migrations/`, `/api/admin/migrations`), recorded in `data_migrations`. Ordered migrations cover standard branches, branch participation and open-ballot expiry. They are restartable and inspectable.
2. **One-off scripts** under `scripts/`, run with `tsx`/Node strip-types, usually with `--dry-run` and `--apply` modes. Examples: vote storage migration, encrypted vote migration, ballot scheduling, branch seeding, membership verification, encrypted-vote rotation.

Rules:

- Never mutate governance history in place.
- A migration must be idempotent and restartable.
- A migration that changes a binding must write an audit event.
- Test against a restored production clone before applying.
- Do not seed or rewrite votes during routine startup.

## Data integrity principles

- **Append-only history.** Revisions, results, publication events, binding events and audit logs are never edited to reflect a later state.
- **Current-state projections may change.** Votes, subscriptions and registry status change; their event history does not.
- **Referential checks are application-level.** There are few foreign keys. Validate that a revision belongs to a proposal and that a branch is recognised before writing.
- **Authorisation is re-checked at the service layer.** A page hiding a control is not a data protection.
- **Projections are not a security boundary in development.** The in-memory driver ignores them.
- **Backups are an operational concern.** See `docs/operations.md` and `docs/coolify-deployment.md`; those documents are older than this set and should be checked against the deployed topology.
