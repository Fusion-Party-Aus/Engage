# Cross-industry synthesis

Research date: 13 November 2026. Companion to the [platform evidence register](01-platform-evidence.md) and [opportunity backlog](03-opportunity-backlog.md).

## Decision summary

Engage's governance foundation is stronger than most of the products studied here. It already separates policy proposals from governance resolutions, discussion stances from formal ballots, ballot wording from recorded results, and ratification from publication. It has immutable revisions, permission-scoped administration, append-only governance events, contribution feedback with structured evidence, scoped roles, and a real member next-action experience.

The problems worth solving are therefore mostly **presentation, responsibility and flow**, not governance semantics:

1. **Role administration speaks in implementation keys.** The role editor is capable, but its effective-permission inspector shows raw permission strings, roles are summary rows without member counts or outcome descriptions, and there is no safe way to preview what a role means. Discord and Stripe show how to make a large capability set legible; GitLab shows how to structure custom roles around a base.
2. **Matter creation is still a form, not a guided decision.** The type registry is extensible in code, but the admin interface asks for a lifecycle stage and a kind in one long form. Linear and Notion show how type-specific templates and a bounded intake reduce cognitive load without exposing a workflow builder.
3. **Administration is a system summary, not a responsibility queue.** "Needs attention" groups by governance action, but there is no owner, no saved view, no "my work" and no safe bulk action. Zendesk and Linear are the strongest models for turning a register into a work queue.
4. **History exists but is not always readable as a chain.** Revisions, amendments, evidence, ballot results, policy records and typed relationships exist, but the member has to assemble the lineage. Wikipedia, GitHub and Airtable show how to present revision and relationship context without a graph database or a raw audit log.
5. **Notifications are broad topics, not relevance controls.** The channel architecture is thoughtful, but members cannot follow a specific matter, choose a digest cadence, or see why a notification arrived. Discourse's watching/tracking vocabulary is the clearest model.
6. **Collaboration stops at the comment box.** Deliberation comments are not anchored to the wording they discuss, and revision changes are not summarised at the point of review. Figma, Google Docs and GitHub show the value of anchored feedback and exact-version review, while also showing why acceptance must not be confused with a formal decision.

The strongest combinations are:

- **Discord's capability editing and effective-access preview + GitLab's base-role discipline + Stripe's can/can't role descriptions**, constrained by Engage's fixed governance boundary.
- **Linear's bounded intake and saved views + Zendesk's assignment/"take it" + Stripe's outcome-uncertainty recovery**, applied only to operational tasks.
- **Wikipedia's revision list and permalinks + GitHub's revision-bound review + Airtable's bidirectional relationships**, presented as a compact lineage rail rather than a graph.
- **Discourse's notification vocabulary + Linear's view subscriptions + Engage's existing catch-up digest**, with no engagement scoring or manipulative re-engagement.
- **Figma/Google Docs anchored feedback + Engage's formal amendment process**, where comments inform but never replace the ballot.

## Method and evidence limits

The evidence register records the twelve platform reviews, source links and four runtime observations. In summary:

- Public interfaces were exercised for GitHub, GitLab, Wikipedia and Discourse Meta only. Authenticated surfaces for Discord, Linear, Zendesk, Airtable, Notion, Stripe, Figma and Google Docs were unavailable.
- Documentation describes supported behaviour, not a specific deployment's configuration. Plan-gated features may not exist for a small organisation.
- No usability test was run with Engage members or administrators. Claims about comprehension are hypotheses, not measurements.
- No production data, usage analytics, support tickets or administrator interviews were inspected.
- Engage was inspected on `research/cross-industry-platforms`, branched from `main` at `787160a`. Line references can move.

## Engage implementation baseline

The repository is the source of truth. This table records what already exists so the backlog does not recommend duplicate work.

