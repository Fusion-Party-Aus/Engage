# Product Marketing Context

**Document version:** v2
**Last updated:** 2026-11-09

## Product Overview
**One-liner:** Engage is Fusion Party Australia's participatory governance platform where members propose ideas, deliberate on exact wording, vote on bound revisions, and audit published policy.
**What it does:** Engage connects public exploration and member participation to an auditable party governance record. Anyone can read public proposals, deliberation stances, revision histories, aggregate ballot tallies, and published policy without an account. Verified Fusion members can submit ideas, debate and amend wording, and cast ballots bound to immutable wording snapshots.
**Product category:** Participatory Democracy & Party Governance Platform
**Product type:** Self-hosted Web Application (Astro + MongoDB)
**Business model:** Civic / Political Party Infrastructure (Free public access; participation gated to verified Fusion Party Australia members)

## Target Audience
**Target companies:** Fusion Party Australia national organisation, state/territory branches, constituent branches, and the Australian voting public.
**Decision-makers:** Fusion members, proposal authors, branch administrators, returning officers, and national administrators.
**Primary use case:** Turning member ideas into deliberated, voted, and formally ratified party policy with an unbroken audit trail.
**Jobs to be done:**
- Quickly see which ballots and discussions need my voice right now without wading through procedural jargon.
- Propose a policy change or wording amendment and see how members respond to it.
- Verify the exact wording a ballot was decided on and distinguish proposals from official ratified policy.
**Use cases:**
- First-time member signing in via magic link, passkey, or Google to get verified and cast their first ballot or deliberation stance.
- Returning member checking "My Engage" for open ballots and catch-up updates since their last visit.
- Public visitor or journalist auditing how an idea progressed through Propose, Deliberate, Decide, and Implement.

## Personas
| Persona | Cares about | Challenge | Value we promise |
|---------|-------------|-----------|------------------|
| New / Casual Member | Knowing where to start and whether they are eligible to act | Parliamentary procedure and scattered Google Docs / Discord threads feel intimidating | Plain-language onboarding, explicit eligibility badges, and one clear next action |
| Active Deliberator / Author | Shaping policy wording and getting constructive feedback | Losing track of revisions or having edits silently alter what people voted on | Structured stances (Support, Concern, Wording suggestion, Comment) and immutable SHA-256 revision diffs |
| Branch / National Officer | Constitutional rigour, branch electorate scoping, and clean handovers | Manual tallying and unclear distinction between a member poll and ratified policy | Cryptographically bound ballot revisions, separate ratification/publication gates, and zero-lock-in Docker backups |

## Problems & Pain Points
**Core problem:** Party policy discussions and votes often scatter across chat channels, email chains, and mutable documents, making it hard for ordinary members to participate and impossible to audit what wording was actually adopted.
**Why alternatives fall short:**
- Generic forum/chat tools (Discord, Discourse) mix casual chat with formal amendments and lack revision-bound ballots.
- Mutable docs (Google Docs, wikis) allow wording to shift during or after a vote.
- Complex parliamentary tools overwhelm newcomers with procedural ceremony before they can read or contribute.
**What it costs them:** Lost member contributions, low activation after joining the party, confusion over which policy version is official, and high administrative overhead.
**Emotional tension:** New members worry "Am I allowed to vote on this?" or "Where do I even begin?", while officers worry about governance integrity and maintainer bus-factor.

## Competitive Landscape
**Direct:** Loomio / Decidim — falls short because generic civic platforms don't model Fusion's specific four-stage lifecycle, branch electorate separation, and distinct ratification-to-registry publication workflow.
**Secondary:** Google Docs + Email Ballots — falls short because wording isn't frozen to ballot revisions and deliberation is disconnected from the final vote.
**Indirect:** Discord / Mailing Lists — falls short because high-volume chat buries substantive wording suggestions and alienates members who only have 5 minutes a week.

