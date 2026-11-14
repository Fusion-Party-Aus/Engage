# Orchestrator handover — RFC 0001 Phase 2

**Written:** 14 November 2026
**For:** the next agent orchestrator
**Repository:** Fusion-Party-Aus/Engage
**Branch at handover:** `feat/rfc0001-sprint1-integration` @ `8d50cd3` (this brief is a later docs-only commit on the same branch)
**Open PR:** [#51](https://github.com/Fusion-Party-Aus/Engage/pull/51) — ready for review, **not merged, not deployed**

This brief is the operating context for taking over the programme. It is not a
substitute for the repository records listed below; it tells you where the
programme actually is, what has already gone wrong, and how to continue without
repeating the work or weakening a governance guarantee.

> **Status update — 15 November 2026.** PR #51 was merged to `main` as `3b36947`
> on 14 November 2026, including the review fixes. The merge gate in §2 is
> satisfied: Phase 2 work branches from `main`. Statements below that describe
> #51 as unmerged are historical and were true when this brief was written.
> #55 is implemented and its migration is documented in
> [ballot-results-index-migration.md](../ballot-results-index-migration.md).

---

## 1. Read these first, in this order

1. `AGENTS.md` — normative product, governance, UI and Git rules. It outranks this brief.
2. `docs/governance/decision-register.md` — canonical maintainer decisions D1–D33 and open questions O1–O10.
3. `docs/status/rfc0001-programme-tracker.md` — every RFC recommendation mapped to an issue, state and evidence.
4. `docs/status/sprint1-integration-report.md` — what was integrated, what conflicts were resolved, and the verification limits.
5. `docs/status/known-gaps.md` — live defect and risk register.
6. `docs/rfc/0001-participatory-governance-platform-evolution.md` — the programme source document.
7. `docs/status/rendering-performance-audit.md`, `docs/security/turnstile.md`, `docs/domain/governance-lifecycle.md` — the three newest slices in detail.

The tracker and GitHub issues are authoritative for progress. Do not treat this
brief, a conversation, or a subagent's summary as the source of truth.

---

## 2. Handover state

### Open pull request

PR #51 contains, in reviewable commits:

- Sprint 1 integration: governance integrity (#26, #50), CRM membership (#32), RBAC authority (#27, #31).
- RFC source document, decision register, tracker, integration report.
- Phase 1 lifecycle: seconding, 30-day deliberation, system advancement, 30-day ballot default, automatic closure, scheduler, migration report.
- Rendering performance: harness, audit, session reuse, projections, query batching, deferred secondary panels, hydration changes.
- Turnstile and abuse protection: server verification, shared rate limiting, widget, docs.

### Verification evidence at handover

- `npm run check`: 0 errors, 0 warnings.
- `npm test` with a MongoDB 8.0 replica set: **368 tests, 368 pass, 0 fail, 0 skipped**.
- `npm run build`: complete.
- Browser: `scripts/rfc0001-governance-browser.mjs` passes seconding → deliberation → ballot with default deadline → vote → vote change, rejects a past deadline, asserts the editor shows the real stage, and reports no page or console errors.

These numbers apply to `8d50cd3`. Re-run them after any change; never reuse them
as evidence for a later commit.

### Local environment facts

- MongoDB used for verification: Docker container `engage-sprint1-mongo`, `mongo:8.0`, single-node replica set `engage-sprint1`, `127.0.0.1:27017`.
- Export before running persistence tests:

  ```sh
  export VOTING_TEST_MONGODB_URI='mongodb://127.0.0.1:27017/?directConnection=true'
  export AUTH_TEST_MONGODB_URI='mongodb://127.0.0.1:27017/?directConnection=true'
  ```

- If the container is missing:

  ```sh
  docker run -d --name engage-sprint1-mongo -p 127.0.0.1:27017:27017 \
    mongo:8.0 --replSet engage-sprint1 --bind_ip_all
  # then initiate the replica set once via mongosh or the driver
  ```

- Playwright is not an application dependency. For browser verification, install it in a temporary prefix and point `ENGAGE_PLAYWRIGHT_MODULE` at its `index.mjs`; install the matching Chromium build with `npx playwright install chromium`.
- The temporary Playwright directory and the Mongo container are local artefacts. They may not exist on another machine or after a restart.
- `RFC_RESPONSE.md` at the repository root is the maintainer's raw questionnaire response. It is untracked. Do not delete it; its substance is captured in the decision register.
- Subagent worktrees were removed after integration. The branches remain:
  `fix/sprint1-governance-integrity`, `fix/sprint1-membership-crm`, `fix/sprint1-rbac-authority`, `feat/phase1-lifecycle`, `perf/rendering-investigation`, `feat/turnstile-abuse-protection`.

### Merge gate

Do **not** merge #51 or deploy. It requires human review. Once it is merged:

1. Rebase or recreate Phase 2 branches on the new `main`.
2. Update links in the tracker and this brief from the PR to `main`.
3. Do not re-open the already-merged slices as new PRs.

---

## 3. Governance invariants — do not weaken these

These are enforced in code and tests. A refactor that loses one is a defect, even
if every test still passes because the test was changed to match.

1. **Eligibility is evaluated when a vote is cast.** No electorate snapshot (D2).
2. **Eligible members may change their vote while the ballot is open** (D11).
3. **Human entry into Decide requires `ballots.bind`** (D5). Ordinary moderators do not gain it.
4. **The lifecycle scheduler is a system actor**, not an officer. It must never require or be granted `ballots.bind`. It identifies as `system:lifecycle-scheduler` (D4).
5. **Seconding is the act that opens Deliberate.** A verified non-author seconds once; officer transitions into Deliberate are refused without a recorded seconder (D3).
6. **Deadlines are scheduled and audited.** No proposal or ballot may be opened without a future close, and closure must be recorded once (D6, D7).
7. **Formal results, certification and audit events are atomic.** Result recording is idempotent and refuses conflicting replacement (I5).
8. **Revision binding is explicit.** Never rebind silently when votes exist. Zero-vote returns clear the binding and record it (I7).
9. **Historical governance records are not deleted.** Matters with revisions beyond the initial draft, votes, ballots, results or registry records cannot be hard-deleted (I1).
10. **Identifiable ballot choices stay behind `canViewIdentifiableBallots`.** No public API, log, list, export or UI may expose them (D26).
11. **Server-side authorisation is authoritative.** UI visibility is not authority.
12. **No invented governance rules.** Do not invent quorum, turnout, abstention effects, ranked-choice method, notice periods, confirmation ballots, election procedure or publication authority. Use O1–O10 and stop at the seam.
13. **No fabricated history.** Do not backfill adoption dates, ballots, results or publication events. Do not import or map National Neon policy (#36, D33).
14. **Ambiguous wording is never automatically ratified.** Every adopted text must derive reproducibly from immutable revisions and amendment outcomes (D19, D20).

When a change touches one of these, write the governance test first, then the
implementation, then update the decision register or open a decision.

---

## 4. What is implemented, and what is only partly implemented

### Done and verified

- Sprint 1 integrity, CRM and RBAC slices.
- Seconding with a member-facing control; scheduled advancement; automatic closure; scheduler CLI; legacy deadline report.
- Ballot deadlines, revision binding/unbinding, atomic formal results.
- Turnstile on magic-link, sign-up (if enabled) and Sense Box; shared Mongo rate limiting.
- Rendering performance first slice, with a repeatable harness.
- Admin select controls now show saved values (see traps below).

### Partial — do not describe as complete

| Area | What is missing |
|---|---|
| Ballot outcome rules (#28) | A computed Yes-vs-No check with an audited override is not built. Abstention denominator (O1) is undecided. The current result is officer-supplied. |
| Ballot-results migration (#55) | **Resolved 15 November 2026.** Startup is a no-op or a report; preflight, backup, verified apply and recovery are documented. |
| Notifications (#33) | `dispatchMemberNotification` still has no production caller. Scheduled transitions notify nobody. |
| Security perimeter (#38) | Turnstile and rate limiting only. CSP, HSTS, frame/content-type headers, full CSRF/Origin coverage remain. |
| Observability (#39) | No metrics, traces or alerting. Scheduler and Turnstile failures are visible only in logs. |
| Command layer (#53) | No typed governance commands or central route policy. `store.ts` is still a god module. |
| Decision record (#54) | No complete member-facing lineage view or administrator responsibility queue. |
| Rendering performance (#52) | Admin register is still ~1 MB HTML; per-vote decryption and full vote scans remain on list reads; React remains on the signed-in header path. |
| Membership (#32) | No unique `(branchId, memberId)` index or duplicate-resolving migration. |
| Legacy lifecycle records | Proposals already in Deliberate without `secondedAt` never auto-advance. They are reported, not rewritten. A human decision is needed. |

---

## 5. Known traps discovered the hard way

These caused real failures in this programme. Check for them before shipping
similar work.

1. **Astro + React select controls.** Astro renders React slot children as raw HTML, so React never sees `<option>`s and cannot apply `defaultValue`. Every `NativeSelect` must put `selected={...}` on the matching option. The first implementation silently reset proposal stages, cleared provenance, set members to pending, and applied the wrong filters. The admin editor and E2E now guard the stage case; audit any new select.
2. **Hydration mismatches on time-dependent text.** The ballot deadline rendered a server date and a client relative time in the same text node, causing React #418. Use stable server text and `suppressHydrationWarning` only on genuinely time-dependent nodes.
3. **MongoDB path conflicts.** Setting and unsetting the same field (`provenance`) in one update fails against real MongoDB. Keep `$set` and `$unset` mutually exclusive.
4. **In-memory DB is not evidence.** `createMemoryDb` does not prove transactions, indexes or conditional-write concurrency. Persistence-sensitive tests must use the replica set.
5. **`runInTransaction` falls back silently** when the `Db` has no client. That is acceptable for memory tests, not for verifying production atomicity. Add replica-set cases for anything consequential.
6. **Single-node replica set contention.** Running several full suites concurrently against `engage-sprint1-mongo` can wedge it and produce 30–115 s timeouts and connection resets. Serialise heavy suites, or give each agent its own Mongo container/port. If tests fail with mass timeouts, check `docker logs` and restart the container before believing the code is broken.
7. **Session caching must stay per request.** `getSessionUser` caches against the `Request` object only. Do not move it to a module global; role revocation must remain immediate on the next request.
8. **Server islands still need authorisation.** A deferred panel receives serialised props; it must re-resolve the session and re-check `canViewIdentifiableBallots` and scope. Never defer eligibility, ballot state or an authorisation decision.
9. **Scheduler cannot recover a very late run.** Past the 60-day ceiling it refuses and reports. That is deliberate; do not silently open an already-expired ballot.
10. **Turnstile fails closed in production.** Without both keys, protected routes return 503. Provision keys before deploying, and allow `challenges.cloudflare.com` when CSP lands.
11. **Subagent reports are not evidence.** Re-read the diff, rerun the suite, and check the assumptions. One subagent implemented seconding as a clock-only act; that would have allowed indefinite stalling and was corrected during integration.
12. **Git history contains the three Sprint 1 branches.** Do not recreate them. If a conflict appears, inspect the merge rather than regenerating the work.

---

## 6. Phase 2 scope and recommended sequence

Phase 2 is not “do everything at once”. The safe order is below. Each slice gets
its own branch, tests, docs and PR sized for review.

### Stage 0 — land the foundation

1. **Human review of #51.** Do not start competing implementations on `main` first.
2. **#55 ballot-results migration safety.** Preflight, dry run, backup, verify, recovery. This is a production blocker and should be the first new PR.

### Stage 1 — finish Phase 1 correctness

3. **Computed outcome validation (#28).** Compare the stored tally: Yes greater than No is successful, a tie is not. Require an audited override to record a contradicting result. Do **not** decide abstentions or quorum.
4. **Real-MongoDB governance coverage.** Add replica-set cases for the deletion guard, transition-event atomicity and result idempotency where they are currently only exercised in memory.

### Stage 2 — architecture, serially

5. **Typed governance command layer and central route policy (#53).** One domain at a time, starting with ballot lifecycle commands, then proposals, then membership. Do not run a competing refactor in parallel. Rebase the query-shape changes from #52 (`includeDetails`, `listOutstandingDecisions` member votes, `listUserActivities` inputs) rather than creating a second read layer.
6. **Read models and pagination (#52 remainder, #54).** Paginate the admin register; add a tally projection so list pages stop scanning and decrypting every vote; lazy-load editor text; then build the decision record and responsibility queue.

### Stage 3 — operational completeness

7. **Notification outbox (#33) and durable job runner.** Scheduled transitions, ballot closure and outcomes should produce durable in-app/email notices with dedupe, preferences and a delivery record. Decide what is essential versus engagement.
8. **Observability and scheduler operations (#39).** Metrics and alerts for missed scheduler runs, Turnstile misconfiguration/unavailability, failed email and queue depth. Wire the scheduler to a monitored cron.
9. **Remaining perimeter work (#38).** CSP/HSTS/frame/content-type headers, general API rate limiting, complete CSRF/Origin coverage.
10. **Performance follow-ups (from the audit).** Remove React from the signed-in header path; tally read model; short-TTL caching for stable public reads only. Never cache member or ballot state.

### Stage 4 — product and governance capabilities

11. Remaining Phase 3 product work: decision records, following, admin queues, role administration UX, amendment/revision comparison, Horizon consistency.
12. Phase 5 governance features only where O1–O10 are decided: automatic ratification, collision-resolution ballots, amend/repeal, public proposal API, elections.

**Do not start** ranked-choice or collision ballots, abstention-dependent outcomes, election-officer roles, identity migration, or the National Neon import before the corresponding decision exists.

---

## 7. Parallelisation rules

Good candidates for parallel subagents:

- Documentation truth pass and contract tests.
- Independent accessibility or Horizon token audits.
- A self-contained security header module once the policy is written.
- Read-only audits (performance, data quality, permission usage).

Serialise anything that touches:

- `src/lib/store.ts` governance mutations,
- ballot binding or vote persistence,
- formal result or audit schema,
- amendment state transitions,
- ratification,
- `src/lib/db.ts` indexes or transactions,
- lifecycle stages.

If two slices need the same invariant, one owns it and the other waits.

### Subagent contract

Use `git worktree add` for each workstream. Tell the subagent explicitly:

- its absolute worktree path and branch;
- that it must `cd` there for every shell command and use absolute paths for file tools;
- that it must never modify the main repository, push, merge or deploy;
- the bounded scope, issue references, acceptance criteria and files it owns;
- that it must run `npm run check`, `npm test` with the replica-set URI, `npm run build`, and browser tests for UI changes;
- that it must commit in Conventional Commits and report files, commits, exact test results, assumptions, unresolved decisions and anything not verified.

`node_modules` can be symlinked from the main checkout for a worktree, or installed
with pnpm. Remove the symlink before removing the worktree.

---

## 8. Verification playbook

```sh
export VOTING_TEST_MONGODB_URI='mongodb://127.0.0.1:27017/?directConnection=true'
export AUTH_TEST_MONGODB_URI='mongodb://127.0.0.1:27017/?directConnection=true'

npm run check
npm test
npm run build

# Browser governance journey (needs Playwright + the Mongo URI)
ENGAGE_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
  node scripts/rfc0001-governance-browser.mjs

# Rendering performance (build first)
ENGAGE_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs npm run perf:render -- \
  --json docs/status/rendering-performance-after.json

# Scheduler and legacy report (dry run is the default)
npm run governance:scheduler
npm run governance:migration-report

# Raw-control audit for changed files
rg -n '<(button|select|input|textarea|table|dialog)\b' <changed-files>
```

For UI work, verify at 390×844 and 1440×1000, keyboard focus visibility, empty/error/success states, and console errors. A passing API test is not UI verification.

---

## 9. Open governance decisions

Do not guess these. Implement only the decided part, leave a seam, and record the
question.

| ID | Question |
|---|---|
| O1 | Effect of abstentions on the denominator, if any |
| O2 | Ranked-choice method, tie handling, ballot timing, original-wording treatment, collision grouping |
| O3 | Confirmation ballot or notice period for any policy class |
| O4 | Election/Returning Officer role and separation of duties |
| O5 | Shared Fusion identity platform |
| O6 | A correct model for irreversible-outcome early closure |
| O7 | Legal document approval and acceptance-gate activation |
| O8 | Steward role model and who may be designated |
| O9 | Whether staff may create directly in Deliberate/Decide without a seconder |
| O10 | Whether materially rewritten wording needs renewed seconding |

Deferred entirely: National Neon policy import (#36). Do not import, map, backfill, publish or fabricate relationships for it.

---

## 10. First ten actions for the new orchestrator

1. Verify you are on `feat/rfc0001-sprint1-integration` or a fresh worktree based on it; confirm `git status` is clean except `RFC_RESPONSE.md`.
2. Read the documents in §1, then `gh issue list --state open`.
3. Re-run the four verification commands in §8 against the current commit. Do not trust the handover numbers.
4. Confirm PR #51 is still open and unmerged. If it was merged, rebase and update the records instead of continuing on the old branch.
5. Check whether the Mongo container and Playwright module exist; recreate them if needed.
6. Open or refresh the issue for the first Phase 2 slice (#55), with preflight and recovery acceptance criteria.
7. Create a worktree and branch for #55. Implement the migration preflight and recovery first; no other agent touches `db.ts` concurrently.
8. In parallel, delegate only a read-only or documentation task (for example, a raw-control/Horizon audit or the stale-docs issue #44).
9. After #55, implement outcome validation (#28) with the decided Yes-vs-No rule and an audited override; leave abstentions untouched.
10. Update the tracker, known-gaps, decision register and changelog in the same commit as each behaviour change; report evidence, not intentions.

---

## 11. Definition of done for Phase 2

Phase 2 is complete only when:

- All new governance writes are typed commands with central route policy and tests proving authorisation, denial, idempotency and scope.
- Proposal list and admin register reads are paginated and projected; list pages no longer decrypt every vote.
- The decision record is complete and reproducible for zero- and one-amendment outcomes.
- Scheduled transitions and closures produce durable notifications with dedupe and a delivery record.
- The scheduler is monitored in production; missed runs and Turnstile failures alert.
- The ballot-results migration is preflighted, verified and recoverable.
- Security headers and CSRF coverage are complete, with residual risk documented.
- Performance improvements have before/after evidence and no governance regression.
- Every changed behaviour is reflected in the canonical docs; no stale contradiction remains.
- Full replica-set suite, typecheck, build and representative browser journeys pass on the final commit.

If a slice cannot meet this because a governance decision is missing, deliver the
decided seam, record the decision needed, and move to an independent slice.

---

## 12. Programme ledger rules

- The repository is the memory: tracker, decision register, known-gaps, issues, PR.
- Do not leave progress only in a conversation.
- Close an issue only against its acceptance criteria, with evidence, or with an explicit supersession note.
- Never claim browser, load, migration or deployment verification you did not perform.
- Prefer a smaller correct slice over a broad unverified one.
