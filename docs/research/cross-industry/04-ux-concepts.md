# Concrete UX concepts

Research date: 13 November 2026. These concepts show how the highest-value opportunities would work in Engage. They are design proposals, not implemented behaviour. Every concept uses the Horizon design system and the shadcn-compatible primitives in `src/components/ui` (or their Astro wrappers in `src/components/admin`).

## Design constraints that apply to every concept

- **Governance before convenience.** A visible control never implies authority. Server-side permission and lifecycle checks remain authoritative.
- **One primary action per surface.** Secondary actions are outlined or in a disclosure.
- **Plain language at the decision point; exact language at the authority point.** Say "Send to deliberation", then show "Ballot wording bound to revision 4".
- **Progressive disclosure.** Purpose and next action first; full permission lists, provenance and technical references behind a disclosure.
- **No raw implementation output.** No permission keys, event names, JSON, stack traces or unformatted IDs in ordinary views.
- **Horizon tokens only.** No arbitrary Tailwind palette utilities or undefined custom properties.
- **Primitives only.** `Button`, `Input`, `Textarea`, `NativeSelect`, `Checkbox`, `Switch`, `ToggleGroup`, `Table`, `Badge`, `Alert`, `Dialog`, `AlertDialog`, `Card`, `Field`, `Separator`.
- **Mobile and keyboard are designed, not adapted.** Test at 390px, 768px and desktop; visible focus on every control; no colour-only status.
- **Never claim success before the server confirms it.** Distinguish saved, not saved and outcome unknown.

---

## Concept 1 — Role and permission studio

**Addresses:** OB-01, OB-02, OB-03, OB-04, OB-16. **Inspiration:** Discord role editor, GitLab custom roles, Stripe role descriptions.

### User story

> As a national administrator, I need to give a branch officer the ability to verify branch members and review ballot wording, without giving them policy ratification or identifiable-ballot access, and I need to understand exactly what I have granted.

### Entry point

`/admin/roles/` becomes **Roles & access**, with three tabs:

- **Roles** — the role library.
- **Assignments** — who holds what, where.
- **Access check** — explain a member's effective access.

The page title is "Roles & access". The description is one line: "Delegate routine administration without changing constitutional authority."

### Role library

```text
Roles & access
Delegate routine administration without changing constitutional authority.

[ Roles ] [ Assignments ] [ Access check ]                         [ Create role ]

Role                         Scope     Who it's for                 Assigned   Actions
---------------------------------------------------------------------------------------
National Administrator       National  Full platform administration       2      View
Moderator                    National  Deliberation and review            5      View
Branch Administrator         Branch    Branch operations                 18      View
Ballot Officer               Branch    Bind wording, record outcomes       4      View  Edit
Membership Verifier          Branch    Verify branch memberships           6      View  Edit
```

Each row uses `Table`, `Badge` for scope, and `Button` for actions. "Assigned" counts active assignments. System roles show "Built in" and have no Edit action. A filter row above the table uses `Input` (search) and `NativeSelect` (scope, assignment status).

### Role detail

A `Dialog` (desktop) or full-page sheet (mobile) with:

```text
Ballot Officer                                      Branch · 4 assigned
--------------------------------------------------------------------------------
Purpose
Prepare and record formal ballots within an assigned branch.

This role can
• Review proposal wording before a ballot opens
• Bind a ballot to an exact revision
• Record a returning-officer result

This role cannot
• Change ballot eligibility or the electorate
• Ratify policy or publish it publicly
• View identifiable member ballots
• Act outside its assigned branch

Constitutional limits
Ballot eligibility and ratification authority are not controlled by this role.
They remain with verified membership and national governance.

[ Permissions (6) ]  [ Assigned members (4) ]  [ History ]
```

The "Constitutional limits" block uses `Alert` with a `ShieldCheck` or `Scale` icon. It is informational, not a control.

The **Permissions** tab groups capabilities by the existing catalogue groups. Each row shows the plain label, a one-line description, and a `Badge` for "Sensitive" or "National only". The raw key is available under "Technical details" for authorised users.

