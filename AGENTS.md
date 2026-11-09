# Engage — Agent & Maintainer Engineering Rules

These rules apply to all agents and maintainers working on Engage.

**Engage is a member participation platform, not a developer console.** Every change must preserve governance correctness, deliver an intuitive user experience, and maintain engineering quality.

A feature is not finished simply because its API works, its tests pass, or its controls appear on screen.

## 1. Product Design Principles

### Design for people, not implementation

Interfaces must reflect what members and administrators are trying to accomplish, not how the underlying software is structured.

- Use language people understand.
- Organise interfaces around tasks, decisions, and outcomes.
- Show the most relevant information and next action first.
- Hide implementation complexity unless it is genuinely necessary.
- Prefer established interaction patterns over novel ones that require explanation.
- Never make users understand the database, API, queue, or internal architecture to complete an ordinary task.

**The interface should make the correct action obvious without requiring instructions.**

### Progressive disclosure

Do not show everything simply because the data is available.

- Prioritise the information necessary for the current task.
- Group related controls and information logically.
- Reveal secondary details when requested or contextually relevant.
- Keep advanced settings and diagnostics separate from routine workflows.
- Avoid oversized dashboards, sprawling forms, and endless panels.
- Do not bury important actions beneath background information.

Complexity may exist behind the interface. It should not dominate the interface.

### Reduce cognitive load

Every additional decision, label, paragraph, and control imposes a cost.

- Use clear visual hierarchy and meaningful grouping.
- Provide sensible defaults where appropriate.
- Reduce the number of decisions required to complete common tasks.
- Avoid asking for information the application already knows.
- Preserve context and user input when moving between steps.
- Make status, progress, and outcomes immediately understandable.

Do not equate fewer clicks with better UX. A clear sequence of steps is preferable to a confusing screen containing everything.

## 2. Interface Copy — Concise, Human, Useful

**Trust the user.**

AI-generated interfaces frequently contain excessive explanation, repetitive labels, unnecessary reassurance, and verbose descriptions of obvious functionality. Engage must avoid these patterns.

### Writing standards

- Use plain, direct Australian English.
- Prefer short, meaningful headings.
- Write action-oriented labels that describe outcomes.
- Remove redundant introductions, summaries, and instructional paragraphs.
- Do not repeat information already communicated through layout or controls.
- Avoid marketing language inside functional application interfaces.
- Explain unfamiliar concepts where explanation is necessary, not everywhere.
- Never expose internal terminology merely because it appears in the codebase.

Examples:

| Avoid | Prefer |
|---|---|
| "Manage your notification preferences and customise how you receive updates from Engage" | "Notifications" |
| "You currently have 3 proposals that are awaiting your participation" | "3 proposals awaiting your vote" |
| "Click the button below to send yourself a test email" | "Send test email" |
| "An error occurred while attempting to process your request" | "Couldn't save changes. Try again." |
| "View detailed analytics and engagement metrics for your members" | "Member engagement" |
| "There are currently no proposals available for you to vote on" | "You're up to date" |

These are examples, not mandatory strings. Copy must remain accurate to the actual feature and governance context.

### When explanations are necessary

Use short contextual help for genuinely unfamiliar, consequential, or irreversible actions.

Formal ballots, eligibility, deadlines, privacy, and governance decisions may require additional explanation. Never sacrifice accuracy or informed participation merely to reduce word count.

**Concise does not mean incomplete.**

## 3. Administrative Interfaces Are Not Developer Tools

Administrators are operating a product. They should not need software engineering knowledge to do their jobs.

### Never expose raw implementation details as the primary UI

Prohibited in ordinary administrative screens:

- Raw JSON responses or database documents.
- API endpoint instructions.
- HTTP methods or status codes without human-readable context.
- Stack traces, exception names, or internal error objects.
- Raw configuration keys or environment variable names.
- Internal queue states presented without meaningful interpretation.
- Unformatted timestamps, identifiers, or serialized objects.
- Technical explanations substituted for usable controls.

If technical details are useful for troubleshooting, provide them through a clearly separated diagnostic view, accessible only to appropriately authorised users.

### Design around administrative questions

An administrator should be able to answer:

- What needs my attention?
- What is happening?
- Is something wrong?
- What can I do about it?
- Did my action succeed?

