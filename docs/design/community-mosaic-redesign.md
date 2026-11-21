# Community Mosaic redesign

**Document status: Current.** Implementation and verification record for the white-background, Australian community redesign on `Policy_Group_Consultation`, 20 November 2026 (Australia/Sydney).

**Starting commit:** `59453ade3e244665d036607e8fd3f7c2f2a24639`. The nominated branch and `main` had the same starting commit. This work belongs to [the Community Participation & UX initiative, #162](https://github.com/Fusion-Party-Aus/Engage/issues/162). It does not close the broader governance or security programmes.

## Scope and decisions

The existing Astro/React application remains intact. The change evolves Horizon into a spacious white interface with deep purple headings, accessible magenta actions, brighter pink/violet/aqua accents, Australian community illustrations, contextual guidance and clearer task hierarchy. The official repository SVG logos remain unchanged.

The source inventory at the starting commit contained 668 files in 117 directories, including 44 Astro page files (20 administrator pages), 74 API endpoint files and 88 components. The redesign uses the three shared layouts and the existing shadcn-compatible primitives to cover that surface. Route coverage below distinguishes direct page changes from shared presentation changes; a shared-layout change does not imply that every possible database state has been exercised.

The user's implementation instruction authorised completion on the nominated branch and replaced the brief's human design checkpoints with internal verification. It did not authorise modifying another branch, production records, secrets, migrations or deployment configuration. Those boundaries remain in force.

### Design choices

- White is the main reading surface. Pale section tints and labelled navigation provide orientation without making colour the sole indicator of state.
- Outfit provides clear, bold headings. Existing Newsreader policy/editorial usage and local font assets remain supported.
- Existing real participation figures and next actions remain. Mockup points, levels, testimonials, invented member portraits and fabricated ballot counts were excluded.
- Larger imagery introduces the homepage, discovery and member welcome. Formal ballots, confidential administration, decision records and policy wording use calmer layouts without persuasive images beside choices.
- `CivicIntro.astro` provides a reusable page introduction; `CommunityImage.astro` owns responsive imagery; `PageHelp.astro` supplies short route-specific guidance in the shared shells.
- Copy describes existing product behaviour. It does not create governance rules, configuration settings, new data contracts or a content-management subsystem.
- Legal wording, acceptance requirements and consent choices remain unchanged. Legal components received CSS changes only.

The palette, typography and component contract are maintained in [DESIGN.md](../../DESIGN.md). Image provenance, complete generation prompts and responsive file details are in [community-image-assets.json](community-image-assets.json).

## Route coverage

All entries below use the existing routes and server-side access checks. The presentation column describes implementation coverage, not a claim that every workflow was tested in a real production environment.

### Public, member and support pages — 24 source routes

| Source route | Presentation delivered | Behaviour retained |
|---|---|---|
| `/` | Australian cover composition, public participation paths, member next action and real summaries, proposal cards and illustrated guide | Existing server data, eligibility-dependent calls to action, proposal visibility and tally-pending labels |
| `/proposals/` | Spacious introduction, consistent controls, cards and section identity | Filters, sort order, pagination, eligibility and scope |
| `/proposals/new/` | Clear proposal introduction and shared form presentation | Existing fields, validation, permissions and submission |
| `/proposals/[slug]/` | White proposal hero, readable discussion/ballot areas, stage navigation and reviewed ballot workflow | Exact proposal content, revisions, amendments, provenance, next action and all server checks |
| `/proposals/[slug]/record/` | Civic introduction and calmer record presentation | Formal decision, bound wording and provenance |
| `/member/` | Sign-in illustration, member welcome, clear attention/catch-up sections, quieter account settings and bookmark disclosure | Sign-in, registration, verification, legal gate, account states, notifications, branch membership and existing profile/passkey behaviour |
| `/members/[memberId]/` | Consistent profile hierarchy and colours | Public/private visibility, initials avatars, actual contribution history and score semantics |
| `/policies/` | Official-policy introduction and clearer registry rows | Published policy filtering and real records |
| `/policies/[...path]/` | Shared policy detail and branch-registry introductions | Wording, history, jurisdiction, withdrawal, supersession and visibility |
| `/sense-box/` | Welcoming illustrated introduction | Public submission, consent, abuse protection and status-link workflow |
| `/sense-box/[submissionId]/` | Contextual introduction and shared reading styles | Publication permissions and discussion controls |
| `/sense-box/status/[submissionId]/` | Private receipt/status introduction and contextual help | Access-token boundary and status semantics |
| `/collaborate/` | Illustrated invitation discovery | Existing initiatives and their configuration |
| `/collaborate/[slug]/` | Consistent contribution introduction | Questions, media controls, privacy, permissions and consent |
| `/collaborate/[slug]/stories/` | Published-story introduction | Approved real story media and publication boundaries |
| `/collaborate/manage/` | Private-management introduction | Correction, visibility and withdrawal controls |
| `/branches/` | Australian community introduction and section cues | Geographic relationships, branch links and existing membership meaning |
| `/how-it-works/` | Illustrated, readable participation guide | Existing procedural guidance and distinctions between contributions, votes and policy |
| `/privacy/` | Shared legal typography and spacing | Privacy text and version unchanged |
| `/terms/` | Shared legal typography and spacing | Terms text and version unchanged |
| `/changelog/` | Consistent introduction, typography and release rows | Genuine generated Git history |
| `/403` | Shared error presentation and recovery links | Forbidden status and access behaviour |
| `/404` | Shared error presentation and recovery links | Not-found behaviour |
| `/500` | Shared error presentation and recovery links | Database/session-independent error layout |

### Administrator pages — 20 source routes

Every administrator page uses `AdminLayout.astro`, the shared Horizon tokens and `admin.css`. The shell now has a light navigation rail, official logo, clear current location and route-specific help. Dense working forms and records retain their existing components. Mobile attention rows and card actions stack rather than squeeze the description beside a button.

| Route | Operational contract retained |
|---|---|
| `/admin/` | Role-dependent attention, work queues and overview |
| `/admin/ballots/` | Ballot binding, closure state, certification and distinct formal decisions |
| `/admin/proposals/` | Proposal lists, creation, filters and permitted actions |
| `/admin/proposals/[slug]/` | Exact revisions, amendments, proposal administration and decision controls |
| `/admin/policies/` | Ratification, publication, withdrawal, supersession and authority |
| `/admin/members/` | Verification and member access restrictions |
| `/admin/branches/` | Branch configuration, memberships, referrals and scopes |
| `/admin/roles/` | Delegation, permission keys and national/branch boundaries |
| `/admin/sense-box/` | Moderation queue, privacy and publication controls |
| `/admin/sense-box/[submissionId]/` | Private notes, consent and individual submission handling |
| `/admin/collaboration/` | Contribution review and permissioned media access |
| `/admin/collaboration/invitation/` | Configured invitation discovery and management |
| `/admin/collaboration/invitation/new/` | Existing invitation creation fields and validation |
| `/admin/collaboration/invitation/[slug]/` | Configured invitation editing and state transitions |
| `/admin/collaboration/operations/` | Existing collaboration operations and settings |
| `/admin/engagement/` | Communication permissions, delivery information and suppression rules |
| `/admin/reports/` | Scoped reports and exports |
| `/admin/responsibilities/` | Assigned responsibility and permitted work |
| `/admin/migrations/` | Existing restricted maintenance controls; no operation run by this redesign |
| `/admin/settings/` | Operational settings, explicit outcomes and existing authority checks |

Notification controls, account-recovery/sign-in surfaces and navigation inherit the shared theme. Email/notification service code and transactional template contracts were reviewed as protected integration surfaces and were not rewritten for decoration.

## User journeys and preservation evidence

The shared mobile navigation, keyboard focus treatment, labelled controls and page help apply across these journeys. The verification record identifies which paths were exercised with synthetic in-memory data and which require real MongoDB or provider infrastructure.

| Journey and entry | Workflow and boundary | Failure or recovery requirement | Verification |
|---|---|---|---|
| New visitor, `/` | Explore Sense Box, invitations, proposals or guide without pretending all participation needs membership | Explain the distinction at the action that needs verification | Public route captures; security-perimeter suite |
| Learn eligibility, guide/proposal | Read the exact proposal and the server-derived eligibility/next action | Ineligible readers see the reason; navigation does not grant authority | Existing eligibility tests and member lifecycle browser suite |
| Register and verify, `/member/` | Existing supported sign-in methods, legal acceptance and verification | Preserve pending/suspended states and return destination | Member lifecycle, perimeter and authentication tests; external provider delivery is not simulated as a real sign-in |
| Find an open ballot, member/discovery | Existing outstanding-ballot links, stage and scope filters | Empty and ineligible states must remain truthful | Member lifecycle and proposal discovery checks |
| Read/review/record, proposal | Read bound wording, choose neutrally, review, explicitly confirm, await server | Preserve selection on rejection; ambiguous response requires checking recorded state | Dedicated ballot browser harness, desktop and mobile |
| Change a vote, proposal | Existing saved choice restored; new choice or reason reviewed before update | Closed ballot hides submission; server remains authoritative | Actual API writes to disposable in-memory data, reason-only update and expiry-during-review checks |
| Discuss, proposal | Existing stance, thread, reply and endorsement controls | Authorisation, privacy and threaded deletion behaviour preserved | Discussion browser suite and existing tests |
| Suggest an amendment, proposal | Exact referenced wording and existing create/review workflow | Preserve validation, authority and conflict constraints | Sense Box/amendment browser suite and existing tests |
| Return after several days, `/member/` | Attention first; catch-up, governance activity and optional bookmarks | Real empty states; no invented engagement data | Member lifecycle and dashboard captures |
| Read policy/history, registry/record | Distinguish proposal, tally, certified outcome and published policy | Existing withdrawal/supersession access rules remain | Policy/record source preservation and route coverage where fixtures exist |
| Branch officer, admin | Existing branch-scoped work and responsibility controls | National-only actions remain server restricted | Existing permission tests and source preservation; route scanner separately checks national-administrator, member and guest views |
| National officer, admin ballot/policy | Existing binding, result, ratification and publication actions remain separate | No UI-generated thresholds or silent policy publication | Protected backend diff; existing governance suites; real-Mongo verification reported separately |
| Admin error/access restriction | Existing validation, read-only states and human-readable result messages | Preserve warnings, consequential confirmations and diagnostics boundaries | Perimeter tests, admin route checks and manual mobile review |

## Formal ballot interaction

The endpoint and payload remain `POST /api/votes` with `{ proposalId, choice, reason }`. No extra field, new endpoint or database change is required.

1. A fresh ballot has no selected option. Existing recorded/pending choices or an explicitly restored guest draft remain identifiable as such.
2. Approve, Abstain and Reject share the same size, typography, icon and selected treatment. Tally displays use equal visual treatment too.
3. Review shows the exact selected choice and optional reason. Entering review sends no request. Editing preserves the draft and returns focus to the choice area.
4. Confirm uses an in-flight guard and disabled controls to prevent duplicate clicks. The server still decides eligibility, binding, deadline and persistence.
5. Only a successful response containing a recognised choice confirms the result. A pending-verification response remains a saved preference, including when client-side eligibility is stale.
6. A definite server rejection preserves the draft for correction/retry. A lost response, server failure or invalid acknowledgement explains that the vote may have been recorded and requires a reload to reconcile before another submission.
7. Choice/reason updates require another review. Expiry display is a convenience check; it cannot extend the authoritative server deadline.
8. The share action copies the canonical proposal URL without query parameters or fragments. An uncertain-submission warning survives copying the link.

No claim of anonymity, end-to-end verifiability or unconditional encryption has been added. Those guarantees depend on the existing implementation and deployment configuration, not the theme.

## Protected boundaries

The source diff does not change `src/lib/`, `src/pages/api/`, package versions, the lockfile, Astro configuration, Docker configuration or GitHub workflows. Server data computations in the redesigned public roots, member dashboard and reviewed secondary routes were compared against the starting commit after excluding presentation imports. Existing member and secondary-route client scripts were retained. Intentional client-side changes are the reviewed ballot workflow and the shared administrator drawer's keyboard/focus handling; the latter improves focus containment and restoration without changing authority checks.

The following remain outside the redesign: eligibility and electorate rules; membership verification; role and branch permissions; ballot opening/closing schedules; quorum; exact revision binding; vote persistence and encryption; certification; policy ratification/publication; audit histories; collection/index schemas; CRM, email, push and scheduler contracts.

Local browser servers use an explicit environment allowlist, no production URI, synthetic accounts and process-local test data. Browser harnesses prevent external provider/API requests. No migration, scheduler, notification drain, bulk email or live member operation was run. In-memory tests do not establish MongoDB transactional correctness.

The open work on [ballot authority (#156)](https://github.com/Fusion-Party-Aus/Engage/pull/156), [electorates (#159)](https://github.com/Fusion-Party-Aus/Engage/pull/159) and [outcome/tally read models (#161)](https://github.com/Fusion-Party-Aus/Engage/pull/161) was not merged into this theme. Future integration must preserve their authoritative contracts. [Governance #137](https://github.com/Fusion-Party-Aus/Engage/issues/137) and [security #138](https://github.com/Fusion-Party-Aus/Engage/issues/138) remain separate programmes.

## Verification

See [community-mosaic-verification.md](community-mosaic-verification.md) for commands, actual results, browser coverage, accessibility findings, performance observations and limitations. The verification distinguishes passed, skipped, unavailable and pre-existing failures. New generated illustrations depict fictional people. Screenshot application accounts and records are synthetic; baseline screenshots retain the repository's existing imagery.

The focused ballot harness is `scripts/ballot-review-browser.mjs`. Existing member, proposal-experience and RFC browser selectors now use the explicit review step; their domain assertions were not weakened to accommodate the redesign.

## Delivery and rollback

This is a source-branch delivery. No other branch was merged or updated, and no deployment command or deployment-workflow dispatch was issued. Existing repository workflow triggers and deployment targets remain unchanged. Repository source does not establish the effective configuration or activity of a private host watcher, so a branch push is not proof either of a live release or of the absence of an automatic deployment.

There is no schema migration to reverse. Recover through a reviewed revert of the redesign commits, preserving unrelated later work, and the existing deployment procedure if an authorised release is subsequently rolled back. The starting commit above is the recoverable source baseline. Do not reset shared history, delete records or run a migration to undo a theme.