## Differentiation
**Key differentiators:**
- Four-stage transparent pipeline (`Propose` → `Deliberate` → `Decide` → `Implement`) with plain-language entry points.
- Immutable wording revisions (`ballotRevisionId` + SHA-256 hash) so votes are never reinterpreted after edits.
- Clear separation between member ballot outcomes, formal party ratification, and Official Policy Registry publication.
- Passwordless member authentication with email magic links, passkeys (WebAuthn), and Google linking.
**How we do it differently:** Public-first transparency for reading and auditing, paired with verified-member-only participation and passwordless sign-in.
**Why that's better:** Visitors get immediate value before signing in, and members never have to manage passwords—signing in with a one-click email link or device passkey.
**Why customers choose us:** Purpose-built for Fusion Party Australia's Horizon identity and governance invariants.

## Objections
| Objection | Response |
|-----------|----------|
| "Do I need an account just to read proposals or policies?" | No—every public proposal, deliberation thread, revision diff, ballot tally, and published policy is open without signing in. |
| "Why can't I vote immediately on my very first sign-in?" | To protect ballot integrity, an administrator cross-checks your name and email against Fusion's membership roll. While pending, you can explore everything and set up a passkey for instant return sign-ins. |
| "Does a passing member vote automatically rewrite party policy?" | No—member ballots decide a bound wording snapshot, after which the authorised party body records formal ratification before publication to the Policy Registry. |

**Anti-persona:** People looking for an anonymous social media feed or real-time chat room (Engage attributes contributions to verified member display names and focuses on structured deliberation).

## Switching Dynamics
**Push:** Frustration with scattered policy drafts, forgotten passwords, and not knowing which decisions are currently open.
**Pull:** A single Horizon-styled workspace (`My Engage`) showing open ballots for you, active discussions, and a 60-second walkthrough.
**Habit:** Reading party newsletter emails without clicking through to deliberate or vote.
**Anxiety:** Uncertainty about whether signing in commits them to complex party procedure or whether their membership email will match.

## Customer Language
**How they describe the problem:**
- "I want to help shape policy, but I don't know which proposals are open for feedback right now."
- "Wait—which version of the wording are we actually voting on?"
**How they describe us:**
- "Fusion's place to propose ideas, debate wording, and vote on bound revisions."
**Words to use:** Idea, proposal, deliberation stance (Support, Concern, Wording suggestion, Comment), formal amendment, bound revision, open ballot, verified member, passkey, Official Policy Registry.
**Words to avoid:** Anonymous voting (ballots are identifiable to national administrators for audit), automatic adoption, secret ballot, generic SaaS jargon ("workspace seats", "upgrade plan").
**Glossary:**
| Term | Meaning |
|------|---------|
| Deliberation Stance | A member contribution during Stage 2 (`support`, `concern`, `amendment` wording suggestion, or `comment`)—distinct from a formal ballot. |
| Formal Amendment | A structured wording replacement diff filed against a specific base revision ID. |
| Bound Ballot Revision | The immutable wording snapshot (`ballotRevisionId`) frozen when a Stage 3 vote opens. |
| Policy Registry | The authoritative record of policies that have passed a ballot, received formal ratification, and been authorised for publication. |

## Brand Voice
| Attribute | Means | Doesn't mean | Example line |
|-----------|-------|--------------|--------------|
| Plain-spoken | Everyday words at entry points; zero parliamentary jargon required to start | Vague or watered-down at decision points | "Use the email address on your Fusion membership. No password needed." |
| Auditable & Exact | Precise governance terms where a member votes or an officer audits | Bureaucratic walls of text on the sign-in screen | "Ballots you are eligible to vote on, bound to an exact wording revision." |
| Welcoming & Optional | Participation is an invitation, never a forced trap or dark pattern | Pushy growth-hacking popups | "Anyone can read public proposals without signing in." |

