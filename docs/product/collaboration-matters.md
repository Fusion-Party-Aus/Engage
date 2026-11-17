# Public collaboration matters: stories and photographs

**Status:** Current · **Verified:** 17 November 2026 · **Issue:** [#143](https://github.com/Fusion-Party-Aus/Engage/issues/143)

A collaboration matter is a public invitation to contribute something to Fusion's work. The pilot asks people what Fusion means to them and invites photographs. A contributor needs no Engage account and no party membership, and nothing they send is published automatically.

This page records the model, the consent rules, the data handling and what is deliberately not built.

## What the pilot does

- `/collaborate/` lists open invitations. `/collaborate/<slug>/` is the invitation and the form.
- A guest can send story answers, up to three photographs, or both.
- A submitter chooses publication channels (website, social, email, print), whether to be named, whether ordinary edits are allowed, and separately whether AI-assisted photo edits are allowed. All channels may be left unselected, which means private consultation only.
- Every contribution lands in a private review queue at `/admin/collaboration/`. A reviewer records `new`, `needs follow-up`, `approved`, `declined` or `withdrawn`.
- Approval is not publication. Where an approved contribution is actually used is recorded separately, per permitted channel, with a reference.
- Approved material is handed to the website team by downloading a JSON export. There is no CMS integration yet.

An Engage account and Fusion party membership are separate things, and neither is required here. A contribution creates no account, no membership and no branch affiliation. A contributor who later creates an account is offered an optional next step, not a condition of contributing.

## Model decision: one type, capabilities not cases

`src/lib/matters.ts` registers one new type, `collaboration`. Every governance capability is false and its allowed stages are empty, so a collaboration matter cannot enter Propose, Deliberate, Decide or Implement, cannot be amended, balloted, ratified, superseded, or published as policy. `src/lib/collaboration-matter.test.ts` proves each refusal.

Consultation and collaboration are the same type in this model. The pilot invitation contains consultation questions and a collaboration contribution in the same form, and separating them into two types would duplicate one lifecycle without changing authority, eligibility or review. If a future workload needs a different authority or lifecycle, register that type then.

Shared with governance matters:

- the word "Matter" and the capability registry that says what a type may do;
- a public route with a stable slug;
- a private review step before anything becomes public.

Deliberately different:

- no `ProposalRecord`, no proposal revision, no ballot, no eligibility check, no seconding, no quorum;
- no membership record and no branch affiliation, so a contribution cannot be mistaken for a member ballot or a verified testimonial;
- contribution records live in their own collections and never appear in proposal or policy reads.

## Lifecycle

Invitation states, set by an editor:

| State | Public page | Accepts contributions |
|---|---|---|
| `open` | Renders the form | Yes |
| `paused` | Shows the closed notice | No |
| `closed` | Shows the closed notice | No |

Contribution states, set by a reviewer with `collaboration.review`:

`new` → `needs_follow_up` → `approved` or `declined`, and any state → `withdrawn`. Each change writes a `collaboration_events` row with the actor, from/to status, time and optional note. A contribution is never deleted by a status change; withdrawal keeps the record and the audit trail.

`needs_follow_up` writes a message intended for the contributor. Nothing is emailed automatically, so the reviewer sends it through the contact address the contributor supplied. The review screen says so.

## Consent

Consent version: `stories-2026-11-17`.

| Question | Default | Enforced |
|---|---|---|
| May we publish this? Website, social, email, print | None selected | Approval is refused when no channel is permitted |
| Credit: named or anonymous | Named | A named contribution needs a name; an anonymous one never stores the supplied name |
| Ordinary edits (crop, resize, colour) | Off | Stored and exported with the contribution |
| AI-assisted photo edits | Off | Requires ordinary edits; stored and exported; not applied by this application |
| May we reply? | Off | An email is required only when the answer is yes; it is never exported |
| Own work and permission | Required | The contributor attests that the story and photos are theirs and that anyone recognisable agreed; the photo field asks people not to send images of children |

Server-side enforcement lives in `submitContribution` and `reviewContribution` (`src/lib/collaboration.ts`). A client cannot widen its own permissions by editing the submitted form.

The attestation is a promise, not a check. Reviewers apply [story and photograph contribution safeguards](../guides/story-contribution-safeguards.md), which cover photographer credit, other identifiable people, minors, AI edits and mistaken publication.

## Data handling

Collections, all indexed at startup (`src/lib/db.ts`):

- `collaboration_initiatives`: slug, wording, questions, state, correction email.
- `collaboration_contributions`: answers, caption, name, optional contact email, consent scope, status, notes, media descriptors, version, consent version.
- `collaboration_media`: the image bytes, MIME type, SHA-256 and original filename.
- `collaboration_events`: the review audit trail.

Photographs:

- JPEG and PNG only, decided by file signature. The declared MIME type is ignored.
- Three files maximum, 5 MB each and 12 MB total. `Content-Length` is checked before the body is read.
- Metadata segments are removed before storage: EXIF, XMP and JPEG comments; PNG `tEXt`, `zTXt`, `iTXt` and `eXIf`. Pixels are not altered.
- Bytes are stored in a separate collection and are reachable only through `/api/admin/collaboration/media/<mediaId>`, which requires `collaboration.review`. There is no public image route.
- The list read never selects image bytes.
- Withdrawal deletes the story text, name, reply address and photographs immediately, keeping only the review record and its date. Declined material is cleared 90 days after the decision, and an approved reply address is cleared after 12 months. `npm run collaboration:retention` reports what is due and `--apply` performs it.

Abuse protection:

- durable fixed-window rate limit, 5 submissions per 10 minutes per hashed client address;
- Cloudflare Turnstile action `collaborate`, checked server-side;
- same-origin enforcement, a honeypot field, and an idempotent request reference that makes a retry safe;
- no raw IP address, no analytics event and no personal data in logs.

## Permissions

| Key | Scope | Granted to | Why |
|---|---|---|---|
| `collaboration.review` | National | National administrators and custom roles | Reads unpublished personal material and contact details |
| `collaboration.manage` | National | National administrators and custom roles | Changes the public invitation, its questions and its state |

Neither key is in the legacy Moderator set. A branch administrator has no access: the pilot is a national storytelling project, not branch casework.

## Configuration and code

An editor changes these without a deployment: title, summary, purpose, questions and hints, question order, the correction email, and the open/paused/closed state. Existing questions keep their keys when the wording changes, so earlier answers stay attached. Re-seeding is insert-only and cannot overwrite an edit.

These stay in code because changing them must pass review: the consent vocabulary, statuses, upload limits, permission keys, metadata stripping and the export shape.

## Operating the pilot

```sh
# Once per environment. Insert-only; safe to rerun.
npm run collaboration:seed
```

Then, in the admin panel: edit the invitation, review contributions, record uses, and download the approved export. Pause intake by setting the invitation to `paused` or `closed`.

## What is not built

- Claiming a contribution after creating an account. Contribution never requires one.
- A public gallery of approved stories or photographs.
- An approval step for a specific AI-edited derivative, and the production-image policy decision behind it. The application records permission; it does not perform or approve edits.
- Horizon CMS integration. Hand-off is a manual export.
- Funnel analytics from arrival to submission. No event is emitted today.
- Automated contributor email, including a withdrawal receipt.
- Approval of the safeguards draft: the minors rule, credit format, removal timeframes and retention periods. The privacy policy now describes this purpose (version 1.3) but remains owner-authorised and unreviewed, so it must not be published as legally cleared.

## Verification

- `src/lib/collaboration.test.ts`: guest submission without an account, consent and validation refusals, anonymity, idempotency, closed intake, reviewer-only access, approval boundaries, version conflicts, permitted-channel use recording, withdrawal, export minimisation, private media and question-key stability.
- `src/lib/collaboration-media.test.ts`: JPEG and PNG metadata stripping, signature sniffing, size limits, filename sanitising.
- `src/lib/collaboration-matter.test.ts`: the governance capability and stage refusals.
- Retention coverage in `src/lib/collaboration.test.ts`: withdrawal clears material at once, the sweep is dry by default and only clears past its window, and an approved reply address is cleared after a year.
- `src/lib/collaboration-mongo.test.ts`: real MongoDB coverage for unique references, version concurrency, BSON media round-trip and export isolation. Run with `VOTING_TEST_MONGODB_URI` set.
- Rendered check on 17 November 2026: desktop and 390 px mobile layouts, guest submission with a photograph returning 201, success copy, admin queue rendering the contribution and consent summary, invitation editor rendering, no console or request errors, no horizontal overflow, and the media route returning 401 without a reviewer session.
