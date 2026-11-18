# Engage

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Engage serves anyone who wants to discover what Fusion is doing, connect with people who share their interests, contribute ideas and expertise, or find meaningful ways to help—whether they have five minutes to share an opinion or five hours to volunteer—alongside members who shape proposals, eligible voters, proposal authors, branch officers, national officers, and public readers looking for Fusion's official positions.

A visitor should understand how to get involved and what happens next without knowing parliamentary procedure. Membership can open additional responsibilities and democratic rights, but it shouldn't be the prerequisite for every meaningful contribution. A member should be able to find relevant activity and know whether they can act. Officers need precise decision records and controls within their delegated authority.

## Product Purpose

Engage is Fusion's home for participation.

A place where anyone can discover what we're doing, connect with people who share their interests, contribute ideas and expertise, participate in discussions and decisions, and find meaningful ways to help.

Whether someone has five minutes to share an opinion or five hours to volunteer, Engage should make it easy to get involved, understand what happens next, and build lasting connections along the way.

Membership can open additional responsibilities and democratic rights, but it shouldn't be the prerequisite for every meaningful contribution.

Its success is making participation approachable and connected while maintaining a clear, auditable path from ideas and contributions to recorded decisions and, where authorised, published policy.

## Positioning

Engage connects open public participation, collaboration, and community connection to a rigorous governance record. Proposal votes, amendment votes, formal ratification and publication remain distinct actions, and a successful vote alone does not make policy official.

## Operating Context

People use Engage on mobile, tablet and desktop. Visitors can read public proposals and published policy without signing in. Members sign in through Better Auth, and verification plus the relevant branch authority determine participation rights. Officers work through scoped administration screens. National officers may record formal ratification and publication under the current implementation.

The four proposal stages are propose, deliberate, decide and implement. They describe progress but do not determine the ordering of homepage content. Open votes need priority because they are time sensitive. Existing production proposals, amendments, contributions, votes, provenance and permissions must survive changes to the interface and data model.

## Capabilities and Constraints

- Astro and MongoDB remain the application foundation. Keep the architecture straightforward; no new services, generic frameworks or Git dependency are needed for the user experience.
- Members can create proposals, discuss them, suggest structured wording changes and inspect revision histories and human-readable comparisons.
- Proposal and amendment ballots are separate and bound to immutable wording revisions. Existing votes must never be reinterpreted after edits.
- Governance authority, originating branch, jurisdiction and publication scope have different meanings. Membership and administration rights are explicit and branch scoped.
- Conflicting amendments require explicit resolution. Governance transitions, ballot results, ratification and publication require auditable records.
- The Policy Registry and versioned public API expose only authorised published revisions, commitments, jurisdiction, provenance and authority. Publication events are durable and reconcilable.
- Signal, Horizon CMS and other external consumers are outside this product goal.

Open governance decisions: Fusion has not supplied constitutional voting thresholds, ratification authority by jurisdiction, qualifying membership rules for every ballot, or notice and effective-date rules. Engage must not invent them. The current implementation restricts formal ratification to national administrators pending a decision about branch authority.

## Brand Commitments

Engage must remain recognisably Horizon, including Fusion's identity, typography, colour system, ribbons and editorial visual grammar. The interface uses everyday language at entry points and exposes exact governance detail where a person acts or audits a decision.

## Evidence on Hand

The repository contains production-oriented proposal data, policy baseline records, migrations, API documentation and tests. The available test suite covers governance APIs, branch permissions, revisions and ballot separation. Real MongoDB integration and migration scenarios are present but skipped in the ordinary test run. No usability research, constitutional thresholds or verified browser screenshots were supplied with this goal; none should be fabricated.

## Product Principles

1. Lead with the user's task and the next useful action.
2. Make participation optional and eligibility explicit.
3. Show official policy separately from proposals and ballot outcomes.
4. Preserve exact wording, votes, provenance and authority through every transition.
5. Reveal procedural detail when it helps a decision or audit, while keeping the first reading path plain.

## Accessibility & Inclusion

The interface must work with keyboard and assistive technology and remain usable at mobile, tablet and desktop sizes. Its language should welcome people unfamiliar with party procedure. Do not rely on colour alone for status or eligibility.
