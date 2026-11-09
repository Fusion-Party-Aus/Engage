# Branch participation and verified membership

This document describes the branch participation model introduced for Engage. It is written for maintainers and branch administrators. It does not expose implementation detail in member or administration interfaces.

## The member-facing model

Engage keeps two different facts apart:

| Fact | Who owns it | What it means |
| --- | --- | --- |
| Following a branch | The member (Engage-owned) | The member wants to see that branch’s proposals and activity. It grants discovery only. |
| Verified branch membership | An authorised branch administrator or trusted membership authority | The branch has recognised the person as a member. It can unlock member-restricted governance activities where the ballot rules allow it. |

Fusion National is included for every Engage account. National governance scope is not a verified branch membership and does not certify party membership. National ballots still require a verified Engage account, and each ballot keeps its own eligibility rules.

Visible labels are **Follower** and **Member**. Following never grants formal voting rights. A verified member remains a verified member if they stop following branch updates; following is a preference, membership is an organisational fact.

## What members see

- Onboarding includes an optional **Your branches** step. Fusion National is included, state/territory and local branches can be selected, and the step can be skipped. A local draft keeps progress if the visit is interrupted.
- **My Engage → My branches** lists the branches a person follows or where their membership is verified, distinguishes Member from Follower, and allows immediate follow/unfollow changes.
- Existing members with no branch connection are silently given National scope on their next visit. They then see a small, dismissible invitation to add their state branch. This is a following preference, not a membership record.
- A restricted ballot explains why the person cannot vote. For example: “Voting is limited to verified Fusion Victoria members. You follow this branch, so you can read and follow its proposals, but following does not grant formal voting rights.”

## What administrators see

Admin → Branch governance has four focused areas:

- **Branches** — a branch overview with followers, verified members, administrators and relevant proposal activity.
- **People** — followers and verified members for the selected branch. A follower can be verified with one action (**Follower → Member**). Revoking membership requires a reason and explains the impact. The person keeps their following preference.
- **Governance access** — delegated branch administrators and their scope.
- **Referrals** — the existing proposal referral capability, kept outside the core participation workflow.

Organisational hierarchy, recognition flags and branch creation sit behind a collapsed **Organisational settings** area available only to national administrators. Normal branch administrators do not need technical identifiers or recognition controls.

All authority is checked on the server. A branch administrator can only act inside their delegated branch. Only a national administrator can delegate or remove branch administrator access. A follower cannot verify themselves through the API or the interface.

## Storage and service boundary

`src/lib/branch-participation.ts` owns the boundary:

- `branch_subscriptions` — Engage-owned personal preferences. Unique on `(memberId, branchId)`, with follow/unfollow audit events in `branch_subscription_events`.
- `branch_memberships` — organisational membership facts. Existing records are retained. Verification metadata records source, verifier, timestamp, role, version and revocation reason.
- `branch_membership_events` — append-only audit trail for assignment, role changes, revocations and external synchronisation.
- `branch_referrals` — unchanged referral records.

`verifyBranchMember`, `revokeBranchMember` and `getProposalEligibility` are the service entry points used by onboarding, My Engage, administration and ballot submission. Pages and APIs do not write membership records directly.

## Eligibility

`getProposalEligibility` is the single decision used by proposal details, ballot submission, pending-vote promotion and ballot digests:

- No jurisdiction branch: verified Engage account only.
- National jurisdiction branch: verified Engage account only. National governance is included by default; a separate National membership record is not required.
- State/territory/local jurisdiction branch: an active verified membership in that exact branch is required. Following is not enough and parents do not confer child membership.
- A missing or unrecognised branch makes the activity unavailable with an explanation rather than a generic access error.

Ballot records remain bound to their immutable wording revisions. Revoking membership does not delete historic votes or change the meaning of a completed decision.

## Migration procedure

Existing verified memberships are facts and are never converted into followers. The migration is additive and restartable.

The primary path is **Admin → Migrations**, available to national administrators. The page shows a live preview of both migrations, their last recorded result and any error. Each run is stored in `data_migrations` with a run count, start time, completion time and actor, so an interrupted operation can be retried safely from the same page.

1. **Standard branches** adds Fusion National and the state and territory branches only when they are missing. Existing branches are never renamed, re-parented or un-recognised.
2. **Branch participation** is blocked until the standard branches exist. It then performs the additive participation migration described below.

Use **Run pending migrations** to run both in order, or apply them individually. Nothing is deleted by either operation.

The same operations remain available for automated deployment:

```bash
# Preview the participation changes. No data writes are made.
npm run branches:participation-migrate -- --dry-run

# Apply the participation migration:
npm run branches:participation-migrate

# Seed the standard branches and National scope for existing verified members:
npm run branches:migrate
```

The participation migration:

1. Adds `engage-legacy` source and `legacy-record` verification metadata to existing verified branch memberships without changing status or role.
2. Adds a following preference for each active legacy branch membership so existing members keep the branch discovery they had before the split. If a subscription already exists, it is left untouched.
3. Assigns currently open proposals without a branch context to National governance (`propose`, `deliberate`, `decide` only). Existing branch-owned proposals, completed decisions, ballot revisions and votes are not rewritten.
4. Writes a `data_migrations` summary and is safe to re-run.

`npm run branches:migrate` still seeds the recognised branch records. Run the seed first on a fresh environment.

## New proposals

New proposals are created with a usable branch context immediately:

- A branch administrator’s own branch supplies governance authority, jurisdiction and branch publication scope.
- An ordinary member’s idea, and a national administrator’s national choice, default to Fusion National with national publication scope.
- The branch context is derived on the server from the actor’s delegated authority, not accepted from untrusted input.

This means a branch proposal can move into deliberation and open its local ballot without a separate national pre-assignment step.

## Underground CRM boundary

`applyExternalMembership` is the integration seam for a future Underground CRM:

- External facts use `source: "underground-crm"` plus an external member identifier, verification timestamp and audit event.
- External membership changes never touch `branch_subscriptions`, so a CRM sync cannot overwrite a person’s chosen branches.
- Local administrators cannot edit or revoke CRM-sourced membership; a discrepancy must be resolved at the authority. This prevents a silent local override.
- If the CRM is unavailable, existing verified facts and recorded votes remain usable. Voting never depends on a live CRM call.
- No second member profile or CRM data model is introduced. Only the organisational membership fact is replaceable.

The integration is deliberately a service boundary, not a speculative full synchronisation client. A future sync job calls `applyExternalMembership` with the authority’s facts.

## Tests

`src/lib/branch-participation.test.ts` covers:

- National default scope and non-removable National following.
- Follow/unfollow, idempotency and duplicate concurrent requests.
- Membership remaining after unfollowing.
- Follower versus verified eligibility and clear restriction messages.
- Branch administrator authority and self-verification prevention.
- Reason-required revocation and historical vote preservation.
- External source integrity and subscription preservation.
- People listing for administration.
- Additive migration, re-run idempotency, National proposal backfill and branch proposal immediacy.
- Parent/child branch non-inheritance.

Run the normal project checks:

```bash
npm test
npm run check
npm run build
```
