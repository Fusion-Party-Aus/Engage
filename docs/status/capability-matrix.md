# Capability matrix

**Status:** Current · **Verified:** 13 November 2026

This page answers "does Engage do this today?" Use it instead of inferring from a screen, a collection name or a design document.

**Implemented** = reachable in production and enforced by code.
**Partial** = code exists but a gate, surface or guarantee is missing.
**Planned** = design only; no production path.

## Product surfaces

| Capability | Status | Evidence / limit |
|---|---|---|
| Public landing page and member home | Implemented | `/`, `src/pages/index.astro` |
| Browse public proposals | Implemented | `/proposals/`, `listProposals` |
| Read a proposal with wording, revisions, discussion and ballot | Implemented | `/proposals/[slug]/` |
| Create a proposal | Implemented | Verified member or staff; `POST /api/proposals` |
| Published policy catalogue | Implemented, empty on a fresh install | `/policies/` reads `policy_registry`; no baseline import |
| Read a published policy | Implemented when a record is published | `/policies/[slug]/` |
| Branch directory | Implemented | `/branches/` |
| Public concern submission (Sense Box) | Implemented | `/sense-box/`, rate-limited |
| How-it-works and changelog | Implemented | `/how-it-works/`, `/changelog/` |
| Terms and privacy pages | Implemented but inactive as a gate | Documents are owner-authorised; acceptance gate off |
| Branded 403/404/500 | Implemented | `src/pages/403.astro`, `404.astro`, `500.astro` |

## Identity and membership

| Capability | Status | Evidence / limit |
|---|---|---|
| Email magic-link sign-in | Implemented | Better Auth + Resend, 10-minute links |
| Google OAuth | Implemented when configured | Conditional provider registration |
| Passkeys | Implemented | Better Auth passkey plugin |
| Local account and session | Implemented | `user` collection; `getSessionUser` |
| Development one-click sign-in | Implemented, environment-gated | Only development/test/preview |
| Pending / verified / suspended status | Implemented | `memberships` |
| Rejected membership state | Not modelled | Suspension must not be described as rejection |
| Account disablement | Implemented | Separate from membership status; sessions deleted |
| Manual verification by officer | Implemented | `members.verify` |
| Automatic verification from UndergroundCRM | Implemented, feature-flagged off | Read-only CRM adapter |
| CRM write-back or webhook | Not implemented | Scheduled/queued pull only |
| Shared Fusion identity / SSO / Fusion Auth | Planned | No code or dependency |
| Legal acceptance gate | Implemented but inactive | Requires flag and published documents |
| Self-service email change or account deletion | Not implemented | Not in scope today |

## Branches

| Capability | Status | Evidence / limit |
|---|---|---|
| National, state, territory, constituent kinds | Implemented | `BranchKind` |
| Nine standard branches seeded | Implemented | Idempotent seeding |
| Constituent branches | Implemented by admin creation; none seeded | `POST /api/admin/branches` |
| Follow a branch | Implemented | `branch_subscriptions` |
| Join a branch as a member | Implemented | Self-service with residence declaration |
| One geographic and one constituent membership | Implemented | Group-bounded switch |
| Following grants branch ballot eligibility | **Not implemented, by design** | Followers are explicitly ineligible |
| CRM-driven geographic membership | Implemented, conflict-safe | Creates a review on disagreement |
| Branch invitations / invite tokens | Not implemented | No endpoint or collection |
| Branch referrals of proposals | Implemented | Admin-only; permission key not used for creation |
| Branch-scoped administration | Implemented | Branch administrator attribute + RBAC |
| Branch-level ratification | Not implemented | Ratification is national-only |

## Deliberation

| Capability | Status | Evidence / limit |
|---|---|---|
| Comments on proposals | Implemented | 5–5,000 characters |
| Stances: support, concern, amendment, comment | Implemented | A stance is a label, not a procedural act |
| Endorse comments | Implemented | Display-only |
| Contribution feedback with evidence | Implemented | Four statuses plus history |
| Comment editing | Not implemented | Comments are immutable; deletion only |
| Comment moderation state and audit | Partial | `comments.moderate` declared; no moderation record |
| Threaded replies | Not implemented | Flat comments |

## Amendments

| Capability | Status | Evidence / limit |
|---|---|---|
| Submit a structured amendment | Implemented | Title/summary/details/outcomes subset |
| Immutable amendment revisions | Implemented | Hash + parent chain |
| Stale/conflict detection against proposal wording | Implemented | Based on base vs latest revision |
| Resolve, reject, withdraw, rebase | Implemented | `resolve.ts` |
| Amendment ballot | Implemented | `open/close-ballot.ts` |
| Formal acceptance | Implemented | `accept.ts` |
| Apply as new proposal revision | Implemented | `apply.ts` |
| Inter-amendment conflict detection | Not implemented | Two amendments may edit the same field |
| Preferential amendment resolution | Not implemented | — |
| Amend/repeal from a policy page | Not implemented | No `targetPolicyId`/change type |

## Ballots and decisions

