# Governance model

**Status:** Current · **Verified:** 13 November 2026

This page explains who may do what, and why. It is the most important page for anyone changing eligibility, permissions or lifecycle rules.

## The five authorities

Engage deliberately separates five facts that are easy to conflate.

| Authority | Question it answers | System of record | Does **not** grant |
|---|---|---|---|
| **Participation eligibility** | May this person take part in this process? | `memberships.status` plus branch membership for branch ballots | Administrative permission, governance authority or publication authority |
| **Organisational membership** | Is this person a member of the party, and in which branch? | UndergroundCRM for party facts; `branch_memberships` for branch facts | Engage account verification by itself; any administrative right |
| **Administrative permission** | What may this officer operate? | `application_roles`, `branchRole`, `rbac_assignments` | Voting eligibility, governance authority or publication authority |
| **Governance authority** | Which body may make this formal decision? | `governanceAuthorityBranchId` and `jurisdictionBranchId` on the matter | Publication authority; the ability to vote |
| **Publication authority** | Who may certify, ratify or publish an outcome? | `policies.ratify` and `policies.publish` permissions; registry state | Ballot eligibility; the right to decide the question |

A person can hold several authorities at once, but no authority is inferred from another. The code and tests enforce this repeatedly: a national administrator without branch membership cannot vote in that branch; a branch administrator cannot manage a national ballot; a moderator can review proposals but cannot bind or certify a ballot.

## Why administration is not governance authority

Administration is **operational**. It answers "who can edit this record, verify this member, or run this screen?" Governance authority is **constitutional**. It answers "which body is entitled to make this decision, for whom, and with what effect?"

They are separate because:

- An operations officer may need to edit a draft on behalf of a branch without being entitled to certify that branch's ballot.
- A national officer may need to fix a typo in a published record without becoming the electorate for the next ballot.
- A branch may administer its own membership while the national body remains the ratifying authority for policy.
- A technical administrator must not be able to manufacture a decision by editing a record.

The implementation expresses this through separate gates:

- **Stage transitions** require editorial authority (`isStaff` or branch administrator at origin) plus type-specific guards.
- **Ballot binding and result recording** require a ballot permission *and* matching governance authority and jurisdiction.
- **Ratification and publication** require national-only permission keys and a successful, revision-matched result.

A national administrator can bypass some branch checks because the role holds national scope. That is an implementation decision, not evidence that administration and authority are the same thing. Where the code allows an administrator to act beyond a strict constitutional reading, it is a **gap to document**, not a rule to copy.

## The branch model

### National

`branch-nat` (Fusion National) is the default national jurisdiction and governance authority when a matter has no narrower coordinate. National ballots are open to every verified member, whether or not they have a branch membership.

### Geographic branches

States and territories are the geographic participation units. A verified member may join **one** state or territory branch, subject to a residence declaration where required. A geographic branch's ballots require an active membership of that exact branch.

### Constituent branches

Constituent branches sit under a state or territory and represent intra-state or affinity groupings. A member may join one constituent branch in addition to one geographic branch. No constituent branches are seeded; they are created by administrators.

### Scope rules

- Parent membership does not confer child membership. A state member is not automatically a constituent member.
- Following a branch never confers membership.
- A branch membership in one branch never confers rights in a sibling branch.
- A national ballot does not require national branch membership.
- A branch ballot requires membership of the **exact** jurisdiction branch.
- A branch administrator or national administrator who lacks that branch membership still cannot vote in that branch ballot.

### National participation

National participation is intentionally broad: any verified member may create proposals, deliberate and vote in national ballots. This is the product's default civic surface. Branch participation narrows eligibility without excluding anyone from national deliberation.

## Rules currently encoded

### Proposal submission

| Rule | Implementation |
|---|---|
| Any verified member may create a proposal. Staff may also create one. | `saveProposal` and `POST /api/proposals` |
| A proposal starts in Propose. | Stage default |
| The author may choose any recognised branch as origin; this grants no membership or authority. | `saveProposal` |
| Only a national administrator may set governance authority, jurisdiction or publication scope. | `saveProposal` |
| A new proposal receives an immutable starting revision. | `ensureLegacyProposalRevision` / `saveProposal` |

### Branch participation

| Rule | Implementation |
|---|---|
| Following is a preference, not a membership. | `branch_subscriptions` vs `branch_memberships` |
| Self-service join requires verified platform membership, a recognised branch, and residence confirmation for geographic branches. | `chooseBranchMembership` |
| Switching replaces the active membership in the same group. | Per-member lock and group replacement |
| CRM-sourced memberships cannot be edited or revoked locally. | `assertLocalMembershipMutation` |
| Revocation requires a reason and preserves historic votes. | `revokeBranchMember` |
| Only a national administrator may grant or revoke branch administrator status. | `verifyBranchMember` / `revokeBranchMember` |

### Verification

| Rule | Implementation |
|---|---|
| Verification is separate from sign-up. | `memberships.status` |
| Manual verification requires `members.verify`. | `saveMember` / `POST /api/admin/members` |
| CRM verification requires a verified email, a unique active person, an active Fusion membership type, and a non-suspended Engage membership. | `membership-verification.ts` |
| Verification does not grant a role or branch membership. | Model separation |
| Suspension blocks participation but not reading. | `canParticipate` |

### Ballot eligibility

