# Prioritised opportunity backlog

Research date: 13 November 2026. Companion to the [synthesis](02-synthesis.md) and [UX concepts](04-ux-concepts.md).

This backlog converts the research into implementable opportunities. It is deliberately conservative: Engage already has strong governance semantics, and a recommendation is only included when the evidence shows a real limitation or a clear usability gain.

## Classification rules

| Classification | Meaning |
|---|---|
| **Implement now** | Addresses a demonstrated Engage limitation, provides clear member or administrator value, fits the existing architecture, and has manageable complexity and governance risk. |
| **Experiment** | Potentially valuable but needs usability validation, a privacy review, or a trial before commitment. |
| **Defer** | Likely useful eventually, but not needed for current workloads or scale. Revisit with evidence. |
| **Reject** | Unnecessary complexity, conflicts with formal governance, increases security/privacy risk, or solves a problem Engage does not have. |

## Scoring

Each opportunity is assessed qualitatively on:

- **Member/administrator value** — does it reduce effort or improve trust?
- **Severity** — how bad is the current limitation?
- **Frequency** — how often is the affected workflow used?
- **Complexity** — engineering and design effort.
- **Governance/security risk** — could it change authority, eligibility, ballot integrity or privacy?
- **Accessibility/extensibility** — does it improve or preserve both?

A high-value, low-risk, low-complexity item is Implement now. A high-value item with uncertain benefit or privacy implications is Experiment. An item that is useful only at greater scale is Defer.

## Summary

| ID | Opportunity | Value | Severity | Frequency | Complexity | Governance risk | Classification |
|---|---|---|---|---|---|---|---|
| OB-01 | Outcome-language role summaries and can/can't panels | High | High | Medium | Low | Low | Implement now |
| OB-02 | Role templates and assigned-member counts | High | High | Medium | Low-medium | Low | Implement now |
| OB-03 | Human-readable effective-access inspector | High | High | Medium | Medium | Medium | Implement now |
| OB-04 | Replace raw permission keys and `window.prompt` | Medium | Medium | Medium | Low | Low | Implement now |
| OB-05 | Guided matter creation by type | High | High | Medium | Medium | Low-medium | Implement now |
| OB-06 | Stage transitions as actions with prerequisites | High | High | High | Medium | Medium | Implement now |
| OB-07 | "My work" queue and saved views | High | High | High | Medium | Low | Implement now |
| OB-08 | Operational steward / assignment | High | High | Medium | Medium | Medium | Implement now |
| OB-09 | Matter lineage panel | High | Medium | Medium | Low-medium | Low | Implement now |
| OB-10 | Revision summary and compare-to-previous | High | Medium | High | Low-medium | Low | Implement now |
| OB-11 | Contribution-evidence deep links | Medium | Medium | Medium | Low | Low | Implement now |
| OB-12 | Per-matter follow levels | High | Medium | Medium | Medium | Low | Implement now |
| OB-13 | Digest cadence and "why this notification" | Medium | Medium | High | Low-medium | Low | Implement now |
| OB-14 | Explicit outcome states for sensitive actions | High | Medium | Low-medium | Medium | Medium | Implement now |
| OB-15 | Responsive admin tables and focus audit | Medium | Medium | High | Low-medium | Low | Implement now |
| OB-16 | Human-readable role audit log | Medium | Medium | Low | Low | Low | Implement now |
| OB-17 | Clause anchors on deliberation comments | High | Medium | Medium | Medium | Medium | Experiment |
| OB-18 | Read-only access preview ("view as member") | High | Medium | Low | High | High | Experiment |
| OB-19 | Safe bulk operations for low-risk tasks | Medium | Medium | Low-medium | Medium | Medium | Experiment |
| OB-20 | Shared team saved views | Medium | Low | Medium | Medium | Low | Experiment |
| OB-21 | Safe response templates / macros | Medium | Medium | Medium | Medium | Medium | Experiment |
| OB-22 | Ballot-binding review checklist | Medium | Medium | Medium | Low | Low | Experiment |
| OB-23 | Additional matter types (consultation, constitutional amendment) | High | Low | Low | High | High | Defer |
| OB-24 | Implementation progress tracking | Medium | Low | Low | Medium | Medium | Defer |
| OB-25 | Relationship graph visualisation | Low | Low | Low | High | Low | Defer |
| OB-26 | Per-matter custom fields | Medium | Low | Low | Medium | High | Defer |
| OB-27 | Reminder automation rules | Medium | Low | Low | High | Medium | Defer |
| OB-28 | Branch-level role delegation | High | Medium | Low | Medium | High | Defer (governance decision first) |
| OB-29 | Portable decision-record export | Medium | Low | Low | Medium | Medium | Defer |
| OB-30 | Generic workflow/matter builder | Low | Low | Low | High | High | Reject |
| OB-31 | Deny overrides / per-record permissions | Low | Low | Low | High | High | Reject |
| OB-32 | Trust levels or engagement scores for governance rights | Low | Low | Low | Medium | High | Reject |
| OB-33 | Bulk formal decisions | Low | Low | Low | Medium | High | Reject |
| OB-34 | Real-time co-editing of formal wording | Low | Low | Low | High | High | Reject |
| OB-35 | AI summaries as the official motion or voting advice | Low | Low | Low | High | High | Reject |
| OB-36 | Gamification, streaks or leaderboards | Low | Low | Low | Low | High | Reject |
| OB-37 | Administrator bypass of protected transitions | Low | Low | Low | Low | High | Reject |

