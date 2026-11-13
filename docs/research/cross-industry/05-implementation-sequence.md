# Recommended implementation sequence

Research date: 13 November 2026. Companion to the [backlog](03-opportunity-backlog.md) and [UX concepts](04-ux-concepts.md).

## Sequencing principles

1. **Fix the language before adding surface area.** The role editor's raw permission keys and `window.prompt` are small defects that undermine trust in a capable permission system. Ship them first.
2. **Build read models before schema changes.** Role summaries, effective access, lineage and revision summaries can be derived from existing records. They validate the information architecture before any new fields are added.
3. **Separate operational responsibility from governance authority.** Assignment and queues come after the permission explanation is clear, so administrators do not confuse the two.
4. **Do not couple formal acts to new automation.** Reminders, assignment and saved views are operational. Ballot binding, result recording, ratification and publication remain individual, permissioned actions.
5. **Validate the risky collaboration ideas before building them.** Clause anchors and access previews need user testing and a privacy review.
6. **Keep each slice independently shippable.** Every phase should leave the product coherent and the governance invariants intact.

## Phase 0 — Validate and baseline (1–2 weeks)

**Goal:** replace assumptions with observed member and administrator behaviour.

| Activity | Output | Why now |
|---|---|---|
| Five administrator task sessions: create a role, find the next ballot task, bind wording, record an outcome, respond to a contribution. | Task success, errors, time, quotes. | The research identifies plausible problems; this confirms which ones matter. |
| Five member task sessions: distinguish comment/amendment/ballot, follow a contribution, find the next action, explain a decision. | Comprehension findings. | Prevents redesigning a flow that already works. |
| Accessibility audit of `/admin/roles/`, `/admin/`, `/admin/proposals/` and the proposal page at 390px and with a screen reader. | Ranked defects. | Mobile and focus work should be based on real failures. |
| Instrument current admin task completion and error rates (no new personal data). | Baseline metrics. | Needed to judge improvement. |
| Confirm matter and ballot volume for the next 12 months. | Scale estimate. | Decides whether saved views, assignment and bulk actions are worth building now. |

**Do not build in Phase 0.** No schema changes. No visual redesign. Only research, instrumentation and a written decision log.

**Exit criteria:** a prioritised defect list, a baseline metric set, and a decision on whether branch-level role delegation needs a governance specification.

---

## Phase 1 — Trust and comprehension foundation (2–4 weeks)

**Ships:** OB-01, OB-02, OB-03 (explanation only), OB-04, OB-16, OB-15 (audit and highest-impact fixes).

### Slice 1.1 — Role language and templates

- Add outcome and exclusion phrases to `PermissionDefinition`.
- Add 4–6 role templates with scope-valid permission sets.
- Render can/can't summaries and a "Constitutional limits" alert.
- Show assigned-member counts and a details drawer.

**Why first:** high value, low risk, uses the existing permission catalogue. It makes the rest of the role work understandable.

**Verification:** unit tests for template scope validity and summary generation; an administrator can explain a role without opening the grid; mobile check at 390px.

### Slice 1.2 — Human-readable access and audit

- Replace raw permission keys with grouped, plain-language grants and origins.
- Add "Why this member has access" and a separate constitutional-boundary block.
- Replace `window.prompt` with an `AlertDialog`.
- Add human action labels, reasons and basic filters to the role audit log.

**Why second:** builds on the language from 1.1 and removes the most developer-looking surface. Low schema impact.

**Verification:** no raw keys in the default view; audit entries are understandable; revocation is audited and keyboard-accessible.

### Slice 1.3 — Responsive and focus defects

- Fix the highest-impact table overflow, small-text and focus issues found in Phase 0.
- Do not redesign everything; fix what blocks task completion.

**Why third:** the new role surfaces must be usable on mobile before more people use them.

**Exit criteria:** an administrator can create, explain, assign and revoke a role without developer knowledge; the role surfaces pass the mobile/keyboard checks; no governance behaviour changed.

**Explicitly out of scope:** access preview (OB-18), branch-level delegation (OB-28), shared views (OB-20).

---

## Phase 2 — Guided governance work (3–5 weeks)