| Rule | Implementation |
|---|---|
| National ballot: any verified member. | `getProposalEligibility` |
| Branch ballot: verified member **and** active membership of the exact branch. | `getProposalEligibility` |
| Follower: not eligible. | Explicit branch status message |
| Unverified member: may save a preference, not a vote. | `savePendingVotePreference` |
| Suspended member: may not vote or save a preference. | `castVote` / preference checks |
| Eligibility is checked at vote time, not snapshotted at ballot open. | Current limitation |
| A ballot must not be expired. | `ballotExpired` |
| An amendment ballot additionally requires the parent ballot to be open and the amendment revision to match. | `castVote` |

### Administrative scope

| Rule | Implementation |
|---|---|
| National grants satisfy branch checks; branch grants never satisfy national checks. | `hasPermission` |
| National-only keys include ratification, publication, member verification, identifiable ballots, role management, settings and migrations. | `PERMISSION_CATALOGUE` |
| A custom role cannot be granted a permission its creator does not hold. | `canGrantPermissionSet` |
| Roles cannot be assigned to oneself or revoked from oneself. | `roles-store.ts` |
| Branch administration is a branch membership attribute, not a custom role. | `branchRole: "administrator"` |
| Revocation takes effect on the next request. | Session cache disabled |
| Several declared permission keys are not wired to routes. | See [status/known-gaps.md](../status/known-gaps.md) |

### Governance and publication

| Rule | Implementation |
|---|---|
| Only a bound, revision-matched successful result allows Decide → Implement. | `saveProposal` |
| A branch actor opening Decide needs authority and jurisdiction to both match their branch. | `saveProposal` |
| Ballot binding requires `ballots.bind` and matching authority/jurisdiction. | `bindBallotToRevision` |
| Result recording requires `ballots.record_result` and matching authority/jurisdiction. | `recordFormalDecision` |
| Ratification is national-only, requires Implement stage, a successful result for the exact revision, and the recorded decision event. | `POST /api/admin/policies/ratify` |
| Publication is a separate national-only act after ratification. | `POST /api/admin/policies/publish` |
| A resolution can never be ratified or published. | `isGovernanceResolution` |
| Withdrawal and supersession preserve history and require publication authority. | Registry endpoints |
| Identifiable ballots are restricted to national administrators or holders of `ballots.view_identifiable`. | `canViewIdentifiableBallots` |

## Encoded assumptions versus authoritative rules

Engage encodes **operational interpretations**. It is not the constitution.

| Assumption in code | Where | Status |
|---|---|---|
| `branch-nat` is the default national authority and electorate | `ballots.ts`, `branch-participation.ts` | Implementation default; Fusion has not confirmed a different national body |
| Nine standard branches, no constituent seeds | `migrations.ts`, `site-config.ts` | Practical seeding decision |
| National ballots need no national membership | `getProposalEligibility` | Product decision; not stated in an authoritative rule in the repo |
| Branch ballots need exact branch membership | `getProposalEligibility` | Product decision, tested |
| One geographic and one constituent membership | `chooseBranchMembership` | Product decision |
| A 2027-01-14 deadline for migrated open ballots | `ballot-expiry-migration.ts` | One-off operational decision, not a general notice period |
| Result vocabulary `successful` / `unsuccessful` / `inconclusive` | `ballots.ts` | Implementation vocabulary |
| No thresholds, quorum, turnout, tie or abstention rules | Absent | **Deliberate gap**; Fusion has not supplied them |
| Ratification restricted to national administrators | `policies.ratify` | Conservative interim rule; branch ratification is not modelled |
| No seconding, notice period or scheduled opening | Absent | **Deliberate gap** |
| No eligibility snapshot | `getProposalEligibility` at vote time | Current implementation; may not satisfy a future rule |
| National administrator may name any recognised branch as ratifying authority | `ratify.ts` | Implementation does not cross-check the ballot result's authority |

The following are **not** established by authoritative documents in this repository:

- voting thresholds or quorum;
- who may ratify branch policy;
- qualifying membership for each class of ballot;
- notice periods, campaign windows or effective-date rules;
- whether a successful vote automatically adopts policy;
- whether seconding is required;
- the status of legacy Reclaim or national policy records.

`docs/engage-product-direction-governance-audit-2026-11-07.md` records these as open decisions G1–G21. `corpus/reconciliation/reclaim/policies/GOV-001…` and `GOV-002…` are **proposals**, not constitutional authority. Do not mine them for rules and present the result as settled.

## How to reason about a governance change

Before changing a rule, answer:

1. **Which authority does this touch?** Participation, organisational membership, administration, governance or publication?
2. **What is the source?** A Fusion decision, a documented product rule, or an implementation convenience?
3. **What record proves it happened?** If the answer is "the UI shows it", the change is not auditable.
4. **Who is excluded?** Name the electorate, the branch and the membership fact.
5. **What happens on failure?** A CRM outage, a revoked role, a closed ballot, a missing revision.
6. **Is it reversible?** Governance acts should be append-only. If a change rewrites history, stop.

## Non-negotiable invariants

- Do not infer voting authority from navigation visibility or client state.
- Do not infer governance authority from administrative permission.
- Do not let a role, branch office or staff flag create ballot eligibility.
- Do not let a follower vote in a branch ballot.
- Do not let branch authority cross branches.
- Do not let a resolution enter the Policy Registry.
- Do not reinterpret votes after wording changes.
- Do not compute an outcome without an approved rule set.
- Do not expose identifiable ballots outside the authorised boundary.
- Do not invent constitutional rules to make an interface feel complete.