Prefer actionable status summaries, understandable tables, clear filters, and focused detail views.

For example, an email delivery interface should present delivery health, failures, recent activity, and a working test-email action.

It should not present instructions for calling the email API or descriptions of environment variables.

### Operational failures

Errors must be actionable.

- Explain what failed in plain language.
- Indicate whether the operation can be retried.
- Preserve user input where possible.
- Distinguish pending, successful, failed, and uncertain outcomes.
- Never claim success until the underlying operation has succeeded.
- Offer relevant recovery actions.
- Keep diagnostic details accessible without making them the main experience.

**Never display implementation instructions where a user-facing solution should exist.**

If a feature requires configuration outside the interface, provide a clear operational state and appropriate next steps rather than pretending the feature is usable.

## 4. Visual Design & Interaction Quality

### Follow Horizon

Horizon is Engage's visual design system.

- Reuse established typography, spacing, colours, components, and interaction conventions.
- Respect light and dark themes.
- Maintain consistent visual hierarchy across member and admin experiences.
- Avoid introducing one-off design languages.
- Reuse accessible, maintained components where appropriate.
- Do not preserve legacy styling or compatibility layers when they conflict with an explicitly approved redesign.

### Avoid common AI-generated UI defects

Do not produce:

- Huge cards containing a single metric and paragraphs of explanation.
- Excessive nested cards, borders, or decorative containers.
- Every section presented as equally important.
- Giant headings that overwhelm functional content.
- Walls of text on administrative screens.
- Repetitive icon-and-description combinations.
- Unnecessary confirmation dialogs and extra steps.
- Forms that expose every possible configuration option at once.
- Dense tables without appropriate formatting, hierarchy, or useful actions.
- Decorative dashboards that consume space without helping a user decide or act.

Use whitespace, typography, and hierarchy to create structure before adding containers or decoration.

### Interaction standards

- Provide clear loading, success, empty, and error states.
- Prevent accidental duplicate submissions.
- Preserve user context after actions.
- Use inline feedback for routine interactions.
- Support keyboard navigation and accessible focus management.
- Meet WCAG 2.2 AA accessibility requirements where applicable.
- Design and verify mobile layouts, not merely desktop layouts.
- Respect reduced-motion preferences.
- Never rely on colour alone to communicate state.

### Empty states

An empty state should explain the situation and provide the next useful action when one exists.

Do not invent actions or fill empty states with unnecessary motivational copy.

## 5. Complete User Workflows

**Implement user stories, not collections of controls.**

Before implementation, identify:

1. Who is using the feature?
2. What are they trying to achieve?
3. What information do they need?
4. What is the simplest safe workflow?
5. What should happen when something goes wrong?
6. How will success be verified?

A feature is incomplete if it works only in the happy path.

### Definition of done

Every user-facing feature must satisfy:

- The intended task can be completed end to end.
- The interface is understandable without developer knowledge.
- Loading, empty, error, and success states are handled.
- Authorisation and privacy constraints are enforced.
- Actions provide accurate feedback.
- Responsive layouts and accessibility are verified.
- Tests cover critical behaviour and failure conditions.
- No raw technical output leaks into normal UI.
- Existing relevant workflows remain functional.

For high-impact features, verify the actual rendered interface and user journey, not only component tests or API responses.

**Passing CI is necessary, not evidence of good UX.**

## 6. Governance & Security Invariants

Never alter ballot eligibility, voting semantics, revision binding, policy authority, or server-side permissions without an explicit governance specification.

Never confuse deliberative discussion stances (`support`, `concern`, `amendment`, `comment`) with formal member ballots (`approve`, `abstain`, `reject`).

Keep identifiable ballot choices restricted to the authorised boundary (`canViewIdentifiableBallots`).

Additional requirements:

- Enforce permissions server-side, not only in the UI.
- Preserve ballot integrity, auditability, and applicable privacy requirements.
- Do not infer voting authority from navigation visibility or client-side state.
- Do not silently change governance behaviour during UI refactors.
- Make consequential decisions and irreversible actions clear to users.
- Keep sensitive information out of logs, analytics, and error messages.
- Distinguish actual voting eligibility from whether a user happens to see a voting control.

Governance correctness takes precedence over interaction convenience.

## 7. Performance & Application Behaviour

### Immediate next action

