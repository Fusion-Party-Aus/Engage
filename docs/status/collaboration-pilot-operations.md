# Collaboration pilot operations

**Status:** Needs assignment · **Written:** 17 November 2026 · **Issue:** [#143](https://github.com/Fusion-Party-Aus/Engage/issues/143)

The correction inbox, escalation path and monthly retention sweep are only real if someone is responsible for them. Fill this page in before the invitation is promoted publicly. Do not assume the person who built Engage holds these roles.

| Responsibility | Requirement | Assigned to |
|---|---|---|
| Primary owner | Monitors the correction inbox on business days and acknowledges requests within 1 business day | **Unassigned** |
| Backup | A different person with access and authority to act when the owner is unavailable | **Unassigned** |
| Escalation | Handles disputed consent, suspected unauthorised publication and requests that miss the 5-day target | **Unassigned** |
| Retention sweep operator | Runs `npm run collaboration:retention` monthly, applies it, and records the output | **Unassigned** |
| Horizon feed check | Runs `npm run horizon:smoke` before launch and whenever the feed contract changes | **Unassigned** |
| Legal/privacy contact | Owns review and approval of privacy policy 1.4 and the safeguards | **Unassigned** |

## What the owner does

- Acknowledge every correction or removal request within 1 business day.
- Hide disputed material from the gallery no later than 1 business day after the request. Prefer hiding over withdrawal while facts are checked.
- Complete the review and resolve the request within 5 business days.
- Remove Fusion-controlled copies elsewhere within 5 business days where technically possible.
- Start takedown requests for material already distributed outside Engage, and explain plainly what cannot be recalled.
- Record the date, the action and the outcome. A reviewer can find a contribution by its short reference in the queue search.

## What the sweep operator does

- Run `npm run collaboration:retention` without flags, read what it would clear, then run it with `--apply`.
- Record the date, the counts and any failure in the pilot's operating log.
- Escalate a failed sweep rather than retrying blindly.