| Question | Existing implementation | Assessment |
|---|---|---|
| What kinds of matter exist? | [`matters.ts`](../../../src/lib/matters.ts) defines a `MatterRegistry` with `policy` and `resolution`, per-type capabilities, allowed stages and type-aware transitions. Unknown types are rejected at trust boundaries. | A sound extensibility seam. It is code-registered, not administrator-configurable, which is the right safety choice. |
| Can a new matter type be added without rewriting dispatch? | A `MatterTypeDefinition` declares capabilities and transitions; `createMatterRegistry` accepts extra definitions. | Yes in code. There is no guided creation experience driven by those capabilities. |
| Are lifecycle transitions protected? | [`validateMatterTransition`](../../../src/lib/matters.ts) rejects invalid stage jumps, requires deliberation before decision, and checks capabilities. `store.ts` calls it on update. | Strong. The admin UI still presents a free stage `<select>` rather than the valid next actions. |
| What is a formal decision? | [`ballots.ts`](../../../src/lib/ballots.ts) separates `BallotRecord` from `FormalDecisionRecord`; ballots bind an immutable revision and an electorate. | Strong separation. Preserve it. |
| How are roles modelled? | [`rbac.ts`](../../../src/lib/rbac.ts) has a 25-key `PERMISSION_CATALOGUE`, national/branch scopes, sensitivity flags, effective snapshots with grant origins, and add-only evaluation. | Strong core. The UI exposes raw keys and lacks role outcome summaries. |
| How is delegation guarded? | [`roles-store.ts`](../../../src/lib/roles-store.ts) blocks self-assignment, self-revocation, editing a role's scope while assigned, granting permissions the actor lacks, and deleting assigned roles. | Good server-side guards. Several are invisible in the UI, and revocation uses `window.prompt`. |
| Can branch administrators delegate? | Only `roles.manage` (national) can create or assign custom roles. Branch admins manage branch membership, not custom roles. | A deliberate boundary, documented as an open governance question. Do not change without a specification. |
| How does an administrator see effective access? | [`RolesManager.tsx`](../../../src/components/admin/RolesManager.tsx) has an "Effective permissions inspector" table. | Useful data, poor presentation: raw permission keys in monospace, no plain-language grouping, no page/action preview. |
| What does the admin overview do? | [`admin/index.astro`](../../../src/pages/admin/index.astro) builds `attentionGroups` for ballot wording, expired ballots, ratification, resolution outcomes, publication, amendments, contributions and member verification. | A genuine action queue, but system-wide and count-based. No ownership, due date, saved view or bulk action. |
| How are proposals created? | [`admin/proposals/index.astro`](../../../src/pages/admin/proposals/index.astro) embeds a create/edit form in the same page as the register, with kind and stage selects and provenance fields. | Capable but dense. Type-specific guidance is limited; stage is chosen rather than earned. |
| Is there an operational owner? | No `assignee`, `ownerId`, `assignedTo` or `dueAt` field was found in the admin/proposal model. | A real gap for multi-officer operations. Distinguish operational stewardship from governance authority. |
| Are there saved views? | Admin pages use URL query parameters (`stage`, `branch`, `view`, `q`) but do not persist named views. | Filtering exists; durable "my work" views do not. |
| Are there bulk actions? | No general bulk action pattern was found in the admin surfaces inspected. | Appropriate for formal acts; a gap for low-risk operational tasks. |
| What history exists? | Immutable `ProposalRevision` snapshots with hashes; amendment revisions; `ContributionFeedbackHistory`; `governance_events`; `governance_relationships`; policy publication events. | Rich data. Presentation is fragmented across sections. |
| How are relationships modelled? | [`governance-relationships.ts`](../../../src/lib/governance-relationships.ts) defines `supersedes`, `amends`, `implements`, `derives_from`, validates existence, type compatibility and circular supersession, and records a governance event. | Good typed foundation. The member-facing lineage is not a single coherent chain. |
| How are ballots bound to wording? | `ProposalRecord.ballotRevisionId`; ballot binding and result routes; revision labels. | Strong. Make the exact bound revision more visible in the decision summary. |
| How are contribution responses evidenced? | `ContributionFeedback` includes optional structured `evidence` (`amendment`, `revision`, `decision`, `policy`) with permission re-checks on display. | Already implemented. Do not recommend a new response-status system. Improve discoverability. |
| How do members find work? | `/proposals/` has eligibility-aware outstanding decisions, filters, paging and a next-action hero; `AttentionQueue.astro` shows open ballots and progress. | Good task orientation. Validate comprehension before adding more navigation. |
| How do notifications work? | [`notifications.ts`](../../../src/lib/notifications.ts) defines five topics, independent email/push consent, in-app inbox, dedupe, lock-screen confidentiality and Web Push. Catch-up digest exists in `member-activity.ts`. | Strong channel architecture. Missing per-matter following, digest cadence and "why am I seeing this". |
| What is the design system? | Horizon tokens and shadcn primitives; `AGENTS.md` mandates primitives and forbids arbitrary palette utilities. | Strong constraint. Any new surface must compose existing primitives. |

## A. Roles, permissions and organisational delegation

### What the evidence shows

Three distinct models appear:

| Model | Product | Core idea | Risk |
|---|---|---|---|
| Layered allow/deny with scopes | Discord | Base role permissions plus per-channel allow/deny overwrites, resolved by precedence | Hard to predict; deny rules and administrator bypass create hidden authority |
| Base role plus additive abilities | GitLab | Pick a default role, add specific capabilities; highest role wins across group/project | Large matrix; wrong base grants too much; enterprise-gated |
| Purpose-built named roles | Stripe | Role names describe a job; can/can't lists; multiple roles additive; sensitive roles restricted | Long role list; additive conflicts |

Engage's model is closest to a **purpose-built named role with an explicit capability list**, but its presentation is closer to a developer permission table.

### The important distinction

The platforms reveal four concepts that are often conflated:

1. **Role capability** — what an actor may attempt (`ballots.bind`).
2. **Organisational authority** — whether the actor's branch or office is constitutionally entitled to that act for this matter.
3. **Membership eligibility** — whether a person is a verified member and in the electorate.
4. **Resource access** — whether a person can see a record.

Engage already separates these in code: configurable permissions do not grant ballot eligibility; `canParticipate` and `canManageBranchBallot` are independent; `canViewIdentifiableBallots` is a special boundary. The interface should make that separation explicit, because a Discord-style role editor invites administrators to assume that ticking a box grants the underlying authority.

### What Engage should adopt

- **Outcome-language role descriptions.** Every role shows a short "This role can…" and "This role cannot…" summary generated from the permission catalogue, plus a "Constitutional limits" note for acts that no role can grant.
- **Role templates.** Start from "Deliberation moderator", "Branch membership verifier", "Ballot officer", "Reports viewer" rather than a blank matrix. A template is a starting point, not a new authority.
- **Assigned-member counts and a member list.** Before editing or deleting, an administrator sees who holds the role and in which branch.
- **Effective-access explanation.** Replace the raw-key table with grouped, plain-language grants and their origins. Add a read-only "what this member can see and do" preview computed by the permission engine.
- **Visible escalation guards.** Disable permissions the actor does not hold and explain why; block self-assignment and self-revocation in the UI as well as the server.
- **Reasoned revocation.** Replace `window.prompt` with an `AlertDialog` containing a `Textarea`, a clear consequence statement, and an audit entry.
- **Human-readable audit log.** Show "Granted Ballot officer to Jordan Lee for Victoria" rather than `role_assigned`, with actor, time, scope, before/after and reason.

### What Engage should reject

- Deny overrides or per-record permission overrides. Add-only grants with explicit scope are safer and easier to explain.
- An all-powerful administrator role that bypasses ballot binding, result recording or ratification. The existing permission model and lifecycle validation must remain authoritative.
- Making ballot eligibility a configurable role permission. Eligibility is a membership/jurisdiction fact.
- A giant permission matrix. Twenty-five keys is already a lot for a volunteer administrator; grouping and templates are better than more granularity.

### Evidence confidence

High for the documented patterns (Discord, GitLab, Stripe). Medium for applicability: Engage's permission model is simpler, and no administrator usability test exists. The raw-key presentation is directly observed in the repository.

## B. Governance matter workflows

### What the evidence shows

- **Linear:** one object, per-team workflows, bounded triage, templates, saved views, archive as a place. The workflow is opinionated by default and configurable by teams.
- **GitHub:** fixed review states and protected transitions; approval is bound to a diff; a timeline records the decision.
- **Zendesk:** forms and contextual workspaces tailor the fields and tools to the task; triggers and automations handle event/time rules.
- **Notion:** templates prefill properties and content; "can edit content" separates content from structure.

### The Engage problem

Engage's `MatterRegistry` is a good extensibility seam, but the admin creation experience does not use it as a guide. The current page offers a single form with:

- a "Lifecycle stage" select containing `propose`, `deliberate`, `decide`, `implement` and `archived`;
- a "Classification" select for policy/resolution;
- a long set of shared fields, including provenance fields that only apply to some matters;
- a separate "Branch and publication scope" disclosure.

This asks the administrator to understand the lifecycle before they have described the matter. It also lets them select a stage that the server may reject, which turns a governance rule into a form error.

### What Engage should adopt

1. **Choose the matter type first.** A short chooser with two or three cards:
   - **Policy proposal** — "Deliberated, amended, voted, ratified, and published as party policy."
   - **Governance resolution** — "Deliberated, amended, and voted; records an organisational outcome but never enters the policy registry."
   - Future types appear only when registered and are described by their capabilities.
