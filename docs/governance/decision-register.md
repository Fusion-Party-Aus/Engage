# Governance decision register

**Status:** Current · **Recorded:** 14 November 2026
**Authority:** Maintainer free-text responses to the RFC 0001 governance questionnaire (`RFC_RESPONSE.md`, 14 November 2026), plus the maintainer scope amendment on the National Neon import.

This register is canonical. Where an RFC 0001 recommendation, an earlier audit, a comment in code or an implementation assumption conflicts with a decision below, **this register wins**. A decision marked *Approved* may be implemented. A decision marked *Direction agreed — specification required* defines intent but must not be encoded with guessed parameters. A decision marked *Deferred* is out of the current programme.

Do not change a decision by editing code. Record the new maintainer decision here, with its date and the affected issues.

## Register

| ID | Decision | Status | RFC / issue impact |
|---|---|---|---|
| D1 | Fusion has previously stalled because deliberation, voting and administration bled into one indeterminate process. Engage must impose a bounded, legible decision path and must not allow a matter to remain open indefinitely. | Approved | RFC §2.1, I2, I6, S3; #26, #30 |
| D2 | Voting eligibility is evaluated **when a member casts a vote**. No electorate snapshot is taken. A member who becomes eligible before the ballot closes may vote; a member who ceases to be eligible may not. | Approved | RFC G11, I2; #26 |
| D3 | A policy proposal requires a **seconder** before it enters Deliberate. | Approved (mechanism needs modelling) | #30 |
| D4 | Deliberation ordinarily lasts **30 days** from seconding. At the deadline the system advances the proposal to Decide automatically. | Approved | #30 |
| D5 | A **ballot officer, or a holder of the explicitly authorised permission**, may advance a proposal to Decide before the deliberation deadline. Ordinary moderators do not acquire this authority by being moderators. | Approved | RFC G6, I4; #27, #31 |
| D6 | The ordinary ballot period is **30 days**. Ballots close automatically at their deadline. | Approved | RFC I2, S3; #26 |
| D7 | The maximum scheduled time from seconding to ballot closure is therefore **60 days**. This is a ceiling on the scheduled process, not a guarantee that every downstream administrative act finishes within it. | Approved | #26, #30 |
| D8 | No additional quorum, minimum turnout or participation threshold is authorised. Decisions are made by the eligible members who participate. | Approved | RFC L1, #28 |
| D9 | Ordinary Yes/No proposals use **simple majority**: Yes greater than No means approval; a tie does **not** approve. | Approved | RFC L1, #28 |
| D10 | Abstentions may be recorded, but their effect on the denominator is **not defined**. No binding calculation may depend on an abstention rule until the maintainer supplies one. A simple Yes-versus-No comparison satisfies D9 without deciding D10. | Direction agreed — specification required | #28 |
| D11 | Eligible members may **change their vote** while the ballot is open. | Approved (already supported) | RFC G12; #26 |
| D12 | Automatic early closure when an outcome becomes mathematically irreversible is **not approved**. The remaining-voters calculation is insufficient because votes can change and eligibility can move during the ballot. The 30-day deadline remains binding. | Deferred — model required | RFC G10, #26 |
| D13 | There is no separate body that validates a proposal before it is decided. The members who decide are the members whose decision is authoritative; officers certify process, not policy preference. | Approved | RFC §7.4; #27, #28 |
| D14 | A successful member vote becomes binding policy **without discretionary executive approval**. Certification of process and publication are procedural acts, not vetoes. | Approved | RFC S2, L1; #27, #28 |
| D15 | With **zero** successful amendments, ratify the approved original wording automatically. | Direction agreed — implementation pending | #27, #34 |
| D16 | With **one** successful amendment, apply it and ratify the resulting wording automatically. | Direction agreed — implementation pending | #34 |
| D17 | With **two or more** successful amendments, require an authorised collision review. Compatible amendments may be applied together; conflicting amendments require a collision-resolution ballot. | Direction agreed — specification required | #34 |
| D18 | For two competing alternatives the intended mechanism is a direct choice. For three or more, ranked-choice voting is intended. The method, tie handling, ballot timing, treatment of the original wording and collision grouping are **not specified**. | Direction agreed — specification required | #34 |
| D19 | A failed main proposal must not become policy solely because an amendment passed. Ambiguous wording must not be ratified automatically. | Approved | #27, #34 |
| D20 | Every adopted text must have a reproducible derivation from immutable revisions, amendment outcomes and any resolution ballot. | Approved | RFC S2; #27, #34 |
| D21 | Every member belongs to National. A member may join one geographic branch and one constituent branch, and may follow additional branches without acquiring membership or voting rights. | Approved | RFC §7.5; #32 |
| D22 | CRM supplies authoritative organisational membership facts and geographic information. Engage owns verification, branch participation and governance eligibility decisions. | Approved | RFC I3, S6; #32 |
| D23 | Branch administrators may delegate roles within their branch, subject to anti-escalation and scope enforcement. Operational stewardship does not confer governance authority. | Approved | RFC I4, S7; #31, #41 |
| D24 | Members may follow individual matters. | Approved | RFC S2, S7 |
| D25 | A matter may be stewarded by its author or a designated party authority (for example a National Executive or Branch Executive). | Direction agreed — role model pending | RFC S7; #29 |
| D26 | Historical governance records are retained indefinitely, subject to applicable legal obligations, and individual vote choices are not publicly identifiable. | Approved | RFC §7.3, S8 |
| D27 | A full public proposal API is intended, with appropriate visibility and confidentiality protections. Identifiable ballot choices must never be exposed. | Approved — API not yet specified | RFC L5 |
| D28 | Comment moderation may use visible moderation states or removal depending on severity, with an audit trail. | Approved | RFC G13; #42 |
| D29 | Secret ballots should use encryption by default, subject to verified key custody and recovery. | Approved (already implemented in part) | RFC §8.4; docs/security-audit-and-ballot-encryption.md |
| D30 | Expected usage is hundreds of members over the next 3–6 months, with a design target of tens of thousands. Do not build premature infrastructure. | Approved | RFC §8.1 |
| D31 | Shared Fusion Auth / Fusion Core identity remains undecided. Define replaceable ports and seams; do not implement a new identity platform. | Deferred — architecture boundary only | RFC S6, L4 |
| D32 | Cloudflare Turnstile is part of the security programme for abuse-prone unauthenticated actions. Server-side verification is mandatory. Routine challenges must not interrupt authenticated voting. | Approved | RFC I10; #38 |
| D33 | Importing the existing National Neon policy baseline is **out of scope** for this programme. It must not be imported, mapped, backfilled or published without a separate provenance and reconciliation project. | Deferred — separate project | #36 |

