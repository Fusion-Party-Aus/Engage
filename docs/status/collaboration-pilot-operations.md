# Collaboration pilot operations

**Status:** Configured in Engage · **Verified:** 17 November 2026 · **Issue:** [#143](https://github.com/Fusion-Party-Aus/Engage/issues/143)

The correction inbox, escalation path and monthly retention sweep are only real if someone is responsible for them. Those assignments are an Engage setting, not a document and not a deployment value.

## Where to set them

`/admin/collaboration/operations/`, available to anyone holding `collaboration.manage`.

| Field | Meaning |
|---|---|
| Primary owner | Monitors the correction address and acknowledges requests within 1 business day |
| Backup owner | A different person with access and authority to act when the primary is unavailable |
| Retention sweep owner | Runs the monthly retention sweep and records its output |
| Correction and removal address | The public address shown on invitations; the primary owner monitors it |
| Escalation details | Who handles disputed consent, suspected unauthorised publication and requests that miss the 5-day target |

The record is stored in `collaboration_operations`. Every save writes a `collaboration_operation_events` audit entry with the actor, the changed fields and the before/after values. Changing personnel needs no deployment. The page shows whether the roster is fully assigned and the last five changes.

The legal/privacy review is a separate obligation and is not one of these fields. Track it with the release owner.

## What the primary owner does

- Acknowledge every correction or removal request within 1 business day.
- Hide disputed material from the gallery no later than 1 business day after the request. Prefer hiding over withdrawal while facts are checked.
- Complete the review and resolve the request within 5 business days.
- Remove Fusion-controlled copies elsewhere within 5 business days where technically possible.
- Start takedown requests for material already distributed outside Engage, and explain plainly what cannot be recalled.
- Record the date, the action and the outcome. A reviewer can find a contribution by its short reference in the queue search.

## What the backup does

- Has the same access and authority as the primary.
- Covers leave, illness and busy periods, and checks the inbox when the primary is unavailable.
- Takes over if the primary leaves the role, until the roster is updated.

## What the escalation contact does

- Handles disputed consent and suspected unauthorised publication.
- Acts on requests that have missed the 5-day target.
- Decides when a hide becomes a withdrawal, with the primary owner.

## What the retention sweep owner does

- Run `npm run collaboration:retention` without flags, read what it would clear, then run it with `--apply`.
- Record the date, the counts and any failure where the team will see it.
- Escalate a failed sweep rather than retrying blindly.

## Until the roster is assigned

A new record starts unassigned and the page says so. Saving requires all three people and a correction address, so a partial roster cannot be written. Public promotion of the invitation remains gated until all three people and a correction address are set. Do not assume the person who built Engage holds these roles.