2. **A capability summary, not a settings page.** Show what this type supports and what it does not. This is the Notion template/Linear workflow idea without exposing configuration.
3. **Type-specific fields.** Resolution creation should not show policy publication fields. Policy creation should show provenance. Both should show the minimum required fields first, with "Add supporting detail" as a disclosure.
4. **Stage as an action, not a dropdown.** Create as a draft (`propose`) with a primary action "Send to deliberation". The transition panel explains prerequisites and disabled reasons. This is GitHub's protected transition pattern applied to governance.
5. **Optional operational steward and target date.** A steward is the person responsible for shepherding the matter operationally. This is not governance authority and must never affect ballot eligibility. It enables "my work" and escalation.
6. **A bounded intake view.** New drafts, branch referrals and suggestions appear in an "Intake" view. Do not add accept/decline/merge semantics to formal matters without a governance specification; those semantics belong to drafts and referrals only.
7. **Templates for repeated matter shapes.** A "Policy proposal" template can prefill the commitment structure, provenance prompts and a review checklist. Templates must not prefill a decision or a ballot.

### What Engage should reject

- A generic workflow builder or custom status designer. The stages are constitutional.
- Free-form custom fields on matters. They would create unvalidated governance data and complicate reporting.
- Automatic stage advancement based on time or activity. Only an authorised human action may advance a formal lifecycle.
- A triage "decline" action that silently cancels a member-created proposal. Any such action needs a reason, a member-visible state and a governance rule.

### Evidence confidence

High for the documented patterns. Medium for the exact creation flow; this is a design proposal, not an observed Engage usability failure.

## C. Administration and operational usability

### What the evidence shows

- **Zendesk:** views are the work surface; assignment and "take it" make responsibility visible; macros reduce repetition with preview; triggers/automations handle time-based escalation.
- **Linear:** saved views, favourites, view owners, subscriptions, triage responsibility and archive.
- **Stripe:** role purpose, least privilege, security history and explicit outcome uncertainty.
- **GitLab:** assigned-user counts, role details and approval state even when optional.

### The Engage problem

The admin overview is a good start, but it answers "what is happening across the system?" rather than "what should I do now?". The groups are useful:

- ballot wording needs review;
- ballots past closing date;
- successful ballots awaiting ratification;
- resolution outcomes to record;
- adopted policy not yet published;
- amendments need review;
- contributions awaiting response;
- member accounts need verification.

But every group is a count plus a link. There is no owner, no age, no due date, no saved filter, no bulk low-risk action, and no personal queue. A branch administrator and a national administrator see the same shape, even though their authority differs. The page also says "Your authority scope" in prose rather than showing the actions that scope enables.

### What Engage should adopt

**1. A responsibility-aware operations queue.**

Default views:

- **My work** — operational tasks assigned to me, or in my branch scope, with permission checks.
- **Unassigned** — tasks that need an owner.
- **Closing soon** — bound ballots closing within seven days, and tasks with a target date.
- **Awaiting decision** — successful ballots needing a recorded outcome, ratification or publication, filtered by authority.
- **Member follow-up** — contributions awaiting response, grouped by matter.

Each row shows the matter, the required action, the owner (or "Unassigned"), the age/due date, and a single primary action. This is Zendesk's view logic with Linear's saved-view ownership.

**2. Operational assignment, not governance delegation.**

Add `stewardMemberId` (or a task assignment record) for operational work: preparing a ballot, responding to contributions, checking a membership. Assignment must not grant a permission or change authority. The assignee still needs the permission to act. This distinction is essential and should be stated in the UI.

**3. Saved views.**

Allow an administrator to save the current filter set as a named personal view, and optionally share it with a branch or national team. Do not build a general query builder; use the existing filters (`stage`, `branch`, `view`, `q`) plus a small set of task filters. View ownership and "last updated" prevent orphaned views.

**4. Safe bulk operations.**

Limit bulk actions to low-risk, reversible operational tasks:

- assign selected items to a steward;
- send a reminder to selected members (previewed, rate-limited);
- verify selected branch memberships (with a confirmation summary and reason);
- mark selected notifications as read (member-side).

Do **not** offer bulk ballot binding, bulk result recording, bulk ratification or bulk publication. Those are formal acts that need individual review and an exact revision.

**5. Explicit outcome states.**

For sensitive actions, show one of:

- **Saved** — the server confirmed the change.
- **Not saved** — validation/permission failure, with the reason.
- **Outcome unknown** — network or server failure after submission; offer "Check current state" before retrying.

Stripe's error model is the source. Engage should not claim success until the persisted record is confirmed, especially for ballot binding, result recording and publication.

**6. Human-readable operational history.**

The role audit log and governance events should be filterable by actor, action, matter and date, with human labels and reasons. Keep raw event identifiers behind a diagnostic disclosure for authorised users.

### What Engage should reject

