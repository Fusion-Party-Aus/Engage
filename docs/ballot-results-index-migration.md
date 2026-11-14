# Ballot-results index migration

**Status:** Current · **Applies to:** `ballot_results` · **Issue:** #55

The `ballot_results` collection stores one formal decision per ballot. Sprint 1
replaced a unique index on `proposalId` with a unique partial index on
`ballotId`, so a matter may have more than one ballot (for example a main and an
amendment ballot). That change is now an explicit, reviewable migration rather
than a startup side effect.

## Why it is explicit

The previous startup code created the new index, dropped the legacy one and
swallowed every error. A duplicate-key failure left the wrong cardinality in
place with no signal, and the drop made rollback effectively impossible. Startup
now never reshapes a legacy collection.

| Database state | Startup behaviour |
|---|---|
| Fresh (no legacy unique `proposalId` index) | Creates the unique partial `ballotId` index and the non-unique `proposalId` lookup index. |
| Already migrated | Read-only no-op. |
| Legacy (unique `proposalId` index present) | Changes nothing and logs that the explicit migration is required. |
| Blocked (duplicate `ballotId` values) | Changes nothing and reports the duplicates. |

## Commands

The migration requires an explicit `--database`; it refuses to infer one from the
URI. Read `MONGODB_URI` from the environment or pass `--uri`.

```sh
# Read-only preflight
npm run ballots:results-index -- preflight --database engage_production_clone

# Dry run (the default): prints the plan, writes nothing
npm run ballots:results-index -- apply --database engage_production_clone --actor member-admin

# Apply
npm run ballots:results-index -- apply --database engage_production_clone \
  --actor member-admin --apply

# Verify the installed state
npm run ballots:results-index -- verify --database engage_production_clone

# Recovery report
npm run ballots:results-index -- recovery --database engage_production_clone
```

Applying to `engage_production` additionally requires `--allow-production` and
`--confirm-production engage_production`. An explicit `--actor` is mandatory for
any apply; the actor and backup ID are written to `data_migrations`.

### Preflight output

The preflight reports the result count, results with a missing or non-string
`ballotId`, duplicate `ballotId` groups, duplicate `proposalId` groups, the
current index definitions and any blockers. Exit code `2` means blockers exist.

### What apply does, in order

1. Refuses if a blocker exists.
2. Writes the current index definitions and every result document to
   `migration_backups` under a `backupId`.
3. Creates the unique partial `ballotId` index and verifies it exists.
4. Drops the legacy unique `proposalId` index — only after the replacement is
   proven.
5. Creates the non-unique `proposalId` lookup index.
6. Verifies the final state and records the run as `completed`.
7. On failure, records `failed` with the error and re-raises. The backup is
   retained.

An interrupted run leaves both indexes in place and is completed by re-running
`apply --apply`. A run on an already-migrated database is a no-op and takes no
new backup.

## Recovery

- **Partial apply:** re-run `apply --apply`. The steps are idempotent.
- **Rollback to the legacy index:** `recovery` reports whether it is possible.
  After any matter has more than one result it is not, and the report says so.
- **Restoring a backup:** backups are evidence, not an automatic restore.
  Restoring one discards results recorded after it was taken; a human decides.

Results are never deleted or rewritten to make an index fit. Duplicate or
conflicting records are reported for reconciliation. This protects decision
records and keeps identifiable ballot choices inside their authorised boundary.

## Verification

- `src/lib/ballot-results-index-migration.test.ts` runs eight cases against a
  real MongoDB replica set: fresh install, legacy startup no-op, duplicate
  blockers, full apply, dry run, partial apply, re-run, loud failure, and
  recovery reporting.
- `src/lib/governance-integrity-sprint1.test.ts` asserts that startup leaves a
  legacy database untouched and that the explicit migration then enables
  one-to-many ballot results.
