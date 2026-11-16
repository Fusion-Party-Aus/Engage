# Ballot quorum

**Status:** Current · **Adopted:** 16 November 2026 · **Rule version:** `two-tier-quorum-v1`
**Authority:** Decision register D37–D39. Requires Committee or Operations Manual confirmation under Constitution rule 98 before the first post-adoption closure is treated as binding.

Engage policy ballots have two independent participation requirements. Both must be satisfied before a ballot can produce a binding outcome.

This page describes the implementation. The governance decision is recorded in [decision-register.md](decision-register.md); the lifecycle steps are in [../domain/governance-lifecycle.md](../domain/governance-lifecycle.md).

## Constitutional basis

Fusion's Constitution is not amended by Engage.

| Provision | What it establishes | How Engage uses it |
|---|---|---|
| Rule 30(4)(e) | The AGM endorses or rejects policy implementations adopted since the previous AGM. | A successful Engage ballot remains subject to that continuing AGM obligation. Quorum does not replace it. |
| Rule 36(2) | A general-meeting quorum is the greater of 30 members or the square root of active membership identified at the last formal AEC audit. | Engage adopts the same two principles — a fixed floor and square-root scaling — for an online ballot. |
| Rule 36(4) | An adjourned meeting may proceed with a reduced quorum. | **Not carried over.** An online ballot has no adjournment. |
| Rule 98 | The Committee may create binding policies and procedures that must not contradict the Rules and may limit, but not expand, discretions. | The procedure should be recorded in the Operations Manual or confirmed by Committee resolution before it is treated as binding. |

Engage ballots are not general meetings. Calling this "rule 36 quorum" would overstate the constitutional position. It is an **adaptation of rule 36's quorum principles**.

## The two requirements

### 1. Platform quorum

At least **30 eligible registered Engage members** must exist when the ballot closes.

- Count unique members with a verified Engage membership.
- Exclude pending and suspended memberships.
- Exclude disabled or removed accounts.
- Exclude accounts linked to the same active CRM person, counting each person once.
- Recent activity is not required for this threshold.

If the platform has fewer than 30 eligible registered members, no ballot can produce a binding outcome, regardless of turnout.

### 2. Ballot quorum

**Q = max(ceil(√N), min(30, ceil(N/2)))**

`N` is the number of eligible, active Engage members when the ballot closes.

| Active eligible members | Participants required |
|---:|---:|
| 20 | 10 |
| 30 | 15 |
| 38 | 19 |
| 50 | 25 |
| 60 | 30 |
| 100 | 30 |
| 500 | 30 |
| 900 | 30 |
| 1,000 | 32 |
| 2,000 | 45 |

The square-root term scales with the electorate. The `min(30, ceil(N/2))` term protects small electorates by requiring a proportional share. The rule is not a permanent 50% quorum: above 60 active members the square-root requirement is equal to or greater than the proportional term.

## What counts as participation

Participation is any recorded `approve`, `abstain` or `reject` on the ballot. Each eligible member counts once, even if they change their vote while the ballot is open.

- Abstentions count towards quorum.
- Abstentions do not count as Yes or No, and do not change the approval comparison.
- Quorum and approval are separate tests. A ballot can meet quorum and still be rejected, or fail quorum despite majority approval.

The final participation count is the number of unique vote records bound to the ballot's frozen wording revision. A ballot with unbound or unreadable votes cannot certify.

## The active member definition

A member is active if, in the **90 days** before closure, Engage recorded at least one of:

- a signed-in visit (an `activity_day` record written when an authenticated session loads a page);
- a vote;
- a comment;
- an authored proposal;
- an authored amendment;
- a view of My Engage (`my_engage_viewed`);
- a view of an eligible ballot (`first_eligible_ballot_viewed`);
- a recorded participation day (`participation_day`).

Activity is genuine authenticated use. The definition is not "voted in this ballot": a member who visits and reads, comments, proposes or amends is active without voting. Casting a vote is itself authenticated use, so a voter is active; the active pool is not limited to the ballot's participants. Registration alone, an administrative job, an email delivery and a queued verification attempt do not make a member active.