- A general trigger/automation builder for governance transitions. Reminders and escalation may be automated; formal acts may not.
- Bulk formal decisions.
- Assignment that implies authority.
- A dashboard that adds more summary cards instead of removing decisions.

### Evidence confidence

High for the patterns; medium for the specific queue design. The absence of assignment/saved views is observed in the repository. The value of bulk actions depends on actual volume, which was not measured.

## D. Deliberation, collaborative editing and revision history

### What the evidence shows

- **Figma:** canvas-anchored comments, resolve/reopen, named version history, non-destructive restore, branches/merges.
- **Google Docs:** explicit Suggesting mode, anchored suggestions, accept/reject one or all with preview, comments with resolve/reopen and action items.
- **Wikipedia:** compact revision list, `cur`/`prev`, exact-version permalinks, edit summaries, minor-edit markers, protection with reasons.
- **GitHub:** line comments, suggested changes, review states, stale-approval invalidation, timeline.
- **Discourse:** visible edit history at all trust levels; moderation separate from participation.

### The Engage problem

Engage already has more governance structure than any of these products:

- formal amendments with base and replacement wording;
- an amendment diff drawer;
- immutable revisions with hashes;
- a ballot bound to a revision;
- contribution feedback statuses and evidence;
- a decision chain on the proposal page.

What it lacks is **reading order and anchoring**:

- A deliberation comment is a free-standing post; it does not say which commitment or clause it concerns.
- A revision is listed with a label and hash; it does not lead with a human summary of what changed.
- Contribution feedback can point to evidence, but the member has to find the evidence elsewhere on the page.
- The amendment diff is present, but a reviewer preparing a revision has no "review all changes" sequence.

### What Engage should adopt

1. **Optional clause anchors on deliberation comments.** A member can attach a comment to a specific commitment, section or amendment. The anchor is a navigation aid, not a formal amendment. It must not change the wording.
2. **A revision summary at the top of each revision.** "What changed" in plain language, author, date, and a link to the exact revision. Encourage a short summary when saving a revision. This is Wikipedia's edit summary and Figma's named version.
3. **Compare to previous / compare selected.** Reuse the existing revision data and amendment diff components. A reviewer should be able to move through changes without opening each record.
4. **"This response points to…" links.** When contribution feedback has evidence, render a short link to the exact revision, amendment or decision, subject to the viewer's permissions. Do not expose an inaccessible record's title.
5. **A review checklist for officers.** Before binding a ballot: wording reviewed, amendments resolved, eligibility checked, deadline set. The checklist is informational and does not replace the server-side checks.

### What Engage should reject

- Real-time co-editing of formal wording.
- Accepting a suggestion directly into a ballot-bound revision.
- Treating comment resolution as consensus or approval.
- Hiding edit history from ordinary members. Visible history supports accountability, provided personal data is handled correctly.
- A generic "suggest edit" feature that bypasses the amendment process. Formal amendments exist for a reason.

### Evidence confidence

High for the external patterns. Medium for member benefit; no deliberation usability test was run. The existing contribution evidence and revision components are observed in code.

## E. Relationships and provenance

### What the evidence shows

- **Airtable:** bidirectional linked records, lookups/rollups, interface-specific access, record revision history with actor/source attribution.
- **Notion:** two-way relations, displayed related properties, page/record duality, templates.
- **GitHub:** cross-references and a chronological timeline; audit log separate from the work surface.
- **Wikipedia:** exact-version links and revision lineage; deletion removes public history.
- **Linear:** parent/sub-issues, relations, archive with working links.

### The Engage problem

Engage has the data for a strong lineage:

- `ProposalRevision.parentRevisionId` and `contentHash`;
- amendments with `appliedRevisionId`;
- `ContributionFeedbackEvidence`;
- `BallotRecord` and `FormalDecisionRecord`;
- policy registry records with publication events;
- `governance_relationships` (`supersedes`, `amends`, `implements`, `derives_from`);
- `governance_events`.

But the member experience is assembled from separate sections. The proposal page has a decision chain, revisions and amendments; the policy page has publication status. There is no single "follow this matter" rail that says:

> Idea → branch referral → revisions → amendment → bound ballot → recorded result → ratification → publication → successor

The prior participatory research already recommended reciprocal links and evidence, and warned against a generic graph. This research supports that conclusion: the best products use **contextual lists and timelines**, not network diagrams.

### What Engage should adopt

