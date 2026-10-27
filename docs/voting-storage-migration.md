# Voting collision repair — proposal-votes-v1

Status: implementation verified on isolated MongoDB 8.0.16; production inspection,
restore rehearsal and production application are still release gates. No production
database access or mutation was performed during implementation.

## Root cause and submission path

At upstream `0e67e5b`, the proposal page sends `{proposalId, choice, reason}` to
`POST /api/votes`. The policy page redirects to that proposal page. The route gets
the authenticated session, then calls `getDatabase` and `castVote`. Authentication
rejects disabled accounts and derives participation from verified membership.
`castVote` accepts `proposalId` or the compatibility `policyId`, resolves the actual
proposal, requires participation and the Decide stage, validates the selection and
upserts by proposal/member. It never supplies `ballotId`.

Before the CRUD rewrite (`99c5940`), `src/lib/platform/database.ts` at `c1f724c`
created `votes`' unique `{ballotId:1, memberId:1}` index named
`one_current_vote_per_member_ballot`. MongoDB retains indexes after code changes.
The rewritten startup attempted a unique proposal/member index but suppressed
index errors and never reconciled the existing index. Missing ballot IDs index as
null: a member's second independent proposal collides with their first. Reproduced
on real MongoDB with the exact reported E11000 key, before applying the fix.

## Repair and data boundaries

Current CRUD decisions use `proposal_votes`, with server-derived
`ballotId = "proposal:" + proposalId` and unique `(ballotId, memberId)`.
One proposal has one current decision ballot in this application version. Repeated
selections update that member's current record. Client-supplied ballot identifiers
cannot change that scope. A future second voting round for one proposal needs an
explicit new ballot model; do not reuse this identity for a new round.

The migration copies only source votes with missing/null ballotId, a known
proposalId, nonempty memberId, a current three-way choice and a Date updatedAt.
It preserves `_id`, member, timestamps, reason and every other field, adding only
the deterministic ballotId. String ballotId records are legacy ballots and are
left in place even if they have the same proposalId/memberId. No legacy vote,
ballot, consultation, audit, eligibility snapshot or index is changed or removed.
Legacy votes are deliberately not combined with current decision tallies.

Unknown/orphaned records, duplicate proposal/member selections and conflicting
destination records stop the migration. It never chooses a winner or overwrites
a vote. The destination unique index is built before copying. An interrupted copy
can resume; completion is marked only after comparing all copied records. After
completion, reapplying cannot reset subsequent votes from the frozen source.

All current vote reads, tallies and member activity use the new collection. Proposal
deletion retains decision records. Membership and stage admission rules are unchanged.
Startup requires the migration marker whenever the original votes collection is
nonempty, awaits uniqueness setup across concurrent requests and propagates index
errors. Fresh databases create the unique index without a data migration.

## Inspection and deployment (production apply requires explicit approval)

1. Build the reviewed image without starting it. Preserve the old image and take
   a protected, consistent backup of the entire database, including indexes. Restore
   it into a separate database for rehearsal. Use the actual deployment's Compose
   files/credentials; never put credentials or individual votes in logs or the PR.
2. Run `node scripts/migrate-proposal-votes.mjs --dry-run` with `MONGODB_URI` and
   `MONGODB_DB_NAME` set explicitly. It connects directly to MongoDB, does not call
   app startup/seeding and performs only reads. It reports source/destination counts
   and actual index definitions without member IDs or choices. Missing collections
   are supported. Nonzero exit blocks deployment; inspect records privately using
   `inspectVoteMigration(db)` to see the validation reasons without automatic repair.
3. On the restored copy, stop writers, run the same dry-run, then
   `node scripts/migrate-proposal-votes.mjs --apply --writers-stopped`. Check source
   votes/indexes are unchanged, copied count matches, and the completion marker and
   destination unique index exist. Start the new app against the copy and verify
   two policies, a repeat selection, eligibility denial and retained legacy ballots.
4. Only after reviewing the real-data dry-run, rehearsal and explicit approval,
   stop **all** production app instances, jobs and other writers. Keep the database
   running. Repeat the production dry-run immediately before applying. Using Compose,
   `docker compose run --rm --no-deps app node scripts/migrate-proposal-votes.mjs --dry-run`
   uses the newly built image and its configured database connection. After approval,
   use the same command with `--apply --writers-stopped`. The flag attests writer
   shutdown; it does not stop writers itself. Never apply while the old app is live.
5. Start only the new image, verify health and preserved totals, then monitor voting
   errors. Any real member ballot changes for a smoke test need the member's consent.

The image includes the migration script and its TypeScript dependency; Node 24 can
execute it without development dependencies. No automatic startup migration occurs.

Rollback after accepting new votes must preserve `proposal_votes`: the original
`votes` records are an archive, not an up-to-date rollback target. Stop writers and
roll forward or perform an explicitly approved reconciliation. Do not resume the old
writer, delete the new collection or restore a stale backup over accepted votes.

## Validation

`VOTING_TEST_MONGODB_URI=<isolated MongoDB URI> pnpm test` runs real MongoDB tests
for independent policies, same-ballot updates, duplicate rejection, separate legacy
consultation ballots, unchanged originals/indexes, dry-run, restart/idempotency,
invalid/duplicate/conflicting data, membership and stage rejection. The original
two-policy test failed with the exact production error before the fix. CI supplies
an isolated MongoDB URI; without it, these integration tests explicitly skip.
`pnpm check` and `pnpm build` cover the application. The workflow no longer calls
the removed `test:cutoff`/`test:auth` scripts from the pre-rewrite application.

These tests validate observed repository schemas and synthetic mixed data. They
do not establish the exact production record/index shape: the read-only production
dry-run and restore rehearsal above remain mandatory before deployment.
