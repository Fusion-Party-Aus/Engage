# Product overview

**Status:** Current · **Verified:** 13 November 2026

## Definition

> Fusion Engage is Fusion Party Australia's participatory governance platform. Members propose ideas, deliberate on policy and organisational matters, participate in formal decisions when eligible, and follow those decisions through to their recorded outcomes. Where authority permits, the same record becomes published party policy.

Engage is reachable at `https://engage.fusionparty.org.au/`. It is a product for members and officers of one political party, not a generic civic-tech platform and not an internal developer console.

Three ideas hold the product together:

1. **Participation is optional and staged.** A visitor can read. A member can discuss. An eligible member can vote. An authorised officer can record and publish the decision.
2. **A vote is not a decision.** A ballot is one input. A formal decision is a separate recorded act, and publication is a third act. The interface must never collapse them.
3. **Wording is evidence.** A ballot is bound to an immutable revision. Editing the text after votes exist does not reinterpret the votes; it requires a new revision and an explicit governance path.

## Why Engage exists

Fusion's governance previously lived across documents, spreadsheets, chat, email and ad hoc votes. That creates predictable problems:

- **Participation is uneven.** People who miss a meeting or a channel cannot easily find what is being decided or whether they are eligible.
- **The record is not durable.** A chat poll records an outcome but not the exact wording, the electorate, the authority or the revision that was voted on.
- **Policy is hard to audit.** A published position may exist without a traceable path back to the proposal, amendments, ballot and ratifying authority.
- **Branches operate at different levels of maturity.** Geographic and constituent branches need scoped administration without gaining national authority.
- **Administration is confused with authority.** Someone who can edit a page is not automatically someone who may certify a result or publish policy.

Engage addresses these by combining deliberation, formal ballots, a policy registry and an audit trail in one member-facing product with scoped administration.

## Primary users

| User | What they need | What they can do today |
|---|---|---|
| **Public reader** | Understand what Fusion is considering and what it has adopted, without an account. | Read public proposals, published policy, branch directory, how-it-works and changelog. |
| **New or unverified member** | Join, understand eligibility, and participate as soon as they are verified. | Sign in by email link, Google or passkey; see verification status; save a vote preference while pending; follow branches. |
| **Verified member** | Find relevant activity, deliberate, and vote when eligible. | Create proposals, comment, endorse, submit amendments, vote in national ballots, join a branch, manage notifications. |
| **Branch member** | Participate in the branch they belong to. | Vote in that branch's ballots; follow any branch for updates. |
| **Proposal author** | Shape an idea into a proposal and see how contributions were handled. | Edit while in Propose; read structured feedback on comments; follow revisions and outcomes. |
| **Branch officer** | Run branch participation within delegated scope. | Verify branch members, manage branch proposals, resolve/apply amendments, bind ballots and record results where authority and jurisdiction match. |
| **National officer** | Certify national decisions and maintain the policy record. | All branch operations, member verification, role management, ratification, publication, withdrawal and supersession. |
| **Integrator** | Read authoritative published policy. | Read-only public API v1 with ETags, versions and canonical links. |

Two boundaries matter:

- A **moderator** is an operational reviewer, not a governance authority. Moderators can review proposals and contributions but cannot bind or certify a ballot.
- A **branch administrator** has real authority inside one branch, and none outside it. National authority is never inferred from branch office.

## Core journeys

### 1. Understand before joining

A visitor lands on `/`, reads `/how-it-works/`, browses `/proposals/` and `/policies/`, and can open any public proposal without an account. The product must make the difference between "being discussed", "being voted on" and "adopted policy" obvious at each step.

### 2. Join and become eligible

The person signs in with an email magic link, Google or a passkey. A new account is `pending`. Verification is a separate fact: either an administrator verifies the member, or the Underground CRM confirms an active Fusion membership. Only `verified` status grants `canParticipate`.

### 3. Choose where to participate

A member follows branches for updates and may join one geographic branch and one constituent branch where eligible. **Following is not membership.** A follower receives updates; only a verified branch member can vote in that branch's ballots.

### 4. Deliberate

On a proposal in Propose or Deliberate, a verified member can comment with a stance (`support`, `concern`, `amendment` or `comment`), endorse others' comments, and propose a structured wording amendment against the current revision.

### 5. Decide

When deliberation closes, an authorised officer moves the matter to Decide. The ballot is bound to an exact revision. Eligible members vote Approve, Abstain or Reject. The server checks eligibility at the moment of voting; the UI only ever reflects it.

### 6. Record and certify

When voting closes, an administrator records a formal result with an external decision-event reference. This is an explicit act, not a computed consequence of the tally. A successful result allows the matter to move to Implement.

### 7. Publish and follow through

For a policy proposal, a national officer may ratify the exact successful revision into the Policy Registry, then publish it. Publication is a further act with its own event record. Published policy appears at `/policies/` and through `/api/v1/`. Supersession and withdrawal preserve history rather than deleting it.

## Problems Engage solves

