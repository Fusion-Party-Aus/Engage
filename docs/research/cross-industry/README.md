# Cross-industry product research for Fusion Engage

Research date: 13 November 2026. Status: research only. No feature, governance rule, permission boundary, production record or deployment was changed.

This collection investigates twelve collaboration, administration, content and developer platforms outside participatory governance, then compares their interaction patterns with Engage's actual implementation. It is deliberately organised by product problem rather than by vendor.

## Contents

| Document | Purpose |
|---|---|
| [01 — Platform evidence register](01-platform-evidence.md) | What was examined on each of the 12 platforms, the sources used, direct UI observations, strengths, weaknesses, applicability and investigation limits. |
| [02 — Cross-industry synthesis](02-synthesis.md) | Recurring patterns grouped by product problem; strongest combinations; where copying a pattern would damage Engage's governance guarantees. |
| [03 — Prioritised opportunity backlog](03-opportunity-backlog.md) | Every meaningful recommendation with current behaviour, proposal, inspiration, benefit, risk, complexity and an Implement now / Experiment / Defer / Reject classification. |
| [04 — Concrete UX concepts](04-ux-concepts.md) | Five implementable Horizon concepts with flows, component mapping, states, accessibility and governance guardrails. |
| [05 — Recommended implementation sequence](05-implementation-sequence.md) | A dependency-aware order of work, with brief-ready scopes and success measures. |

## Method in one paragraph

For every platform we reviewed first-party product documentation, and inspected live public interfaces where authentication was not required. Four public interfaces were exercised at runtime with REA's owned browser: GitHub, GitLab, Wikipedia and Discourse Meta. We could not inspect authenticated product surfaces (Discord, Linear, Zendesk, Airtable, Notion, Stripe Dashboard, Figma, Google Docs). Those platforms are assessed from official documentation and, where noted, public source or public design guidance. Documentation describes supported behaviour; it does not prove that a particular deployment, plan or permission state behaves identically. Inferences about Engage are labelled as proposals, not observations.

## Evidence vocabulary

- **Documented** — stated by the vendor's official documentation or help centre.
- **Source** — visible in public source code, models or configuration.
- **Observed** — seen in a live public interface during this investigation.
- **Inference** — our interpretation or proposed adaptation for Engage.
- **Unverified** — plausible but not established by this investigation.

## Relationship to earlier research

The earlier [participatory governance comparison](../participatory-platforms-engage-comparison.md) examines Decidim, CONSUL and Loomio and the governance semantics of participation. This collection deliberately excludes those products. It studies how mature commercial and open-source products solve permissions, workflow, operational queues, collaboration history, relationships, notifications and accessibility.

The two bodies of work are complementary:

- The participatory research answers **what a governance decision is and how its authority must be preserved**.
- This research answers **how to make the surrounding product usable at scale** without weakening that authority.