**Ships:** OB-05, OB-06, OB-08, OB-07 (personal views first), OB-14 (ballot binding and result recording).

### Slice 2.1 — Transition read model and stage actions

- Derive valid next actions from `MatterTypeDefinition.transitions`, the current stage, the user's permissions and the matter's branch authority.
- Replace the free stage select with the action panel and prerequisite checklist.
- Keep the server validation unchanged; add tests that a forged invalid transition still fails.

**Why first:** it is the bridge between the matter model and every admin workflow. It also makes the creation flow easier to design.

**Dependency:** none beyond the existing `matters.ts` and `store.ts`.

### Slice 2.2 — Guided creation

- Add `/admin/proposals/new` with the type chooser, type-specific fields and draft-first save.
- Keep the register separate from creation.
- Add "Save and send to deliberation" only when the transition is valid.

**Why second:** uses the transition read model and avoids a second source of lifecycle truth.

**Verification:** both types create correctly; resolution never shows policy-only fields; branch scope is enforced; no stage is chosen manually.

### Slice 2.3 — Operational steward and "My work"

- Add steward fields and audit events.
- Add "Take it"/"Assign to…".
- Add the default "My work" and "Unassigned" views.
- Add personal saved views with a small filter set.

**Why third:** assignment only makes sense once tasks have clear actions and a queue. Personal views can ship before shared views.

**Verification:** assignment never grants permission; a user without permission can see an assigned task but cannot act; saved views are permission-scoped.

### Slice 2.4 — Sensitive-action outcome states

- Introduce a shared result pattern for ballot binding and result recording.
- Add "Outcome unknown" with "Check current state".
- Add idempotency where the existing API supports it.

**Why fourth:** these are the highest-consequence actions; the pattern should be proven before extending it to ratification/publication.

**Exit criteria:** an administrator can go from intake to deliberation to ballot binding using explicit actions, with a visible owner and a safe failure path.

**Explicitly out of scope:** bulk actions (OB-19), shared views (OB-20), macros (OB-21), automatic reminders (OB-27).

---

## Phase 3 — Traceability and collaboration (3–5 weeks)

**Ships:** OB-09, OB-10, OB-11, OB-22.

### Slice 3.1 — Lineage read model

- Build an ordered lineage from proposals, referrals, revisions, amendments, contributions, ballots, results, policy records and typed relationships.
- Add reciprocal links and permission filtering.
- Add the "Technical details" disclosure for authorised users.

**Why first:** it is a read-only presentation of existing data and has no governance risk if permission filtering is correct.

**Verification:** permission tests for private/branch records; no inaccessible titles; the chain matches the records.

### Slice 3.2 — Revision summary and compare

- Add optional revision summaries.
- Add compare-to-previous and compare-selected.
- Mark the bound ballot revision unmistakably.

**Why second:** the lineage identifies the revision; the comparison explains it. Both reuse the same revision data.

### Slice 3.3 — Evidence deep links

- Render evidence chips from `ContributionFeedbackEvidence`.
- Link to the exact revision/amendment/decision/policy.
- Keep restricted records neutral.

**Why third:** completes the contribution loop after the lineage and revision surfaces exist.

### Slice 3.4 — Ballot-binding checklist

- Add the read-only pre-bind checklist.
- Link each item to its record.
- Keep server validation authoritative.

**Why fourth:** low complexity, but best validated with returning officers after the lineage is available.

**Exit criteria:** a member can follow a contribution to the exact revision, result and published policy; an officer can review what changed before binding; no access leak.

**Explicitly out of scope:** clause anchors (OB-17), real-time co-editing, a graph view.

---

## Phase 4 — Member relevance and re-engagement (3–4 weeks)

**Ships:** OB-12, OB-13.

### Slice 4.1 — Follow model and control

- Add per-matter follow levels and defaults.
- Add the follow control on proposal/policy pages.
- Add the "Following" list.
- Resolve follow level in notification dispatch, in addition to topic consent.

**Why first:** the follow model is the foundation for cadence and relevance.

**Verification:** following never grants access; muted matters produce no notifications; private branch matters are not discoverable; push consent remains independent.

