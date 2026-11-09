# Proposal discovery and voting

## Investigation and design

The original hero held the summary, commitments occupied individual bordered cards in the main column, and the ballot lived in a separate rail. On mobile the entire main column, including discussion and history, preceded that rail. Ballot progression was available only after saving a vote. Discovery had lifecycle tabs, a duplicate stage dropdown, shortcut chips and three large ranking panels ahead of the list.

The canonical introduction remains beneath the title. Commitments and accessible full rationale share the reading column; the contextual ballot rail repeats the canonical summary at the decision. Mobile DOM order is reading content, ballot, then amendments/discussion/history. Full rationale, amendments, discussion, history and privacy information remain available. Wording metadata is under “Ballot record”. The existing immutable revision and server permission rules are unchanged.

Lifecycle tabs are separate from visible personal filters, with existing discovery rankings under Explore. Explicit `focus=all` survives stage navigation and GET form submissions. Voting defaults to outstanding eligible ballots only when no explicit focus exists. Search, topic, branch and participation filters feed the same count dataset; the Voting stage shows open, revision-bound ballots. Joined discussions use actual member contributions. Outstanding decisions reuse the already authorised proposal list and retain canonical branch/revision/deadline checks.

## Verification

- `npm test`: 170 passed, 15 skipped (optional integration coverage).
- `npm run check`: zero errors and warnings; existing hints remain.
- `npm run build`: passed, including an exported source tree without `.git`. No separate lint script is configured.
- Isolated Chrome, 1440×1000 and 390×844: save, revisit and update a vote; server-confirmed persisted choices; skip without recording a vote; retry after a simulated server failure while preserving choice; completion after all eligible ballots; explicit opt-out through lifecycle tabs and browser back/forward; no matching search results; no horizontal overflow or uncaught browser errors.
- Existing branch participation tests pass, including equivalence of outstanding counts when reusing discovery data. Branch permutations are covered by automated tests rather than authenticated screenshots of real members.
- Screenshots use synthetic preview accounts and in-memory data, with 23 ballots opened through the administration API. Desktop and mobile runs use successive outstanding proposals; dates and counts reflect the capture session. Baseline: `50a7710`. Revised implementation screenshots replace the rejected PR captures; original before captures remain unchanged. Screenshots are in `docs/screenshots/proposal-experience/`.
- The final after captures hide the Astro developer toolbar. Decision-area captures include the full region so sticky navigation does not obscure the summary.

## Reproduce browser checks

Start fresh isolated previews on ports 4396 (baseline) and 4397 (current), using `APP_MODE=preview`, an empty `MONGODB_URI`, and matching local `PUBLIC_ORIGIN`/`BETTER_AUTH_URL`. Install Playwright outside the application. Run:

```sh
ENGAGE_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
CHROME_EXECUTABLE=/absolute/path/to/chrome \
node scripts/proposal-experience-browser.mjs
```

Use `AFTER_ONLY=1` to capture just the current version. The script opens 23 ballots and changes synthetic votes: use only fresh in-memory previews. It does not connect to production. Keyboard focus/radio semantics are retained, but no claim of a full assistive-technology or WCAG audit is made.

The approved reset restores Voting preferences from a scoped cookie: explicit URL > restored Voting choice > default. Lifecycle links clear vote-only parameters. Next/skip opens the next proposal at its introduction. Share and Join discussion are restored. Context is visible by default so ordinary scrolling also presents the summary at the ballot. Tall-screen desktop layouts keep the rail sticky; shorter viewports scroll naturally so no controls become trapped.
