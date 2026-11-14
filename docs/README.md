# Engage documentation

This directory is the canonical documentation set for Fusion Engage. It exists so that maintainers and coding agents can answer four questions without reading the whole repository:

1. What is Engage, and what is it not?
2. How does its governance model work?
3. Where is a behaviour implemented?
4. What may I safely change?

**Verified against:** `main` at `d1a24af` (13 November 2026).

Documentation is not a substitute for the code. Where this set and the implementation disagree, the implementation is the current behaviour and the document is a defect. Record the discrepancy in [status/known-gaps.md](status/known-gaps.md) and correct the document in the same change.

## Reading order

| If you need to… | Read |
|---|---|
| Understand the product, users and scope | [product/overview.md](product/overview.md) |
| Understand how Engage relates to Fusion's other systems | [product/ecosystem.md](product/ecosystem.md) |
| Learn the vocabulary and core records | [domain/domain-model.md](domain/domain-model.md) |
| Understand eligibility, authority and branch scope | [domain/governance-model.md](domain/governance-model.md) |
| Trace an idea from submission to published policy | [domain/governance-lifecycle.md](domain/governance-lifecycle.md) |
| Navigate the codebase | [architecture/overview.md](architecture/overview.md) |
| Work on persistence, revisions or votes | [architecture/data-and-persistence.md](architecture/data-and-persistence.md) |
| Add or change an API route | [architecture/api-and-authorisation.md](architecture/api-and-authorisation.md) |
| Work on email, notifications or PWA | [architecture/notifications-and-jobs.md](architecture/notifications-and-jobs.md) |
| Protect sign-in and public submissions | [security/turnstile.md](security/turnstile.md) |
| Build, test or deploy | [architecture/build-deploy-operations.md](architecture/build-deploy-operations.md) |
| Make a change | [guides/contributing.md](guides/contributing.md) |
| Act as an autonomous agent | [guides/agent-guide.md](guides/agent-guide.md) |
| Know what is actually shipped | [status/capability-matrix.md](status/capability-matrix.md) |
| Know what is broken or undecided | [status/known-gaps.md](status/known-gaps.md) |
| Know which governance rules the maintainer has approved | [governance/decision-register.md](governance/decision-register.md) |
| Track RFC 0001 implementation progress | [status/rfc0001-programme-tracker.md](status/rfc0001-programme-tracker.md) |
| Understand a proposed direction | [rfc/README.md](rfc/README.md) |

## Documentation map

```
docs/
├── README.md                         # This index and maintenance rules
├── product/
│   ├── overview.md                   # Purpose, users, journeys, scope
│   └── ecosystem.md                  # Fusion, Horizon, CRM, Core/Auth, Signal, CMS
├── domain/
│   ├── domain-model.md               # Concepts, records, relationships
│   ├── governance-model.md           # Five authorities, branches, eligibility
│   └── governance-lifecycle.md       # Stages, acts, transitions, variants
├── architecture/
│   ├── overview.md                   # Stack, layers, request flow, dependency rules
│   ├── data-and-persistence.md       # MongoDB, collections, revisions, votes
│   ├── api-and-authorisation.md      # API surface, DTOs, permissions, public API
│   ├── notifications-and-jobs.md     # Email, inbox, push, PWA, cron, scripts
│   └── build-deploy-operations.md    # Local dev, CI, Docker, Coolify, NUC
├── guides/
│   ├── contributing.md               # Change protocol and quality gates
│   └── agent-guide.md                # Orientation, invariants, traps, recipes
├── governance/
│   └── decision-register.md          # Maintainer-approved governance rules
├── security/
│   └── turnstile.md                  # Turnstile, abuse protection, rate limits
├── status/
│   ├── capability-matrix.md          # Implemented / partial / planned
│   ├── known-gaps.md                 # Defects, risks and open decisions
│   ├── rfc0001-programme-tracker.md  # Recommendation-by-recommendation progress
│   └── sprint1-integration-report.md # Verification evidence for the first slice
└── rfc/
    ├── README.md                     # RFC status, structure and rules
    └── 0001-…                        # Proposed platform evolution RFC
```

## Relationship to other documents

- **`AGENTS.md`** is normative for user experience, visual design, governance invariants, Git discipline and verification. It outranks this documentation where the two overlap.
- **`PRODUCT.md`** is the product schema used by the Impeccable design workflow. It remains valid but is shorter than [product/overview.md](product/overview.md).
- **`DESIGN.md`** defines the Horizon implementation contract: tokens, typography, components and layout.
- **`docs/governance/`**, **`docs/architecture/`** and **`docs/integrations/`** contain earlier focused specifications. They remain useful for detail, but this set is the entry point and resolves their status.
- **`docs/research/`** is evidence and option analysis, not a commitment. Nothing in it is implemented merely because it is documented.
- **`docs/rfc/`** contains proposed directions and decision records. An RFC is not current behaviour and is not an implementation authorisation. Where an RFC and this documentation set disagree about what is shipped, this set and the code are authoritative.
- Dated audits, release records and migration inventories are historical. They describe the system at a point in time and must not be read as current state.

## Status vocabulary

This set uses three labels consistently:

| Label | Meaning |
|---|---|
| **Implemented** | Reachable in a production build and enforced by code. |
| **Partial** | Some code exists, but a gate, surface or guarantee is missing. The gap is named. |
| **Planned** | Design or intent only. No production path exists. |

A feature is not "implemented" because a collection, type or admin screen exists. It is implemented when a user can complete the task and the server enforces the outcome.

## Maintenance rules

1. **Update in the same change.** A pull request that changes a lifecycle rule, permission, endpoint or integration must update the affected document.
2. **Cite code.** Prefer `path/to/file.ts` and symbol names over line numbers, which drift. Line numbers are acceptable in a dated audit.
3. **Separate fact from intention.** Never describe a planned capability in the present tense.
4. **Do not invent governance rules.** If Fusion has not supplied a threshold, quorum, notice period or ratifying authority, document the gap. Do not encode a guess.
5. **Prefer deletion to accumulation.** Replace superseded guidance rather than adding another contradictory page. If a historical record must remain, label it clearly and move it out of the reading path.
6. **Verify before claiming.** Documentation claims about behaviour should be checked with `rg`, a test run or the rendered app. Record what was not verified.

## Commands used to verify this set

```sh
pnpm check
pnpm test
pnpm build
rg -n '<(button|select|input|textarea|table|dialog)\b' <changed-files>
```

Real-MongoDB suites (`voting-mongo.test.ts`, parts of the governance API suite) and Playwright journeys are skipped in an ordinary local run unless the required services are configured. See [architecture/build-deploy-operations.md](architecture/build-deploy-operations.md).