### Slice 4.2 — Digest cadence and reasons

- Separate cadence from topic consent.
- Add a reason to notifications and templates.
- Update unsubscribe to the specific matter first.
- Preserve current behaviour for members who have not chosen.

**Why second:** depends on the follow model.

### Slice 4.3 — Returning-member polish

- Improve "Since your last visit" with a short change line and one next action per matter.
- Cap the list and remove any pressure language.
- Keep the approval-gated re-engagement flow unchanged.

**Exit criteria:** a member can predict which notifications they will receive; every notification explains why; essential messages are unaffected; no engagement score or dark pattern.

---

## Phase 5 — Validated experiments (after Phase 4)

Run only if Phase 0 and Phase 4 produce evidence of need.

| Experiment | Trigger | Guardrail |
|---|---|---|
| Clause anchors on comments (OB-17) | Members report difficulty connecting comments to wording; a moderated test shows benefit. | Anchors are navigational only; formal amendments remain the only wording-change path. |
| Read-only access preview (OB-18) | Support repeatedly struggles to explain access; an explanation-only view is insufficient. | No impersonation, no mutations, no private record content; logged and permissioned. |
| Bulk low-risk actions (OB-19) | Administrators report repetitive work at volume; a time study shows benefit. | Never for formal acts; preview, reason, rate limit, reversibility. |
| Shared views (OB-20) | Multiple officers recreate the same filters; personal views are well used. | Permission-scoped; owner and last-updated; no public sharing. |
| Response templates (OB-21) | Officers write the same routine messages repeatedly. | Preview and edit; never sets feedback status or a formal result. |

Each experiment needs a written hypothesis, a success measure, a rollback plan and a review date. Do not ship an experiment as a permanent feature without that review.

---

## Dependency map

```text
Role language/templates (1.1)
  ├─ Human-readable access/audit (1.2)
  │    └─ Access preview experiment (5)
  └─ Responsive/focus fixes (1.3)

Transition read model (2.1)
  ├─ Guided creation (2.2)
  ├─ Stage action panel (2.1)
  └─ Ballot checklist (3.4)

Operational steward (2.3)
  ├─ My work / Unassigned (2.3)
  ├─ Personal saved views (2.3)
  │    └─ Shared views experiment (5)
  └─ Bulk low-risk actions experiment (5)

Lineage read model (3.1)
  ├─ Revision summary/compare (3.2)
  ├─ Evidence deep links (3.3)
  └─ Ballot checklist (3.4)

Follow model (4.1)
  └─ Digest cadence/reasons (4.2)
       └─ Returning-member polish (4.3)

Outcome states (2.4)
  └─ Extend to ratification/publication only after review
```

## Overlap with ongoing work

The repository has recent work on governance transparency, extensibility hardening, notifications/PWA and configurable roles. The sequence deliberately builds on that work rather than replacing it:

- **Configurable roles** already provide the permission catalogue, snapshots and server guards. Phase 1 is presentation and safe explanation, not a new RBAC engine.
- **Extensibility hardening** already provides `MatterRegistry`, typed relationships and governance events. Phase 2 uses the registry; Phase 3 presents the relationships.
- **Notifications/PWA** already provides channels, consent isolation and dedupe. Phase 4 adds relevance and cadence; it does not replace the channel layer.
- **Governance transparency** already provides revisions, contribution evidence and decision records. Phase 3 makes them readable as a chain.

Before starting each phase, rebase and re-check the relevant files; line references in this research can move.

## Brief-ready scopes

The following are suitable for a focused implementation brief without repeating the research.

### Brief A — Role language and templates

**Goal:** an administrator can understand and create a role without reading permission keys.

**In scope:** outcome/exclusion metadata; 4–6 templates; can/can't summary; constitutional-limits alert; assigned counts; role details drawer.

**Out of scope:** deny rules, new permissions, branch-level delegation, access preview.

**Acceptance:** see Concept 1 acceptance checks 1, 2, 4, 6.

### Brief B — Human-readable access and audit

**Goal:** an administrator can explain why a member has access and review who changed it.