| Capability | Status | Evidence / limit |
|---|---|---|
| Five-stage lifecycle | Implemented | `propose`, `deliberate`, `decide`, `implement`, `archived` |
| Matter registry with policy/resolution types | Implemented | `src/lib/matters.ts` |
| Stage transition validation | Implemented | Table plus guards; `requiredPermission` not enforced |
| Immutable ballot-to-revision binding | Implemented | `ballot-binding.ts` + audit events |
| Approve / abstain / reject votes | Implemented | `proposal_votes` |
| Change vote while open | Implemented | Upsert; unique index |
| Pending preference before verification | Implemented | Promoted only if revision matches |
| National ballot eligibility | Implemented | Any verified member |
| Branch ballot eligibility | Implemented | Exact active branch membership |
| Eligibility snapshot at ballot open | Not implemented | Checked at vote time |
| Ballot deadline enforcement | Implemented | Exclusive at `ballotClosesAt` |
| Set a deadline for a new ballot | **Not implemented** | No API writes `ballotClosesAt` |
| Scheduled ballot opening | Not implemented | No scheduler or `opensAt` |
| Explicit proposal-ballot close | Not implemented | Deadline is the only close |
| Record a formal result | Implemented | Officer supplies result + decision event |
| Compute result from tally | **Not implemented, by design** | No thresholds, quorum or ties |
| Multiple ballot instances per matter | Not implemented | One current ballot per proposal |
| Confirmation ballot | Not implemented | — |
| Seconding | Not implemented | — |
| Encrypted vote storage | Implemented, off by default | AES-256-GCM + blind index |
| Identifiable ballot access control | Implemented | National boundary |
| Election/Returning Officer role | Not implemented | National admin is the conservative boundary |

## Policy Registry

| Capability | Status | Evidence / limit |
|---|---|---|
| Ratify a successful policy proposal | Implemented | National-only, exact revision + decision event |
| Ratify a governance resolution | Blocked by design | 409 |
| Publish a ratified policy | Implemented | Publication event + idempotency |
| Withdraw a published policy | Implemented | Reason + event |
| Supersede a published policy | Implemented | Cycle detection |
| Reconcile pending publication events | Implemented | Admin-only, state-filtered |
| Un-ratify or edit registry wording | Not implemented | Append-only model |
| Import the national policy baseline | Not implemented | Registry starts empty |
| Import Victorian baseline | Not implemented; blocked | No corpus or authority |
| Branch-level ratification | Not implemented | — |
| Public API for published policy | Implemented | `/api/v1/` |
| Public API for proposals | Not implemented | Proposals are web-only |
| Public API deprecation policy | Not implemented | — |

## Notifications and engagement

| Capability | Status | Evidence / limit |
|---|---|---|
| Email topic preferences | Implemented | Independent of push |
| In-app inbox and read state | Implemented | `member_notifications` |
| Web Push subscriptions | Implemented, optional | VAPID required to send |
| PWA manifest and service worker | Implemented | No caching of API or navigations |
| Digest email | Implemented when scheduler runs | 25 per run |
| Ballot-opening fan-out to inbox/push | **Built but unwired** | `dispatchMemberNotification` has no caller |
| Governance-outcome fan-out | **Built but unwired** | Same |
| Bounce/complaint suppression | Implemented | Cannot be overridden by member |
| Re-engagement campaign | Implemented, approval-gated | Batches ≤ 25 |
| In-process scheduler | Not implemented | External cron required |
| Coolify scheduled tasks enabled | No | Must be configured |

## Administration

| Capability | Status | Evidence / limit |
|---|---|---|
| Admin overview and attention queue | Implemented | `/admin/` |
| Proposal management | Implemented | `/admin/proposals/` |
| Ballot/decision register | Implemented | `/admin/ballots/` |
| Member verification and roles | Implemented | `/admin/members/` |
| Custom roles and permission inspector | Implemented | `/admin/roles/`; UI still shows raw keys |
| Branch governance | Implemented | `/admin/branches/` |
| Policy registry operations | Implemented | `/admin/policies/` |
| Reports (CSV/PDF) | Implemented | `/admin/reports/` |
| Engagement/email dashboard | Implemented | `/admin/engagement/` |
| Migrations | Implemented | `/admin/migrations/` |
| Site settings | Implemented | `/admin/settings/` |
| Public pulse poll | **Not implemented** | Inert flag and roadmap label |
| Full RBAC consolidation | Partial | Several keys declared but not enforced |

## Platform and integrations

| Capability | Status | Evidence / limit |
|---|---|---|
| Astro SSR on Node | Implemented | Standalone adapter |
| MongoDB persistence | Implemented | With development in-memory fallback |
| Seed baseline proposals | Implemented | 78 records, insert-only |
| DTO-minimised APIs | Implemented | `api-contracts.ts` |
| Public ETag API | Implemented | `/api/v1/` |
| Request middleware / central guard | Not implemented | No `src/middleware.ts` |
| CSP and standard security headers | Not implemented in app | Perimeter responsibility |
| General API rate limiting | Not implemented | Auth and Sense Box only |
| Structured logging | Partial | Redacting operational logger |
| Metrics/tracing | Not implemented | — |
| Resend email | Implemented | Sign-in, digest, lifecycle |
| UndergroundCRM | Implemented, gated | Read-only |
| Plausible analytics | Implemented, host-gated | Production host only |
| Signal | Planned | No code |
| Horizon CMS / Sanity | Planned | No code |
| Horizon design system | Implemented as tokens/primitives | Not a runtime service |
| Coolify / NUC / GHCR deployment | Implemented | Health-checked releases |

## Explicitly missing governance capabilities

These are not oversights in the matrix; they are open product decisions:

- thresholds, quorum, turnout, tie-breaking, abstention and non-voter treatment;
- notice periods, campaign windows and scheduled opening;
- qualifying membership rules for each class of ballot;
- ratifying authority by jurisdiction;
- seconding;
- confirmation ballots;
- eligibility snapshots at ballot open;
- automatic ratification;
- policy amendment/repeal initiated from a published policy.

See [known-gaps.md](known-gaps.md) and `docs/engage-product-direction-governance-audit-2026-11-07.md`.