1. **A compact lineage panel** on proposal and policy pages, using ordered steps with dates and plain labels. Each step links to the exact record. Show only steps that exist; do not invent a stage.
2. **Reciprocal links.** If a policy supersedes a proposal, the proposal shows "Superseded by [policy]" and the policy shows "Supersedes [proposal]". If an amendment was applied, the revision shows the amendment and the amendment shows the applied revision.
3. **Evidence chips with permission-aware links.** "Incorporated in revision 4" or "Applied as amendment #2" rather than an unlinked claim. Reuse the existing evidence resolver.
4. **A separate diagnostic view.** Raw event IDs, relationship IDs and content hashes belong in an authorised diagnostic disclosure, not the primary member view.
5. **Archive and supersession as destinations, not dead ends.** Keep active discovery clean, but let an authorised reader follow the chain forward. This requires an explicit historical access decision; do not simply expose archived records to everyone.

### What Engage should reject

- A generic node-and-edge graph editor.
- Free-form "related records" that bypass typed relationships and validation.
- Deleting records to retire them.
- Showing raw IDs or hashes as the primary lineage label.
- A public lineage that exposes private branch matters or identifiable ballots.

### Evidence confidence

High for the external patterns and the existence of Engage's typed relationships. Medium for the exact panel design. Historical access remains a governance decision, not a UI choice.

## F. Notifications, engagement and onboarding

### What the evidence shows

- **Discourse:** Watching / Tracking / Watching First Post / Normal / Muted; per-topic, category and tag controls; notification menu tabs; configurable defaults; activity summary.
- **Linear:** view subscriptions; notifications for items added/completed; no self-notifications.
- **GitHub:** review requested, assigned, mentions, participating; granular notification settings; audit separate.
- **Notion:** inbox for permission requests; comments and mentions.
- **Discord:** notification settings per server/channel; role mentions; no governance semantics.

### The Engage problem

Engage's notification architecture is already careful:

- five topics;
- independent email/push consent;
- in-app inbox with read/unread;
- dedupe;
- lock-screen confidentiality;
- catch-up digest;
- approval-gated re-engagement.

But the member controls are broad. A member can choose "New ballots" or "Contribution responses", not "this proposal" or "this branch". There is no per-matter follow, no digest cadence control, and no explanation of why a notification appeared. `digestEnabled` is tied to the `closing_deadlines` preference, which couples two concepts.

### What Engage should adopt

1. **Follow a matter.** Three levels:
   - **All updates** — new deliberation, amendments, revisions, decisions.
   - **Decisions only** — ballot opens, result recorded, policy published.
   - **Muted** — no notifications, but the matter remains accessible.

   Defaults: author = All updates; voter/commenter = Decisions only; everyone else = not following. Make the default visible and easy to change. This avoids implicit subscription fatigue.

2. **A follow list.** "Following" in the member area, grouped by matter, with the current state and next action. This is Discourse's tracking list and Linear's view subscription, without a social feed.

3. **Digest cadence separate from topics.** Immediate / daily / weekly / off. Keep essential account messages outside the cadence. Do not infer consent. If a member chooses weekly, do not also send immediate ballot alerts unless they opted in.

4. **"Why am I seeing this?"** Every inbox item and email has a one-line reason: "You voted on this proposal", "You follow this branch", "You are the author", "You are eligible to vote". This reduces mistrust and support burden.

5. **A returning-member catch-up.** Engage already builds "Since your last visit". Keep it, but make the primary action obvious and cap the list. Do not add streaks, points, leaderboards or artificial urgency.

6. **Quiet defaults.** No notification for every comment. No re-engagement campaign without explicit approval. No "you haven't voted" shaming. The existing approval-gated re-engagement is the right pattern.

### What Engage should reject

- Engagement scores or trust levels that affect governance rights.
- Streaks, leaderboards, badges for voting, or push notifications designed to create anxiety.
- Auto-following every matter a member views.
- A single "all notifications" switch that makes granular consent meaningless.
- Sending identifiable ballot information in push payloads (already avoided).

### Evidence confidence

High for Discourse's documented vocabulary. Medium for Engage member preferences; no member research was conducted. The existing notification architecture is strong and should be extended, not replaced.

## G. Accessibility and comprehension

### What the evidence shows

- **Google Docs:** keyboard shortcuts for comment navigation (J/K/R/E/U), visible comment panel, resolve/reopen.
- **Linear:** dense but hierarchical lists, keyboard-first navigation, peek preview.
- **Discourse:** clear notification vocabulary, visible trust-level table, mobile-friendly topic timeline.
- **Notion:** access levels described in plain language; access requests.
- **GitHub/GitLab:** tabs, timelines and sidebars; heavy pages that become difficult on mobile.
- **Airtable:** record-review layout for repetitive review.
- **MediaWiki:** compact history list with explicit labels; mobile view separate.

