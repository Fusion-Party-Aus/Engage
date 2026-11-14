# Sprint 1 integration report

**Branch:** `feat/rfc0001-sprint1-integration`
**Date:** 14 November 2026
**Status:** Verified integration branch. Not merged. No deployment performed.

## What was integrated

| Branch | Commit | Issues | Merged into integration |
|---|---|---|---|
| `fix/sprint1-governance-integrity` | `919e7a5` | #26, #50 | Yes |
| `fix/sprint1-membership-crm` | `af890d0` | #32 | Yes |
| `fix/sprint1-rbac-authority` | `4ed96bc` | #27, #31 | Yes |
| `docs/rfc-platform-evolution` | `a132b13` | RFC 0001 | Yes — the programme's source document |

All three implementation branches merged without textual conflicts. Their `src/lib/store.ts` changes touched adjacent regions and merged cleanly.

## Conflicts that were behavioural, not textual

The combined suite initially failed four tests. Each failure was a real cross-branch contradiction, not a flaky test.

| Failure | Cause | Resolution |
|---|---|---|
| `governance-integrity` admin fixture could not open a ballot | The fixture declared an empty permission snapshot, so the new `ballots.bind` gate denied an administrator. | The fixture now resolves real legacy administrator permissions, as a session does. Production sessions already behave this way. |
| RBAC ballot test omitted a closing date | The governance branch made `ballotClosesAt` mandatory when entering Decide. | The test supplies a future date. |
| RBAC deletion test deleted an archived, superseded matter | The governance branch correctly refuses deletion of matters with governance history. | The permission test now deletes a draft with no history, and separately proves that a branch-scoped `proposals.delete` grant does not confer destructive authority. |
| Deletion expectations across branches | `proposals.delete` is national-only in the catalogue, but the RBAC test granted it per branch. | `hasPermission` now ignores branch grants for national-only permissions (defence in depth). The test asserts the denial. |

## Reconciliation with maintainer decisions

The [decision register](../governance/decision-register.md) is authoritative. Three integration consequences:

1. **`ballots.bind` (D5) is correct but incomplete.** Ordinary moderators no longer enter Decide. The approved automatic advancement at the deliberation deadline (D4) must use a **system actor**, not a permission grant to a scheduler. It must still bind the revision and emit a governance event. This is Phase 1 work.
2. **Deadlines are mandatory but not scheduled.** A ballot cannot open without a future close date (good), but nothing creates a default 30-day deadline or closes the ballot automatically (D6). Phase 1.
3. **Certification is not approval.** `policies.ratify` remains a manual procedural act. The decision register separates result, adopted wording, certification and publication (D13–D20). Automatic ratification is Phase 5.

## Defects found and fixed during integration

Browser verification found two defects that the unit suites could not see.

### 1. Admin proposal edits failed in MongoDB with a provenance path conflict

`saveProposal` placed `provenance` in both `$set` and `$unset` when the editor submitted `provenance: null` (the default "None (clear provenance)" option). MongoDB rejects the update: *"Updating the path 'provenance' would create a conflict at 'provenance'"*. Every staff edit through the admin form was affected.

**Fix:** the clear and set branches are now mutually exclusive. **Regression test:** `voting-mongo.test.ts` — "admin stage transition may clear provenance without a MongoDB path conflict", run against the replica set.

### 2. Ballot deadline caused a React hydration mismatch

The deadline banner rendered a date on the server and a relative/local time after mount. React 19 reported error #418 (`text`) on every ballot page with a deadline. The rendered result was correct; the mismatch polluted the console and forced a client re-render.

**Fix:** the two intentional server/client text nodes opt out of hydration comparison with `suppressHydrationWarning`. The server text remains meaningful and stable; the client replaces it with the viewer's local deadline. The date label helper now takes an explicit timezone to document that it is hydration-stable.

Both defects pre-date Sprint 1 but were only observable through a real browser against a real MongoDB.

## Verification evidence

All commands were run on the integration branch at the commit containing this report's parent changes.