Every proposal page (`/proposals/[slug]/`) must display the user's immediate next action and estimated time in the hero banner.

This information must reflect the user's actual state and permissions. Never present unavailable or inapplicable actions as actionable.

### Data access

- Run independent MongoDB queries via `Promise.all(...)` where safe.
- Project only required fields on list queries.
- Avoid redundant `listProposals` calls within the same request.
- Avoid unnecessary database round trips and duplicate data fetching.
- Use appropriate caching without introducing stale governance-sensitive information.
- Measure meaningful performance changes rather than assuming an optimisation is beneficial.

### Zero-reload interactions

Voting (`ProposalBallot.tsx`), endorsing comments, and posting deliberation stances must update in place without unnecessary full-page reloads.

- Provide immediate feedback.
- Prevent duplicate submissions.
- Handle failed mutations and restore consistent state.
- Never imply a vote has been recorded before server confirmation.
- Refresh dependent information without disrupting unrelated page content.

### Avoid unnecessary complexity

Prefer the simplest maintainable implementation that satisfies the requirements.

- Do not introduce abstractions for hypothetical future needs.
- Do not retain obsolete compatibility layers without a documented reason.
- Remove dead code when safely replacing functionality.
- Avoid adding dependencies for functionality adequately supported by the existing stack.
- Do not silently increase operational complexity to solve a minor interface problem.

## 8. Git & Changelog Discipline

Every meaningful slice of work must be committed to Git using clear Conventional Commits.

### Atomic commits

Group related changes into logical commits:

- `feat(<scope>): <member/admin-facing capability>`
- `perf(<scope>): <measurable performance improvement>`
- `fix(<scope>): <bug or safeguard corrected>`
- `docs(<scope>): <documentation update>`
- `refactor(<scope>): <internal restructuring without behaviour changes>`
- `test(<scope>): <test coverage or verification improvement>`
- `chore(<scope>): <build, CI, or configuration update>`

Commit messages should describe meaningful outcomes, not merely files touched.

### Changelog requirements

The public `/changelog/` page (`src/pages/changelog/index.astro`) depends on the generated `src/data/changelog.json` snapshot.

- Run `npm run changelog` after meaningful commits and before final verification.
- Ensure the committed snapshot reflects the relevant project history.
- Include the updated snapshot in the final commit or amend it into the relevant change where appropriate.
- Avoid recursively regenerating the snapshot solely because a snapshot-only commit was created.
- Verify production builds work without `.git`.
- Never fabricate or manually misrepresent changelog history.

### Repository hygiene

- Never commit `.env`, credentials, secrets, or temporary artifacts.
- Do not stage unrelated changes.
- Inspect diffs before committing.
- Do not silently revert unrelated work.
- Keep commits reviewable and narrowly scoped.

## 9. Verification & Agent Accountability

Agents must verify their work rather than assuming implementation implies correctness.

### Required verification

For relevant changes:

- Run type checks, linting, tests, and build checks.
- Test critical success and failure paths.
- Inspect actual rendered pages where browser testing is available.
- Verify meaningful responsive breakpoints.
- Check console errors and failed requests.
- Confirm backend actions produce the intended persisted outcome.
- Review the final interface for verbosity, hierarchy, accessibility, and exposed implementation details.

Where visual inspection or end-to-end testing is unavailable, explicitly report that limitation. Do not claim verification that did not happen.

### Final report

Report concisely:

- What changed, in user-facing terms.
- What was tested and the results.
- Any unresolved problems or operational requirements.
- Commit references and deployment status, where relevant.

Do not use long implementation narratives as a substitute for verification.

## 10. Final Quality Gate

Before declaring work complete, answer:

**User experience**
- Is the next action obvious?
- Is the copy as concise as it can be without losing meaning?
- Does the interface hide irrelevant complexity?
- Can the user complete their task without understanding the implementation?

**Visual quality**
- Does it look and behave like part of Engage?
- Is the hierarchy clear?
- Is it usable on mobile?
- Are accessibility requirements met?

**Engineering**
- Does the workflow work end to end?
- Are errors, permissions, and edge cases handled?
- Are governance invariants preserved?
- Is obsolete or unnecessary code removed?
- Are verification, commits, and changelog complete?

**If the interface looks like something built for a developer to debug rather than a member or administrator to use, redesign it before calling the work finished.**