## Consequences for implementation

### The lifecycle must be scheduled, not remembered

D3–D7 replace the current manual-only lifecycle. Implementation must add:

- a seconder act recorded as an immutable governance event;
- a deliberation deadline derived from the seconding time;
- automatic advancement to Decide at that deadline, executed by a **system actor** and recorded as a governance event;
- an authorised early-advancement path that records the actor and reason;
- a ballot deadline defaulting to 30 days from opening, which remains overridable by an authorised officer within the permitted process;
- automatic closure at the deadline, after which no vote is accepted;
- idempotent, recoverable execution so a missed scheduler run cannot reopen or double-advance a matter.

### Automatic advancement and `ballots.bind` are different authorities

Sprint 1 correctly removed the ability of an ordinary moderator to move a matter into Decide by requiring `ballots.bind` (D5). D4 adds a second, non-human path: the **system** advances at the deliberation deadline.

The system path must:

- identify itself as a system actor, not impersonate an officer;
- not require `ballots.bind`, because no human is exercising discretion;
- still bind the exact wording revision and record the binding event;
- be impossible to trigger for a proposal with an unresolved amendment or an invalid stage;
- be idempotent under concurrent scheduler runs.

An authorised officer advancing early **does** require `ballots.bind` and must record actor, authority and reason.

### Formal ratification is a procedure, not a veto

D13–D20 separate four things that the current system conflates:

1. the **ballot result** (what members decided);
2. the **adopted wording** (the exact text, derived reproducibly);
3. **certification** (an officer confirms the process and recorded result);
4. **publication** (the adopted policy becomes publicly available).

Certification may block on procedural defects. It must not be used to reject a valid member decision on policy grounds. Until automatic ratification is implemented, the manual `policies.ratify` path must not be described as discretionary approval.

### National Neon import is deferred

No code, migration, seed or documentation may claim that legacy Neon policies were adopted through Engage. The policy registry must remain able to support a future import, but no reconciliation work starts under this programme. Issue #36 is deferred.

## Open decisions requiring maintainer input

| ID | Question | Blocks |
|---|---|---|
| O1 | Effect of abstentions on the denominator, if any | Binding tally rules (#28) |
| O2 | Ranked-choice method, tie handling, ballot timing, original-wording treatment, collision grouping | Amendment collision resolution (#34) |
| O3 | Whether a confirmation ballot or notice period applies to any policy class | #30 |
| O4 | Election/Returning Officer role and separation of duties | #29 |
| O5 | Shared Fusion identity platform | #31, S6/L4 |
| O6 | A correct model for irreversible-outcome early closure | #26 |
| O7 | Legal document approval and acceptance-gate activation | #40 |
| O8 | Steward role model and who may be designated | D25 |
