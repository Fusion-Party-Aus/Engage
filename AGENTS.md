# Engage — Agent & Maintainer Engineering Rules

## 1. Git & Changelog Discipline (Mandatory for All Agents)

Every meaningful slice of work MUST be committed to `git` using clear **Conventional Commits** so that the public `/changelog/` page (`src/pages/changelog/index.astro`) and `src/data/changelog.json` stay accurate and up to date.

### Commit Workflow
1. **Commit atomic units of work**: Do not leave large uncommitted changes across multiple subsystems at the end of a session. Group related changes into logical commits:
   - `feat(<scope>): <plain-language summary of what members/admins can now do>`
   - `perf(<scope>): <plain-language summary of latency or rendering improvement>`
   - `fix(<scope>): <plain-language summary of bug or governance safeguard fix>`
   - `docs(<scope>): <documentation, runbook, or walkthrough update>`
   - `chore(<scope>): <build, CI, or configuration update>`
2. **Regenerate the changelog snapshot before building or finishing**:
   - Run `npm run changelog` (or `npm run build`, which runs `scripts/generate-changelog.mjs` automatically) and include `src/data/changelog.json` in the commit so Docker production builds without `.git` still display the latest commit history on `/changelog/`.
3. **Never commit secrets or scratch files**:
   - Never stage `.env`, credentials, or temporary test artifacts.

## 2. Governance & Security Invariants
- Never alter ballot eligibility, voting semantics, revision binding, policy authority, or server-side permissions without an explicit governance specification.
- Never confuse deliberative discussion stances (`support`, `concern`, `amendment`, `comment`) with formal member ballots (`approve`, `abstain`, `reject`).
- Keep identifiable ballot choices restricted to the authorised boundary (`canViewIdentifiableBallots`).

## 3. Performance & UX Standards
- **Immediate Next Action**: Every proposal page (`/proposals/[slug]/`) must display the user's immediate next action and estimated time in the hero banner.
- **Parallel Queries & Caching**: Run independent MongoDB queries via `Promise.all(...)`, project only required fields on list queries, and avoid redundant `listProposals` calls within the same request.
- **Zero-Reload Micro-Interactions**: Voting (`ProposalBallot.tsx`), endorsing comments, and posting deliberation stances must update the UI in place without forcing full-page reloads.