### Create / edit role

```text
Create role
[ Start from: Deliberation moderator ▾ ]   [ Scope: Branch ▾ ]

Name          [ Branch Ballot Officer                    ]
Description   [ Prepares and records branch ballots       ]

What this role can do
Proposals & Deliberation
  [x] Review archived proposals
  [x] Edit proposal wording and stage
  [ ] Delete proposals                  National only
Ballots
  [x] Bind proposal ballots             Sensitive
  [x] Record ballot results             Sensitive
  [ ] View identifiable ballots         National only

[ Show all permissions ]

This role cannot grant:
• ballot eligibility or an electorate
• policy ratification or publication
• identifiable-ballot access

[ Cancel ]                                      [ Create role ]
```

Behaviour:

- Choosing a template prefills name, description, scope and permissions.
- Changing scope from national to branch removes national-only selections and disables those checkboxes with an explanation.
- A permission the actor does not hold is disabled with "You cannot grant a permission you do not hold."
- Sensitive permissions require an inline confirmation: "This allows X. Continue?" The confirmation is part of the form, not a browser prompt.
- Saving shows "Role created" or a plain error; the form preserves input on failure.

### Assign role

A `Dialog` with:

- Member picker (reuse `admin-search-picker`).
- Role picker (only assignable roles).
- Branch picker when the role is branch-scoped.
- Optional review date (operational follow-up, not an authority expiry).
- A summary: "Jordan Lee will be able to bind ballots for Victoria. They will not be able to ratify or publish policy."

On submit, the server checks self-assignment, scope, permission escalation and role status. The UI shows the server's reason if blocked.

### Revoke assignment

`AlertDialog`:

```text
Revoke Ballot Officer from Jordan Lee?

Jordan will immediately lose the ability to bind ballots and record results
for Victoria. Existing ballot records are not changed.

Reason
[ Role no longer required                               ]

[ Cancel ]                         [ Revoke assignment ]
```

No `window.prompt`. Focus starts in the dialog, Escape cancels, focus returns to the Revoke button.

### Effective access check

A member picker, then:

```text
Jordan Lee · Verified member · Victoria

What Jordan can do
Proposals     Review archived proposals, edit wording before voting
Ballots       Bind ballot wording, record results (Victoria)
Members       Verify branch memberships (Victoria)
Reporting     Export aggregate reports (Victoria)

Why Jordan has this access
Ballot Officer        Branch role · Victoria · assigned by Alex Chen, 3 Nov 2026
Branch Administrator  Legacy branch delegation · Victoria
Member                Base participation · verified 12 Jan 2026

Constitutional boundary
Eligible to vote in Victoria ballots: Yes (verified branch member)
Can view identifiable ballots: No
Can ratify or publish policy: No

[ Show technical details ]
```

Every grant is a row with a plain label, scope, source and date. "Technical details" reveals permission keys and grant IDs for authorised diagnostic use.

### States and edge cases

| State | Treatment |
|---|---|
| No custom roles | Empty state: "No custom roles yet. Start with a template." Button opens Create role. |
| Role has assignments | Delete is disabled with "Reassign the 4 members before deleting this role." |
| Scope change blocked | Alert: "This role has active assignments. Create a new role for a different scope." |
| Permission not held | Checkbox disabled, inline note: "You cannot grant this permission because you do not hold it." |
| Self-assignment | Member picker excludes the current user; if forced, server returns a plain error. |
| Save failure | Alert preserves all fields; "Couldn't save role. Try again." with a retry button. |
| Loading | Skeleton rows in the table; `aria-busy` on the region. |

### Accessibility and mobile

- The permission groups use real `Checkbox` controls inside a labelled `fieldset`/legend; no hidden inputs with drawn labels.
- At 390px, the role table becomes stacked rows: role name, scope badge, assigned count, and a "View" button. No horizontal scroll.
- The permission grid becomes one column; group headings are sticky within the dialog if needed.
- All dialogs trap focus, restore focus, and have a visible close button.
- The can/can't lists are real lists, not colour-coded chips.

