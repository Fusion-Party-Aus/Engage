# Ballot-binding rehearsal — isolated production clone

**Date:** 8 November 2026  
**Source:** read-only `mongodump` of `engage_production` taken 2026-11-07T14:06:29Z  
**Target:** disposable MongoDB 8.0 single-node replica set, database `engage_rehearsal`  
**Production writes:** none

## Starting state

| Item | Value |
| --- | ---: |
| Proposals | 81 |
| Open Decide proposals | 36 |
| Archived proposal with votes (`GOV-002`) | 1 |
| `proposal_votes` | 194 |
| Existing `proposal_revisions` | 0 |
| Existing `ballot_binding_events` | 0 |

## Dry run

`pnpm ballots:migrate inventory` produced 37 ballots, 194 votes, 37 supported, 0 ambiguous, 0 conflicting.

`pnpm ballots:migrate plan` produced 37 entries, 194 votes and **no blockers**.

## Apply

`pnpm ballots:migrate apply --apply` committed one transaction.

| Item | Result |
| --- | ---: |
| Ballots bound | 37 |
| Votes attached to a revision | 194 / 194 |
| New immutable revisions | 37 |
| `ballot_binding_events` | 37 |
| Open Decide ballots bound | 36 / 36 |
| Open Decide ballots unbound | 0 |
| Archived historical ballot bound | 1 / 1 |
| Verification | 37 verified, 0 failures |

## Preservation check

A before/after comparison of all 194 vote records found **0 mismatches** across:

- `ballotId`
- `proposalId`
- `memberId`
- `choice`
- `authorName`
- `reason`
- `updatedAt`

Only the intended `revisionId` and `revisionBindingEventId` fields were added.

## Idempotency

A second apply using a freshly generated bound inventory returned 37 idempotent events. Counts remained:

- 194 votes
- 37 revisions
- 37 binding events
- 36 bound Decide ballots
- 0 unbound Decide ballots

## New voting after migration

- A new eligible member vote on `POL-011` succeeded; tally increased from 4 to 5.
- A new eligible member vote on `GOV-001` succeeded; tally increased from 8 to 9.
- The archived `GOV-002` ballot correctly rejected a new vote because it is not in Decide.
- All vote records, including new votes, carried a `revisionId`.

## Fail-closed checks

- Unbound ballot before migration rejected voting with: “This existing ballot has votes without one consistent revision reference.”
- A wording change caused 1 ambiguous ballot and a plan blocker; apply refused with zero writes.
- A planted inconsistent revision caused the transaction to roll back; zero ballots remained bound and zero events were written.
- Existing votes naming a different revision were classified as conflicting and blocked the plan.

## Startup check

A fresh production clone was initialized twice:

- all 81 `updatedAt` values unchanged after each run;
- proposal content and stages unchanged;
- 81 revisions after the first run, still 81 after the second;
- 0 binding events;
- 36 Decide ballots still unbound.

This confirms startup no longer rewrites unchanged proposals and does not silently bind historical ballots.

## Rehearsal conclusion

The migration is deterministic, idempotent, transactionally safe against the clone, and preserves all existing vote records. Production execution remains a separate authorised Coolify cutover step.
