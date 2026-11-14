# Agent guide

**Status:** Current · **Verified:** 13 November 2026

This page is for autonomous coding agents. It assumes you can read code but not the history. Read it before editing.

## Orientation in five minutes

1. `AGENTS.md` — non-negotiable UX, governance, Git and verification rules.
2. `docs/product/overview.md` — what the product is and is not.
3. `docs/domain/governance-model.md` — the five authorities and eligibility rules.
4. `docs/domain/governance-lifecycle.md` — stage and act semantics.
5. `docs/status/known-gaps.md` — what is already broken; do not "rediscover" it as new work.

Then open the files you intend to change. Do not plan from documentation alone.

## Canonical file map

| If the task concerns… | Start here |
|---|---|
| Proposal CRUD, stages, revisions | `src/lib/store.ts`, `src/lib/matters.ts`, `src/lib/proposal-revision.ts` |
| Comments, stances, feedback | `src/lib/store.ts` (`addComment`, `setCommentFeedback`) |
| Amendments | `src/pages/api/amendments.ts`, `src/pages/api/admin/amendments/*`, `src/lib/amendments.ts` |
| Ballot binding/results | `src/lib/ballot-binding.ts`, `src/lib/ballots.ts`, `src/pages/api/admin/ballots/*` |
| Votes | `src/lib/store.ts` (`castVote`), `src/lib/vote-storage.ts`, `src/lib/ballot-crypto.ts` |
| Eligibility | `src/lib/branch-participation.ts` (`getProposalEligibility`) |
| Branches/following | `src/lib/branch-participation.ts`, `src/pages/api/member/branches.ts` |
| Verification/CRM | `src/lib/membership-verification.ts`, `src/lib/underground-crm.ts` |
| Auth/session | `src/lib/auth.ts` |
| Roles/permissions | `src/lib/rbac.ts`, `src/lib/roles-store.ts` |
| Policy registry | `src/pages/api/admin/policies/*`, `src/lib/public-api.ts` |
| Public API | `src/pages/api/v1/*`, `src/lib/api-contracts.ts`, `src/lib/public-api.ts` |
| Notifications/email | `src/lib/notifications.ts`, `src/lib/engagement-email.ts`, `src/lib/web-push.ts` |
| Persistence/indexes | `src/lib/db.ts`, `src/lib/migrations.ts` |
| UI primitives | `src/components/ui/*`, `src/components/admin/*`, `DESIGN.md` |
| Deployment | `Dockerfile`, `docker-compose*.yml`, `.github/workflows/*`, `deploy/` |

## Task routing

| Task | Approach |
|---|---|
| "Add a field to a proposal" | Decide if it is wording (hashed) or metadata. Update `types.ts`, normalisation, DTOs, forms, revision hashing only if wording, and tests. |
| "Change who can vote" | Change `getProposalEligibility` and the tests that prove followers/admins cannot vote. Update the governance model. Do not change UI first. |
| "Add an admin action" | Route → service → audit event → permission key. Use the catalogue, not a new `isAdmin` flag. |
| "Fix a stale page" | Find the service that owns the data; do not patch around it in the template. |
| "Add a notification" | Topic + channel consent + dedupe + template + preference UI + test. |
| "Add an integration" | Adapter in `src/lib/integrations.ts`, explicit env, failure behaviour, docs, feature flag. |
| "Improve a screen" | Follow `AGENTS.md`; use primitives; verify at 390 px and desktop. |
| "Fix a security bug" | Reproduce in a test first; enforce in the service, not only the route. |

## Non-negotiable invariants

- Never let a role, staff flag or branch office create ballot eligibility.
- Never let a follower vote in a branch ballot.
- Never let branch authority operate outside its branch.
- Never let a national grant be satisfied by a branch grant.
- Never bind a ballot to ambiguous wording.
- Never reinterpret existing votes after an edit.
- Never mutate a revision, ballot result, ratification or publication event.
- Never let a governance resolution enter the Policy Registry.
- Never expose identifiable ballots outside `canViewIdentifiableBallots`.
- Never compute a result, threshold, quorum or tie-break without an approved rule.
- Never return a raw MongoDB document from an API.
- Never put governance rules in a React component.
- Never claim verification you did not perform.

## Traps

### Documentation drift

These documents are known stale or contradictory:

- `README.md` historically described `/policies/` as the 76-policy voting surface. That is wrong: `/policies/` is the published registry; the seed lives at `/proposals/`. This set corrects it.
- `docs/operations.md` references removed endpoints and scripts.
- `docs/engage-legal-privacy-review-2026-11-08.md` predates CRM verification and Plausible; its "not implemented" list is stale.
- `docs/coolify-deployment.md` has an out-of-date status banner.
- `docs/member-engagement.md` contains an older deadline than `ballot-deadline.ts`.
- ADR 0003 describes a transactional ballot-admission protocol that the current `castVote` does not implement.

Always check code before repeating a documentation claim.

### The stage table is partly declarative

`matters.ts` declares `requiredPermission` and `authorityKind`, but `saveProposal` does not enforce `requiredPermission`. The real gates are staff/branch-admin status plus explicit guards. Do not assume the table is the enforcement.

### Ballot rebinding

