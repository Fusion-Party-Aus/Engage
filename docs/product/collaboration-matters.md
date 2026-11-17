# Public collaboration matters: stories and photographs

**Status:** Current · **Verified:** 17 November 2026 · **Issue:** [#143](https://github.com/Fusion-Party-Aus/Engage/issues/143)

A collaboration matter is a public invitation to contribute something to Fusion's work. The pilot asks people what Fusion means to them and invites photographs. A contributor needs no Engage account and no party membership, and nothing they send is published automatically.

This page records the model, the consent rules, the data handling and what is deliberately not built.

## What the pilot does

- `/collaborate/` lists open invitations. `/collaborate/<slug>/` is the invitation and the form.
- Editors create and manage any number of invitations at `/admin/collaboration/invitation/`. An invitation is created as a private draft and has no public page until it is opened.
- Each invitation has one reviewed contribution profile, chosen at creation: **story with photographs** or **written responses**. A written-response invitation never asks for photos, a name, or edit permission, and the server rejects photos sent to it. This keeps photography consent out of a future station or policy consultation without a form builder.
- A guest can send story answers, up to three photographs, or both.
- A submitter chooses publication channels (website, social, email, print), whether to be named, whether ordinary edits are allowed, and separately whether AI-assisted photo edits are allowed. All channels may be left unselected, which means private consultation only.
- Every contribution lands in a private review queue at `/admin/collaboration/`. A reviewer records `new`, `needs follow-up`, `approved`, `declined` or `withdrawn`.
- Approval is not publication. Where an approved contribution is actually used is recorded separately, per permitted channel, with a reference.
- An approved story with website consent can be **published** to a public gallery at `/collaborate/<slug>/stories/`. Approval and publication are separate: approving for editorial use never makes a story public. A reviewer can hide a published story, or show it again, without changing its approval.
- A contributor keeps a private link to correct, hide or withdraw their own contribution without an account. If they are signed in, they can optionally link the contribution to their Engage account.
- Approved material is also handed to the website team by downloading a JSON export. There is no CMS integration yet.

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
| `draft` | None (404) | No |
| `open` | Renders the form | Yes |
| `paused` | Shows the closed notice | No |
| `closed` | Shows the closed notice | No |
| `archived` | None (404); retained for records | No |

Creating an invitation and opening it are separate decisions: creation always produces a draft. An archived invitation can be restored, which clears `archivedAt`. Contributions belong to the invitation that accepted them and are never moved or merged.

Contribution states, set by a reviewer with `collaboration.review`:

`new` → `needs_follow_up` → `approved` or `declined`, and any state → `withdrawn`. An approved story can be hidden from or returned to the public gallery without changing its status. Each change writes a `collaboration_events` row with the actor, from/to status, time and optional note. A contribution is never deleted by a status change; withdrawal keeps the record and the audit trail.

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

## The contributor's own link

On success the contributor receives a link of the form `/collaborate/manage/#<token>`. The token is the only authority: no account is needed, and it reaches no other contribution.

- The token is derived from the submission's request reference and a deployment signing secret, but it is returned only in the response that creates the contribution. Replaying an existing submission returns no token: identical content is not proof of ownership. If the first response is lost, the contributor uses the correction address instead. Rotating `RATE_LIMIT_SECRET`, `BETTER_AUTH_SECRET` or `SESSION_SECRET` invalidates every outstanding management link; contributors must then use the correction address. Coordinate rotation with the operations owner.
- Only a SHA-256 hash of the token is stored. The raw token appears once, in the URL fragment, so it is never sent to the server in a URL, logged, or leaked through a referrer.
- Opening the link shows what they sent, its status, whether it is public, and a masked reply address.
- **Save corrections** updates the words and caption, returns the contribution to `needs_follow_up`, and removes it from the gallery until a reviewer approves and publishes it again.
- **Remove from public gallery** hides a published story without changing its approval.
- **Withdraw completely** deletes the stored words, name, reply address and photographs immediately and records the contributor's action in the audit trail. The link stops working.
- A lost link can only be recovered by emailing the invitation's correction address. There is no name or email lookup, because that would let one person reach another's contribution.

## Optional account link

A signed-in member who holds a contribution's private link can choose to link it to their Engage account. This is never a condition of contributing and never a condition of managing the contribution.

- The link is offered only after the token proves access. The member must tick an explicit consent box.
- Stored: the member identifier, the time and the consent version (`claim-2026-11-17`). An audit event records the link.
- Claiming changes neither publication nor approval, and creates no administrative permission. The private link remains the only authority to correct or withdraw.
- The contributor can unlink from the same page; that is audited too.
- A contribution can be linked to one account. A second account is refused.
- A linked story appears on the member's public profile at `/members/<id>/` only while it is public in the gallery. Hiding or withdrawing it removes it from the profile at the same time. Unpublished or unapproved linked material never appears, and the profile shows the same excerpt and credit the gallery shows.

## Operational ownership

The people responsible for corrections, continuity and the retention sweep are an administrator setting at `/admin/collaboration/operations/`, not a deployment value or a document.

- Fields: primary owner, backup owner, retention sweep owner, default correction address and escalation details.
- Only `collaboration.manage` can change them. Saves are versioned so two administrators cannot overwrite each other, and the settings write and its audit event commit together.
- The page distinguishes **assigned** from **ready**: an owner must be active, verified and hold `collaboration.review`. Assigning someone does not grant that permission.
- Public promotion stays gated until the roster is assigned and ready.
- Changing personnel needs no deployment.

### One correction address model

The operations setting holds the default correction address. An invitation may set an explicit override; leaving its field blank inherits the default. Public invitations show the resolved address, never a third fallback. A new invitation starts without an override, so changing the default takes effect everywhere that has not opted out.

## Aggregate interest counts

Each invitation records four events so an editor can see where people stop:

| Stage | When it is counted | Recorded by |
|---|---|---|
| Arrival | The invitation page loads in a browser that runs scripts | Browser |
| Started | First interaction with a form field | Browser |
| Sent | A contribution is accepted | Server |
| Opened account creation | The optional account step is opened from the success screen | Browser |

A row holds the invitation, a UTC day, the stage, a count and an expiry. Nothing else. There is no cookie, session, IP address, identifier or typed content, so the numbers measure events, not unique people, and cannot be linked to anyone. Rows expire after about 13 months, and the public event endpoint is rate limited to 30 events a minute per hashed address.

The invitation editor shows the last 30 days: arrivals, starts, sends, account steps, and three ratios. The ratios are events divided by events, not unique-visitor conversion, so they can exceed 100% when a client event is missed or repeated. The panel labels them "of arrivals" and "of starts" rather than as visitor rates. Treat them as a rough drop-off signal: script blockers and bots mean arrivals are undercounted and occasionally inflated, and an account step is not a registration.

## Data handling

Collections, all indexed at startup (`src/lib/db.ts`):

- `collaboration_initiatives`: slug, wording, questions, state, correction email.
- `collaboration_contributions`: answers, caption, name, optional contact email, consent scope, status, notes, media descriptors, version, consent version.
- `collaboration_media`: the image bytes, MIME type, SHA-256 and original filename.
- `collaboration_events`: the review audit trail.
- `collaboration_funnel`: aggregate counts per invitation, day and stage, with a TTL.

Photographs:

- JPEG and PNG only, decided by file signature. The declared MIME type is ignored.
- Three files maximum, 5 MB each and 12 MB total. `Content-Length` is checked before the body is read.
- Metadata segments are removed before storage: EXIF, XMP and JPEG comments; PNG `tEXt`, `zTXt`, `iTXt` and `eXIf`. Pixels are not altered.
- Bytes are stored in a separate collection. Reviewers read them through `/api/admin/collaboration/media/<mediaId>`, which requires `collaboration.review`. A published story's photographs are also served from `/api/collaboration/media/<mediaId>`, which re-checks approval, explicit publication, website consent, profile and hidden state on every request and is not cached.
- The list read never selects image bytes.
- The public gallery route re-checks approval, website consent, profile and hidden state on every request, so no published copy survives withdrawal.
- Withdrawal by a reviewer or by the contributor's own link deletes the stored story text, name, reply address and photographs immediately, keeping only the review record and its date.
- Reply-address retention runs from the approval date (`approvedAt`), not from the last time a reviewer touched the record. Legacy approved records without it fall back to their last update once. It cannot recall a copy someone downloaded, screenshotted, reposted or printed before the withdrawal; the safeguards describe how those are chased.
- Declined material is cleared 90 days after the decision, and an approved reply address is cleared after 12 months. `npm run collaboration:retention` reports what is due and `--apply` performs it.

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

An editor changes these without a deployment: creating invitations, the contribution profile at creation, title, summary, purpose, questions and hints, question order, the correction email, and the draft/open/paused/closed/archived state. Existing questions keep their keys when the wording changes, so earlier answers stay attached. Re-seeding is insert-only and cannot overwrite an edit.

These stay in code because changing them must pass review: the consent vocabulary, statuses, upload limits, permission keys, metadata stripping and the export shape.

## Operating the pilot

Create an invitation at `/admin/collaboration/invitation/new/`, add or edit its questions, then set it to `open` when the wording is ready. The seeded pilot invitation is a bootstrap only:

```sh
# Optional: create the pilot invitation if it does not exist. Insert-only.
npm run collaboration:seed
```

Review contributions at `/admin/collaboration/`, record uses, and download the approved export. Pause intake by setting the invitation to `paused` or `closed`; retire it with `archived`.

## What is not built

- An approval step for a specific AI-edited derivative, and the production-image policy decision behind it. The application records permission; it does not perform or approve edits.
- External publication synchronisation beyond the JSON export. Corrections, hiding and withdrawal do not propagate to another system; this is tracked in #157.
- Automated contributor email, including a withdrawal receipt.
- A credit-format decision: beside the image or at the end of a page, and whether one caption per photo set is enough.
- Legal/privacy approval of version 1.6. The minors rule and removal timeframes were adopted on 17 November 2026, but the policy remains owner-authorised and unreviewed.

## Verification

- `src/lib/collaboration.test.ts`: guest submission without an account, consent and validation refusals, anonymity, idempotency, closed intake, reviewer-only access, approval boundaries, version conflicts, permitted-channel use recording, withdrawal, export minimisation, private media and question-key stability. It also covers invitation creation, unique addresses, draft privacy, open/pause/archive/restore, per-invitation counts, reference search, profile isolation, terminal states, accepted private input, repeated placements on one channel, preserved review notes, question snapshots and stale-answer refusal.
- `src/lib/collaboration-media.test.ts`: JPEG and PNG metadata stripping, signature sniffing, size limits, filename sanitising.
- `src/lib/collaboration-matter.test.ts`: the governance capability and stage refusals.
- Retention coverage in `src/lib/collaboration.test.ts`: withdrawal clears material at once, the sweep is dry by default and only clears past its window, and an approved reply address is cleared after a year.
- `src/lib/collaboration-mongo.test.ts`: real MongoDB coverage for unique references, version concurrency, BSON media round-trip and export isolation. Run with `VOTING_TEST_MONGODB_URI` set.
- Rendered journeys on 17 November 2026, in a production build against MongoDB: a guest submits a story with a photograph (201) and sees the success screen with a reference; a private-only response is accepted as consultation input; a second invitation is created as a draft (public page 404), opened (200) and archived (404); review notes survive a reload and a later status change; the private media route returns 401 without a reviewer session; desktop and 390 px mobile layouts have no horizontal overflow and no console or request errors.
- Gallery journeys: approving a website story leaves it out of the gallery; publishing it shows the chosen credit and photograph; hiding removes it and its media route returns 404; showing brings both back with the original publication date; withdrawal removes it permanently. Written consultation responses never appear. Screenshots and the environment note are in [gallery evidence](../status/evidence/collaboration-gallery/README.md).
- Funnel journeys: a page arrival, first form interaction and successful submission each increment their stage once; the editor's 30-day panel shows the counts and conversions; the stored row contains only invitation, day, stage, count and expiry.
- Operational-owner setting: the page started unassigned; three member pickers and the contact fields saved; active, verified owners with the review permission showed assigned and ready; an owner without it showed "Assigned, but not ready" with the reason; values survived a reload; recent changes were recorded; the queue links to the page. No console errors.
- Correction address model: an invitation created without an override inherited the operations default on its public page, while the pilot kept its explicit address.
- Contributor management journey: a signed-in member can optionally link the contribution after ticking consent, the link survives a reload and shows in the review queue, and a published linked story appears in a "Published stories" section on the member profile with a link to its gallery anchor. Hiding the story removes it from the profile, and unlinking removes it while keeping the contribution. Claiming changes neither publication nor management authority. The success screen offers a private link whose token stays in the URL fragment; the link shows the contribution and status; removing from the gallery takes effect immediately; a correction returns the story to review and off the gallery; withdrawal deletes the material and invalidates the link. No request URL contained the token during the check.
