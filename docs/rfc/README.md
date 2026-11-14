# Requests for comment

This directory holds substantial design proposals that are too large, too cross-cutting or too consequential to decide in a pull request description.

An RFC is a decision document. It records evidence, options, trade-offs and a recommendation. It is not an implementation authorisation.

## Status vocabulary

| Status | Meaning |
|---|---|
| **Draft** | Being written. Not ready for a maintainer decision. |
| **Proposed** | Complete enough to review. The recommendation may be accepted, rejected or amended. |
| **Accepted** | The maintainer has approved the direction. Implementation still needs its own scoped pull requests. |
| **Rejected** | The direction will not be pursued. The record remains for future context. |
| **Superseded** | A later RFC replaces this one. |

An accepted RFC does not authorise code changes. Each recommendation still needs:

- a governance decision, where it changes eligibility, authority, ballots or publication;
- a scoped implementation plan;
- tests and verification appropriate to the risk;
- documentation updated in the same change.

## Naming and location

```
docs/rfc/NNNN-short-slug.md
```

The number is allocated when the RFC is first proposed. Numbers are never reused.

Supporting evidence, research notes or appendices may sit beside the RFC:

```
docs/rfc/NNNN-short-slug.md
docs/rfc/NNNN-evidence-register.md
```

## Required sections

Every RFC uses the same structure so reviewers can compare proposals:

1. Maintainer summary.
2. Problem statement and goals.
3. Existing application architecture.
4. Research methodology.
5. Cross-industry comparative findings.
6. Product and UX findings.
7. Governance integrity findings.
8. Technical and operational findings.
9. Prioritised recommendations.
10. Alternatives considered.
11. Explicit non-goals.
12. Risks and migration considerations.
13. Open questions requiring maintainer decisions.
14. Suggested incremental implementation sequence.
15. Evidence and source references.

Small RFCs may combine sections, but must not omit the decision, alternatives, risks and open questions.

## Evidence rules

- Separate **observation** (what the repository or a running system does), **external evidence** (what another product documents or demonstrates), **assumption** (what we infer) and **recommendation** (what we propose).
- Cite file paths and symbols rather than line numbers where possible. Line numbers drift.
- Do not treat vendor documentation as proof that a particular deployment behaves the same way.
- Do not present a governance rule, threshold or authority as settled unless Fusion has supplied it.
- Record what was not verified.

## Relationship to other documentation

- [`docs/README.md`](../README.md) is the canonical documentation index.
- [`docs/status/known-gaps.md`](../status/known-gaps.md) is the live defect register.
- [`docs/research/`](../research/) is evidence and option analysis. It is not a commitment.
- [`AGENTS.md`](../../AGENTS.md) is normative for product design, governance invariants, Git discipline and verification.

## RFC index

| RFC | Title | Status | Date |
|---|---|---|---|
| [0001](0001-participatory-governance-platform-evolution.md) | From working governance prototype to durable participation platform | Proposed | 14 November 2026 |
