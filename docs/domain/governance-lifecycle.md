# Governance lifecycle

**Status:** Current · **Verified:** 14 November 2026

This page traces a matter from an idea to an authoritative outcome, and separates **operational workflow states** from **protected governance acts**.

## End-to-end path

```mermaid
sequenceDiagram
  actor Author
  actor Member
  actor Officer
  participant Engage
  participant Scheduler as Lifecycle scheduler
  participant Registry as Policy Registry

  Author->>Engage: Create matter (generally Propose; administrators may create directly in Deliberate)
  Member->>Engage: Second the proposal (Propose only) — records secondedAt + deliberationEndsAt
  Member->>Engage: Comment, endorse, propose amendment
  Officer->>Engage: Advance to Deliberate (existing workflow transition)
  Officer->>Engage: Resolve / rebase / reject amendments
  Scheduler->>Engage: At deliberationEndsAt — system advances to Decide and binds the latest revision
  Officer->>Engage: Bind ballot to exact revision
  Officer->>Engage: Open Decide early (requires ballots.bind; default 30-day deadline)
  Member->>Engage: Cast Approve / Abstain / Reject
  Scheduler->>Engage: At ballotClosesAt — records ballot.closed (no stage change, no result)
  Officer->>Engage: Record formal result + decision event
  Officer->>Engage: Advance to Implement
  Officer->>Engage: Ratify successful revision
  Engage->>Registry: Adopted, unpublished
  Officer->>Engage: Publish
  Engage->>Registry: Published + publication event
  Officer->>Engage: Record implementation / supersede / withdraw
```

## Stages

| Stage | Member-facing meaning | What is expected | Substantive edits |
|---|---|---|---|
| `propose` | **Propose** | The idea is being written and shaped. Another member may second it, starting the 30-day deliberation clock. | Author or officer |
| `deliberate` | **Deliberate** | Members discuss, endorse and propose amendments. The system advances the matter at the deliberation deadline. | Officer; wording may change into a new revision |
| `decide` | **Decide** | A formal ballot is open on a fixed revision. | Locked |
| `implement` | **Implement** | The outcome is recorded and being carried out. | Locked |
| `archived` | **Archived** | Closed without further active work. | Restricted to authorised viewers |

`archived` is a real lifecycle stage, not a deleted record. Archived matters and their revisions remain auditable.

The four member-facing stages are Propose, Deliberate, Decide and Implement. "Archived" is administrative terminology and should not dominate a member's reading path.

## Valid transitions

The matter registry defines 16 edges. Every edge declares `requiredPermission: "proposals.edit"` and an `authorityKind`.

| From | To | Authority kind | Notes |
|---|---|---|---|
| propose | deliberate | workflow | Normal progression |
| propose | archived | workflow | Abandon a draft |
| deliberate | propose | workflow | Return for rewriting |
| **deliberate** | **decide** | **governance** | Opens the formal ballot. Requires a revision. |
| deliberate | archived | workflow | Abandon after discussion |
| decide | deliberate | workflow | Withdraw the ballot before a result |
| **decide** | **implement** | **governance** | Requires a successful result for the bound revision |
| decide | archived | workflow | Close without implementation |
| implement | deliberate | workflow | Reopen discussion |
| implement | propose | workflow | Return to drafting |
| **implement** | **decide** | **governance** | Reopen the decision |
| implement | archived | workflow | Close completed work |
| archived | propose | workflow | Restore |
| archived | deliberate | workflow | Restore |
| **archived** | **decide** | **governance** | Restore into a ballot |
| archived | implement | workflow | Restore as implemented |

### Invalid transitions

These are rejected regardless of who asks:

- `propose → decide` — a draft must be deliberated first.
- `propose → implement` — a draft cannot skip both deliberation and decision.
- `deliberate → implement` — a matter must be voted on in Decide first.
- Any edge not in the table above.
- Any transition into a stage the matter type does not allow.

