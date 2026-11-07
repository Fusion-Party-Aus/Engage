# Engage legacy ballot binding — production procedure

**Release candidate:** `proposal-ballot-integrity` working tree based on `0ad210b`  
**Prepared:** 8 November 2026  
**Scope:** application-level migration procedure. Deployment, database backup execution, container orchestration and production cutover belong to the Coolify operator.

## 1. What this migration does

Production contains open Decide-stage ballots whose votes predate immutable wording revisions. The migration:

1. creates one deterministic immutable revision for each existing ballot from its current proposal wording;
2. binds the ballot to that revision;
3. attaches every existing vote to the same revision;
4. writes one auditable `ballot_binding_events` record per ballot;
5. preserves vote choice, member identity, ballot identity and vote timestamps.

The binding is explicitly retrospective. No original vote-time revision snapshot existed. The evidence is the confirmed absence of wording change: each proposal is compared with the deployment baseline wording, and the migration fails closed if the current title, summary, outcomes or details differ.

The batch covers **36 open Decide ballots** plus **1 archived historical ballot** (`GOV-002`) that still carries three votes, so all **194 existing `proposal_votes` records** become revision-bound. The four older records in the legacy `votes` collection are not part of this operation; they were already handled by `proposal-votes-v1`.

## 2. Prerequisites