### Governance guardrails

- The role editor never changes `canParticipate`, ballot eligibility or the identifiable-ballot boundary.
- The permission catalogue is fixed; administrators cannot invent a capability.
- National-only permissions cannot be attached to branch roles.
- Self-assignment and self-revocation remain blocked server-side.
- Every create/edit/assign/revoke writes an audit event with actor, target, scope, reason and before/after.

### Acceptance checks

1. An administrator can create a branch role from a template without opening the full permission list.
2. Every role shows a can/can't summary and a constitutional-limits note.
3. The effective-access view contains no raw permission keys in its default state.
4. A branch role cannot display or select a national-only permission.
5. Revocation uses a dialog with a reason and an audited result.
6. Keyboard-only and 390px use are verified.

---

## Concept 2 — Guided matter creation and stage actions

**Addresses:** OB-05, OB-06, OB-22. **Inspiration:** Linear templates and triage, Notion templates, GitHub protected transitions.

### User story

> As a branch administrator, I want to propose a policy change without first understanding the whole lifecycle, and I want to know what I can do next and why.

### Creation flow

`/admin/proposals/new` (or a full-page `Dialog` from the register).

#### Step 1 — Choose the type

```text
What are you creating?

( ) Policy proposal
    Deliberated, amended, voted, ratified, and published as party policy.
    Includes policy provenance and publication.

( ) Governance resolution
    Deliberated, amended, and voted. Records an organisational outcome.
    Never enters the policy registry.

[ Cancel ]                                             [ Continue ]
```

Each option is a `Card` with a radio-style `ToggleGroup` or a `Checkbox`-backed card. Do not use a raw radio input. The selected card gets a visible border and a "Selected" badge; focus is visible.

#### Step 2 — Describe the matter

```text
New policy proposal

Title
[ Universal dental care in Medicare                            ]

Summary
[ What the proposal does, in plain language.                    ]

Key commitments (one per line)
[ • Add dental to Medicare                                     ]
[ • Fund through the existing Medicare levy                    ]

Rationale and background
[ Markdown supported.                                           ]

Topic
[ Health ▾ ]

[ Add supporting detail ]   (disclosure)
  Attachment URL
  Attachment description
  Provenance classification
  Prior policy links
  Branch and publication scope (national administrators only)

[ Back ]                                [ Save draft ]
```

Rules:

- The form never asks for a lifecycle stage. A new matter is saved as `propose`.
- Resolution creation hides policy publication and provenance fields.
- Policy creation shows provenance prompts but does not require them if the classification is "new proposal".
- Branch administrators see only their branch in the scope picker and cannot set national publication scope.
- The primary action is "Save draft". A secondary action "Save and send to deliberation" appears only if the user has `proposals.edit` and the matter passes the transition requirements.

#### Step 3 — Review

A read-only summary of the type, title, summary, commitments, scope and authority. The primary action is "Send to deliberation" or "Save draft". The screen states: "Sending to deliberation opens the matter for member discussion. It does not open a ballot."

### Stage action panel

On the admin proposal detail page, replace the free stage select with:

```text
Current stage
2 · Deliberation
Members can discuss and propose amendments. No formal ballot is open.

Next action
Open formal ballot
Requires: reviewed wording, resolved amendments, confirmed authority, closing date.

  [x] Wording reviewed
  [x] Open amendments resolved or withdrawn
  [ ] Ballot wording bound
  [ ] Closing date set

[ Open ballot ]  (disabled until prerequisites are met)

Other changes
[ Return to draft ]  [ Archive ]   (disclosure; each shows its own confirmation)
```

The checklist is informational. The server still validates the transition, permission and ballot binding.

For each action, show:

- what it does;
- who it affects;
- whether it is reversible;
- the exact record it will create;
- the required permission in plain language ("You need the Bind ballot wording permission for Victoria").

### Copy examples