The 90-day window is rolling. Changes in the active electorate before closure change the requirement; after closure they change nothing.

### Known data limitation

Before this rule, Engage did not record a general activity day. Historical activity is reconstructed from retained votes, comments, proposals, amendments, My Engage views, eligible-ballot views and participation-day records. A member who used Engage before the change but left no such record will not count as active until their next authenticated visit. The rule does not manufacture activity to hit a threshold.

## Closure snapshot

The binding calculation is recorded once, inside the same transaction as ballot closure. The record is stored in `ballot_quorum_records`, keyed uniquely by `ballotId`.

It captures:

- ballot, matter and frozen revision identifiers;
- closure and record timestamps;
- the rule version and its effective date;
- eligible registered member count and active eligible member count;
- excluded duplicate, disabled and missing accounts;
- the 90-day window start;
- the platform threshold and result;
- the ballot threshold and result;
- unique participants and the approve/abstain/reject tally;
- whether approval was satisfied;
- the verdict (`adopted`, `rejected`, `inconclusive`);
- any anomaly that prevented calculation.

The record is insert-only. No request path updates it. If the scheduler cannot read participation, it still records the electorate and marks the record `unavailable`; certification is then refused until the closure is reviewed.

If a ballot closed after the rule took effect but has no record, certification refuses with `BALLOT_QUORUM_SNAPSHOT_MISSING`. Reconstructing the electorate from current membership would create a historical result that never existed.

## Outcomes

| Outcome | Meaning |
|---|---|
| **Adopted** | Both quorum tests and the existing Yes-versus-No approval test are satisfied. |
| **Rejected** | Both quorum tests are satisfied, but Yes did not exceed No. |
| **Inconclusive** | Platform or ballot quorum was not satisfied. The proposal is neither approved nor rejected. |

A recorded `successful` result maps to adopted, `unsuccessful` to rejected and `inconclusive` to inconclusive. The stored result vocabulary is unchanged for compatibility.

A ballot that fails quorum can only be recorded as inconclusive. Supplying an override reason does not permit an officer to record it as successful or unsuccessful; quorum is a gate, not a discretion.

An inconclusive ballot does not automatically retry. It can return to Deliberate through the existing stage path, where the wording can change or the matter can be archived. Reopening Decide is an officer act and remains subject to the existing ballot-binding and lifecycle rules.

## First-round transition

The inaugural ballot round closes on **14 January 2027**. That date is not changed by this rule.

- Ballots already closed before 16 November 2026 are not reassessed. Certification records them as `legacy-not-applied` and uses the earlier approval-only rule.
- Ballots open on 16 November 2026 close under `two-tier-quorum-v1` and receive a closure snapshot from the scheduler.
- The member-facing explanation is published on the proposal page and `/how-it-works/` before the first closure.

## Administration and correction

Administrators see the current or final calculation on the proposal workspace: electorate counts, both thresholds, participation, rule version and any anomaly. They cannot edit a threshold for an individual ballot.

There is no in-product correction action. A correction to a recorded closure must be a separate reviewed change that appends an audit record and a governance event, with the reason recorded. Do not edit or replace `ballot_quorum_records` directly.

## Implementation

| Concern | Code |
|---|---|
| Formula, evaluation, electorate read, immutable record shape | `src/lib/quorum.ts` |
| Closure snapshot and certification gate | `src/lib/ballots.ts` (`recordBallotQuorumAtClosure`, `ensureBallotQuorumRecordForCertification`, `recordFormalDecision`) |
| Successful authenticated activity day | `src/lib/member-presence.ts`, called from `src/lib/auth.ts` |
| Scheduled closure transaction | `src/lib/governance-scheduler.ts` (`closeDueBallots`) |
| Member explanation | `src/pages/proposals/[slug].astro`, `src/pages/how-it-works/index.astro` |
| Administrator explanation | `src/pages/admin/proposals/[slug].astro` |
| Tests | `src/lib/quorum.test.ts`, `src/lib/quorum-mongo.test.ts` |
