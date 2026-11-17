# Story and photograph contribution safeguards

**Status:** Draft for approval · **Written:** 17 November 2026 · **Issue:** [#143](https://github.com/Fusion-Party-Aus/Engage/issues/143)

These are the rules for accepting, reviewing, publishing and removing contributions through a collaboration invitation. An invitation is created with one of two profiles: story with photographs, or written responses. The photo, credit and edit rules below apply to the story profile only; a written-response invitation records no name, photographs or edit permission. They are written for the pilot described in [public collaboration matters](../product/collaboration-matters.md).

This is an operational draft. It is not legal advice, and the items under "Decisions still needed" require an owner or legal decision before the invitation is promoted publicly.

## What the contributor is told

The form asks for two attestations before sending:

> I'm 18 or over.
>
> This is my own story and my own photos, I have the right to share them, and I have permission from anyone who can be recognised in a photo. I've read the privacy policy.

The photo field adds: "If other people are recognisable, ask them first. Photographs must not show identifiable children."

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

Pilot rule, adopted 17 November 2026:

- Contributors must be 18 or over. The form asks for a simple attestation, with no date of birth and no identity documents.
- Do not publish photographs containing an identifiable child, even with a parent or guardian's permission.
- A photograph is acceptable only when any children in it are genuinely unidentifiable and no contextual clue identifies them.
- Adults may discuss parenting or family life, but do not publish identifying details about a child.
- Do not accept a submission made on behalf of a child during this pilot.
- When uncertain, hold the photograph for clarification or decline it.

This is a Fusion editorial safeguard, not a claim about Australian law. A minor's capacity to consent is not settled by a universal age.

## Reviewer checklist

Before approving, confirm:

1. The contributor supplied the material and holds the rights described above.
2. Every recognisable person has agreed, or the material is declined.
3. No child is identifiable at all. There is no guardian exception in this pilot.
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

## The public gallery

Approving a story does not publish it. An approved story appears on the invitation's public gallery only after a reviewer presses "Publish to gallery", and only when the contributor allowed the website channel. Credit follows their choice; "no name" means no name is stored or printed, though a photograph may still identify them. Hide a story from the gallery if a question arises, rather than withdrawing it, when the material may still be used elsewhere. Hiding and restoring are reviewer actions with an audit trail. Written consultation responses are never published individually.

## Publishing and recording use

- Use approved material only in the channels the contributor selected. The review screen refuses any other channel.
- Record where it was used, with a page address, campaign or issue reference.
- Do not re-edit beyond the permission recorded.
- Do not add a quote, caption or framing the contributor did not supply.
- The hand-off export and the authenticated Horizon feed exclude reply addresses and internal notes. Do not add them to a public page or a content system. The feed mirrors the gallery, so hiding a story removes it from the next poll as well.

## Withdrawal, correction and retention

Implemented:

- Marking a contribution `withdrawn` deletes the story text, name, reply address and photographs immediately. The review record and its date remain.
- A contributor can do the same from their private link, without an account. Linking the contribution to a signed-in account is optional and does not transfer management authority; the private link remains the only way to correct or withdraw it.
- Declined material is cleared 90 days after the decision.
- An approved contribution's reply address is cleared after 12 months. The story stays while it may be in use.
- `npm run collaboration:retention` reports what would be cleared. `--apply` performs it. Run it monthly and record the output.

Removal commitments, adopted 17 November 2026:

| Action | Commitment |
|---|---|
| Acknowledge a correction or removal request | Within 1 business day |
| Hide disputed material from Engage | As soon as practicable, no later than 1 business day |
| Remove material published in error | Immediately on discovery where possible |
| Complete the review and resolve the request | Within 5 business days |
| Remove Fusion-controlled copies elsewhere | Within 5 business days where technically possible |
| Material already distributed outside Engage | Start takedown requests and explain the limits |

Hiding is quick and reversible. Permanent withdrawal and deletion follow verification, and cannot recall a copy someone already downloaded, reposted or printed. Never promise more than that.

The commitments only hold if someone owns the inbox. The correction address needs a named owner, a named backup, an escalation path and a named retention-sweep operator. Record all four in [collaboration pilot operations](../status/collaboration-pilot-operations.md). They are currently unassigned.

## Decisions still needed

1. Approve the credit format and whether credit must appear beside the image or at the end of a page.
2. Confirm the retention periods in code (`RETENTION` in `src/lib/collaboration.ts`).
3. Complete legal review of the privacy policy text added for this purpose (version 1.4).
4. Decide whether a signed-in member contributing a story needs a separate notice or consent step.
5. Name the owner and backup for the correction inbox, and confirm who runs the monthly retention sweep and where its output is recorded.
6. Approve a way to describe individual photographs, if reviewers find the single caption too coarse.

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