**Tone by context:**
- Support / Onboarding: Warm, reassuring, step-by-step, honest about verification timing.
- Launch / Headlines: Editorial authority (Newsreader serif) paired with crisp action (Outfit sans).
- Errors: Specific problem + immediate recovery path ("That sign-in link has expired. Request a fresh link below or use your passkey.").
**Terms we own:** My Engage, Horizon, 60-second walkthrough, bound wording revision.
**Never use (and why):** "Secret ballot" (national administrators can audit identifiable ballot records per governance rules); "Instant policy" (ratification is separate from voting).

## Proof Points
**Metrics:** 4-stage auditable lifecycle; SHA-256 content hashes on every revision; 10-minute hashed magic-link expiry; WebAuthn passkey support.
**Customers:** Fusion Party Australia members, branches, and public readers.
**Value themes:**
| Theme | Proof |
|-------|-------|
| Fast, passwordless access | One-click email sign-in links, WebAuthn device passkeys, and Google sign-in |
| Governance integrity | Separate deliberation stances, amendment ballots, proposal ballots, and ratification records |
| Zero lock-in transparency | Public JSON API v1 (`/api/v1/policies`), OpenAPI 3.1 spec, and self-contained Docker backup/restore |

## Goals
**Business goal:** Increase member sign-in completion, passkey enrollment, and first-session activation (casting an eligible ballot, posting a first deliberation stance, or exploring active proposals while verification is pending).
**Conversion action:** Passwordless sign-in completion → Passkey enrollment + Onboarding checklist completion (First vote or stance).
**Current metrics:** Baseline sign-in and onboarding flow being upgraded with passkey support and guided activation.

## Learnings
*Decisions and tested lessons. Newest first. Keep it to about 20 active entries.*
| Date | Learning | Evidence | Applies to | Status |
|------|----------|----------|------------|--------|
| 2026-11-09 | Automatic passkey prompting works in two complementary layers: (1) eager WebAuthn `signIn.passkey()` on `/member/` for returning devices with `engage_passkey_enrolled=true` (plus an opt-out toggle) and Conditional UI (`autoFill: true`) on the email field; (2) post-sign-in Conditional Create (`useAutoRegister: true`) + a 1-click passkey upgrade banner in `MemberOnboarding`. | `@better-auth/passkey` client spec & WebAuthn Conditional UI/Create | `signup`, `onboarding`, `cro` | active |
| 2026-11-09 | Preserving deep-link intent (`?returnTo=...&intent=vote|deliberate|propose&title=...`) across passkey, magic link, and Google sign-in eliminates context loss when a member clicks "Sign in to vote" on a proposal page. | `src/pages/proposals/[slug].astro` & `src/pages/member/index.astro` | `cro`, `signup`, `marketing-psychology` | active |
| 2026-11-09 | Enhancing the post-vote confirmation in `ProposalBallot.tsx` (Peak-End Rule) with direct links to `#deliberation` ("Share your reasoning in discussion") and `/member/` ("Check remaining open ballots") turns a single vote into a multi-action session without page reloads. | `src/components/ui/ProposalBallot.tsx` | `marketing-psychology`, `onboarding` | active |
| 2026-11-09 | Returning members only need email (or passkey/Google) to sign in; full name is only required on first-time email registration, so collapsing the name field into a `<details>` disclosure and pre-filling remembered email reduces returning-member friction. | Codebase audit (`src/lib/auth.ts` `NAME_REQUIRED` hook) | `signup`, `onboarding` | active |

## Changelog
*Newest first. One line per revision: what changed and why.*
- v2 (2026-11-09) — Added automatic passkey sign-in prompting, WebAuthn conditional auto-registration, deep-link intent preservation (`?returnTo=`), returning-member email memory, and Peak-End post-vote loops.
- v1 (2026-11-09) — Initial context drafted from codebase (`PRODUCT.md`, `DESIGN.md`, `src/pages/member/index.astro`, `src/pages/how-it-works/index.astro`) for Sign-in UI/UX, Passkey support, and Member Onboarding flow.