| Moment | Copy |
|---|---|
| Draft saved | "Draft saved. It is visible to administrators only." |
| Sent to deliberation | "Sent to deliberation. Verified members can now discuss it." |
| Ballot opened | "Ballot opened for Victoria. It is bound to revision 4 and closes on 14 January 2027." |
| Transition blocked | "You can't open a ballot yet. Bind the reviewed wording first." |
| Invalid stage request | "That stage isn't available from here. Reload the page and choose a valid action." |

### States and edge cases

| State | Treatment |
|---|---|
| No permission | The action is hidden; a read-only note explains the current stage. |
| Branch mismatch | The action is disabled: "This ballot is governed by Victoria. You administer New South Wales." |
| Ballot already bound | "Wording is already bound to revision 4. To change it, return to deliberation and create a new revision." |
| Matter archived | Read-only record with "Restore to draft" if permitted; no direct ballot action. |
| Concurrent edit | "This matter changed while you were editing. Review the current version before saving." |
| Save failed | Preserve the form; show a plain error and retry. |

### Accessibility and mobile

- Type cards are keyboard-selectable with a visible focus ring and `aria-pressed`/radio semantics.
- The stage checklist uses a real list with text status, not colour alone.
- At 390px, the stage panel stacks; the primary action remains visible without scrolling past the checklist.
- Long forms use `Field` with visible labels and hints, not placeholders as labels.

### Governance guardrails

- The type registry remains code-defined; no administrator can invent a type.
- A new matter always starts in `propose`.
- The UI cannot force an invalid transition; server validation remains authoritative.
- A checklist tick never substitutes for permission or lifecycle validation.
- No template can prefill a ballot, result, ratification or publication.

### Acceptance checks

1. A first-time administrator can create both matter types without choosing a stage.
2. Resolution creation never shows policy-only fields.
3. Every visible stage action is valid; invalid actions are disabled with a reason.
4. The server rejects a forged invalid transition.
5. The bound revision is visible before a ballot opens.
6. Mobile and keyboard use are verified.

---

## Concept 3 — Action-oriented administration

**Addresses:** OB-07, OB-08, OB-14, OB-19. **Inspiration:** Zendesk views and assignment, Linear saved views, Stripe outcome certainty.

### User story

> As a branch administrator, I want to open Engage and see the three things I need to do today, not a dashboard of everything that exists.

### Admin home

```text
Governance operations
Good morning, Alex. You have 4 items that need you.

[ My work ] [ Unassigned ] [ Closing soon ] [ Awaiting decision ] [ Contributions ]

My work                                                     [ Save view ] [ Pin ]
--------------------------------------------------------------------------------
Ballot wording needs review
Universal dental care in Medicare · Victoria · 2 days old
[ Bind wording ]                                             Alex Chen

Contribution awaiting response
Transport pricing · 3 comments · 5 days old
[ Respond ]                                                  Unassigned

Member verification
2 pending accounts in Victoria
[ Review members ]                                           Unassigned
```

Tabs are `ToggleGroup` or a labelled nav with `aria-current`. The list is a set of `Card` rows or a `Table` on desktop, not a grid of metric tiles.

### Task row anatomy

| Element | Purpose |
|---|---|
| Action title | What needs doing, in outcome language. |
| Matter title | The record it concerns, linked. |
| Scope | Branch or National badge. |
| Age/deadline | "2 days old", "Closes in 3 days". |
| Owner | Name or "Unassigned". |
| Primary button | The single next action. |
| Secondary menu | Assign, snooze (later), open record. |

Do not show a large number and a paragraph of explanation. A row is enough.

### Assignment

- **Take it** assigns the current administrator as operational steward.
- **Assign to…** opens a `Dialog` with a member picker and an optional note.
- The row shows "You" or the assignee's name.
- The detail page shows a small "Steward" field with the same statement: "Operational responsibility only. Does not grant governance authority."

### Saved views

`Save view` opens a `Dialog`:

```text
Save this view

Name
[ Ballots I need to bind ]

Include
[x] Only my branch
[x] Only items assigned to me
[ ] Include unassigned items

[ Cancel ]   [ Save view ]
```

The first release supports personal views only. A pinned view appears at the top of the admin workspace. A view is permission-scoped: it never exposes records the viewer cannot access.

### Bulk actions

Selection is available only on views that opt in (for example, branch member verification). When items are selected, a sticky action bar appears:

```text
3 members selected
[ Verify memberships ]   [ Send reminder ]   [ Clear selection ]
```

Confirmation shows the count, the branch and the consequence. A reason is required. Bulk actions are never available for ballot binding, result recording, ratification or publication.

### Error and recovery states

For sensitive actions, use a consistent `Alert`:

```text
Couldn't confirm the ballot was bound
The connection dropped after you submitted. The ballot may already be bound.
Check the current state before trying again.

[ Check current state ]   [ Back to ballot ]
```

Never show "Saved" until the record is confirmed. For validation failures, preserve the form and explain the fix.

### Empty states

- My work: "Nothing assigned to you. [View unassigned work]"
- Unassigned: "Everything has an owner."
- Closing soon: "No ballots close in the next seven days."
- Contributions: "No contributions are waiting for a response."

No motivational paragraphs. One sentence and, where useful, one action.

### Mobile

- Tabs scroll or become a `NativeSelect` labelled "View".
- Task rows stack: title, matter, metadata, full-width primary button.
- The sticky bulk bar sits above the safe-area inset and does not cover the last row.
- The assignment dialog is full-screen on small viewports.

### Governance guardrails

- Assignment never grants a permission or eligibility.
- A task is visible only if the viewer can access the underlying record.
- Saved views cannot be shared publicly in the first release.
- Bulk actions exclude all formal governance acts.
- Sensitive actions distinguish not saved from outcome unknown.

### Acceptance checks

1. An administrator can answer "what should I do now?" from the default view.
2. "Take it" assigns operational ownership without changing permissions.
3. A saved view survives reload and remains permission-scoped.
4. Bulk actions are unavailable for formal decisions.
5. A simulated post-submit network failure shows "Outcome unknown" with a working check.
6. The queue is usable at 390px.

---

## Concept 4 — Contribution, revision and decision lineage

**Addresses:** OB-09, OB-10, OB-11, OB-17. **Inspiration:** Wikipedia history, GitHub timeline, Airtable bidirectional links, Figma/Google Docs anchored feedback.

### User story

> As a member, I want to follow my contribution through the wording change, the ballot, the decision and the published policy, without hunting through five sections.

### Proposal page — lineage section

Place the lineage after the proposal hero and before the main reading content, or in the right rail on desktop below the ballot card. On mobile it appears after the summary and before the detailed rationale, collapsed by default if more than four steps.

```text
Lineage
Idea · 12 Oct 2026
  Submitted by Jordan Lee

Branch referral · 18 Oct 2026
  Referred by Victoria to National

Revision 3 · 2 Nov 2026
  Wording updated after deliberation

Amendment #2 applied · 5 Nov 2026
  "Include dental for children under 18"

Ballot bound · 7 Nov 2026
  Exact wording: revision 4

Result recorded · 14 Nov 2026
  Successful · 68% approve · 41% turnout

Ratified · 15 Nov 2026

Published · 16 Nov 2026
  View policy →
```

Each step is a link where a record exists. A step that does not exist is omitted. Do not show a grey "not yet" step unless it clarifies the next action.

### Revision detail

```text
Revision 4 · 7 Nov 2026 · Bound ballot wording
By Alex Chen

What changed
• Added dental cover for children under 18
• Clarified the funding paragraph
• No change to the title

[ Compare to revision 3 ]   [ View full wording ]

This is the exact wording members voted on.
```

The comparison uses a two-pane "Before / After" or a unified diff. On mobile, use a unified diff with clear "Added" / "Removed" text labels, not colour alone.

### Contribution response with evidence