### The Engage risk

Engage's Horizon system has strong foundations: semantic tokens, visible focus, reduced-motion support, mobile navigation and shadcn primitives. The risk is not visual style; it is **cognitive load in administrative surfaces**:

- the role editor presents 25 permissions in two columns of small text;
- the effective-permission inspector shows raw keys;
- the admin proposals page combines a creation form and a register;
- tables can become dense on mobile;
- error messages sometimes describe the mechanism rather than the next action.

### What Engage should adopt

- **Plain-language labels at the point of decision; exact terms at the point of authority.** "Send to deliberation" is plain; "Ballot wording bound to revision 4" is exact. Use both where they belong.
- **Progressive disclosure.** Show the role's purpose and can/can't summary first; expand the full permission list only when editing.
- **One primary action per surface.** The proposal hero already does this. Extend it to admin task rows.
- **Keyboard and focus.** Every composed control must keep a visible focus ring; do not hide native inputs. Use `ToggleGroup`/`Checkbox` for composite choices.
- **Mobile-first tables.** Prefer stacked rows with labelled values over horizontally scrolling wide tables. If a table must scroll, keep the identifying column sticky and announce the scroll region.
- **Error recovery.** Say what failed, whether it can be retried, and what to do next. Preserve input. Distinguish "not saved" from "outcome unknown".
- **No colour-only status.** Keep the text label; the current `Badge` usage generally does this.
- **Short empty states with a next action.** "You're up to date" is better than a paragraph.

### What Engage should reject

- A separate "simple mode" that hides governance facts.
- Icons without labels for consequential actions.
- Tooltips as the only explanation of a permission or authority.
- Colour-coded role chips without text.
- Mobile layouts that simply shrink the desktop table.

### Evidence confidence

High for the principles; low for specific WCAG conformance because no assistive-technology audit was run. The current design system already provides most of the primitives; the work is composition and copy.

## Strongest combinations

### 1. Discord capability editing + GitLab base-role discipline + Stripe role descriptions

**What it solves:** the role editor is capable but unreadable.

**Combination:**

