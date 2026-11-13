# Platform evidence register

Research date: 13 November 2026. Companion to the [cross-industry synthesis](02-synthesis.md) and [opportunity backlog](03-opportunity-backlog.md).

## Scope, method and evidence limits

### What this register is

A platform-by-platform record of the features examined, evidence used, interaction patterns worth adapting, trade-offs, and relevance to Engage. It is not a feature catalogue and not a recommendation list; recommendations are in the backlog.

### Evidence types used

| Type | Meaning in this register |
|---|---|
| **Documented** | A first-party help centre, product documentation or administrator guide describes the behaviour. |
| **Observed** | A live public interface was exercised at runtime on the research date. Observations are bounded to the pages and steps recorded in the runtime ledger. |
| **Source** | Public source code or a public model/configuration file shows a structural decision. |
| **Inference** | Our interpretation, including proposed adaptation to Engage. |
| **Unverified** | Not established by this investigation. |

### Runtime coverage

REA MCP (`rea-agents` 6.9.0) was available. An owned Chromium 156.0.8078.80 profile was launched for each scenario with empty storage, light theme, reduced motion, blocked service workers and a 1280×720 viewport. No account was created, no authentication bypassed, no private record opened, no vote cast and no production data changed. Each scenario terminated its owned process.

| Ref | Public target | Evidence record | What it establishes | Limits |
|---|---|---|---|---|
| R1 | [GitHub — Engage pull request #24](https://github.com/Fusion-Party-Aus/Engage/pull/24) | `ev_8dd34f9472d5787009db8ddf06c9939d5ec5b4f09f78e34751c9181c9343f16d` | A merged PR surface in a real repository: Conversation / Commits / Checks / Files changed tabs, commit groups, check status, review sidebar, reviewers, assignees, labels, linked issues and activity timeline. | Public repository, signed out. No review submission, check log, merge action or protected-branch bypass was exercised. |
| R2 | [GitLab — `gitlab-org/gitlab` merge request !1](https://gitlab.com/gitlab-org/gitlab/-/merge_requests/1) | `ev_95c385b9cda420ebfee9a53df8550b4c82cdad984a5f2278feb2ff8da2200f57` | A public merge request with "Approval is optional", eligible approvers, open-thread count and navigation, pipeline status, commits, activity timeline, labels, and cross-references. | Ancient public MR. No approval rule was configured, no thread resolved, no pipeline run. |
| R3 | [Wikipedia — Participatory democracy revision history](https://en.wikipedia.org/w/index.php?title=Participatory_democracy&action=history) | `ev_39b8f8b882bbc57f68ded4684ceac843136b9b917bae6b5799d5147c716d02ba` | Grouped-by-date revision list, `cur`/`prev` comparison controls, radio selection for two-revision comparison, byte deltas, editor attribution, edit summaries, minor-edit marker, `undo` links, filtering and paging. | History listing only. Diff page, rollback, patrolled status and oversight tools were not exercised. |
| R4 | [Discourse Meta — Trust Level Permissions Reference](https://meta.discourse.org/t/trust-level-permissions-reference/224824) | `ev_7a5f8e0ded9487b3c39b07a8d7927c6814a60f9592de7275966fdeb90cd754c1` | A long-lived public topic with sidebar navigation, trust-level permission table, post timeline, reply controls, notification controls and staff/moderator actions. | Read-only signed-out view. No notification preference, flag, moderation action or trust promotion was exercised. |

The documentation review covered all twelve platforms. Authenticated surfaces were unavailable without accounts: Discord, Linear, Zendesk, Airtable, Notion, Stripe Dashboard, Figma and Google Docs. Their evidence is therefore documented or source-based, not observed runtime behaviour.

### General limits

- No plan-specific limits, enterprise-only controls, SSO/SCIM behaviour, mobile apps or screen-reader output were verified unless explicitly stated.
- "Documented" does not mean a feature is enabled in every deployment. Vendors gate features by plan, role and administrator configuration.
- Vendor screenshots and marketing pages were not treated as proof of interaction detail.
- No proprietary code or implementation was copied. Descriptions are original analysis of public documentation and source.
- Engage line references identify the inspected implementation and can move after later edits.

---

## 1. Discord — role hierarchy, overrides and effective permissions

**Focus:** role creation, permission flags, scoped overrides, effective permissions and delegation.

### Evidence

- **Documented:** [Permissions API](https://discord.com/developers/docs/topics/permissions) describes permission flags, bitwise composition, role hierarchy, channel overwrites, implicit permissions and permission syncing. [Roles and Permissions](https://support.discord.com/hc/en-us/articles/214836687-Role-Management-101) describes the server Settings > Roles editor, role colours, hierarchy, Manage Roles and channel-exclusive roles. [View Server As Role](https://support.discord.com/hc/en-us/articles/360055709773-View-Server-As-Role-Permission-Guide) describes previewing the server as one or more roles.
- **Documented:** [Audit Logs resource](https://docs.discord.com/developers/resources/audit-log) records administrative actions with actor, target, changes and an optional reason; entries are retained for 45 days.
- **Unverified:** Discord's client UI, role drag-and-drop, permission toggle states, mobile layout and screen-reader behaviour.

### Interaction patterns worth studying

1. **Role editor as a capability checklist, grouped by plain-language category.** A role is a named set of switches; the interface shows what each switch enables, not a database key.
2. **Role hierarchy is a separate concept from permission computation.** Position governs who may edit or assign whom. Permissions themselves are additive across roles, not ordered by position. This is a useful separation: authority to delegate is not the same as the capabilities delegated.
3. **Scoped overrides.** Guild-level base permissions can be narrowed or widened per channel through allow/deny overwrites. This is powerful but produces a precedence ladder that ordinary administrators struggle to predict.
4. **Effective-access preview.** "View Server As Role" temporarily shows the server as a role or combination of roles, including visible channels and available management options. It is a comprehension tool for a permission model that is otherwise hard to reason about.
5. **Delegation guardrails.** Manage Roles can only edit roles below the actor's highest role and can only grant permissions the actor already holds. A member cannot act on someone with an equal or higher role.
6. **Audit reason.** Administrative actions can carry a reason that is visible in the audit log. Moderation actions such as time-out also record a reason.

### Strengths

- The role list makes a large permission surface approachable by grouping and naming.
- Effective-permission preview addresses the biggest failure mode of layered permissions: nobody can predict the result.
- Hierarchy prevents a delegated administrator from editing or assigning above their own position.
- Multiple roles combine additively, which is easy to explain at the point of assignment.

### Weaknesses and failure modes

- The deny-override precedence ladder is notoriously difficult to reason about. A user can see a channel because one role allows it even if another denies it unless a higher-precedence overwrite wins.
- `ADMINISTRATOR` bypasses channel restrictions, creating a single switch with enormous blast radius.
- Role hierarchy mixes social status, colour and authority. Position is not a reliable explanation of capability.
- Audit retention is finite (45 days per the developer documentation), so it is an operational log rather than a permanent governance record.
- The model is designed for community spaces. It has no concept of constitutional acts, ballots, jurisdiction or separation between eligibility and permission.

### Applicability to Engage

**Adopt the presentation, not the precedence model.** Engage already has the safer core: a fixed catalogue of named permissions, add-only grants, national and branch scopes, effective-permission snapshots with grant origins, and server-side enforcement. It should borrow:

- grouped, plain-language capability editing;
- assignment limits and "you cannot grant what you do not hold" surfaced in the UI;
- an effective-access explanation or preview;
- reason capture on sensitive grants and revocations;
- an audit view that names actor, target, change and reason.

Engage should **not** adopt deny rules, per-resource overwrites for governance records, or an all-powerful administrator bypass. Its scope model is deliberately simpler because a branch ballot's eligibility cannot be allowed to depend on a channel-style override. The governance boundary (`canManageBranchBallot`, `canParticipate`, `canViewIdentifiableBallots`) must remain independent of configurable roles.

### Investigation limits

No authenticated Discord client was inspected. The permission computation and hierarchy rules are documented with executable pseudocode, which is stronger than a marketing description, but client rendering, error messages, mobile layout and assistive-technology behaviour remain unverified.

---

## 2. Linear — workflow, triage, views and contextual action

**Focus:** issue and project lifecycles, workflows, contextual actions, navigation and information density.

### Evidence

- **Documented:** [Triage](https://linear.app/docs/triage) describes a team inbox for issues created by integrations or members outside the team, with accept / decline / duplicate / snooze actions, triage responsibility rotation, rules and configurable requirements before leaving triage. [Custom Views](https://linear.app/docs/custom-views) describes durable filtered views, saved and shared views, favourites, view owners and view subscriptions. [Concepts](https://linear.app/docs/conceptual-model) describes issues, per-team workflows, triage, teams/sub-teams and views. [Issues](https://linear.app/docs/creating-issues) describes issue creation, templates, prefilled creation URLs, property defaults and move semantics. [Team pages](https://linear.app/docs/default-team-pages) describes Active, Backlog and Archive. [Project status](https://linear.app/docs/project-status) describes lifecycle categories and inherited status configuration. [Ops and marketing](https://linear.app/docs/ops-and-marketing) shows non-engineering workflow examples.
- **Unverified:** Linear's authenticated UI, keyboard model, cycle automation and mobile behaviour.

### Interaction patterns worth studying

1. **One object, many team-specific workflows.** The issue is stable; statuses are a per-team ordered workflow. Teams choose names that fit their work rather than forcing every team into one global status list.
2. **Triage as a bounded intake queue.** New work does not silently mix with active work. It enters a queue where a person accepts it, declines it, marks it duplicate or snoozes it. Triage can require a priority before an issue leaves.
3. **Saved views are first-class objects.** A filtered list can be named, shared, favourited, owned and subscribed to. Views are how teams turn a generic register into "my work" and "work I am responsible for".
4. **Contextual creation.** Issues can be created from a global shortcut, a prefilled URL, an issue template or selected text. Most properties have sensible defaults; required fields are few.
5. **Archive is a place, not a status.** Active, Backlog and Archive are distinct views over the same object. Archived records keep working links and can be restored.
6. **Density with hierarchy.** Lists group by status, show compact metadata, and rely on keyboard and peek preview rather than opening a full page for every scan.

### Strengths

- Triage prevents intake from becoming a backlog swamp.
- Per-team workflows accommodate genuinely different work without a universal workflow builder.
- Saved views convert a large register into a small number of task-shaped lists.
- The default workflow is opinionated, and customisation is optional rather than the first-run experience.

### Weaknesses and failure modes

- Triage rules and per-team configuration can drift into inconsistent or conflicting automation; Linear surfaces rule conflicts but still requires governance of the rules themselves.
- Snoozing hides work from others by default, which can look like avoidance in a shared service queue.
- Workflow customisation is designed for product teams; it assumes an administrator can freely invent statuses. That is unsafe for formal governance states.
- View proliferation can recreate the overload it was meant to solve.

### Applicability to Engage

**Strong fit for the operational layer, weak fit for the governance layer.** Engage should borrow:

- a bounded intake view for draft proposals, branch referrals and suggestions, without granting new decision semantics;
- saved views such as "My reviews", "Unassigned ballots", "Closing this week", "Contributions to answer";
- a small, opinionated default lifecycle rather than a workflow builder;
- archive as a separate destination with working links and clear restoration;
- lightweight creation with sensible defaults and templates.

Engage should **not** let administrators invent arbitrary lifecycle statuses or approval stages. Its stages are constitutional (`propose → deliberate → decide → implement`, with `archived`), and transitions are validated in `matters.ts`. The correct analogy is Linear's *opinionated defaults*, not its *configurable workflow builder*.

### Investigation limits

No authenticated Linear workspace was available. Documented behaviour is detailed but plan-gated automation (Triage Intelligence, rules, responsibility) was not exercised and may differ by plan.

---

## 3. GitHub — review requirements, protected operations and decision history

**Focus:** pull requests, review requirements, protected operations, auditability and decision history.

### Evidence

- **Documented:** [About pull request reviews](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/about-pull-request-reviews) describes Comment / Approve / Request changes, line comments, suggested changes, reviewer requests and required approvals. [About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches) describes required reviews, stale-approval dismissal, required checks, conversation resolution, linear history, merge queue, lock branch, bypass controls and push restrictions. [Incorporating feedback](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/incorporating-feedback-in-your-pull-request) describes applying single or batched suggestions and out-of-scope follow-up issues. [Audit log](https://docs.github.com/en/organizations/keeping-your-organization-secure/managing-security-settings-for-your-organization/reviewing-the-audit-log-for-your-organization) describes actor/action/time/organisation/repository fields, filters, export and 180-day retention.
- **Observed (R1):** A merged public pull request rendered Conversation / Commits / Checks / Files changed, commit groups, a check summary, review and assignee sidebars, labels, linked issues and an activity timeline. The page distinguished a human comment from a bot review and showed "No reviews" where no review had been submitted.
- **Unverified:** Submitting a review, dismissing a stale approval, a failing required check, branch protection administration, merge queue and audit-log search.

### Interaction patterns worth studying

1. **Review is an explicit decision with named states.** Comment, Approve and Request changes are different acts, not a single "reply" action. Request changes can block merging.
2. **Protected transitions are configured once and enforced everywhere.** Required reviews, required checks and conversation resolution are properties of a protected branch, not conventions that each author remembers.
3. **Stale approval invalidation.** When the diff changes after approval, approvals can be dismissed. The approval is bound to what was reviewed, not to the pull request as an abstract object.
4. **The timeline is the decision record.** Commits, reviews, comments, check results, labels, cross-references and merges appear in one chronological surface with actor and timestamp.
5. **Suggestions are exact and optional.** A reviewer can propose a concrete line change; the author applies it as a commit, batches several, or opens a separate issue for out-of-scope feedback.
6. **Audit log is separate from the work surface.** Ordinary collaboration stays readable; security-relevant administrative events have their own filtered, exportable log.
7. **Human and bot activity are visibly distinct.** R1 showed a bot review collapsing into a table with a "Review failed" state, separate from the human comment.

### Strengths

- The model makes "what was approved" and "what changed afterwards" explicit.
- Protected operations are enforced server-side and are difficult to bypass accidentally.
- Conversation, commits and checks share a timeline, so the decision history is legible without a separate report.
- Suggested changes reduce the gap between feedback and action.

### Weaknesses and failure modes

- Administrators can bypass branch protections by default unless "do not allow bypassing" is enabled. A governance product cannot rely on a bypassable default.
- Required reviews can stall work when reviewers are unavailable; GitHub provides dismissal by write-access users, which is itself an authority decision.
- The timeline becomes extremely dense on long-lived pull requests.
- Audit retention is finite, and the UI has limited search relative to a SIEM.
- Review semantics are code-centric; they do not model eligibility, jurisdiction or a formal electorate.

### Applicability to Engage

Engage already has the harder governance version of these ideas: immutable revisions, ballot wording bound to a revision, a separate recorded result, ratification, publication and append-only governance events. It should borrow the **interaction grammar**:

- present formal transitions as explicit actions with prerequisites, not a free stage dropdown;
- bind approvals and feedback to the exact revision they reviewed;
- show a single chronological decision timeline that distinguishes human actions, system events and formal records;
- make "what changed since this was reviewed" visible (Engage already has revisions and amendment diffs);
- keep an administrative audit view separate from the member-facing record.

Engage should **not** copy GitHub's default administrator bypass. Ballot binding, result recording, ratification and publication must remain protected by explicit permissions and fixed lifecycle rules, with no convenience override.

### Investigation limits

R1 was a public repository's merged PR, signed out. No review was submitted, no check failed, no branch protection rule was edited and no audit-log page was opened. The observation establishes the layout and labels, not enforcement behaviour.

---

## 4. GitLab — custom roles, granular permissions and approval rules

**Focus:** custom roles, granular permissions, approval rules and organisational hierarchy.

### Evidence

- **Documented:** [Roles and permissions](https://docs.gitlab.com/user/permissions/) defines default roles, cumulative permissions, group/project scopes, inherited membership, protected branches and the full action matrix. [Custom roles](https://docs.gitlab.com/user/custom_roles/) describes custom member roles based on a default role plus additional permissions, custom admin roles, limits, assignment, deletion rules and inheritance comparisons. [Approval rules](https://docs.gitlab.com/user/project/merge_requests/approvals/rules/) describes required approvals, multiple rules, optional rules, protected-branch targeting, eligible approvers, code owners and permission-specific approval settings.
- **Observed (R2):** A public merge request showed "Approval is optional", eligible approvers, two open threads with previous/next navigation, pipeline status, commits, an activity timeline, labels and cross-references. The page made approval state visible even when approval was not required.
- **Unverified:** Creating a custom role, assigning it, configuring an approval rule, protected-branch enforcement and the group hierarchy UI.

### Interaction patterns worth studying

1. **Base role plus additions.** A custom role starts from a default role and adds specific abilities. This avoids a blank-slate permission matrix and makes the minimum capability obvious.
2. **Scope inheritance with highest-role resolution.** A user can hold different roles at group and project levels; the highest role wins. Subgroups inherit membership from parents.
3. **Approval rules are separate from roles.** A role grants the ability to approve; an approval rule defines how many approvals and which users/groups are eligible for a particular target branch. Capability and requirement are different objects.
4. **Eligibility is explicit.** Approvers must be direct members of the project or an eligible group; inherited members may not count. Authors and committers can be prevented from approving.
5. **Optional vs required approval.** The same mechanism can express advisory review and blocking approval without inventing a second workflow.
6. **Deletion is constrained.** A custom role cannot be deleted while assigned.
7. **Role details include assigned-user counts.** The roles page lists the number of users assigned to each custom role and provides a details view.

### Strengths

- Base-plus-additions is easier to author and audit than an unstructured checklist.
- Separating "who can approve" from "how many approvals are required" is a clean conceptual model.
- Group/project inheritance reflects real organisational structure.
- Assignment and deletion constraints reduce orphaned or accidental authority.

### Weaknesses and failure modes

- The permission matrix is enormous, and custom roles are an Ultimate-plan feature. The model is powerful but not approachable for a small administrator team.
- Highest-role resolution can surprise users who expect a project-level role to override a group-level role.
- Approval rules can be overridden per merge request unless an administrator prevents it, and approver eligibility depends on membership type.
- Custom roles based on a default role still carry all base permissions; an administrator may grant more than intended by choosing the wrong base.
- Group hierarchy complexity grows quickly and can produce `404`-style access failures when an approver group cannot view the target project.

### Applicability to Engage

Engage's roles are already base-less and permission-list-based, which is simpler. The useful imports are:

- **role templates** ("start from Deliberation moderator" rather than a blank grid);
- **assigned-member counts** and a details drawer before editing;
- **capability vs requirement separation** — a role may permit an action, but the lifecycle still decides whether the action is valid;
- **direct vs inherited scope clarity** in the effective-access explanation;
- **cannot delete while assigned** (already implemented) presented as an operational safeguard.

Engage should **not** adopt arbitrary approval rules for formal ballots. The number of approvals, electorate and authority are constitutional, not workspace settings. It should also avoid a huge permission matrix; its 25-key catalogue is already at the upper bound of what a volunteer administrator should scan.

### Investigation limits

No GitLab account or project administration was available. R2 is a public, historically merged merge request with approval optional; it does not demonstrate a required approval rule, an approval action or a protected-branch rejection.

---

## 5. Zendesk — agent workspace, queues, assignment and operational administration

**Focus:** agent workspaces, queues, assignments, triggers, macros and operational administration.

### Evidence

- **Documented:** [Views](https://support.zendesk.com/hc/en-us/articles/4408888828570-About-triggers-and-automations) describes shared, personal and standard views; conditions/operators/values; preview; column/group/sort configuration; cloning; and access by role. [Manually assigning a ticket](https://support.zendesk.com/hc/en-us/articles/4408887127450-Manually-assigning-a-ticket) describes assignee/group assignment, "take it", and bulk assignment from a view. [About ticket fields](https://support.zendesk.com/hc/en-us/articles/4408886739098-About-ticket-fields) describes standard and custom fields, including status, assignee, follower, priority, type and approval status. [Macros](https://support.zendesk.com/hc/en-us/articles/4408887656602-About-macros) describes prepared responses/actions, previewing changes, applying multiple macros, keyboard shortcuts, and permission/conflict failures. [Triggers](https://support.zendesk.com/hc/en-us/articles/4408822236058-About-Zendesk-triggers-and-how-they-work) and [automations](https://support.zendesk.com/hc/en-us/articles/4408832701850-About-automations-and-how-they-work) describe event-based vs time-based rules, ordering, loop prevention and limits. [Contextual workspaces](https://support.zendesk.com/hc/en-us/articles/4408833498906-Setting-up-contextual-workspaces) describes tailoring the ticket form and tools by criteria.
- **Unverified:** The authenticated Agent Workspace, live view rendering, macro application, trigger conflicts and mobile layout.

### Interaction patterns worth studying

1. **Views are the primary work surface.** Agents do not start from a database table; they start from "Unsolved tickets assigned to me", "New tickets needing triage", "Pending tickets awaiting response". Views can be personal or shared, cloned, ordered and categorised.
2. **Assignment is a first-class field.** A ticket can be assigned to a group or an agent, with a one-click "take it" and bulk assignment from a view.
3. **Macros turn repeated judgement into a previewed action.** An agent can see exactly which fields, comments and attachments a macro will change before applying it. Multiple macros can be combined, but conflicting changes are possible.
4. **Triggers vs automations is a useful mental split.** Event-based rules respond immediately to a change; time-based automations respond to elapsed time. Ordering matters, and loops are a known failure mode.
5. **Contextual workspace.** The form and relevant tools can change based on criteria, reducing the "everything visible at once" problem.
6. **Bulk action is scoped to a view.** Bulk assignment is explicit, and the user chooses the target group/agent once.
7. **Failure is surfaced.** Macro application can fail because of a concurrent update, missing field on the form, or insufficient permission; the documentation tells agents what to check.

### Strengths

- The queue is task-shaped, not entity-shaped.
- Assignment makes responsibility visible and enables "my work".
- Macros dramatically reduce repetitive typing while preserving preview and editability.
- Time-based escalation is a real operational need that a static queue does not solve.

### Weaknesses and failure modes

- Triggers and automations are a low-level rules engine. Conflicting rules, ordering effects and loops are common enough to require explicit documentation and an events log.
- Views have limits and can proliferate; Zendesk itself recommends reports for trends rather than very large views.
- Macros can apply contradictory changes; preview helps but does not prevent all conflicts.
- Bulk actions can be dangerous at scale.
- The model assumes a support organisation with groups, agents and SLAs; it does not model formal authority.

### Applicability to Engage

This is the strongest source for **administrative usability**. Engage already has a "Needs attention" queue, but it is a system-wide summary grouped by governance action. It should become:

- responsibility-aware ("My work", "Unassigned", "Branch work") using an operational owner/assignment field;
- filterable and savable, without introducing a general rules engine;
- equipped with a small number of **safe macros** for routine communications (request more information, acknowledgement), always previewed and never used to record a formal result;
- explicit about failure: "This ballot changed while you were editing. Reload and try again."

Engage should **not** adopt a trigger/automation builder for governance transitions. A time-based rule must never bind a ballot, record a result or ratify policy. Automated reminders and escalation are acceptable; automated formal acts are not.

### Investigation limits

No Zendesk instance was available. All interaction detail is documented; the actual Agent Workspace, view builder, macro preview and events log were not observed.

---

## 6. Airtable — flexible data models, interfaces and access controls

**Focus:** flexible data models, relational records, interface design and access controls.

### Evidence

- **Documented:** [Airtable permissions overview](https://support.airtable.com/docs/airtable-permissions-overview) describes workspace, base, interface and form permissions and the rule that effective base access is the higher of workspace and base permission. [Linking records](https://support.airtable.com/articles/3370222027-linking-records-in-airtable) and [understanding linked record relationships](https://support.airtable.com/articles/1484376934-understanding-linked-record-relationships-in-airtable) describe bidirectional links, self-links, one-to-many/many-to-many and junction tables. [Interface layouts](https://support.airtable.com/articles/7171868269-adding-layouts-to-interfaces) describes form, dashboard, overview, record review and blank layouts; [managing and sharing interfaces](https://support.airtable.com/articles/4255096925-managing-and-sharing-airtable-interfaces) describes interface-specific access. [Record-level revision history](https://support.airtable.com/articles/3516802427-record-level-revision-history-in-airtable) describes per-record activity, actor attribution and retention limits, and states that revision history is view-only and cannot be exported through the API. [Snapshots](https://support.airtable.com/articles/2163132802-taking-and-restoring-snapshots-in-airtable) describes non-destructive restore into a new base and loss of revision history in restored copies.
- **Unverified:** Airtable base/interface builder, field configuration, permission enforcement and mobile experience.

### Interaction patterns worth studying

1. **Separate the data model from the interface.** A base holds tables and links; interfaces are curated views for a particular audience, with their own permissions. Interface-only collaborators can act without seeing the underlying base.
2. **Bidirectional linked records.** Linking creates a mirrored relationship, and lookup/rollup fields surface related values without duplication. This is a strong model for "related matter" navigation.
3. **Record review layout.** A purpose-built layout for triaging many records one at a time reduces the cost of repetitive review.
4. **Revision history with actor attribution.** The expanded record shows comments and revision history, including whether a change came from a user, automation, sync, API or form. Retention varies by plan.
5. **Effective permission is the higher of two scopes.** The documentation is explicit about how workspace and base permissions combine, and marks inherited permissions with a `WORKSPACE` tag.
6. **Snapshots restore into a new base.** Restoring does not silently overwrite the live base, which is a useful safety pattern for bulk changes.

### Strengths

- Flexible relationships make cross-record context cheap to add.
- Interfaces prove that the same data can have a task-specific front end without duplicating it.
- Permission provenance is visible (workspace vs base).
- Revision history distinguishes human edits from automation, sync and API changes.

### Weaknesses and failure modes

- Flexible schemas make it easy to create inconsistent structures; governance semantics are not enforced by the platform.
- "Higher of two permissions" can grant more access than an administrator expects.
- Revision history is view-only, retention-limited and not exportable; it is not an audit record.
- Interface-only access can hide the underlying data model from the person who needs to understand it.
- Linked-record pickers can expose records the user cannot otherwise see unless carefully configured.

### Applicability to Engage

Engage already has typed relationships (`supersedes`, `amends`, `implements`, `derives_from`) and a policy registry. It should borrow:

- **curated interfaces for different audiences** — a member view, an officer queue and a public record over the same matter data;
- **bidirectional relationship display** — if a policy supersedes a proposal, the proposal should link forward to the policy;
- **record-review interaction** for amendment/contribution triage (one record at a time with next/previous);
- **clear permission provenance** in the effective-access view ("National role", "Branch role for Victoria", "Legacy branch administrator").

Engage should **not** expose a general base/table/field builder to administrators. The matter schema is a governance contract; making it freely editable would allow an administrator to create a matter type that bypasses validation. New matter types should remain code-reviewed registry entries.

### Investigation limits

No Airtable account or base was available. All observations are documented. The interface builder, linked-record picker and permission UI were not exercised.

---

## 7. Notion — structured content, linked records, templates and contextual navigation

**Focus:** structured content, linked records, databases, templates and contextual navigation.

### Evidence

- **Documented:** [Sharing and permissions](https://www.notion.com/help/sharing-and-permissions) describes general access, access levels (full access, can edit, can edit content, can create, can comment, can view), inherited permissions, overrides where the broadest access wins, page-level database access and access requests. [Relations and rollups](https://www.notion.com/help/relations-and-rollups) describes one-way and two-way relations, self-relations, display properties and rollups. [Database templates](https://www.notion.com/help/database-templates) describes templates that prefill properties and content, repeating templates and nesting limits. [Database property access](https://www.notion.com/help/database-property-access) describes column-level access and person-property exceptions.
- **Unverified:** The Notion editor, sidebar, database views, template picker and permission request flow.

### Interaction patterns worth studying

1. **Content is a page, relationships are properties.** A database row is also a full page with its own content, comments and permissions. This makes "record" and "document" the same navigable object.
2. **Two-way relations with display properties.** A relation can show selected properties of the related page, so the reader sees enough context without opening it.
3. **Templates prefill structure and defaults.** A template can set properties and content, and can recur. This is a low-configuration way to make repeated creation consistent.
4. **"Can edit content" separates content from structure.** A contributor can edit rows and values without changing views, properties or database structure.
5. **Permission inheritance plus broadest-access resolution.** Subpages inherit, page-level overrides exist, and the broadest grant wins.
6. **Access requests.** A user who hits a locked page can request access; the owner can approve or reject from the inbox.
7. **Contextual navigation.** Pages live in a sidebar hierarchy; linked pages open in place or in a peek view, and backlinks/mentions provide return paths.

### Strengths

- The page/record duality is excellent for policy work: a matter can have structured metadata and long-form content in one place.
- Templates make structured creation fast without a form builder.
- Two-way relations and displayed properties make context visible without a graph.
- "Can edit content" is a useful intermediate permission for contributors who should not alter structure.

### Weaknesses and failure modes

- Broadest-access-wins can leak information when a user belongs to a permissive group; the documentation warns administrators to check all sharing paths.
- Flexible databases invite schema sprawl and inconsistent conventions.
- Page-level permissions are hard to audit at scale.
- Moving a page can remove access for everyone else; inheritance is not always intuitive.
- Templates can create stale structure when the underlying process changes.

### Applicability to Engage

Engage's proposal page already combines structured metadata, long-form rationale, commitments, amendments, discussion and history. The useful imports are:

- **template-driven matter creation** with type-specific defaults;
- **two-way contextual links** between a matter and its related decisions/policies;
- **"can edit content but not structure"** as a way to describe contributor permissions without granting lifecycle authority;
- **access request / explanation** patterns for members who cannot see a branch-scoped record.

Engage should **not** let the broadest role win by default. Its permission model is additive but scope-aware, and a branch grant must not silently become national. It should also avoid a free-form page hierarchy for governance records; stable URLs and typed relationships are safer than a user-managed tree.

### Investigation limits

No Notion workspace was available. All interaction detail is documented. The permission-request flow, database templates and property-level access were not observed.

---

## 8. Discourse — trust levels, moderation, onboarding and notifications

**Focus:** community trust levels, moderation, onboarding, notifications and discussion management.

### Evidence

- **Documented:** [Trust Level Permissions Reference](https://meta.discourse.org/t/trust-level-permissions-reference/224824) lists feature access by trust level and staff role. [Discourse Trust Levels: A Detailed Explanation](https://meta.discourse.org/t/discourse-trust-levels-a-detailed-explanation/396792) describes automatic promotion thresholds and loss of TL3. [Understanding Discourse Trust Levels](https://blog.discourse.org/2018/06/understanding-discourse-trust-levels/) describes the philosophy, TL0–TL4 capabilities and the shift to group-based permissions. [Configuring default notification settings](https://meta.discourse.org/t/configuring-default-notification-settings-for-users/285619) describes Watching / Tracking / Watching First Post / Normal / Muted, per-topic and per-category defaults, and auto-tracking. [Understanding the notifications menu](https://meta.discourse.org/t/understanding-the-notifications-menu-in-discourse/3059) describes notification types, filters, dismiss and priority indicators. [Understanding Discourse for new users](https://meta.discourse.org/t/understanding-discourse-for-new-users/96331) describes topic/category/tag notification controls.
- **Observed (R4):** A long-lived public topic rendered with sidebar navigation, a detailed trust-level table, post timeline, reply controls and notification controls. The page was readable signed out; staff actions were not available.
- **Unverified:** Promotion computation, moderation actions, flag review, notification delivery and mobile layout.

### Interaction patterns worth studying

1. **Progressive trust, but not progressive *authority*.** New users are sandboxed from actions that could harm the community; experienced users gain editing and moderation abilities. Trust levels are earned through reading and participation.
2. **Group-based permissions now supplement trust levels.** Many former trust-level gates became group permissions, so an administrator can grant a specific capability without promoting the whole user.
3. **Notification levels are per topic, category and tag.** Watching, Tracking, Watching First Post, Normal and Muted give users a vocabulary for relevance. Defaults are configurable, and users can override.
4. **Notification menu tabs and priority.** Replies, likes, personal messages, bookmarks, chat and review queue are separated; the avatar shows one priority indicator at a time.
5. **Edit history is visible to everyone.** The trust-level table lists "View Post Edit History" as available at all levels, while hiding/reverting revisions is staff-only.
6. **Moderation is a distinct staff surface.** Review queue, flags, silencing, suspension and user anonymisation are separated from ordinary participation.

### Strengths

- The notification vocabulary is unusually clear and user-controlled.
- Progressive restrictions protect new users without requiring administrator intervention.
- Group permissions allow targeted capability grants.
- Visible edit history supports accountability in a fast-moving discussion.

### Weaknesses and failure modes

- Trust levels can become a status game and reward prolific posting rather than thoughtful participation.
- Automatic promotion thresholds are opaque to ordinary users unless explained.
- Notification defaults can create fatigue; the documentation itself warns about "clogging" inboxes.
- Community trust is not legal membership. A highly trusted participant is not thereby eligible to vote.
- Moderation actions can be perceived as arbitrary without clear reasons and appeal paths.

### Applicability to Engage

Engage should borrow the **notification relevance model** and the **separation of moderation from participation**, not the trust-level ladder as a source of governance authority.

- Per-matter notification levels (All updates / Decisions only / Muted) map cleanly onto proposals and branches.
- A visible edit history for deliberation comments could improve accountability, but must not expose deleted personal information.
- Review queues for flagged comments are useful for moderators; they should not be conflated with ballot decisions.

Engage must **reject** trust levels as a basis for voting eligibility, amendment rights or ballot access. Eligibility is a verified membership and branch fact, not an engagement score. It should also avoid public leaderboards or "regular" badges that could pressure participation.

### Investigation limits

R4 was a read-only public topic. No account, trust promotion, flag, moderation action, notification preference change or email delivery was exercised. Documentation describes defaults, which sites can change.

---

## 9. Stripe Dashboard — operational clarity, sensitive actions, permissions and error recovery

**Focus:** operational clarity, sensitive actions, permissions, reporting and error recovery.

### Evidence

- **Documented:** [Start a team](https://docs.stripe.com/get-started/account/teams) describes inviting members, assigning multiple roles, reviewing actions, least privilege, editing roles, notifications and security history. [User roles](https://docs.stripe.com/get-started/account/teams/roles) lists detailed roles with "some of what this role can do" and "some of what this role can't do", multiple-role additivity, IAM Administrator limits, Super Administrator assignment restrictions and account-owner uniqueness. [Error handling](https://docs.stripe.com/error-handling) describes choosing a response by outcome certainty: correct the request, ask the customer to act, retry safely with an idempotency key, or reconcile an unknown outcome before repeating. It also distinguishes API errors, webhook failures, stored errors and connection errors.
- **Unverified:** The Stripe Dashboard, role assignment UI, security history page, notification preferences and error rendering.

### Interaction patterns worth studying

1. **Role descriptions lead with purpose and show can/can't lists.** A reader can understand a role without reading a permission matrix. Roles are additive, and the documentation warns about conflicts.
2. **Sensitive roles have assignment restrictions.** Only a Super Administrator can assign Super Administrator; the IAM Administrator can manage access but cannot grant the highest roles.
3. **Least privilege is stated as an operating principle.** The guidance is to grant the lowest permission required, not the most convenient bundle.
4. **Outcome certainty drives recovery.** The error model explicitly separates invalid request, customer action, safe retry and unknown outcome. Unknown outcomes must be reconciled, not blindly retried.
5. **Security history is a named place.** Team activity is retained for 180 days and reviewable separately from ordinary product screens.
6. **Notification preferences are per user.** Team members configure their own email notifications; administrators do not infer consent.

### Strengths

- Role descriptions are written for operators, not implementers.
- The recovery model is unusually honest about uncertainty.
- Sensitive actions have explicit assignment restrictions.
- Security history is separated from daily operations.

### Weaknesses and failure modes

- The role list is long and product-specific; a small team can still misconfigure multiple roles.
- Multiple roles are additive, so conflicts and unintended authority are possible.
- The documentation's can/can't lists are extensive and can be overwhelming.
- Idempotency and reconciliation are developer concepts; an administrator needs a human-readable version.

### Applicability to Engage

Engage should borrow:

- **role descriptions in outcome language** ("Can bind ballot wording and record outcomes", not "ballots.bind");
- **can / can't summaries** for each role;
- **assignment restrictions** surfaced in the UI (self-assignment blocked; cannot grant above own authority);
- **explicit outcome states** for sensitive actions: saved, failed, denied, outcome unknown — with a "Check current state" recovery path;
- **security/role history** as a separate, filterable view.

Engage should **not** turn governance acts into generic role permissions. `ballots.bind`, `ballots.record_result`, `policies.ratify` and `policies.publish` are constitutional operations. They may be delegated only within the existing permission catalogue and scope rules, never invented as a new role capability.

### Investigation limits

No Stripe account or Dashboard was available. The role lists and error model are documented in detail, but the actual Dashboard, security history and notification settings were not observed.

---

## 10. Figma — collaborative feedback, version history and review workflows

**Focus:** collaborative feedback, version history, contextual comments and review workflows.

### Evidence

- **Documented:** [Guide to comments](https://help.figma.com/hc/en-us/articles/360039825314-View-and-manage-versions) describes comment mode, canvas-anchored comments, replies, mentions, reactions, resolution, hiding, sorting and notification settings. [View a file's version history](https://help.figma.com/hc/en-us/articles/360038006754-View-a-file-s-version-history) describes a timeline of named and autosaved versions, contributor attribution, descriptions, restore, duplicate, share a version link, and the fact that restoring is non-destructive and keeps comments. [Branches and merges](https://help.figma.com/hc/en-us/articles/5691750511383-Incomplete-merges-or-updates) describes branch-specific work, merge conflicts, restoring a branch or main file, and the risk that restoring main applies to everyone with access.
- **Unverified:** The Figma canvas, comment mode, version timeline, branch/merge UI and mobile comment flow.

### Interaction patterns worth studying

1. **Comments are anchored to a place in the artefact.** A comment sits on the canvas region it concerns, not in a detached chronological thread. This preserves context.
2. **Comment threads have resolve/reopen.** A discussion can be closed without deleting it; resolved comments remain accessible.
3. **Version history is a timeline with names and descriptions.** Autosaves are grouped; meaningful versions can be named and described; a version link can be shared.
4. **Restore is non-destructive.** Restoring adds checkpoints rather than erasing the current state, and comments from all versions are retained.
5. **Branches isolate substantial changes.** A branch can be merged back, with conflict resolution and a clear "before merge" checkpoint.
6. **Notification settings are separate from commenting.** A user can participate without receiving every comment notification.

### Strengths

- Anchored comments dramatically reduce "which part are you talking about?" ambiguity.
- The version timeline is understandable to non-engineers: name, description, time, contributor.
- Non-destructive restore lowers the fear of experimenting.
- Resolved comments preserve history without cluttering the active view.

### Weaknesses and failure modes

- Anchored comments can become stale when the artefact changes; Figma keeps them but their anchor may move.
- Restoring a main file affects everyone and can wipe later changes; the documentation warns explicitly.
- Branch/merge is a complex mental model for occasional users.
- Comment volume can overwhelm the canvas; hiding/docking is necessary.
- A comment is not an approval; resolution does not prove the change was made.

### Applicability to Engage

Engage should borrow:

- **anchored deliberation comments** on a specific commitment, clause or section, without turning them into formal amendments;
- **a named revision timeline** with author, time, summary and a link to the exact version;
- **non-destructive history** (already true: revisions are immutable);
- **resolved/officer-responded state** only if it does not imply consensus; the existing contribution feedback status is a better vocabulary;
- **a "review this version" link** for reviewers.

Engage should **not** adopt real-time co-editing or branch/merge for formal wording. Formal wording changes must go through the amendment and ballot process. A comment thread resolving is not a governance decision.

### Investigation limits

No Figma file or account was available. The comment/version documentation is detailed, but the actual canvas, comment anchoring, restore flow and branch UI were not observed.

---

## 11. Wikipedia / MediaWiki — revision comparison, attribution and historical transparency

**Focus:** revision comparisons, attribution, moderation, historical transparency and dispute handling.

### Evidence

- **Documented:** [Help:History](https://www.mediawiki.org/wiki/Help:History) describes the revision history page, `cur`/`prev` comparison, date links, editor attribution, edit summaries, minor-edit markers, byte counts, paging, watched pages, RSS/Atom feeds, permanent links, deletion effects and revision restoration. [Help:Diff](https://www.mediawiki.org/wiki/Help:Diff) describes the diff view. [Help:Protected pages](https://www.mediawiki.org/wiki/Help:Protected_pages) describes semi-protection, full protection, reasons, expiry and the fact that protection changes are logged in the page history.
- **Observed (R3):** The revision history of a live article rendered a date-grouped list with `cur`/`prev` links, radio selection, byte deltas, editor names, edit summaries, minor-edit markers and undo links. The page exposed paging and filtering controls.
- **Unverified:** The diff view, rollback, patrolling, oversight, deletion and mobile layout.

### Interaction patterns worth studying

1. **Every revision is attributable and linkable.** Date, editor, byte delta and edit summary are visible in the list; a permanent link identifies an exact version.
2. **Comparison is a first-class action.** `cur` and `prev` provide one-click comparisons; two revisions can be selected for a custom diff.
3. **Edit summaries explain intent.** A short summary is expected with each change, making the history readable without opening every diff.
4. **Minor edits are marked.** This helps readers skip copy-edits when looking for substantive changes.
5. **Protection is temporary and reasoned.** A page can be semi-protected or fully protected for a reason and duration; the protection event is logged.
6. **Deletion removes public access to history.** The documentation explicitly notes that deleting a page removes regular users' access to its history. This is a caution, not a model to copy.

### Strengths

- The revision list is compact, scannable and understandable without training.
- Exact-version links are stable and citable.
- Edit summaries and minor-edit markers provide useful signal.
- Protection is an explicit, reviewable state rather than a hidden permission.

### Weaknesses and failure modes

- Diffs can be noisy and hard to read for long or heavily formatted pages.
- Edit summaries are optional in practice and can be misleading.
- Protection can be used to win disputes; it is a power tool with social consequences.
- Deletion can destroy public attribution and historical context.
- There is no formal electorate or binding decision; consensus is social, not recorded as a ballot.

### Applicability to Engage

Engage already has immutable revisions, content hashes and a revision record. It should borrow:

- a **compact revision list** with author, time, summary and a link to the exact revision;
- **one-click compare to previous** and **compare selected revisions**;
- a **change summary** at the point of saving (optional but encouraged);
- **stable links to the exact wording** used in a ballot;
- **clear protection status** when a matter is locked for voting, with the reason and the exact revision.

Engage should **not** treat a wiki-style edit as a decision. Its formal amendment and ballot process is the correct authority. It should also avoid deletion as a routine way to retire records; archive/supersede with a reason is safer.

### Investigation limits

R3 was the history listing only. No diff, rollback, protection action, deletion or mobile view was exercised. The documentation describes behaviour that may vary by wiki configuration.

---

## 12. Google Docs — suggested edits, comments and collaborative review

**Focus:** suggested edits, comments, review resolution and collaborative document workflows.

### Evidence

- **Documented:** [Suggest edits in Google Docs](https://support.google.com/docs/answer/6033474) describes Suggesting mode, coloured insertions and crossed-out deletions, comments attached to suggestions, email notification to the owner, accept/reject one-by-one, and accept/reject all with preview. [Use comments, action items & emoji reactions](https://support.google.com/docs/answer/65129) describes anchored comments, the comments panel, filtering open/resolved, replying, resolving, reopening, assigning action items, reassigning, marking done, follow-up counts, and keyboard shortcuts (R/J/K/E/U).
- **Unverified:** The Google Docs editor, suggestion rendering, comment panel, notification emails and mobile behaviour.

### Interaction patterns worth studying

1. **Editing mode is explicit.** Editing, Suggesting and Viewing are modes, not hidden states. A suggester sees their change as a proposal, not as the live text.
2. **Suggestions are anchored and attributed.** Insertions/deletions are shown in context, with the suggester's identity and a comment thread.
3. **Accept/reject is a deliberate review act.** The owner can accept one suggestion or review all, with a preview of the result.
4. **Comments can be resolved and reopened.** Resolved comments remain accessible; the active view can be filtered.
5. **Action items are assigned inside comments.** A comment can become a task with an assignee and a done state, and the document shows a follow-up count.
6. **Keyboard navigation is first-class.** J/K move between comments, R replies, E resolves, U exits.

### Strengths

- The suggestion model is immediately understandable: the original is unchanged until someone accepts.
- Anchoring keeps feedback next to the text.
- Accept/reject all with preview reduces repetitive review.
- Action items bridge discussion and follow-up.

### Weaknesses and failure modes

- Accepting a suggestion is a document edit, not a formal decision; authority is whoever owns the document.
- Suggestion mode can be disabled or unavailable depending on sharing permission.
- Comments can proliferate and become stale; resolved comments are easy to forget.
- The model assumes a single owner or a small trusted group.
- Notification behaviour can be noisy.

### Applicability to Engage

Engage already has formal amendments with base/replacement wording, a diff drawer, ballot binding and a separate decision record. The useful imports are:

- **anchored feedback on specific wording** for deliberation comments;
- **a clear "proposed vs current" visual** (already present in amendments);
- **review all changes** for an officer preparing a revision;
- **comment resolution only as an officer-response state**, not as approval;
- **keyboard navigation** for high-volume review.

Engage should **not** allow a member or officer to accept a suggested wording change directly into a ballot-bound revision. The amendment must be resolved, balloted where required, and applied as a new immutable revision. A Google-Docs-style "accept" would collapse deliberation and decision.

### Investigation limits

No Google account or document was available. All interaction detail is documented. The editor, suggestion acceptance, comment resolution and notification emails were not observed.

---

## Cross-platform evidence map

| Product problem | Strongest evidence | Secondary evidence |
|---|---|---|
| Role creation and permission editing | Discord, Stripe, GitLab | Zendesk custom roles, Airtable |
| Delegation safeguards | Discord hierarchy, GitLab base roles, Stripe IAM/Super Admin | Notion access requests |
| Effective-access explanation | Discord View As Role, Airtable workspace/base provenance, Notion broadest-access warning | GitLab highest-role resolution |
| Type-specific workflow | Linear per-team workflows, GitHub protected branches | Zendesk ticket forms/contextual workspaces |
| Intake and triage | Linear Triage, Zendesk views | GitHub review requested |
| Work queues and saved views | Zendesk views, Linear custom views | GitHub review/assignee filters |
| Assignment and responsibility | Zendesk assignee/"take it", Linear triage responsibility | GitHub reviewers/assignees |
| Structured creation | Notion templates, Linear templates | Zendesk ticket forms |
| Revision comparison | Wikipedia history/diff, Figma version history | GitHub commits, Airtable revision history |
| Anchored feedback | Figma comments, Google Docs suggestions | GitHub line comments |
| Decision history and audit | GitHub timeline/audit log, Discord audit log | Airtable revision history, MediaWiki history |
| Relationships and lineage | Airtable linked records, Notion relations | GitHub cross-references, MediaWiki links |
| Notification relevance | Discourse watching/tracking, GitHub subscriptions | Linear view subscriptions |
| Error recovery | Stripe outcome model | Zendesk macro conflict guidance |
| Accessibility and progressive disclosure | Google Docs keyboard shortcuts, Linear density | Discourse notification vocabulary, Notion access levels |

## Questions this investigation could not answer

1. Which of Engage's existing admin screens are actually confusing to its own administrators in daily use? No usability session was run.
2. How often do branch administrators need to assign roles, and would national-only role management become a bottleneck?
3. Do members want per-proposal following, or is the existing catch-up digest sufficient?
4. Would anchored comments improve deliberation, or fragment it into clause-level arguments that lose the whole-motion context?
5. How many matters and concurrent ballots does the organisation expect within 12 months? Scale changes the value of saved views, assignment and bulk operations.
6. Which administrative tasks are truly repetitive enough to justify safe macros or bulk actions?
7. What accessibility barriers exist in the current Horizon admin tables and role editor on mobile and with screen readers?

These are validation questions, not feature commitments.