**In scope:** grouped grant rows; origin/scope/date; constitutional boundary; revocation dialog; human audit labels and filters.

**Out of scope:** impersonation, raw event console, export beyond existing permissions.

**Acceptance:** see Concept 1 acceptance checks 3 and 5.

### Brief C — Guided matter creation and stage actions

**Goal:** an administrator can create the right matter type and take the next valid action without knowing the lifecycle.

**In scope:** type chooser; type-specific fields; draft-first save; transition read model; action panel; prerequisite checklist; server validation tests.

**Out of scope:** new matter types, workflow builder, custom fields.

**Acceptance:** see Concept 2 acceptance checks 1–5.

### Brief D — Operations queue and steward

**Goal:** an administrator can see and complete their own work.

**In scope:** steward fields; Take it/Assign; My work/Unassigned/Closing soon/Awaiting decision/Contributions views; personal saved views; empty states.

**Out of scope:** shared views, bulk actions, SLA/automation.

**Acceptance:** see Concept 3 acceptance checks 1–4.

### Brief E — Outcome certainty for formal actions

**Goal:** an administrator never duplicates or misreports a formal act after a failure.

**In scope:** saved/not saved/outcome unknown; check-current-state; idempotency where supported; preserved input.

**Out of scope:** changes to ballot semantics or permissions.

**Acceptance:** see Concept 3 acceptance check 5.

### Brief F — Matter lineage and revision summary

**Goal:** a member can follow a matter from idea to publication.

**In scope:** ordered lineage; reciprocal links; permission filtering; revision summary; compare; bound-revision marker; evidence chips.

**Out of scope:** graph view, new relationship types, historical access expansion.

**Acceptance:** see Concept 4 acceptance checks 1–5.

### Brief G — Follow, digest and notification reasons

**Goal:** a member receives relevant notifications and can explain why.

**In scope:** follow levels; defaults; following list; cadence; reasons; per-matter unsubscribe; returning-member polish.

**Out of scope:** engagement scoring, new push channels, re-engagement campaign changes.

**Acceptance:** see Concept 5 acceptance checks 1–6.

## Success measures

Measure against the Phase 0 baseline:

| Area | Measure |
|---|---|
| Role administration | Time to create a valid branch role; number of roles with unintended permissions; support questions about access. |
| Guided creation | Invalid transition errors per matter; time to create a proposal/resolution; fields edited after creation. |
| Operations | Time to find and complete the next task; unassigned task age; tasks completed per administrator. |
| Traceability | Members who can locate the exact voted wording; contribution-response evidence links used; support questions about "what happened". |
| Notifications | Unsubscribe rate; notification-to-action rate; members who can explain why they received a notification; digest open rate. |
| Accessibility | Keyboard task completion; mobile overflow defects; focus visibility defects. |

Do not optimise for raw engagement. A member who reads carefully and votes once is not a worse participant than a member who comments daily.

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Role summaries become another hand-maintained source of truth | Medium | Generate from the permission catalogue; test coverage for every permission. |
| Assignment is mistaken for authority | Medium | Explicit copy; permission checks independent; test an assignee without permission. |
| Saved views leak records across branches | Low-medium | Permission-scoped queries; tests with a branch admin; default to personal views. |
| Lineage exposes a private record | Medium | Permission filter on every step; neutral "restricted" label; tests. |
| Follow defaults create notification fatigue | Medium | Conservative defaults; author/voter only; easy mute; measure unsubscribe. |
| Outcome-unknown handling is inconsistent | Medium | Start with two routes; shared component; simulation tests. |
| The work expands into a full workflow builder | Low | Explicit out-of-scope list; governance review of any new matter type. |
| Accessibility is deferred to the end | Medium | Phase 1 audit; acceptance checks in every brief; no "mobile later". |

## What must not change

- Ballot eligibility and electorate resolution.
- Revision binding and the immutability of ballot wording.
- The separation of discussion stances from formal ballot choices.
- The separation of ballot result, ratification and publication.
- The identifiable-ballot permission boundary.
- Server-side permission enforcement.
- The requirement that formal transitions are authorised human actions.

If an implementation brief appears to require changing one of these, stop and write a governance specification first.