---

## Implement now

### OB-01 — Outcome-language role summaries and can/can't panels

**Problem or user need.** An administrator cannot tell what a role does without reading a list of permission names and inferring their consequences. This makes role creation slow and error-prone.

**Existing Engage behaviour.** [`RolesManager.tsx`](../../../src/components/admin/RolesManager.tsx) lists role name, description, scope and permission count. The full catalogue is shown only while editing. There is no generated summary of what the role enables or prohibits.

**Proposed improvement.** Each role card and detail view shows:

- a one-sentence purpose;
- "This role can…" with 3–6 outcome phrases (for example, "Review and edit proposal wording before voting");
- "This role cannot…" with the most consequential exclusions;
- a "Constitutional limits" note for acts no role can grant (ballot eligibility, identifiable ballots without the specific permission, ratification outside national scope).

The summary is generated from the permission catalogue and measured against the fixed governance boundary, not hand-written per role.

**Source of inspiration.** Stripe's role pages lead with purpose and can/can't lists; GitLab's role details show base role and assigned users; Discord groups capabilities by category.

**Expected benefit.** Faster role creation, fewer over-granted roles, better audit conversations, and a clear explanation of why a role cannot grant constitutional authority.

**Risks and constraints.** Summaries can become stale if hand-maintained; generate them from the catalogue. Do not imply that a role grants eligibility. Do not use marketing language. Keep the exact permission list available behind a disclosure for audit.

**Implementation complexity.** Low. Extend the existing `PermissionDefinition` metadata with an outcome phrase and an exclusion phrase, then render summaries in `RolesManager`.

**Priority classification.** Implement now.

**Acceptance signals.** An administrator can explain a role's effect without opening the permission grid; the exact list remains available; a role that includes `ballots.view_identifiable` clearly states the privacy consequence; a branch role cannot display a national-only capability as available.

---

### OB-02 — Role templates and assigned-member counts

**Problem or user need.** Creating a role starts from a blank matrix, and an administrator cannot see whether a role is in use before editing or deleting it.

**Existing Engage behaviour.** The editor starts with an empty permission set and a scope select. The role table shows a permission count but no member count. Deletion is blocked server-side while assigned, but the UI does not show why until the action fails.

**Proposed improvement.**

- A "Start from" template chooser: Deliberation moderator, Branch membership verifier, Ballot officer, Reports viewer. Selecting a template prefills name, description, scope and permissions, all editable.
- The role table shows "Assigned to N members" and a link to the filtered member/assignment list.
- A detail drawer shows role purpose, scope, permissions, assigned members, last changed and audit history.
- Delete is disabled with an explanation when the role has active assignments.

**Source of inspiration.** GitLab custom roles are based on a default role; GitLab's roles page shows assigned-user counts and a details view. Stripe's role list is job-shaped.

**Expected benefit.** Less blank-page anxiety, more consistent role design, fewer orphaned roles, and a safer edit/delete workflow.

**Risks and constraints.** Templates must not imply authority; they are starting points. A template must not include national-only permissions when the selected scope is branch. Keep the number of templates small (4–6) to avoid a new catalogue.

**Implementation complexity.** Low-medium. Add template definitions and a count query; reuse the existing role table.

**Priority classification.** Implement now.

**Acceptance signals.** A new administrator can create a usable branch role in under two minutes; every template is scope-valid; the role list shows assignment counts; delete is blocked with a visible reason.

---

### OB-03 — Human-readable effective-access inspector

**Problem or user need.** The current inspector answers "which permission keys does this member hold?" but not "what can this person actually see and do, and why?".

**Existing Engage behaviour.** The effective-permissions table renders `g.permission` in monospace and lists scope and role origin. It does not group by task, explain inherited/legacy grants, or show the pages/actions affected.

**Proposed improvement.** Replace the raw table with:

- a grouped summary by task area (Proposals, Ballots, Policy, Members, Reporting);
- plain-language grant rows: "Can bind ballot wording — Victoria branch — Branch Ballot Officer — granted by Alex Chen on 3 Nov 2026";
- a "why" column that distinguishes legacy role, legacy branch administrator, and custom role;
- a "Constitutional boundary" panel showing eligibility and identifiable-ballot access separately;
- an optional read-only "access explanation" that lists the navigation destinations and actions the member would see, computed by the same permission functions. Do not impersonate the member or reveal record content.