- A MongoDB replica set. The apply step uses a single transaction. It fails rather than falling back to partially-applied writes.
- A fresh, verified backup of the target database before any application startup or migration.
- The release-candidate image or working tree that contains `scripts/ballot-migration.ts`.
- Node.js with type stripping (the repository's `pnpm ballots:migrate` script uses `node --experimental-strip-types`).
- `MONGODB_URI` for the target database and an explicit `--database` argument. Never infer the database from the URI.
- Production credentials with write permission only for the apply step.

Required application environment for this release:

```text
MONGODB_URI
MONGODB_DB_NAME
BETTER_AUTH_URL=https://engage.fusionparty.org.au
PUBLIC_ORIGIN=https://engage.fusionparty.org.au
BETTER_AUTH_SECRET
SESSION_SECRET
```

`PUBLIC_ORIGIN` is new. It is the trusted origin used for canonical metadata and public API `Link` headers. If omitted, the application falls back to `BETTER_AUTH_URL`. Forwarded host headers are not trusted. `FORMAL_BALLOTS_ENABLED` is not read by this application and must not be treated as a release control.

## 3. Dry run on an isolated clone

Always rehearse against a restored production-data clone first.

```bash
export MONGODB_URI='mongodb://127.0.0.1:27018/?directConnection=true'

# 1. Inventory every ballot that needs binding (read-only).
pnpm ballots:migrate inventory \
  --database engage_rehearsal \
  --out-json /tmp/ballot-inventory.json \
  --out-md /tmp/ballot-inventory.md

# Expected on the 8 November production snapshot:
#   37 ballots (36 open + 1 archived)
#   194 votes
#   37 supported / 0 ambiguous / 0 conflicting

# 2. Produce the binding plan. No writes.
pnpm ballots:migrate plan \
  --database engage_rehearsal \
  --inventory /tmp/ballot-inventory.json

# 3. Apply to the clone only.
pnpm ballots:migrate apply \
  --database engage_rehearsal \
  --inventory /tmp/ballot-inventory.json \
  --apply

# 4. Verify ballot, vote and audit-event consistency (read-only).
pnpm ballots:migrate verify \
  --database engage_rehearsal \
  --inventory /tmp/ballot-inventory.json
```

`apply` without `--apply` is a dry run. A plan with any blocker exits non-zero and writes nothing.

## 4. Production cutover sequence (application steps)

The Coolify operator controls infrastructure, backup execution and cutover timing. The application sequence is:

1. **Back up** the production database and record the backup checksum. Do not proceed without a restore-tested backup.
2. **Deploy the release candidate** and let application startup complete. Startup now:
   - inserts missing baseline proposals only;
   - does not rewrite existing proposals or their `updatedAt`;
   - backfills missing immutable revisions with deterministic identifiers;
   - does **not** bind any ballot automatically.
3. **Check application health** and confirm the public site responds.
4. **Inventory production read-only** and confirm the expected counts and zero blockers:

   ```bash
   pnpm ballots:migrate inventory \
     --database engage_production \
     --out-json /tmp/engage-production-ballot-inventory.json \
     --out-md /tmp/engage-production-ballot-inventory.md
   ```

   If the count, wording hashes or classifications differ from the reviewed inventory, stop. Do not apply.
5. **Plan production read-only**:

   ```bash
   pnpm ballots:migrate plan \
     --database engage_production \
     --inventory /tmp/engage-production-ballot-inventory.json
   ```

6. **Apply**, only with explicit production confirmation:

   ```bash
   pnpm ballots:migrate apply \
     --database engage_production \
     --inventory /tmp/engage-production-ballot-inventory.json \
     --apply \
     --allow-production \
     --confirm-production engage_production \
     --actor '<operator identity>' \
     --batch-id 'engage-legacy-ballots-<cutover-date>'
   ```

   The command refuses production writes without both production flags, an explicit `--apply` and a named `--actor`. It runs inside one MongoDB transaction. Any inconsistency or failure rolls back the batch.

7. **Verify** with the same inventory:

   ```bash
   pnpm ballots:migrate verify \
     --database engage_production \
     --inventory /tmp/engage-production-ballot-inventory.json
   ```

   Expected: `verified: 37`, `failures: []`.

8. **Application smoke test** the public site, member ballot and admin workspace (see §6).

## 5. Idempotency and retry behaviour

- Revision identifiers are deterministic: `legacy-<sha256(proposalId)>`.
- Binding event identifiers are deterministic: `bind-<sha256(proposalId + decisionEventId)>`.
- A repeated identical apply returns the existing events and creates no duplicate revisions, vote links or events.
- A repeated apply with different wording, a different revision or a different reason is rejected.
- If the process is interrupted before the transaction commits, nothing is applied. Re-run the same command.
- If the process is interrupted after commit, re-running reports the same 37 events as idempotent.

The applied rehearsal produced:

```json
{
  "ballots": 37,
  "votesBefore": 194,
  "votesAfter": 194,
  "boundVotes": 194,
  "bindingEvents": 37,
  "decideBound": 36,
  "decideUnbound": 0,
  "verification": { "verified": 37, "failures": [] }
}
```

## 6. Post-migration application smoke tests

- `GET /api/health` returns 200.
- `/proposals/` lists proposals; `Platform & Branding Review` renders with one ampersand.
- A bound legacy ballot shows a human-readable label such as “Original recorded wording · 27 Oct 2026”, not `legacy—…`.
- A verified member can cast a vote on a bound legacy ballot; the tally increases.
- A ballot that is still unbound rejects voting with the explicit revision-binding error.
- `/admin/proposals/?stage=decide` shows no unbound ballot review forms after the batch.
- `/policies/` explains that the Engage registry is empty, that Fusion has adopted policy elsewhere, and that proposals are not ratified policy.
- Canonical links and public API `Link` headers use `https://engage.fusionparty.org.au`, not `localhost`.
- Anonymous admin routes redirect to `/member/`; ordinary members cannot read identifiable ballot records.

## 7. Rollback

The migration is additive:

- new `proposal_revisions` documents with `provenance: "legacy-backfill"`;
- `ballotRevisionId`, `ballotRevisionBoundAt`, `ballotRevisionBoundBy` on proposals;
- `revisionId` and `revisionBindingEventId` on `proposal_votes`;
- `ballot_binding_events` documents.

The previous application ignores these fields and collections. A code rollback is expected to remain readable and non-destructive.

Important limitation: votes cast through the **old** application after a rollback do not carry a `revisionId`. If the new application is later restored, those new records will look like mixed bound/unbound ballot history and will fail closed. If rollback is followed by further voting, restore the pre-migration database backup before re-upgrading, or plan an explicit reconciliation.

The safest rollback is: stop writing, restore the pre-cutover database backup, and redeploy the previous image.

## 8. Audit and evidence

- `docs/ballot-migration-inventory-2026-11-08.json` — complete machine-readable inventory.
- `docs/ballot-migration-inventory-2026-11-08.md` — human-readable inventory with per-ballot evidence.
- Each ballot has one `ballot_binding_events` row containing:
  - `proposalId`, `ballotId`, `revisionId`, `contentHash`;
  - `decisionEventId`, `migrationBatchId`, `bindingBasis`;
  - reviewed and rebound vote counts;
  - operator identity and timestamp.

No historical revision timestamp, approval event or voter intent is fabricated. The revision uses the proposal's recorded creation time and is marked as a legacy backfill.