`ballotRevisionId` is not cleared when a matter returns to Deliberate. If wording changes and the matter re-enters Decide, the old binding is retained. Do not "fix" this by silently rebinding existing votes; that would reinterpret them. Treat it as a governance decision.

### No proposal-ballot close endpoint

Proposal ballots close by deadline, not by an officer action. No API sets `ballotClosesAt` for a new ballot. Amendment ballots have an explicit close. Do not add a close endpoint that bypasses the deadline or writes a result.

### Result is computed and checked

The officer supplies `successful`, `unsuccessful` or `inconclusive`, and the result must match the outcome computed from the votes bound to the ballot and revision. The only encoded rule is D9: approve greater than reject approves, a tie and zero votes do not, and abstentions never change the comparison because no abstention denominator is defined (D10/O1). No quorum or turnout applies (D8). The basis is versioned as `simple-majority-d9-v1`.

A contradicting result is accepted only as an explicit override with a written reason, and the override is stored on the result and in the `decision.recorded` event. Do not add a threshold, quorum, abstention denominator or ranked-choice rule without a recorded maintainer decision — see the decision register open items O1 and O2.

### Permission keys are not all wired

`proposals.delete`, `comments.moderate`, `proposals.view_archived`, `proposals.manage_supersession`, `amendments.resolve`, `amendments.apply`, `branches.manage` and `sense_box.review` are declared but several routes use legacy flags. Do not assume granting a custom role those keys changes behaviour. If you wire one, test it and update the RBAC docs.

### No middleware

There is no `src/middleware.ts`. Every route authenticates itself. A new endpoint without an explicit check is public. There is no default deny.

### In-memory database lies

The development fallback ignores projections and indexes and has no transactions. A test passing in memory does not prove production uniqueness or atomicity.

### Development auth

The dev cookie works only in `development`, `test` or `preview`. It is ignored in production. Do not add a bypass for "staging" or a missing `APP_MODE`.

### Inert flags

`ENGAGE_PUBLIC_PULSE_POLL` and `FORMAL_BALLOTS_ENABLED` do not implement features. Do not build UI that implies they do.

### Unwired notifications

`dispatchMemberNotification` has no production caller. Wiring it is a product change: decide which governance events should notify whom, add dedupe and preferences, and test.

## Safe change recipes

### Add a metadata field to a matter

1. Add it to `ProposalRecord` and `normalizeProposalDoc`.
2. Add it to the create/update payload and admin form.
3. Add it to the relevant API DTO if members should see it.
4. Decide whether it is locked after a ballot opens. Governance coordinates are locked; a display note may not be.
5. Add a migration only if existing records need a value.
6. Update `docs/domain/domain-model.md` if it is a new concept.

### Change eligibility

1. Write a failing test in `branch-participation.test.ts` for the new electorate and for the excluded cases.
2. Change `getProposalEligibility` in one place.
3. Update the ballot UI's explanatory state; do not add a client-side eligibility rule.
4. Check `castVote` still checks the returned eligibility.
5. Update `docs/domain/governance-model.md` and the capability matrix.
6. State the rule source. If there is none, stop.

### Add a governance audit event

1. Identify the act and its stable identifiers (matter, ballot, revision, actor, authority).
2. Write through `recordGovernanceEvent` or the owning service's event collection.
3. Make it append-only and idempotent where retries are possible.
4. Add a test that reads the event back.
5. Never log a vote choice or a secret.

### Add an API route

Follow the checklist in [architecture/api-and-authorisation.md](../architecture/api-and-authorisation.md#adding-an-endpoint). At minimum: session, explicit permission, validation, service call, allowlist DTO, error mapping, tests.

### Fix a UI defect

1. Reproduce it in the rendered app if possible.
2. Identify whether the cause is data, authorisation, copy or layout.
3. Use an existing primitive and variant.
4. Check keyboard focus, mobile width and dark mode.
5. Run the raw-control audit.
6. Do not broaden the change into a redesign.

## When to stop

Stop and ask a human if:

- the correct rule depends on Fusion's constitution or an unresolved decision;
- a change would reinterpret existing votes, revisions or results;
- a change would let an administrator vote, certify their own ballot, or cross branches;
- a migration would rewrite governance history;
- you need a new external service or credential;
- the only way to make the UI work is to expose raw technical data;
- tests require a decision about thresholds, quorum, notice or eligibility that is not written down.

A documented gap is a valid outcome. A guessed rule is not.

## Verification commands

```sh
pnpm check
pnpm test
pnpm build
rg -n '<(button|select|input|textarea|table|dialog)\b' <changed-files>
rg -n 'text-(amber|red|green|blue|slate|zinc|gray)-[0-9]' <changed-files>
git diff --check
git status --short
```

For real MongoDB:

```sh
export VOTING_TEST_MONGODB_URI=...
export AUTH_TEST_MONGODB_URI=...
pnpm test
```

## Final report format

Report:

- **Changed** — in user-facing terms, not a file list.
- **Verified** — commands, results, and what was not verified.
- **Unresolved** — defects, decisions needed, operational requirements.
- **Commits** — hashes and deployment status where relevant.

Do not write a narrative of everything you read. Do not claim a browser check you did not perform.