| Check | Command | Result |
|---|---|---|
| Type and template check | `npm run check` | 0 errors, 0 warnings (35 hints) |
| Unit and integration suite, no MongoDB | `npm test` | 304 tests, 287 pass, 17 skipped (conditional real-MongoDB cases) |
| Unit and integration suite with MongoDB 8.0 replica set | `VOTING_TEST_MONGODB_URI=... AUTH_TEST_MONGODB_URI=... npm test` | **304 tests, 304 pass, 0 fail, 0 skipped** |
| Production build | `npm run build` | Complete |
| Browser journeys | `node scripts/rfc0001-governance-browser.mjs` | Passed; no page errors or console errors |

### Browser journeys executed

Against the production build, a disposable MongoDB database, and synthetic dev identities only:

1. **Deadline enforcement in the interface.** Submitting Decide without a closing date surfaces *"A future ballot closing date is required when opening a ballot."* and does not change the proposal.
2. **Opening a ballot with a deadline.** The proposal moves to Decide, binds a wording revision, stores a future `ballotClosesAt`, and writes a `proposal.stage_transition` governance event.
3. **Member deadline visibility.** The mobile ballot shows the closing banner and local time.
4. **Voting.** A verified member records *Approve*; the stored choice and tally update.
5. **Vote change.** The same member changes to *Reject*. The stored record is updated in place; there is exactly one vote row for that member and ballot.

Screenshots and a machine-readable result are written to `docs/screenshots/rfc0001/`.

**Not executed in a browser:** delegated custom-role journeys, branch-referral delegation, cross-branch denial, and amendment ballot flows. These are covered by the RBAC suite at the domain and route level, but the rendered interfaces were not exercised. This must not be reported as browser-verified.

## Migration and rollback implications

### `ballot_results` index change

Startup previously created a unique index on `{ proposalId: 1 }`. The integration replaced it with a unique partial index on `{ ballotId: 1 }` and a non-unique `proposalId` index, initially as a startup side effect.

**Resolved (#55, 15 November 2026).** Startup no longer reshapes a legacy collection. It creates the indexes on a fresh database, is a no-op when already migrated, and reports a legacy or blocked database without changing it. `npm run ballots:results-index` provides a read-only preflight (counts, duplicates, missing `ballotId`, index state), a backup of the index definitions and documents, a verified apply that drops the legacy index only after the replacement exists, a loud recorded failure, and a recovery report. Results are never deleted to fit an index; duplicates are reported for reconciliation. See [the procedure](../ballot-results-index-migration.md).

The original risks and their current handling:

1. **Silent failure.** Removed. Failures are recorded in `data_migrations` as `failed` and re-raised; index creation is verified.
2. **One-way change.** Rollback is not automatic and remains destructive once a matter has multiple results; the recovery report states this rather than performing it.
3. **Legacy documents without `ballotId`.** Still excluded by the partial filter and reported by the preflight. Application logic remains the protection.

### Existing ballots without deadlines

Existing open ballots may have no `ballotClosesAt`. They are not migrated by this branch. The one-off `2027-01-14T13:00:00Z` migration remains the only backfill. Phase 1 must decide whether to schedule these ballots, extend the one-off deadline, or require an officer to set one — and must record the decision.

### Historical CRM verification reviews

The membership branch records provenance for new manual verifications. Existing reviews are not reconciled. A reporting query is needed before any data correction.

## Limitations of this verification

- The governance-integrity suite still uses the in-memory database. Transactional atomicity was exercised on real MongoDB only by the voting suite and the new provenance regression. Add replica-set cases for the deletion guard, result atomicity and transition events in Phase 1.
- No load, capacity or concurrency stress test was run.
- No deployment, migration rehearsal or rollback drill was performed.
- Legal and constitutional review is outside this work.

## Next workstream

Phase 1, tracked in the [programme tracker](../status/rfc0001-programme-tracker.md):

1. Proposal seconding, deliberation deadline, automatic advancement, default 30-day ballot deadline, automatic closure, idempotent scheduler.
2. Computed Yes-versus-No outcome validation with an audited override; abstentions remain undecided.
3. Real-MongoDB concurrency and crash-recovery tests for governance writes.
4. `ballot_results` migration preflight and recovery procedure.
5. Notification outbox foundation for scheduled transitions.