```text
Jordan Lee · Concern · 2 Nov 2026
The funding mechanism is unclear for low-income households.

Officer response · Alex Chen · 5 Nov 2026
Incorporated. The funding paragraph now explains the levy exemption.
[ Incorporated in revision 4 → ]   [ View amendment #2 → ]
```

If the viewer cannot access the evidence: "Supporting record restricted." Do not show the title.

### Anchor picker (experiment)

When composing a comment:

```text
Commenting on
[ Whole proposal ▾ ]
  Whole proposal
  Commitment 1: Add dental to Medicare
  Commitment 2: Fund through the Medicare levy
  Rationale: Funding
```

The anchor appears above the comment: "On Commitment 1". It is a navigation aid, not an amendment. A note explains: "To propose a formal wording change, submit an amendment."

### Policy page — reciprocal lineage

```text
Published policy
Universal dental care in Medicare

Lineage
Supersedes policy proposal GOV-2026-0142 (ratified 15 Nov 2026)
Ballot: revision 4 · successful
[ View the decision record ]

Superseded by
None
```

### States and edge cases

| State | Treatment |
|---|---|
| No revisions | Show "No wording changes yet." |
| Private record | Omit the title; show "A related record is restricted." |
| Superseded | Show the successor first, then the historical chain. |
| Withdrawn amendment | Show "Withdrawn" with the reason if permitted. |
| Very long chain | Collapse older steps behind "Show earlier history". |
| Technical detail | A disclosure for authorised users with IDs/hashes. |

### Accessibility and mobile

- The lineage is an ordered list (`ol`) with headings and dates; screen readers get the sequence.
- Do not use a canvas/SVG graph.
- Diff panes have text labels and a logical reading order; the unified view is default on mobile.
- Links are real links, not clickable divs.
- Dates use `<time datetime>`.

### Governance guardrails

- The lineage is a read model; it does not create or alter relationships.
- Only typed relationships are shown; no free-form related records.
- A ballot result is never labelled "adopted policy" before ratification.
- A comment anchor never counts as an amendment.
- Inaccessible records do not leak titles or content.

### Acceptance checks

1. A member can follow a contribution to the exact revision, decision and policy.
2. The bound revision is unmistakable.
3. A private related record does not reveal its title.
4. The lineage matches the underlying records in tests.
5. Mobile and screen-reader order is verified.

---

## Concept 5 — Follow, digest and notification relevance

**Addresses:** OB-12, OB-13. **Inspiration:** Discourse watching/tracking, Linear view subscriptions, existing Engage catch-up.

### User story

> As a member, I want to hear about the two proposals I care about and the ballots I can vote on, without being emailed about everything.

### Follow control

On the proposal hero, next to the stage badge:

```text
[ Following: Decisions only ▾ ]
  All updates
  Decisions only
  Muted
```

The control is a `NativeSelect` or a `ToggleGroup` with a visible label. A short hint: "You'll hear about ballots and recorded outcomes. Change this anytime."

Defaults:

- Author: All updates.
- Voter or commenter: Decisions only.
- Everyone else: Not following. The control reads "Follow this proposal".

Changing the control saves immediately and shows "Following updated." It never changes voting eligibility.

### Following list

`/member/?view=following`:

```text
Following

Universal dental care in Medicare
Decisions only · Ballot opens 7 Jan 2027
[ View proposal ]

Transport pricing review
All updates · 3 new comments since your last visit
[ View proposal ]

[ Manage notification preferences ]
```

Group by matter, show the current state and next action, cap the initial list and offer "Show all".

### Notification preferences

```text
Notifications

How often
( ) Immediate
(•) Daily digest
( ) Weekly digest
( ) Off — I'll check Engage myself

Topics
                          Email   Push
New ballots                 [x]    [ ]
Closing deadlines           [x]    [ ]
Contribution responses      [x]    [ ]
Governance outcomes         [x]    [ ]
Account and membership      [x]    [x]   (essential)

[ Save preferences ]
```

Rules:

- Cadence is independent of topic consent.
- Push is strictly opt-in and never inferred from email.
- Account/security messages are outside the cadence and cannot be disabled.
- "Off" does not disable essential messages.
- The UI states: "We won't email you about a matter you've muted."

### Inbox — why this notification

```text
New ballot: Universal dental care in Medicare
Victoria · Closes 14 Jan 2027
You're seeing this because you're a verified member of Victoria.
[ Review ballot ]
```

Each item has a one-line reason. The reason is also in the email footer and the push payload where confidentiality allows.

### Email footer

```text
You're receiving this because you follow Universal dental care in Medicare.
[ Change what you follow ]   [ Pause non-essential emails ]   [ Unsubscribe ]
```

The unsubscribe link goes to the specific matter preference first, with a global option. Do not use a single "unsubscribe from everything" as the only route.

### Returning member

The existing "Since your last visit" group stays. Add:

- a short "What changed" line per matter;
- one primary next action (vote, review result, read response);
- a cap of four groups, with "Show all";
- no streak, score or "you haven't voted" pressure.

### States and edge cases

| State | Treatment |
|---|---|
| No followed matters | "You're not following anything yet. Follow a proposal to hear about decisions." |
| Muted matter | It remains accessible, but no notifications; show "Muted" in the follow list. |
| Ineligible member | Follow is allowed only for matters they can view; a private branch matter is not discoverable. |
| Digest empty | Do not send. Show "Nothing new" in the inbox. |
| Push denied | Explain browser permission and offer email instead. |
| Delivery failure | Show "Couldn't save preferences" and preserve choices. |

### Accessibility and mobile

- The preference matrix uses real `Checkbox`/`Switch` controls with column headers and row labels; onmobile it becomes per-topic cards with labelled toggles.
- The follow control has a visible label and focus ring.
- Notification reasons are text, not icons alone.
- Email templates remain readable at 320px and in dark mode.

### Governance guardrails

- Following never grants eligibility or access.
- Push payloads never contain private branch titles or ballot choices.
- Preferences are per member; administrators cannot infer consent.
- No engagement scoring or behavioural pressure.
- Re-engagement remains approval-gated and rate-limited.

### Acceptance checks

1. A member can follow a matter at three levels and see the state.
2. A muted matter produces no notifications.
3. Digest cadence is independent of topic consent.
4. Every notification explains why it arrived.
5. Push remains opt-in and confidential.
6. An ineligible member cannot discover a private branch matter through follow.

---

## Cross-concept component map

| Need | Primitive |
|---|---|
| Primary/secondary actions | `Button` |
| Search/filter fields | `Input`, `NativeSelect` |
| Long text | `Textarea` |
| Permission toggles | `Checkbox` |
| Channel preferences | `Switch` |
| View/type selection | `ToggleGroup` |
| Data registers | `Table` |
| Status and scope | `Badge` |
| Inline feedback | `Alert`, `AlertTitle`, `AlertDescription` |
| Confirmation | `AlertDialog` |
| Detail/create dialog | `Dialog` |
| Surfaces | `Card` family |
| Field label/hint/error | `Field` |
| Member identity | `Avatar` |
| Section separation | `Separator` |

## What these concepts deliberately do not include

- A generic settings page for governance rules.
- A graph editor.
- A workflow builder.
- A second design system.
- A dashboard of decorative metrics.
- An "AI assistant" panel.
- A mobile-only simplified mode that hides authority.
- A public engagement score.

## Validation plan for the concepts

Before implementation, test the highest-risk assumptions with five members and five administrators:

1. Can a member explain the difference between a comment, an amendment and a ballot after using the proposal page?
2. Can an administrator create a branch role and explain its limits without help?
3. Can an administrator find and complete the next ballot task from the admin home?
4. Can a member follow a matter and correctly predict which notifications they will receive?
5. Can a member follow a contribution to the exact revision and decision?
6. Do clause anchors help or fragment discussion?
7. Does the lineage panel clarify or overwhelm on mobile?

Measure task success, time, errors and verbal misunderstandings, not clicks alone.