- Start from a small set of job-shaped templates (GitLab base role, Stripe purpose).
- Edit with grouped, plain-language capabilities (Discord role editor).
- Show a can/can't summary and a "Constitutional limits" panel (Stripe + Engage governance).
- Preview effective access without impersonation (Discord View As Role, constrained).
- Show assigned members and grant origins (GitLab role details, Engage's existing snapshot).

**Why it fits Engage:** it preserves the existing add-only, scoped, server-enforced model. It does not import deny rules or administrator bypass.

### 2. Linear bounded intake + Zendesk assignment + Stripe outcome certainty

**What it solves:** the admin overview shows system state, not individual responsibility.

**Combination:**

- A small set of saved views (Linear).
- "Take it" and an operational steward (Zendesk).
- A task row with one primary action (Zendesk/Linear).
- Explicit saved/not saved/outcome unknown states (Stripe).
- No automation of formal acts.

**Why it fits Engage:** it improves throughput without changing who may bind a ballot or record a result. Assignment is operational, not constitutional.

### 3. Wikipedia revision list + GitHub review binding + Airtable reciprocal links

**What it solves:** the member cannot follow a matter from contribution to publication.

**Combination:**

- A compact, date-ordered revision list with author and summary (Wikipedia).
- Exact-version links and "what changed since review" (GitHub).
- A lineage panel with reciprocal links (Airtable/Notion).
- Evidence chips that link to the exact record (Engage's existing feedback evidence).

**Why it fits Engage:** it uses existing immutable revisions and typed relationships. It does not add a graph database or a second lifecycle.

### 4. Discourse notification levels + Linear view subscriptions + Engage catch-up

**What it solves:** notifications are broad topics, not relevance.

**Combination:**

- Per-matter follow levels (Discourse).
- A follow list with current state (Linear view subscriptions).
- Digest cadence independent of topic consent (Discourse email preferences).
- "Why am I seeing this?" (GitHub/Linear).
- Existing catch-up digest and approval-gated re-engagement.

**Why it fits Engage:** it extends a careful channel architecture without manipulative mechanics or inferred consent.

### 5. Figma/Google Docs anchored feedback + Engage formal amendments

**What it solves:** deliberation comments are detached from the wording.

**Combination:**

- Optional clause anchors on comments (Figma/Google Docs).
- A clear proposed-vs-current diff (already present).
- Officer response with structured evidence (already present).
- Formal amendment and ballot as the only path to change bound wording.

**Why it fits Engage:** it improves the deliberative reading experience while preserving the constitutional distinction between discussion and decision.

## Where copying a pattern would harm Engage

| Pattern | Why it is attractive | Why it must not be copied directly |
|---|---|---|
| Discord channel permission overrides | Fine-grained, familiar to community administrators | Deny/allow precedence and per-record overrides make governance access unpredictable; an administrator could accidentally hide a ballot or expose a private branch record. |
| Discord `ADMINISTRATOR` bypass | Convenient for owners | No role should bypass ballot binding, result recording, ratification or identifiable-ballot restrictions. |
| GitLab configurable approval rules | Flexible review requirements | Formal ballot authority, electorate and approval sequence are constitutional, not workspace settings. A configurable rule could let an unauthorised group approve a decision. |
| GitHub administrator bypass of branch protection | Useful for emergencies | Engage's formal acts need a documented, audited procedure, not a convenience bypass that leaves no trace. |
| Notion broadest-access-wins | Simple mental model | A branch grant must not silently become national access. Engage should fail closed and explain the exact scope. |
| Discourse trust levels as eligibility | Easy to automate participation | Voting eligibility is a verified membership and branch fact. Engagement must never grant constitutional authority. |
| Google Docs "accept suggestion" | Fast editing | Accepting wording is not a formal amendment or ballot. Engage must preserve the amendment → ballot → apply sequence. |
| Airtable flexible schema builder | Empowers administrators | The matter schema is a governance contract. Free-form types or fields could bypass lifecycle validation. |
| Zendesk trigger/automation builder | Powerful operational automation | A time-based rule must never bind a ballot, record a result, ratify or publish. Automate reminders, not formal acts. |
| Figma branch/merge for formal wording | Familiar to designers | Formal wording changes must be revisioned and balloted, not merged by an editor. |

## What not to build

The following are explicitly rejected or deferred in the backlog. They are listed here so future work does not reintroduce them as "best practice".

- A generic workflow or matter-type builder for administrators.
- Deny-based permission overrides for governance records.
- Engagement scores, trust levels or leaderboards that affect voting rights.
- Real-time co-editing of formal wording.
- A relationship graph editor.
- Bulk ballot binding, result recording, ratification or publication.
- AI-generated summaries presented as the official motion or voting advice.
- Auto-following every matter or person a member interacts with.
- A separate "simple mode" that hides the exact wording or authority.
- A developer-style audit console as the primary administrative experience.

## Open questions for validation

1. Which administrative tasks are most frequent and most frustrating? Instrument task completion and ask five administrators.
2. Do branch administrators need to assign pre-approved roles, or is national assignment acceptable? This is a governance decision, not a UI decision.
3. Would members use per-matter following, or does the existing catch-up digest already cover their needs?
4. Do clause-anchored comments improve comprehension, or fragment deliberation? Test with a real amendment.
5. Can an effective-access preview be built without exposing data the previewing administrator cannot see? If not, limit it to an explanation, not a rendered preview.
6. What is the expected matter volume in the next 12 months? Saved views and assignment are more valuable at higher volume.
7. Which current admin tables fail on mobile or with a screen reader? Run an accessibility audit before redesigning.
8. Does the organisation want operational stewardship recorded at all? It adds a field and a queue, but also accountability.

## Evidence confidence summary

| Finding | Confidence | Basis |
|---|---|---|
| Role editing benefits from templates, grouping and can/can't summaries | High | Discord, GitLab, Stripe documentation |
| Effective-access explanation is necessary for layered permissions | High | Discord View As Role, Airtable provenance, Notion warnings |
| Engage's raw permission keys are a UX defect | High | Direct repository observation (`RolesManager.tsx`) |
| Bounded intake and saved views improve admin throughput | High | Zendesk, Linear documentation |
| Engage lacks operational assignment and saved views | High | Repository search found no assignment/due-date fields and only query-param filters |
| Revision history should lead with human summaries and exact links | High | Wikipedia, Figma, GitHub documentation |
| Engage's revision/relationship data is sufficient for a lineage panel | Medium-high | Repository inspection; no rendered journey test |
| Per-matter following would reduce notification fatigue | Medium | Discourse documentation; no Engage member research |
| Clause anchors would improve deliberation | Medium | Figma/Google Docs/GitHub patterns; no governance-specific test |
| A read-only access preview is safe | Medium | Discord pattern; privacy constraints need design review |
| Bulk actions are needed | Low-medium | No volume data; only recommended for low-risk tasks |
| AI summaries would help | Low | Prior research found no verified member need or neutrality guarantee; not recommended here |