| Problem | How Engage responds |
|---|---|
| "I didn't know this was being decided." | Public proposal pages, a member attention queue, closing-soon signals and notification preferences. |
| "Was I allowed to vote?" | Server-side eligibility per ballot, explicit status messages, and a separate following/membership distinction. |
| "What exactly did we vote on?" | Immutable revisions with content hashes and ballot binding events. |
| "Who decided this?" | Recorded governance authority, jurisdiction, decision event and ratifying body. |
| "Is this official policy?" | A separate Policy Registry with ratification and publication events. Proposals and ballot outcomes are not policy. |
| "Can a branch edit national policy?" | Branch-scoped permissions and matching authority/jurisdiction checks. |
| "Why was my comment ignored?" | Structured contribution feedback (`incorporated`, `considered`, `deferred`, `declined`) with optional evidence. |

## What makes Engage different

Engage is not a forum with a poll attached. The differences are structural:

- **Deliberation stances are not ballots.** `support`, `concern`, `amendment` and `comment` describe discussion. `approve`, `abstain` and `reject` are formal votes. They are stored and presented separately, and neither is derived from the other.
- **Amendments are first-class records.** An amendment has its own revision chain, ballot, result and formal acceptance before it can change proposal wording.
- **Votes bind to wording.** Changing the text invalidates the basis of existing votes; the system locks substantive edits once a ballot opens or a vote exists.
- **Eligibility is scoped, not global.** National ballots are open to verified members. Branch ballots require membership of that branch. Administration never creates voting rights.
- **Authority is explicit.** The body with governance authority and the jurisdiction of the decision are recorded fields, not inferences from who is editing.
- **Outcomes are recorded, not computed.** An officer must cite a decision event. Engage deliberately does not invent thresholds or certify a result from a tally it does not have rules for.
- **Publication is a separate registry act.** Ratification and publication each produce durable events. The public API serves only published revisions.
- **History is append-only where it matters.** Revisions, results, publication events, branch membership events and RBAC changes are audit records.

## Participation versus formal decision-making

| | Participation | Formal decision-making |
|---|---|---|
| **Purpose** | Shape, test and improve a proposal. | Establish an authoritative outcome. |
| **Typical acts** | Comment, endorse, submit an amendment, discuss. | Open a ballot, cast a formal vote, record a result, ratify, publish. |
| **Who** | Any verified member (subject to visibility). | Eligible voters for the ballot; authorised officers for the acts around it. |
| **Record** | Comment, stance, endorsement, amendment revision, contribution feedback. | Ballot binding, vote record, decision event, ballot result, ratification, publication event. |
| **Reversible?** | Yes. Discussion can continue and wording can change before a ballot. | No. Results and publication events are immutable; later states are recorded as new events. |
| **Effect** | Influences the proposal. | Creates an official outcome, and for policies, an authoritative published revision. |

A member commenting "I support this" has not voted. A proposal with 90% supportive comments has no formal status. A successful ballot has not published policy. These distinctions are governance requirements, not UI preferences.

## What Engage explicitly does not attempt to do

- **Be the membership system of record.** UndergroundCRM is authoritative for person records, party membership and electorate facts. Engage stores the verification outcome and its own participation facts.
- **Be the party's identity provider.** Authentication is local Better Auth. Fusion Core / Fusion Auth is a future proposal, not a dependency.
- **Be a general-purpose forum, social network or messaging product.** Deliberation exists to improve governance matters.
- **Be a survey or sentiment tool.** The Sense Box collects public concerns, but it is not a ballot and creates no decision.
- **Replace Signal, Horizon CMS or public websites.** Engage may eventually supply published policy to them; it does not publish campaigns or manage web content.
- **Implement parliamentary procedure it has not been given.** Thresholds, quorums, notice periods, seconding, tie-breaking and ratifying authority by jurisdiction are not invented in code.
- **Guarantee ballot secrecy against a determined administrator in every configuration.** Encryption is available and must be configured; the default deployment stores votes in plaintext. The threat model is documented in [security-audit-and-ballot-encryption.md](../security-audit-and-ballot-encryption.md).
- **Provide electoral or legal advice.** Published policy is a party record, not a statement of law.

## Current capabilities and future ambitions

**Shipping today:** proposals with five lifecycle stages; deliberation with stances and endorsements; structured amendments with their own revisions and ballots; formal ballot binding and result recording; policy ratification, publication, withdrawal and supersession; branch following and branch membership; scoped RBAC; UndergroundCRM verification behind a feature flag; email, in-app and Web Push plumbing; PWA; public API v1; encrypted-vote support.

**Not shipping today:** a populated national policy baseline (the registry starts empty); automated thresholds, quorum or tally computation; scheduled ballot opening; eligibility snapshots taken at ballot open; seconding; confirmation ballots; election-officer roles; amendment/repeal initiated from a policy page; AI briefings; Signal or Horizon CMS integration; Fusion Core/Auth.

The authoritative list, with evidence, is [status/capability-matrix.md](../status/capability-matrix.md). Known defects are in [status/known-gaps.md](../status/known-gaps.md).

## How success is judged

Engage succeeds when:

- a member can find the activity relevant to them and knows whether they can act;
- an eligible voter can vote once, change their mind while the ballot is open, and see the exact wording they voted on;
- an officer can complete a governance act without understanding MongoDB;
- an auditor can reconstruct who had authority, what was voted on, what was recorded and when policy became official;
- a public reader can distinguish discussion, decision and adopted policy without reading a manual.

Passing tests and returning 200 responses are necessary but not sufficient evidence for any of these.
