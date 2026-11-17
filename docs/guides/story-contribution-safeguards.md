# Story and photograph contribution safeguards

**Status:** Draft for approval · **Written:** 17 November 2026 · **Issue:** [#143](https://github.com/Fusion-Party-Aus/Engage/issues/143)

These are the rules for accepting, reviewing, publishing and removing stories and photographs through a collaboration invitation. They are written for the pilot described in [public collaboration matters](../product/collaboration-matters.md).

This is an operational draft. It is not legal advice, and the items under "Decisions still needed" require an owner or legal decision before the invitation is promoted publicly.

## What the contributor is told

The form asks for one attestation before sending:

> This is my own story and my own photos, and I have the right to share them, including permission from anyone who can be recognised in a photo. I've read the privacy policy.

The photo field also says:

> If other people are recognisable, ask them first. Please don't send photos of children.

An attestation is a promise, not a check. The reviewer applies the rules below.

## Photographer credit and licensing

| Situation | Rule |
|---|---|
| Contributor took the photo | Accept. Credit as the contributor chooses: named or anonymous. |
| Contributor appears in a photo taken by someone else | Accept only with the photographer's permission, recorded in internal notes with who gave it and when. |
| Photo from a professional or agency shoot | Decline unless a licence covering Fusion's intended channels is recorded. A social-media repost is not a licence. |
| Photo found online, in a group chat or forwarded | Decline. |
| Photo includes a logo, artwork or performance | Decline unless the rights holder's permission is recorded. |

Credit follows the contributor's choice on the form. When named credit is chosen, use the name exactly as supplied. Do not add a title, branch or membership description the contributor did not choose.

## Other identifiable people

- A photograph is acceptable only when every person who can be recognised has agreed to Fusion using it in the channels the contributor selected.
- The contributor's attestation covers this. The reviewer asks for confirmation when the photo clearly shows other people, and records the answer in internal notes.
- Decline photographs of identifiable people in vulnerable or private settings: health care, support services, protests where identification could expose someone to harm, or anywhere the subject could not reasonably expect publication.
- Do not promise to blur or crop someone out. The application does not offer it, and a promise the process cannot keep is worse than a refusal.
- Public figures at public events are treated like anyone else. Publication still needs the contributor's rights and the subject's reasonable expectation considered.

## Minors

Proposed rule, awaiting approval:

- Do not accept photographs of anyone under 18, including a contributor's own children, beyond a photo where the minor is not identifiable (for example, a distant crowd).
- Do not accept a story that identifies a minor without a parent or guardian's consent, recorded in internal notes.
- A guardian may contribute on a minor's behalf. Record the relationship and consent. Do not name the minor in public copy.
- If a submitted photo might show a minor and the reviewer is unsure, decline and ask. Do not guess.

## Reviewer checklist

Before approving, confirm:

1. The contributor supplied the material and holds the rights described above.
2. Every recognisable person has agreed, or the material is declined.
3. No minor is identifiable unless the guardian rule is satisfied.
4. The selected channels, credit choice, ordinary-edit permission and AI-edit permission match the intended use.
5. The caption and answers are the contributor's, not rewritten into a testimonial.
6. The contribution is not presented as proof of party membership, endorsement or a policy position.
7. Photos have no remaining location or device metadata. The application strips it on upload; do not re-attach an original.
8. The contact address, if given, is used only to discuss this contribution.
9. Nothing in the material needs a correction before publication.

## AI-assisted edits

Permission for AI-assisted edits is off by default and separate from ordinary editing.

- Never generate a person, an event, attendance or an endorsement.
- An edit may add Fusion branding or adjust presentation. It must not change what the photograph shows.
- Keep the original and the derivative distinguishable. Record which file was approved.
- Show the derivative to the contributor and get approval before any public use, when a reply address exists. If there is no reply address, do not use an AI-assisted derivative.
- Mark an AI-assisted derivative in internal notes and in the hand-off export record.

## Publishing and recording use

- Use approved material only in the channels the contributor selected. The review screen refuses any other channel.
- Record where it was used, with a page address, campaign or issue reference.
- Do not re-edit beyond the permission recorded.
- Do not add a quote, caption or framing the contributor did not supply.
- The hand-off export excludes reply addresses and internal notes. Do not add them to a public page or a content system.

## Withdrawal, correction and retention

Implemented:

- Marking a contribution `withdrawn` deletes the story text, name, reply address and photographs immediately. The review record and its date remain.
- Declined material is cleared 90 days after the decision.
- An approved contribution's reply address is cleared after 12 months. The story stays while it may be in use.
- `npm run collaboration:retention` reports what would be cleared. `--apply` performs it. Run it monthly and record the output.

Operational commitments, requiring approval:

- A correction or removal request sent to the invitation's correction address is actioned within 5 working days.
- If material was published in error, remove it from the live site within 1 business day, tell the contributor, and record what happened.
- Approved material still in use is reviewed annually, and removed when it is no longer used.

## Decisions still needed

1. Approve or amend the minors rule above.
2. Approve the credit format and whether credit must appear beside the image or at the end of a page.
3. Approve the removal and mistaken-publication timeframes.
4. Confirm the retention periods in code (`RETENTION` in `src/lib/collaboration.ts`).
5. Complete legal review of the privacy policy text added in version 1.3 for this purpose.
6. Decide whether a signed-in member contributing a story needs a separate notice or consent step.
7. Confirm who owns the monthly retention sweep and where its output is recorded.

## Where the rules are enforced

| Rule | Enforcement |
|---|---|
| No publication without channel consent | `reviewContribution`, `approval` branch |
| Private-only contributions cannot be approved | `reviewContribution` |
| Anonymous contributions store no name | `submitContribution` |
| Metadata removed before storage | `prepareImage`, `src/lib/collaboration-media.ts` |
| Media readable only by a reviewer | `readContributionMedia` and the admin media route |
| Withdrawal deletes material | `reviewContribution` calls `clearContributionContent` |
| Retention sweep | `purgeExpiredContent`, `scripts/collaboration-retention.ts` |
| Export omits contact and notes | `exportApproved` |