A no-op transition (same stage to same stage) is treated as valid.

### What actually gates a transition

The declared `requiredPermission` is **descriptive metadata, not enforced**. The real gate in `saveProposal` is:

- a national administrator or moderator (`isStaff`), or
- a branch administrator of the matter's `originatingBranchId`, or
- the author, only while the matter is in `propose` — and the author cannot change the stage.

Additional governance guards:

- Entering `decide` requires at least one proposal revision. If no ballot revision is set, the latest revision is bound automatically.
- A branch actor entering `decide` must have `governanceAuthorityBranchId` in their branches **and** `jurisdictionBranchId` equal to it. National administrators and moderators are not subject to this check.
- `decide → implement` requires a `ballot_results` record for the matter and the **exact** `ballotRevisionId` with `result: "successful"`.
- Once in `decide`, or once any vote exists, substantive fields are locked: title, summary, details, outcomes, attachment, kind, governance authority, jurisdiction and publication scope.
- `space`, `provenance` and `implementationNote` remain editable.

These guards are the current implementation. They are not a complete constitutional model, and some are weaker than the UI suggests (see [status/known-gaps.md](../status/known-gaps.md)).

### Two paths into Decide

There are now two distinct entry paths, with different authorities:

| Path | Actor | Authority | Record |
|---|---|---|---|
| Officer advances early (D5) | Human officer | `ballots.bind` plus matching authority/jurisdiction | `proposal.stage_transition` with the member as actor |
| Deliberation deadline (D4) | `system:lifecycle-scheduler` | No human discretion; no `ballots.bind` is required or granted | `proposal.stage_transition` with the system actor and a deterministic event ID |

The system path cannot be triggered for a proposal that is not in `deliberate`, has no `deliberationEndsAt`, has blocking amendments, or already has votes that are not bound to the current wording revision. It binds the latest immutable revision and takes the proposal's 60-day ceiling as the ballot deadline. It never impersonates an officer or certifies a result.

## Phase-by-phase

### 1. Matter creation

A verified member (or staff) creates a matter. It starts in `propose`. The author supplies title, summary, outcomes, details, origin branch, optional attachment and provenance. A national administrator may set authority, jurisdiction and publication scope.

Records written: `proposals`, first `proposal_revisions`, a lifecycle event.

### 2. Initial proposal state

The author may edit while in `propose`. Every substantive save appends a revision when the wording hash changes. The author sees the current wording and revision history; other members may read a public proposal but cannot edit it.

### 3. Deliberation

Deliberation ordinarily lasts **30 days from seconding** (D4). The clock starts when a member seconds the proposal, not when an officer moves it to the Deliberate stage.

**Seconding (D3).** A proposal in Propose may be seconded once by a verified member who is not its author. `POST /api/proposals/[proposalId]/second` records `secondedBy`, `secondedAt` and `deliberationEndsAt` (30 days later) and writes a `proposal.seconded` governance event. It refuses:

- the author seconding their own proposal;
- a proposal that already has a seconder;
- a member whose membership is not verified;
- a proposal that is not in Propose.

The implemented reading of D3 is deliberately minimal and visible for review:

- **one seconder, and never the author.** D3 requires "a seconder" and the audit record says the author cannot second their own motion; it does not authorise multiple or competing seconders.
- **seconding does not change the stage.** The register says a seconder is required "before it enters Deliberate" but does not say whether seconding is itself the transition or a hard pre-condition on an officer's transition. This branch records the act and starts the clock, and leaves Propose → Deliberate as the existing workflow transition. Enforcing seconding as a gate on that transition, and what happens when seconded wording changes materially, remain open questions.
- **seconding applies to every matter type.** D3 names policy proposals; the recorded mechanism is not type-specific and no type-specific rule was invented.
- **seconding is participation, not a ballot.** It requires a verified membership and read access, and uses no ballot permission. It is not a formal vote and confers no approval.