**Source of inspiration.** Discord's View Server As Role; Airtable's workspace/base provenance labels; Notion's access-level descriptions.

**Expected benefit.** Faster support, safer delegation, fewer accidental grants, and a clear answer to "why can this person see that?".

**Risks and constraints.** A rendered preview can leak data. Start with an explanation list, not a full impersonation. Re-use `hasPermission` and scope helpers; never infer authority from navigation. Restrict the inspector to `roles.manage` and log access if the preview includes sensitive capabilities.

**Implementation complexity.** Medium. The permission snapshot and catalogue already exist; the work is grouping, copy and a safe read model.

**Priority classification.** Implement now (explanation). The rendered "view as member" preview is OB-18 (Experiment).

**Acceptance signals.** No raw permission keys in the primary view; every grant names its origin and scope; a branch grant never appears as national; the explanation matches server-side checks in tests.

---

### OB-04 — Replace raw permission keys and `window.prompt`

**Problem or user need.** Raw implementation strings and browser prompts make the interface feel like a developer tool, and `window.prompt` cannot show context, validation or a proper focus trap.

**Existing Engage behaviour.** [`RolesManager.tsx`](../../../src/components/admin/RolesManager.tsx#L718) renders `g.permission` in `font-mono text-xs`. Revocation calls `window.prompt` with a default reason. The audit table shows raw `entry.action`.

**Proposed improvement.**

- Remove raw keys from the primary inspector (OB-03); keep them in an authorised diagnostic disclosure.
- Replace `window.prompt` with `AlertDialog` + `Textarea` + consequence copy + confirm/cancel.
- Map audit actions to human labels ("Role assigned", "Role revoked", "Role created") and show the reason.
- Use `Badge` and `Table` primitives; preserve focus and error states.

**Source of inspiration.** Stripe's operator-facing role descriptions; GitHub's human-readable timeline; Discord's audit reason.

**Expected benefit.** Immediate quality improvement in the most developer-looking admin surface; fewer accidental revocations; better audit comprehension.

**Risks and constraints.** This is a small, contained change; the main risk is scope creep into the full role redesign. Do it as a separate commit so it can ship independently.

**Implementation complexity.** Low.

**Priority classification.** Implement now.

**Acceptance signals.** No raw permission key or raw event action in the default view; revocation requires a reason in a dialog; focus returns to the trigger; keyboard and screen-reader use are verified.

---

### OB-05 — Guided matter creation by type

**Problem or user need.** Creating a policy proposal or governance resolution requires the administrator to understand the lifecycle and choose a stage before describing the matter. The form exposes fields that do not apply to the chosen type.

**Existing Engage behaviour.** [`admin/proposals/index.astro`](../../../src/pages/admin/proposals/index.astro) has one create/edit form with a "Lifecycle stage" select, a "Classification" select, shared fields and a provenance disclosure. The form is embedded in the register page.

**Proposed improvement.** A short, stepped creation flow:

1. **Choose the type.** Policy proposal or Governance resolution, each with a capability summary.
2. **Describe the matter.** Title, summary, commitments, rationale, topic. Resolution creation hides policy publication/provenance fields; policy creation shows provenance prompts.
3. **Review and save.** Save as a draft (`propose`). The primary action is "Save draft" or "Save and send to deliberation"; the latter runs the same transition validation as the server.
4. **Template defaults.** Prefill structure (commitment prompts, provenance checklist) without prefill of a decision or ballot.

The existing register stays separate from creation; creation opens a focused page or dialog.

**Source of inspiration.** Linear's templates and bounded creation; Notion database templates; GitLab's base-role starting point; Zendesk contextual forms.

**Expected benefit.** Fewer invalid transitions, less irrelevant configuration, faster creation, and a clearer mental model of what each matter type can do.

**Risks and constraints.** Do not create a generic field builder. Do not let a template set a ballot or a decision. Do not change `MatterRegistry` semantics. The flow must work for both national and branch administrators, with branch scope restrictions.

**Implementation complexity.** Medium. The registry and validation exist; the work is route/UI restructuring and type-specific field rendering.

**Priority classification.** Implement now.

**Acceptance signals.** A first-time administrator can create both types without reading documentation; resolution creation never shows policy publication fields; invalid stage jumps are impossible from the UI; server validation remains the source of truth.

---

### OB-06 — Stage transitions as actions with prerequisites

**Problem or user need.** A free stage `<select>` presents every stage as equally available. The administrator discovers the rule only after the server rejects the change.

**Existing Engage behaviour.** The editor and the quick-action row use a `NativeSelect` populated with all stages. `validateMatterTransition` rejects invalid transitions server-side, but the UI does not preview validity or explain prerequisites.

**Proposed improvement.** Replace the free select with a small action panel:

- **Current stage** and a one-line explanation.
- **Next valid action(s)** as primary/secondary buttons: "Send to deliberation", "Open formal ballot", "Record outcome", "Archive".
- **Requirement checklist** for each action: wording reviewed, amendments resolved, ballot wording bound, deadline set, authority confirmed.
- **Disabled actions** with a reason and a link to the missing prerequisite.
- A "Move to another stage" disclosure for exceptional returns/restores, still validated.

**Source of inspiration.** GitHub's protected transitions and merge box; Linear's workflow actions; Stripe's outcome states.

**Expected benefit.** Fewer failed actions, better comprehension of the lifecycle, fewer accidental stage changes, and a visible link between governance rules and the interface.

**Risks and constraints.** Do not weaken server validation. Do not imply that a checklist tick authorises an act. The action panel must respect branch/national authority and `requiredPermission`. Do not hide the ability to return/archive when it is valid.

**Implementation complexity.** Medium. Add a transition read model derived from `MatterTypeDefinition.transitions` and the proposal state, then render actions.

**Priority classification.** Implement now.

**Acceptance signals.** Every visible action is valid for the current state; invalid actions are disabled with a reason; the server still rejects forged requests; stage changes are recorded in the governance timeline.

---

### OB-07 — "My work" queue and saved views

**Problem or user need.** The admin overview is a system-wide count summary. An individual officer cannot see their own workload, and a branch administrator cannot save a repeated filter.

**Existing Engage behaviour.** `attentionGroups` in [`admin/index.astro`](../../../src/pages/admin/index.astro#L227) groups by governance action. Admin pages use URL query parameters (`stage`, `branch`, `view`, `q`) but do not persist views.

**Proposed improvement.** Add a small set of default views at the top of the admin workspace:

- **My work** — tasks assigned to me or in my branch scope.
- **Unassigned** — tasks needing an owner.
- **Closing soon** — bound ballots closing within seven days.
- **Awaiting decision** — successful ballots needing an outcome/ratification/publication, filtered by authority.
- **Contributions to answer** — matters with unresponded comments.

Each row shows matter, required action, owner, age/deadline and one primary action. Administrators can save the current filter as a personal view and pin it. Start with personal views only; shared views are OB-20.

**Source of inspiration.** Zendesk views; Linear custom views and favourites; GitHub review-requested.

**Expected benefit.** Less scanning, clearer responsibility, faster completion, and a lower cognitive load for occasional administrators.

**Risks and constraints.** Do not build a general query builder. Do not show totals that include records the viewer cannot access. Saved views must be permission-scoped and fail closed. Avoid making the default view noisy; five is enough.

**Implementation complexity.** Medium. Reuse `attentionGroups` and existing filters; add a persisted view record and a task read model.

**Priority classification.** Implement now.

**Acceptance signals.** An officer can answer "what should I do now?" in one screen; a saved view survives reload; a branch admin never sees national-only tasks; empty states are clear.

---

### OB-08 — Operational steward / assignment

**Problem or user need.** Multiple officers can see the same task, but nobody is responsible for it. Work can sit unowned.

**Existing Engage behaviour.** No `assignee`, `ownerId`, `assignedTo` or `dueAt` field was found in the admin/proposal model. Role assignments exist, but they delegate permissions, not tasks.

**Proposed improvement.** Add an operational assignment on the matter or task:

- `stewardMemberId` (optional) and `stewardAssignedAt/By`;
- optional `targetDate` for operational follow-up;
- a "Take it" action and an "Assign to…" picker using the existing admin search/picker patterns;
- a visible owner on the task row;
- an audit event for assignment changes.

The UI states: "Steward is responsible for operational follow-up. This does not grant governance authority or ballot eligibility."

**Source of inspiration.** Zendesk assignee and "take it"; Linear triage responsibility; GitHub assignees.

**Expected benefit.** Clear accountability, fewer dropped tasks, better handover, and a reliable "my work" view.

**Risks and constraints.** Assignment must not grant a permission. The assignee still needs the relevant permission to act. Do not let an assignee bind a ballot without the ballot permission. Avoid a full SLA engine. Target dates are operational, not constitutional deadlines.

**Implementation complexity.** Medium. Add fields and audit events; update the queue and detail views.

**Priority classification.** Implement now.

**Acceptance signals.** A task can be taken and reassigned; the owner is visible; an assignee without permission sees the task but cannot perform the restricted action; assignment is audited.

---

### OB-09 — Matter lineage panel

**Problem or user need.** A member cannot follow a contribution or matter from idea to publication without assembling separate sections and records.

**Existing Engage behaviour.** Revisions, amendments, `ContributionFeedbackEvidence`, ballot results, policy records, typed relationships and governance events exist, but the member-facing presentation is fragmented. The proposal page has a decision chain; the policy page has publication status.

**Proposed improvement.** A compact "Lineage" rail on proposal and policy pages:

- ordered steps with dates and plain labels;
- each step links to the exact record;
- only existing steps are shown;
- reciprocal links (policy ↔ proposal, amendment ↔ applied revision, evidence ↔ feedback);
- a "Show technical references" disclosure for authorised users with IDs/hashes.

Example: `Idea (12 Oct) → Branch referral (18 Oct) → Revision 3 (2 Nov) → Amendment #2 applied (5 Nov) → Ballot bound (7 Nov) → Result recorded (14 Nov) → Ratified (15 Nov) → Published (16 Nov)`.

**Source of inspiration.** Airtable bidirectional linked records; Notion relations; GitHub timeline; Wikipedia exact-version links.

**Expected benefit.** Members can see what happened and what is current; officers can explain a decision; support burden falls.

**Risks and constraints.** Must respect permissions on every linked record. Do not show a private record's title to an unauthorised viewer. Do not imply a linear history where the records show a different path. Do not replace the formal decision record with a narrative.

**Implementation complexity.** Low-medium. Build a read model from existing collections; no schema change.

**Priority classification.** Implement now.

**Acceptance signals.** A member can follow a matter from contribution to published policy; inaccessible records do not leak titles; the panel matches the underlying records; no raw IDs in the primary view.

---

### OB-10 — Revision summary and compare-to-previous

**Problem or user need.** Revisions are listed with labels and hashes, but a reader cannot quickly see what changed or review a revision against its predecessor.

**Existing Engage behaviour.** `ProposalRevision` has `parentRevisionId`, `contentHash`, author and snapshot. The proposal page renders a revision record; amendments have a diff drawer. A dedicated revision comparison is not the primary reading path.

**Proposed improvement.**

- When saving a revision, invite a short "What changed" summary (optional but encouraged).
- Render the summary at the top of each revision entry with author/date and an exact-version link.
- Add "Compare to previous" and "Compare selected" using a text diff; keep the full wording available.
- On a ballot-bound revision, show "This is the exact wording members are voting on" and the binding date.

**Source of inspiration.** Wikipedia edit summaries and `cur`/`prev`; Figma named versions; GitHub commit history.

**Expected benefit.** Faster review, fewer misunderstandings about what changed, better audit narrative, and a clearer link between feedback and revision.

**Risks and constraints.** Diffs can be noisy; provide a readable summary and a full-text view. Do not let a summary replace the exact wording. Do not expose private revision text to unauthorised viewers.

**Implementation complexity.** Low-medium. Extend the revision record with an optional summary; build a diff view from existing snapshots.

**Priority classification.** Implement now.

**Acceptance signals.** A reviewer can identify what changed and when; the bound revision is unmistakable; the exact wording is always one click away.

---

### OB-11 — Contribution-evidence deep links

**Problem or user need.** A response can claim a contribution was incorporated, but the evidence is not always easy to reach from the comment.

**Existing Engage behaviour.** `ContributionFeedback` supports structured evidence (`amendment`, `revision`, `decision`, `policy`) and the resolver re-checks viewer permissions. The comment UI shows the response and history, but the evidence link is not a primary reading path.

**Proposed improvement.**

- Render a short evidence chip next to the response: "Incorporated in revision 4 →", "Applied as amendment #2 →", "Recorded in decision →".
- Link to the exact record and anchor; if the viewer cannot access it, show a neutral "Supporting record restricted" rather than a title.
- Keep the response's actor, time and note visible.
- Do not imply that an author's acknowledgement is constitutional approval.

**Source of inspiration.** GitHub cross-references; Airtable linked records; the prior participatory research's evidence recommendation (already partly implemented).

**Expected benefit.** Makes "incorporated" verifiable; reduces disputes; closes the participation loop without a new status taxonomy.

**Risks and constraints.** Do not leak inaccessible record titles. Do not auto-generate evidence from a keyword match. Keep the existing status vocabulary. This is a presentation change, not a new feedback system.

**Implementation complexity.** Low. The evidence model and resolver exist.

**Priority classification.** Implement now.

**Acceptance signals.** An incorporated response links to the changed wording/decision; unauthorised evidence stays private; the response history remains intact.

---

### OB-12 — Per-matter follow levels

**Problem or user need.** Members can choose broad topics, but cannot follow a specific matter they care about, and may receive too much or too little.

**Existing Engage behaviour.** Notifications are topic-based (`new_ballots`, `closing_deadlines`, `contribution_responses`, `governance_outcomes`, `account_membership`). Branch following exists. Catch-up is derived from participation, not explicit following. There is no per-proposal follow record.

**Proposed improvement.**

- A "Follow" control on each proposal/policy with three levels: All updates, Decisions only, Muted.
- Defaults: author = All updates; voter/commenter = Decisions only; others = not following. Show the default and allow change.
- A "Following" list in the member area, with current state and next action.
- Notifications respect the follow level in addition to topic consent.
- An unsubscribe link in every email goes to the specific matter preference, not only global topics.

**Source of inspiration.** Discourse Watching/Tracking/Normal/Muted; Linear view subscriptions.

**Expected benefit.** More relevant notifications, less fatigue, better return visits, and a clear member-controlled relationship with a matter.

**Risks and constraints.** Do not auto-follow everything. Do not let following imply voting eligibility. Respect push/email consent independently. Do not expose a private matter's title in a notification to an unauthorised member. Keep the default conservative.

**Implementation complexity.** Medium. Add a follow record and resolve it in notification dispatch; update member UI.

**Priority classification.** Implement now.

**Acceptance signals.** A member can follow/unfollow a matter; notifications match the chosen level; an ineligible member cannot follow a private branch matter; the follow list is understandable.

---

### OB-13 — Digest cadence and "why this notification"

**Problem or user need.** Members cannot choose how often they receive digests, and a notification does not explain why it arrived. `digestEnabled` is coupled to the `closing_deadlines` topic.

**Existing Engage behaviour.** `resolveUnifiedPreferences` derives email topic defaults from `digestEnabled`; `updateMemberNotificationPreferences` writes `digestEnabled` when `closing_deadlines` changes. In-app notifications have topic, title, body and href, but no reason field.

**Proposed improvement.**

- Separate **digest cadence** (Immediate / Daily / Weekly / Off) from topic consent. Essential account messages remain separate.
- Add a `reason` to generated notifications: "You voted on this proposal", "You follow this branch", "You are the author", "You are eligible to vote".
- Show the reason in the inbox and the email footer.
- Do not infer consent across channels; keep the existing independence.
- Provide a global "Pause non-essential notifications" control with a clear resume path.

**Source of inspiration.** Discourse email preferences and notification menu; GitHub notification reasons; Linear notification settings.

**Expected benefit.** Fewer unwanted emails, more trust, easier support, and better retention without manipulation.

**Risks and constraints.** Cadence changes must not suppress essential account/security messages. Do not send a daily digest with nothing in it. Respect existing preferences during migration; default to the current behaviour until the member chooses.

**Implementation complexity.** Low-medium. Add a cadence field and a reason field; update templates and dispatch.

**Priority classification.** Implement now.

**Acceptance signals.** A member can choose weekly without losing ballot alerts they opted into; every notification has a plain reason; essential messages are unaffected; unsubscribe works per matter and globally.

---

### OB-14 — Explicit outcome states for sensitive actions

**Problem or user need.** A network failure during ballot binding or result recording can leave the administrator unsure whether the action succeeded.

**Existing Engage behaviour.** Sensitive routes return JSON errors and the UI shows inline status. The pattern is not uniform, and there is no explicit "outcome unknown" state with a reconciliation action.

**Proposed improvement.** A shared operation-result pattern for sensitive actions:

- **Saved** — confirmed by the server, with the new revision/result reference.
- **Not saved** — validation/permission failure, with a plain reason and preserved input.
- **Outcome unknown** — request may have succeeded; show "Check current state" and do not offer a blind retry.
- Use an idempotency key for bind/result/publication actions where the API supports it.
- Link to the current record so the administrator can verify.

**Source of inspiration.** Stripe's error-handling model (correct, retry safely, reconcile unknown).

**Expected benefit.** Prevents duplicate formal records, reduces panic, and makes failure recovery trustworthy.

**Risks and constraints.** Do not claim success before persistence. Do not expose raw stack traces. Keep the diagnostic request ID available to authorised users. This is a cross-cutting change; start with ballot binding and result recording.

**Implementation complexity.** Medium. Add a shared result type and UI state; audit existing routes.

**Priority classification.** Implement now.

**Acceptance signals.** A simulated network failure after submit shows "Outcome unknown" and a working "Check current state"; a retry does not duplicate a result; the final state is accurate.

---

### OB-15 — Responsive admin tables and focus audit

**Problem or user need.** Administrative tables (roles, effective permissions, audit log, ballot register, member list) can become dense or overflow on mobile, and composed controls need a visible focus state.

**Existing Engage behaviour.** Horizon has responsive rules and focus tokens. Some admin tables use the shadcn `Table`; role permission cards use small text and a two-column grid. No mobile/screen-reader audit is recorded.

**Proposed improvement.**

- Audit every admin table at 390px and 768px.
- Prefer stacked rows with labelled values on mobile; if a table must scroll, use a labelled scroll region and a sticky identifying column.
- Ensure every `Checkbox`, `ToggleGroup`, `NativeSelect` and dialog trigger has a visible focus ring.
- Reduce role-editor density: one column on narrow screens, clear group headings, and a "Show all permissions" disclosure.
- Test with keyboard only and a screen reader for the role editor and revocation dialog.

**Source of inspiration.** Google Docs keyboard-first comments; Linear density; Discourse mobile topic view; WAI-ARIA practices.

**Expected benefit.** Administrators can work on a phone or with assistive technology; fewer mis-taps; compliance with WCAG 2.2 AA expectations.

**Risks and constraints.** Do not create a separate mobile-only control layer. Use the existing primitives and tokens. Do not hide essential governance facts on mobile.

**Implementation complexity.** Low-medium. Mostly CSS, composition and testing; some markup changes.

**Priority classification.** Implement now.

**Acceptance signals.** No horizontal overflow at 390px; every control has a visible focus state; the role editor is usable with keyboard only; the audit log is readable without zooming.

---

### OB-16 — Human-readable role audit log

**Problem or user need.** The audit log shows raw action names and role IDs, so an administrator cannot quickly understand who changed what.

**Existing Engage behaviour.** `listRolesAndAssignments` returns audit entries with `action`, `actorName`, `roleId`, `targetMemberId`, `branchId` and `createdAt`. `RolesManager` renders the raw action and resolves role/member names. The table has no filter, reason or before/after detail.

**Proposed improvement.**

- Human action labels: "Role created", "Role updated", "Role assigned", "Role revoked".
- Target, scope, actor, time and reason in one row.
- Filters by action, actor, role, branch and date.
- A details disclosure with before/after permissions (for updates) and the exact grant origin.
- Export only for authorised roles, with a clear note that exports leave the application's access controls.

**Source of inspiration.** GitHub audit log fields and filters; Discord audit reason; Stripe security history.

**Expected benefit.** Faster investigation, better accountability for delegated access, and a usable record for governance review.

**Risks and constraints.** Do not expose member personal data beyond the authorised boundary. Do not present the audit log as a permanent legal record if retention is limited. Keep raw event IDs in a diagnostic disclosure.

**Implementation complexity.** Low. The data exists; the work is labels, filters and presentation.

**Priority classification.** Implement now.

**Acceptance signals.** Every entry is understandable without knowing event names; a role update shows what changed; filters work; unauthorised users cannot export.

---

## Experiment

### OB-17 — Clause anchors on deliberation comments

**Problem or user need.** Comments are detached from the wording they discuss, so readers must infer which commitment or clause is meant.

**Existing Engage behaviour.** Deliberation comments have a stance and body, but no anchor to a commitment, section or amendment.

**Proposed improvement.** An optional anchor picker when composing a comment: "Whole proposal" (default) or a specific commitment/section. The comment displays the anchor as a link. The anchor is navigational only; it does not change the wording or create an amendment.

**Source of inspiration.** Figma canvas comments; Google Docs anchored comments; GitHub line comments.

**Expected benefit.** Less ambiguity, faster reading, better officer triage.

**Risks and constraints.** Anchors may fragment discussion or become stale if the wording changes. A comment on a clause must not be mistaken for an accepted amendment. Test with a real proposal and a cross-section argument. Keep "whole proposal" as the default. Do not add anchoring to formal amendments; they already have base/replacement wording.

**Implementation complexity.** Medium.

**Priority classification.** Experiment. Validate comprehension and moderation load before committing.

---

### OB-18 — Read-only access preview ("view as member")

**Problem or user need.** An administrator wants to see what a member would see without guessing from permission keys.

**Existing Engage behaviour.** The effective-permission snapshot lists grants but does not render the member's navigation or action set.

**Proposed improvement.** A read-only preview that runs the permission engine for a selected member and shows which navigation destinations, page sections and actions would be available. It does not impersonate the member, does not expose record content the viewer cannot see, and cannot cast a ballot or open identifiable ballots.

**Source of inspiration.** Discord View Server As Role, constrained for governance and privacy.

**Expected benefit.** Faster permission troubleshooting and better role design.

**Risks and constraints.** High privacy risk. A preview could leak private branch titles or ballot data. Build it as an explanation, not a session. Require `roles.manage`, log the preview, exclude sensitive record content, and test with a member who has private branch access. Do not allow "view as" to perform mutations.

**Implementation complexity.** High.

**Priority classification.** Experiment after OB-03; only if support demand is demonstrated.

---

### OB-19 — Safe bulk operations for low-risk tasks

**Problem or user need.** Repetitive operational tasks (assigning stewards, verifying branch memberships, sending reminders) take many clicks.

**Existing Engage behaviour.** No general bulk action pattern was found.

**Proposed improvement.** A selection mode with a preview and confirmation for low-risk tasks only:

- assign selected items to a steward;
- send a reminder to selected members;
- verify selected branch memberships with a reason.

**Source of inspiration.** Zendesk bulk assignment; GitHub bulk issue actions; Linear bulk move.

**Expected benefit.** Less repetitive work at higher volume.

**Risks and constraints.** Bulk formal acts are prohibited. Preview the count and consequences; require a reason; rate-limit reminders; make the operation reversible where possible. Do not add bulk to ballot binding, result recording, ratification or publication.

**Implementation complexity.** Medium.

**Priority classification.** Experiment; depend on demonstrated volume.

---

### OB-20 — Shared team saved views

**Problem or user need.** A branch or national team wants a common queue rather than each officer recreating filters.

**Existing Engage behaviour.** Only URL query parameters exist.

**Proposed improvement.** Share a saved view with a branch or national team, with an owner and last-updated label. Permission-scoped.

**Source of inspiration.** Zendesk shared views; Linear team views.

**Expected benefit.** Consistency across officers and easier onboarding.

**Risks and constraints.** View proliferation and stale ownership. Start with personal views (OB-07); add shared views only after usage data.

**Implementation complexity.** Medium.

**Priority classification.** Experiment.

---

### OB-21 — Safe response templates / macros

**Problem or user need.** Officers repeat similar responses to contributions or membership questions.

**Existing Engage behaviour.** No macro/template system for administrative responses. Officers type each response.

**Proposed improvement.** A small set of approved response templates for routine communications (acknowledgement, request for more information), with preview and edit before sending. Templates never record a formal result or change a matter stage.

**Source of inspiration.** Zendesk macros with preview.

**Expected benefit.** Faster, more consistent routine communication.

**Risks and constraints.** A template can be wrong for the context or sound impersonal. Require preview and editing. Do not allow templates to set `ContributionFeedback.status`, bind a ballot or publish policy. Keep the list short and owner-reviewed.

**Implementation complexity.** Medium.

**Priority classification.** Experiment.

---

### OB-22 — Ballot-binding review checklist

**Problem or user need.** Before binding, an officer must confirm several conditions; the interface does not present them together.

**Existing Engage behaviour.** The proposal page and ballot register show some state, but there is no consolidated pre-bind review.

**Proposed improvement.** A read-only checklist before the bind action: bound revision selected, amendments resolved/withdrawn, electorate/branch confirmed, deadline set, wording reviewed. Each item links to the relevant record. The checklist is informational; the server remains authoritative.

**Source of inspiration.** GitHub merge box requirements; Zendesk required fields before leaving triage.

**Expected benefit.** Fewer binding errors and a clearer audit narrative.

**Risks and constraints.** Do not let a checklist tick replace permission/lifecycle checks. Do not imply that a checklist guarantees a valid ballot.

**Implementation complexity.** Low-medium.

**Priority classification.** Experiment (low risk, but validate with returning officers).

---

## Defer

### OB-23 — Additional matter types (consultation, constitutional amendment)

The registry supports new types, but there is no demonstrated workload yet. Adding types without a governance specification risks inventing lifecycle semantics. Defer until a real programme, owner and rule set exist.

### OB-24 — Implementation progress tracking

A "what happened after the decision" milestone tracker could help resolutions, but it creates administrative maintenance and can overstate delivery. Defer until members repeatedly ask or commitments routinely go stale.

### OB-25 — Relationship graph visualisation

A graph is visually attractive but harder to read than the proposed lineage rail, especially on mobile. Defer; prefer typed links and ordered steps.

### OB-26 — Per-matter custom fields

Custom fields would let administrators add unvalidated governance data. Defer until a specific, reviewed need exists (for example, a required impact assessment), and implement as a typed schema, not a free-form builder.

### OB-27 — Reminder automation rules

Time-based reminders are useful, but a rules engine is a large surface. Defer; start with fixed reminders (closing soon, unowned task) and no user-configurable automation.

### OB-28 — Branch-level role delegation

This is a governance decision, not a UI feature. The current model restricts custom role management to national administrators. Defer until the organisation decides whether branch administrators may assign pre-approved roles. Any change needs escalation safeguards and an audit specification.

### OB-29 — Portable decision-record export

A durable, portable record could be useful for external audit or archiving. Defer until a real recipient and format requirement exists. Do not let exports bypass access controls.

---

## Reject

### OB-30 — Generic workflow/matter builder

Rejected. It would let administrators invent lifecycle states and bypass `MatterRegistry` validation. The stages are constitutional; new types belong in code review.

### OB-31 — Deny overrides / per-record permissions

Rejected. Deny/allow precedence makes governance access unpredictable and can hide or expose ballots. Engage's add-only, scoped model is safer.

### OB-32 — Trust levels or engagement scores for governance rights

Rejected. Voting eligibility is a verified membership and branch fact, not a measure of activity. Gamifying governance would undermine the constitution.

### OB-33 — Bulk formal decisions

Rejected. Ballot binding, result recording, ratification and publication need individual review of the exact revision and authority. Bulk actions are limited to operational tasks.

### OB-34 — Real-time co-editing of formal wording

Rejected. Formal wording is immutable and ballot-bound. Co-editing would create ambiguity about what was voted on. Deliberation and amendments are the correct collaboration surfaces.

### OB-35 — AI summaries as the official motion or voting advice

Rejected. Prior research found no verified member need, neutrality guarantee, or source-fidelity assurance. A summary may help reading, but it must never replace the exact motion or be presented as voting advice. Revisit only with a strict evidence and privacy specification.

### OB-36 — Gamification, streaks or leaderboards

Rejected. They pressure participation, reward volume over judgement, and can expose participation patterns. The existing catch-up and reminders are sufficient.

### OB-37 — Administrator bypass of protected transitions

Rejected. No convenience override for ballot binding, result recording, ratification or publication. Emergency procedures, if needed, must be explicit, permissioned and audited.
