# Contributing

**Status:** Current · **Verified:** 13 November 2026

`AGENTS.md` is the normative rulebook for this repository. This page explains how to apply it to common changes. If they conflict, `AGENTS.md` wins.

## Before you change anything

1. Read [product/overview.md](../product/overview.md) and [domain/governance-model.md](../domain/governance-model.md).
2. Find the behaviour in code. Do not trust an old document or a UI label.
3. Decide which authority your change touches: participation, membership, administration, governance or publication.
4. Check whether the change alters a protected act. If it does, stop and obtain an explicit governance specification.

## Repository conventions

- TypeScript with explicit `.ts` / `.tsx` imports.
- Astro pages for routing and SSR; React islands for interaction.
- No new framework, state manager, ORM or schema library without a decision record.
- Use `runtimeEnv(locals)`, not `process.env`, in request paths.
- Use `src/components/ui` primitives. Raw `<button>`, `<input>`, `<select>`, `<textarea>`, `<table>` and `<dialog>` are defects unless explicitly excluded by `AGENTS.md`.
- Use Horizon semantic tokens. No arbitrary Tailwind palette utilities or undefined CSS variables.
- Australian English in user-facing copy and documentation.
- Write for members and officers, not for developers. No raw JSON, stack traces, permission keys or collection names in ordinary admin screens.

### The raw-control audit

Run before finishing:

```sh
rg -n '<(button|select|input|textarea|table|dialog)\b' <changed-files>
```

Acceptable matches are `type="hidden"` inputs and the primitive implementations in `src/components/ui`. Everything else must be replaced or explicitly justified.

## Change protocol

### A normal feature

1. **Define the user task.** Who is doing what, and what tells them it worked?
2. **Find the domain owner.** Most rules belong in `src/lib`, not in a page.
3. **Change the smallest surface.** Do not refactor unrelated modules in the same commit.
4. **Enforce server-side.** UI visibility is not authorisation.
5. **Write the record.** If the act is consequential, write an audit event.
6. **Test failure paths.** Unauthorised, invalid, empty, duplicate and closed states.
7. **Verify the rendered interface.**
8. **Commit atomically** with a Conventional Commit.
9. **Regenerate and commit the changelog** for meaningful work.

### A governance change

This is not a normal feature. Before code:

- Identify the rule source: a Fusion decision, an existing documented product rule, or a bug.
- State the eligibility, electorate, authority, record and failure behaviour.
- Confirm the change does not silently reinterpret existing votes or revisions.
- Confirm resolutions remain excluded from policy publication.
- Confirm identifiable ballots remain restricted.
- Add tests that prove the old behaviour is intentionally replaced.

If the rule is not supplied, document the gap rather than guessing. `docs/engage-product-direction-governance-audit-2026-11-07.md` lists the open decisions.

### A schema or persistence change

- Update `initializeDatabase()` indexes.
- Add a restartable migration if existing data must change.
- Test against real MongoDB, including uniqueness and transactions.
- Never rewrite votes, revisions, results or publication events in place.
- Ensure the app can run during a rolling migration, or document the downtime.

### An API change

- Add or extend an allowlist DTO in `api-contracts.ts`.
- Apply `requireApiPermission` or a domain-specific helper.
- Validate input explicitly.
- Return a human-readable error with the right status.
- Add contract and authorisation tests.
- Update [architecture/api-and-authorisation.md](../architecture/api-and-authorisation.md).

## UI work

Follow `AGENTS.md` §1–§5 and `DESIGN.md`.

- Lead with the task and the next action.
- Use progressive disclosure; do not dump every field or state.
- Do not wrap a single metric in a large card with explanatory prose.
- Handle loading, empty, error, success and unauthorised states.
- Preserve user input on failure.
- Prevent duplicate submissions.
- Support keyboard and visible focus.
- Test mobile, not just desktop.
- Never rely on colour alone.

Copy examples:

| Avoid | Prefer |
|---|---|
| "Manage your notification preferences and customise how you receive updates" | "Notifications" |
| "There are currently no proposals available for you to vote on" | "You're up to date" |
| "An error occurred while processing your request" | "Couldn't save changes. Try again." |

## Testing

```sh
pnpm check
pnpm test
pnpm build
```

Add tests for:

- the new success path;
- the unauthorised caller;
- the invalid input;
- the relevant domain failure (closed ballot, stale revision, cross-branch actor);
- a regression that would have caught the original bug.

Use real MongoDB for persistence, uniqueness and transaction behaviour. The in-memory driver does not enforce indexes or projections.

For browser journeys, inspect the actual page. Do not infer visual correctness from component tests.

## Git and changelog

Use Conventional Commits that describe the outcome:

```
feat(ballots): bind amendments to the proposal ballot revision
fix(branches): prevent cross-branch membership edits
perf(proposals): project list fields and parallelise queries
docs(governance): document the five authorities
```

- Keep commits atomic and reviewable.
- Do not stage unrelated work.
- Do not commit `.env`, secrets or generated artefacts other than the changelog snapshot.
- Run `pnpm changelog` after meaningful commits and include the snapshot.

## Documentation

A behaviour change updates its canonical page:

| Change | Update |
|---|---|
| Product scope or user journey | `docs/product/overview.md` |
| Ecosystem or integration | `docs/product/ecosystem.md` |
| Domain concept | `docs/domain/domain-model.md` |
| Eligibility, authority or permissions | `docs/domain/governance-model.md` |
| Stage, act or transition | `docs/domain/governance-lifecycle.md` |
| Layer, route or dependency | `docs/architecture/overview.md` |
| Collection, index or migration | `docs/architecture/data-and-persistence.md` |
| Endpoint or DTO | `docs/architecture/api-and-authorisation.md` |
| Email, push, PWA or cron | `docs/architecture/notifications-and-jobs.md` |
| Build, env or deployment | `docs/architecture/build-deploy-operations.md` |
| Shipped status | `docs/status/capability-matrix.md` |
| New defect or decision | `docs/status/known-gaps.md` |

## Review checklist

**Product**

- Is the next action obvious?
- Is the copy concise and accurate?
- Can a member complete the task without understanding the implementation?
- Is planned functionality labelled as planned?

**Governance**

- Are eligibility and authority still separate?
- Does an administrator gain no vote?
- Does a branch actor stay inside the branch?
- Is the exact wording still bound to the ballot?
- Are results and publication still separate, recorded acts?
- Is history preserved?

**Engineering**

- Is authorisation enforced on the server and in the service?
- Are failure and empty states handled?
- Is the DTO an allowlist?
- Are indexes and migrations safe?
- Are tests meaningful against real MongoDB where required?
- Are raw controls absent and Horizon tokens used?

**Delivery**

- Is the commit atomic?
- Is the changelog snapshot updated?
- Is the documentation updated?
- Is the verification evidence real, and are its limits stated?