A proposal created directly in Deliberate by an officer has no seconder and no deliberation clock. The scheduler never advances it; the [migration report](#scheduled-transitions-and-the-lifecycle-scheduler) lists these records.

Returning a seconded proposal to Propose does not clear the seconder or the clock: the schedule is anchored to the original seconding. Whether a materially rewritten proposal needs renewed seconding is an open question and is not implemented.

An officer advances the matter to `deliberate`. Comments, endorsements and amendments become the substantive input. Deliberation can continue in `decide` and `implement` as discussion, but it can no longer change the ballot wording.

### 4. Contributions and amendments

A member may submit an amendment against a base revision while the matter is in Propose or Deliberate. The amendment is classified `proposed`, `stale` or `conflict`. An officer resolves it to `ready`, `rejected` or `withdrawn`, optionally rebasing it onto the latest revision.

### 5. Revision creation

Amendments do not edit the proposal directly. Applying an accepted amendment calls the normal proposal save path, which appends a new revision. The previous revision remains immutable.

### 6. Ballot preparation and wording binding

Entering `decide` binds a revision. An officer may also bind explicitly through `POST /api/admin/ballots/bind`, which requires `ballots.bind` and matching authority/jurisdiction. Binding:

- refuses if the matter is not in `decide`;
- refuses if the revision does not belong to the matter;
- refuses to rebind when a different revision is already recorded or any vote names a different revision;
- attaches only unbound votes;
- writes a `ballot_binding_events` record and a `governance_events` `ballot.bound` event.

If binding is inconsistent, new votes are refused.

Opening a ballot also fixes its deadline. When an officer opens a ballot without supplying `ballotClosesAt`, the default is **30 days from opening** (D6). An explicit date from an authorised operator remains authoritative. The automatic path described below uses the 60-day ceiling from seconding instead (D7).

### 7. Eligibility and voting

Eligibility is resolved at vote time:

- national ballot — any verified member;
- branch ballot — verified member with active membership of the exact branch;
- follower — not eligible;
- pending member — preference only;
- suspended member — no vote and no preference.

Votes are `approve`, `abstain` or `reject`. A member may change their vote while the ballot is open. Unique partial indexes prevent duplicate votes, including encrypted votes via a blind index.

### 8. Ballot closure

A proposal ballot closes at `ballotClosesAt`. The boundary is exclusive: at that instant and after it, no vote or vote change is accepted (`ballotExpired`).

The lifecycle scheduler records closure automatically. For each proposal in `decide` whose deadline has passed and which has no recorded closure it:

- sets `ballotClosedAt` on the proposal with a conditional update, so it happens once;
- sets the matching `ballots` projection row to `closed` when one exists;
- writes one `ballot.closed` governance event with the system actor and a deterministic event ID.

Closure deliberately does **not** change the stage, record a result, certify the ballot or evaluate a tally (D12). Recording the formal result and moving to Implement remain separate officer acts (sections 9 and 10). Amendment ballots are not closed by the scheduler: they have their own explicit close action and share the parent ballot's deadline.

If the matter later leaves Decide, or an authorised operator configures a new deadline, the closure marker is cleared so the new ballot instance can be closed again; the historical `ballot.closed` event remains.

Legacy ballots with no readable deadline remain open and are listed by the migration report. See [Scheduled transitions and the lifecycle scheduler](#scheduled-transitions-and-the-lifecycle-scheduler).

Amendment ballots have an explicit close action.

### 9. Result recording

An officer records a result through `POST /api/admin/ballots/result`. Requirements:

- matter in `decide`;
- a bound revision;
- `ballots.record_result` at the authority branch;
- matching governance authority and jurisdiction;
- result `successful`, `unsuccessful` or `inconclusive`;
- an external `decisionEventId`.

The record is immutable, one per ballot, and certifies the ballot. The tally is available for display but is **not** compared with the result.

### 10. Formal decision processing

The formal decision is the ballot result. It creates a `governance_events` `decision.recorded` entry. Moving to Implement is a separate workflow transition that checks for a successful result on the exact revision.

### 11. Ratification

For a **policy** matter only, a national officer may ratify:

- matter must be in `implement`;
- a `ballot_results` record must exist for the exact revision with `successful`;
- the supplied `decisionEventId` must match the recorded one;
- the authority must be a recognised branch;
- an `Idempotency-Key` is required;
- optional adopted amendment IDs must each be `accepted` with matching base and approval revisions;
- a resolution is rejected with 409.

Ratification writes a `policy_registry` record with `status: "adopted"` and `publicationStatus: "unpublished"`. It may create a composite ratified revision containing adopted amendments.

### 12. Publication

Publication requires a ratified record, a revision, a ratification decision event and `policies.publish`. It writes a `publication_events` row and marks the registry record `published`. Only published records appear on `/policies/` and `/api/v1/`.

### 13. Implementation tracking

The `implement` stage and `implementationNote` record what happened. Implementation is descriptive; it does not create a separate policy record.

### 14. Archival and supersession

Archiving preserves the record. Supersession links a published policy to a successor. Withdrawal removes a policy from current authority while retaining history.

- Supersession requires a published source and an **adopted** successor (not necessarily published), and detects cycles.
- Withdrawal requires a published policy, a reason and an idempotency key.
- Neither deletes the registry record or its events.

## Scheduled transitions and the lifecycle scheduler

The schedule is defined once, in `src/lib/lifecycle-schedule.ts`:

| Constant | Value | Decision |
|---|---|---|
| `DELIBERATION_PERIOD_DAYS` | 30 | D4 |
| `BALLOT_PERIOD_DAYS` | 30 | D6 |
| `MAXIMUM_SCHEDULE_DAYS` | 60 | D7 |

Durations are elapsed 24-hour periods. Routes, scripts and copy import these constants rather than restating the numbers.

### Automatic advancement (D4, D5, D7)

A system actor, `system:lifecycle-scheduler`, moves a matter from Deliberate to Decide when `deliberationEndsAt` has passed. For each due matter it:

1. requires a `secondedAt` anchor and refuses if the 60-day ceiling has already passed;
2. refuses while any amendment is unresolved (see below);
3. binds the **latest immutable proposal revision**, refusing if existing votes reference a different revision;
4. sets `ballotClosesAt = secondedAt + 60 days` and records `ballotRevisionBoundBy = system:lifecycle-scheduler`;
5. writes one `proposal.stage_transition` event with `trigger: "scheduled_deliberation_deadline"`, the actor, and both deadlines in metadata.

It does not require or grant `ballots.bind`. A human advancing early still needs `ballots.bind` and matching authority; that gate is unchanged (D5).

**Blocking amendments.** The blocking set is defined by exclusion and fails closed: `rejected`, `withdrawn`, `applied`, `not-endorsed` and `inconclusive` are the only non-blocking statuses. Everything else — `proposed`, `stale`, `conflict`, `ready`, `voting`, `endorsed`, `accepted`, or an unrecognised value — blocks the schedule and is reported with its amendment IDs. A `ready` or `accepted` amendment has been approved but not yet applied, so advancing would bind wording members have not deliberated on.

### Idempotency and concurrency

Scheduled writes use a conditional filter that repeats the candidate query (`{stage: "deliberate", deliberationEndsAt: {$lte: now}}`), so only one of any number of concurrent runs can move a matter. The event ID is deterministic — `sched:advance:<proposalId>:<deliberationEndsAt ISO>` and `sched:close:<proposalId>:<ballotClosesAt ISO>` — and the `governance_events.eventId` unique index plus `recordGovernanceEventOnce` make a replayed run a no-op. The state change and its event are written in one transaction on MongoDB.

### Running the scheduler

```sh
npm run governance:scheduler              # dry run (default): report only
npm run governance:scheduler -- --apply   # perform the transitions
```

The command prints a JSON report with `advanced`, `skipped`, `closed`, `blockers` and `errors`, plus counts. It requires `MONGODB_URI` and fails loudly without it; it never falls back to the in-memory development database. There is no daemon: run it from the deployment's existing cron or job runner and treat a failed run as an operational alert.

Report reason codes:

| Bucket | Reason | Meaning |
|---|---|---|
| `skipped` | `already_advanced` | A concurrent run won the conditional update |
| `skipped` | `stage_changed` | A human changed the stage first |
| `skipped` | `no_current_revision` | The matter has no immutable wording to bind |
| `skipped` | `invalid_deadline` | A closure candidate has an unreadable deadline |
| `blockers` | `blocking_amendments` | Unresolved amendments (IDs included) |
| `blockers` | `ballot_revision_conflict` | Existing votes are not bound to the current wording |
| `blockers` | `scheduled_ballot_deadline_passed` | The 60-day ceiling has passed; an officer must re-open with an explicit date |
| `blockers` | `missing_schedule_anchor` | `secondedAt` or `deliberationEndsAt` is missing; no clock to trust |
| `errors` | — | Unexpected failure; the run exits non-zero |

### Failure behaviour

| Situation | Behaviour |
|---|---|
| Scheduler is not run | Nothing advances or closes. The next run catches up; deadlines are absolute, not relative to the run |
| Scheduler runs twice | The second run reports `already_advanced` or records no second closure |
| Scheduler runs after the 60-day ceiling | Advancement is refused and reported; no unvotable ballot is opened |
| Unresolved amendment at the deadline | Advancement is refused and reported; a human must resolve it |
| Officer advanced before the deadline | The scheduler finds nothing to do; normal closure applies at the officer-set deadline |
| Ballot closes | Voting and vote changes are refused; no result or stage change is implied |
| Ballot has no deadline (legacy) | It remains open; the migration report lists it |

### Legacy migration reporting (read-only)

```sh
npm run governance:migration-report
```

Prints a JSON report, and writes nothing, listing:

- open proposal ballots, open amendment ballots and `ballots` projection rows with a missing or malformed deadline;
- proposals in Deliberate with no `deliberationEndsAt`.

Recovery is manual and audited: an officer sets an explicit future deadline, closes an amendment ballot through its close action, or advances a never-seconded matter explicitly with `ballots.bind`. Backfilling a seconder or a deliberation deadline would fabricate a governance act and is not performed by any script. The report states these options in its own output.

## Variants

### Policy proposal

```
Propose → Deliberate → Decide → Implement → (ratify) → (publish)
                                      └→ supersede / withdraw later
```

A policy can be ratified and published. It can adopt formally accepted amendments into a composite revision. It is the only type that enters the Policy Registry.

### Governance resolution

```
Propose → Deliberate → Decide → Implement → archived
```

A resolution has deliberation, amendments and ballots, but no ratification and no publication. Its outcome is recorded on the matter and in governance events. Attempting to ratify returns 409.

### Amendment ballot

```
proposed/stale/conflict → ready/rejected/withdrawn
ready → voting → endorsed/not-endorsed/inconclusive
endorsed → accepted → applied
```

An amendment ballot runs only while the parent matter is in `decide` and the amendment's base equals the matter's ballot revision. It shares the matter's deadline. The result is an endorsement decision, not adoption: formal acceptance and application are separate acts.

### Consultation

The ballot model reserves a `consultation` purpose, but no production consultation workflow is implemented. Do not describe one as available.

## Protected acts versus workflow states

| Act | Type | Who | Record |
|---|---|---|---|
| Create matter | Participation | Verified member | Proposal + revision |
| Second a proposal | Participation | Verified member who is not the author | `secondedBy`, `secondedAt`, `deliberationEndsAt`, event |
| Comment / endorse | Participation | Verified member | Comment record / upvote event |
| Submit amendment | Participation | Verified member | Amendment + amendment revision |
| Advance to Deliberate | Workflow | Staff or origin branch admin | Stage change, lifecycle event |
| Resolve amendment | Workflow | Branch/national administrator | Amendment revision + decision |
| **Bind ballot wording** | **Governance** | `ballots.bind` + matching authority | Binding event |
| **Open Decide** | **Governance** | Human: `ballots.bind` + matching authority. System: deliberation deadline | Stage change + event |
| Cast vote | Formal participation | Eligible verified voter | Vote record |
| **Record result** | **Governance** | `ballots.record_result` + matching authority | Immutable ballot result + event |
| **Advance to Implement** | **Governance** | Staff/origin branch admin, successful result required | Stage change |
| **Ratify** | **Governance** | `policies.ratify` (national) | Registry record |
| **Publish / withdraw / supersede** | **Governance** | `policies.publish` (national) | Publication event + registry state |
| Record ballot closure | Scheduled governance record | `system:lifecycle-scheduler` at the deadline | `ballot.closed` event + `ballotClosedAt` |
| Archive | Workflow | Staff/origin branch admin | Stage change |

A workflow state can be reversed. A protected act cannot: later corrections are new records.

## Failure and exception paths

| Situation | Current behaviour |
|---|---|
| No revision exists when entering Decide | Transition refused; create/save the proposal first |
| Branch actor's authority and jurisdiction differ | Transition to Decide refused |
| Ballot has no deadline (legacy record) | It remains open; the migration report lists it and the scheduler never closes it |
| Ballot deadline passes | Votes and vote changes refused; the scheduler records `ballot.closed` once, with no stage change or result |
| Deliberation deadline passes with unresolved amendments | The scheduler refuses to advance and reports the amendment IDs |
| Scheduler runs late, past the 60-day ceiling | Advancement refused and reported; an officer must re-open with an explicit date |
| Proposal in Deliberate without a seconder | Never advances automatically; the migration report lists it |
| Result recorded without a tally | Allowed; result is officer-supplied |
| Matter returned to Deliberate after a ballot, wording edited, then returned to Decide | Existing `ballotRevisionId` is retained; a zero-vote ballot is rebound to the new revision on re-entry, a voted ballot is refused rather than silently rebound |
| Amendment base no longer latest | Amendment becomes `stale`; applying requires a current base |
| Two amendments change the same field | Both can be `ready`; no inter-amendment conflict detection; both block the scheduler |
| Ratifying authority differs from the ballot result's authority | Not cross-checked |
| Superseded policy's successor is unpublished | Public page may link to a policy that is not visible |
| CRM unavailable during verification | Retryable failure; membership not revoked |

## What is deliberately missing

- Thresholds, quorum, turnout, tie-breaking, abstention and non-voter rules.
- Notice periods, campaign windows and scheduled ballot opening.
- Eligibility snapshots at ballot open.
- A hard seconding gate on Propose → Deliberate, competing seconders, and renewed seconding after a material wording change (see the assumption under Deliberation).
- Confirmation ballots or multiple ballot instances per matter.
- Automatic ratification.
- Preferential amendment resolution.
- A proposal-ballot close operation that closes a ballot before its deadline. D12 defers mathematically-irreversible early closure.
- A second result-validation step comparing the tally with the recorded result.

Automatic advancement at the deliberation deadline and automatic closure at the ballot deadline are now implemented (D4–D7). Scheduled opening remains missing: the clock starts at seconding and the ballot opens when a human advances early or the scheduler advances at the deadline.

These are not bugs to be quietly "fixed" with a guessed rule. Each requires a governance decision. See [status/known-gaps.md](../status/known-gaps.md) and `docs/engage-product-direction-governance-audit-2026-11-07.md` (G1–G21).
