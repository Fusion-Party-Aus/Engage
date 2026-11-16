# Notifications, email, PWA and scheduled work

**Status:** Current · **Verified:** 15 November 2026

## Notification model

Engage has five notification topics:

| Topic | Category | Purpose |
|---|---|---|
| `new_ballots` | Engagement | A ballot the member may vote in has opened |
| `closing_deadlines` | Engagement | A ballot is closing soon |
| `contribution_responses` | Engagement | An officer responded to the member's contribution |
| `governance_outcomes` | Engagement | A decision or publication occurred |
| `account_membership` | Essential | Verification, suspension or account changes |

Channels are independent:

- **Email** — topic consent, derived from the frozen digest rollout cohort for existing members.
- **In-app** — inbox items in `member_notifications`.
- **Web Push** — browser push subscriptions.

Push defaults to **off** and is never inferred from email consent. Email consent does not imply push consent.

Suppression is enforced server-side: a bounced or complained address cannot re-enable email until the operator clears the suppression. A member cannot override it.

Preferences are resolved by `resolveUnifiedPreferences` in `src/lib/notifications.ts`.

## Channels

### Email

Provider: Resend REST API, called directly.

- Sign-in magic links: inline HTML, 10-minute expiry, 5 requests per 60 seconds, hashed token storage, 10-second request timeout.
- Digest and lifecycle email: `src/lib/engagement-email.ts`.
- Templates: `src/lib/email-templates.ts` — digest, new ballot, mid-period reminder, re-engagement, contribution response and membership notification.
- Every lifecycle and digest send carries an idempotency header and a `List-Unsubscribe` one-click header. Sign-in links are one-time, expire in 10 minutes and do not use marketing unsubscribe headers.
- `src/pages/api/email/webhook.ts` verifies Resend/Svix signatures, a 5-minute timestamp window and a 100 KB body cap, then records delivery, bounce and complaint events.
- `src/pages/api/email/unsubscribe.ts` uses a signed HMAC token; GET shows a confirmation page with `Referrer-Policy: no-referrer`, POST performs the unsubscribe.
- Re-engagement is approval-gated with batches of at most 25 recipients.

### In-app

- Items live in `member_notifications`.
- `notification_deliveries` provides dedupe with a unique `_id` of `inapp:<member>:<dedupeKey>` and a matching composite `dedupeKey` value, because the unique index is on `dedupeKey`.
- `/api/notifications/inbox` supports `mark_read` and `mark_all_read`.
- The header bell hydrates `NotificationCenter`.

Governance events reach the inbox through the notification outbox described below. The in-app inbox is the baseline delivery channel for a formal ballot notice: the preference model has no per-topic in-app opt-out.

### Discord (one-way weekly digest)

Public proposal digest through a Discord webhook, with a deliberately **neglect-first**
Attention Debt selection algorithm. Unlike per-member email reminders, this is a
server-wide, non-personalised invitation to contribute; it is not tied to individual
vote status or email notification consent.

- Candidate selection is public national Deliberate/Decide proposals only.
- The inaugural cohort opened together, so historical proposal creation dates
  have no effect on the score.
- Low activity, unfeatured proposals and time-critical ballots receive more
  exposure through a seeded weighted lottery with repeat cooldown.
- Only credible fresh public aggregate turnout is shown; never a private vote
  or identifiable ballot choice.
- An admin-only preview and explicit test send target a separate test Discord
  server; live sending is disabled by default.
- Webhook URLs, role IDs, enablement and Melbourne posting schedule are edited in
  **Admin → Platform settings → Discord**. They live in a separate, encrypted
  integration settings store; webhook values never enter public site settings or
  settings-history snapshots. The existing auth bootstrap key protects ciphertext.
- The external cron is an hourly *trigger*; Engage decides if the configured
  local posting day/hour is due and keeps one attempt per Melbourne week.
- See [Discord weekly digest setup](../integrations/discord-weekly-digest.md).

### Web Push

- `push_subscriptions` stores endpoints keyed by a hash of `memberId\0endpoint`.
- Only HTTP(S) endpoints are accepted.
- `404` and `410` responses revoke the subscription automatically.
- VAPID configuration is optional; without it, push is a no-op that sends nothing.
- `src/lib/web-push.ts` contains subscription, send and revocation logic.

### PWA

- `public/manifest.webmanifest` declares a standalone app with `/member/` as `start_url`.
- `public/sw.js` caches only icons, `_astro` assets and the manifest. It explicitly bypasses `/api/*` and all navigations, so governance pages are never served stale.
- Push and notification-click handlers validate the origin before opening a URL.
- The service worker is registered from `SiteLayout.astro`.

## Governance notification events

Two governance lifecycle events are wired through the durable outbox (issue #33).
`governance_outcomes` and `contribution_responses` are deliberately **not** wired;
see the deferred list below.

| Event | Topic | Trigger | Dedupe key | Channels |
|---|---|---|---|---|
| Ballot opened | `new_ballots` | `runGovernanceScheduler` advances a matter from Deliberate to Decide and commits the transition | `governance:ballot_opened:<proposalId>:<memberId>` | In-app, Web Push (opt-in) |
| Closing soon | `closing_deadlines` | A scheduler run finds an open ballot whose `ballotClosesAt` is inside the approved seven-day window | `governance:ballot_closing_soon:<proposalId>:<ballotClosesAt ISO>:<memberId>` | In-app, Web Push (opt-in) |

One row exists per member, ballot and event. The closing-soon key includes the
deadline, so one reminder is sent per ballot deadline; if an officer moves the
deadline, that is a new reminder window.

### Audience rule

The audience is exactly the electorate, never an approximation.

- Candidates are narrowed by participation facts: verified platform membership
  for a national ballot, an active membership of the owning branch for a branch
  ballot, and a recognised branch. Following a branch never qualifies.
- Every candidate is then confirmed with `getProposalEligibility` — the same
  predicate that authorises a vote — and `canViewProposal`, the same visibility
  gate used when casting a vote. A member who could not vote is not notified.
- Authors, administrators and officers are not treated differently: they are
  notified only when they satisfy the same predicate.
- Eligibility is checked again when the row is drained. A membership revoked, a
  branch de-recognised or a ballot closed between enqueue and send marks the row
  `suppressed`; it is not retried.

### Delivery policy

- **In-app** is the baseline channel for a formal ballot notice. The preference
  model has no per-topic in-app opt-out, so the inbox is not a marketing channel.
- **Web Push** is strictly opt-in per topic and is never inferred from email
  consent. A member without push consent is recorded as a suppressed push channel.
- **General communications** (`generalCommunicationsEnabled`) covers general
  party updates outside formal Engage ballots. It does not suppress ballot
  notices.
- **Email suppression** after a bounce or complaint is an email-delivery state.
  It does not suppress the in-app inbox or an opted-in push.
- **Email** is not sent by this outbox in this slice. The ballot digest already
  emails outstanding ballots, and duplicate email fan-out needs its own consent
  and cadence decision.

### Outbox and drain

`notification_outbox` stores one document per recipient and event:

```ts
{
  _id: dedupeKey, dedupeKey, memberId, topic, event,
  matterId, ballotId, revisionId?,
  payload: { title, body, href, isConfidential },
  status: "pending" | "sent" | "failed" | "suppressed",
  attempts, nextAttemptAt, claimToken?, claimExpiresAt?,
  lastAttemptAt?, lastError?, sentAt?, suppressedAt?, suppressionReason?,
  channels: { inApp, push },
  createdAt, updatedAt, retainUntil?
}
```

- **Enqueue never blocks governance.** The transition commits first. Fan-out is
  written immediately afterwards and its errors are logged as operational
  events; the scheduler report, conditional writes and governance events are
  unchanged. Enqueue is idempotent, and each run repairs a scheduler-opened
  ballot from the previous 24 hours that has no outbox row, so a crash between
  commit and fan-out is recovered.
- **Claim.** The drain claims one row with a conditional `findOneAndUpdate` that
  sets a five-minute lease. A second worker's filter rejects a leased row, so two
  concurrent drains never send the same row. A crashed worker's lease expires and
  the row is retried. Dispatch dedupe keys make an ambiguous retry safe.
- **Retry.** A failed send records `failed`, increments `attempts` and schedules
  a retry after 1, 2, 4 or 8 minutes. The fifth failure is terminal. A suppressed
  row is never retried.
- **Retention.** Terminal rows receive `retainUntil` two years after the event.
  The TTL index deletes only on that field, so pending and failed rows are never
  swept away.
- **Indexes.** Unique `dedupeKey`; `(status, nextAttemptAt)`; `(matterId, event)`;
  `(memberId, createdAt)`; TTL on `retainUntil`.

`npm run notifications:drain` is dry-run by default; `--apply` sends. It requires
`MONGODB_URI`, prints a counts-only JSON summary (never a member identifier or
payload) and exits non-zero when a send failed. Both modes record a
`notification-outbox-drain` entry in `job_runs`; a partial failure is recorded as
a failed run.

### Content rules

- The notification names the matter and links to the bound ballot page
  (`/proposals/<slug>/#proposal-vote`).
- The body states the deadline in Melbourne time. It never restates the motion,
  summary, outcomes or details.
- A payload never contains a vote choice, tally, comment or identifiable ballot
  data.
- A branch or private matter is marked confidential. Push uses a neutral
  lock-screen title and body; the real title stays in the authenticated inbox.

### Deferred events

| Event | Topic | Why it is not wired yet |
|---|---|---|
| Result recorded | `governance_outcomes` | The result route is being refactored in another change. Wiring it now would fan out from a route that is about to move. |
| Contribution response | `contribution_responses` | Needs a product decision about who is notified, when a response is public, and how a comment outcome is represented without exposing deliberation content. |

Until those events are wired, do not tell members that every governance event
produces a notification.

## Endpoints

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/notifications/inbox` | GET, PATCH | Session | List and mark read |
| `/api/notifications/preferences` | GET, POST | Session | Topic/channel preferences |
| `/api/notifications/push-subscription` | POST, DELETE | Session | Register/remove a push endpoint |
| `/api/email/preferences` | POST | Session + Origin | Email topic preferences (303 redirect) |
| `/api/email/unsubscribe` | GET, POST | HMAC token | One-click unsubscribe |
| `/api/email/webhook` | POST | Svix signature | Delivery/bounce/complaint events |
| `/api/email/digest` | POST | Bearer `ENGAGE_CRON_SECRET` | Send due digest batches |
| `/api/admin/discord-settings` | GET / PATCH | `settings.manage`; Origin required on PATCH | Configure Discord channels, role mentions, enabled state and weekly schedule |
| `/api/admin/discord-digest` | GET / POST | Admin session; Origin required on POST | Preview and explicitly test-send to separate Discord server |
| `/api/cron/discord-digest` | POST | Bearer `ENGAGE_CRON_SECRET` | Run one public Discord digest per Melbourne week |

## Scheduled work

There is **no in-process scheduler**. `setInterval` is not used. Scheduled work is an HTTP endpoint called by an external scheduler.

| Job | Endpoint | Secret | Gate |
|---|---|---|---|
| Ballot digest email | `POST /api/email/digest` | `ENGAGE_CRON_SECRET` | `ENGAGE_DIGEST_ENABLED === "true"` |
| Discord weekly digest | `POST /api/cron/discord-digest` | `ENGAGE_CRON_SECRET` | Enabled and scheduled through Admin → Platform settings → Discord |
| CRM membership verification | `POST /api/cron/membership-verification` | `ENGAGE_CRM_VERIFICATION_CRON_SECRET` | CRM verification enabled (409 when off) |
| Health probe | `GET /api/health` | None | Always available |

Two scheduled jobs are CLIs rather than endpoints: `npm run governance:scheduler -- --apply`
advances and closes due matters, and `npm run notifications:drain -- --apply`
delivers queued governance notifications. Run the drain immediately after the
scheduler.

The documented digest cadence is every 15 minutes. Coolify production currently has **no enabled scheduled tasks**; the operator must configure them. The systemd units in `deploy/systemd/` run the LAN-only Coolify poller, not application jobs.

Consequences of missing schedulers:

- No digest email is sent.
- No automatic CRM verification cycle runs.
- No ballot opens or closes automatically; closure is enforced by deadline at vote time.
- No reminder is sent unless a digest job is run.
- No governance in-app or push notification is delivered unless the outbox drain runs.

Every authorised run — success or failure — is recorded in the `job_runs` ledger, and `npm run ops:health` turns that evidence into exit-coded states. See [job cadence and health](../architecture/build-deploy-operations.md#job-cadence). A dry run is recorded but never counts as a scheduled run for health.

## Scripts

`scripts/` contains operational and migration tooling, not application runtime code.

| Script | Purpose |
|---|---|
| `generate-changelog.mjs` | Build the changelog snapshot from Git history |
| `ballot-migration.ts` | Legacy Decide-stage ballot inventory/migration |
| `migrate-proposal-votes.mjs` / `.ts` | Move legacy votes into `proposal_votes` |
| `migrate-encrypted-votes.ts` | Encrypt existing votes; supports dry run and rotation |
| `ballot-tally-projection.ts` | `npm run ballots:tally-projection`: report, rebuild and verify the display-only `ballot_tallies` rows (dry-run by default, `--apply`, `--verify`) |
| `schedule-open-ballots.ts` | One-off deadline assignment for open ballots |
| `seed-branches.ts` | Seed standard branches |
| `migrate-branch-participation.ts` | Branch participation migration |
| `membership-verification.ts` | CRM verification/reconcile/backfill CLI |
| `run-governance-scheduler.ts` | `npm run governance:scheduler`: advance/close due matters, JSON report |
| `drain-notification-outbox.ts` | `npm run notifications:drain`: deliver queued governance notifications (dry-run by default, `--apply`) |
| `operational-health.ts` | `npm run ops:health`: scheduled-work health, JSON or `--human`, exit codes |
| `grant-engage-admin.mjs` | Grant platform administrator |
| `preview-emails.ts` | Render templates locally |
| `admin-engagement-http.mjs` | Mock-provider HTTP harness |
| `member-lifecycle-browser.mjs` | Playwright member journey |
| `proposal-experience-browser.mjs` | Playwright proposal/ballot journey |
| `deploy-nuc.sh` | NUC release deploy |
| `coolify-poll-deploy.sh`, `coolify-final-backup.sh` | Coolify promotion and backup |
| `corpus-*.mjs`, `reclaim-extract.mjs`, `reconcile-*.mjs` | Offline corpus analysis; not runtime |

Run migration scripts with a dry run first. They are not exposed to members.

## Design rules for new notifications

1. **Consent first.** Add a topic to the catalogue, default it correctly and respect channel independence.
2. **Dedupe.** Every in-app or email send needs a stable dedupe key so retries do not spam.
3. **No governance content in email headers.** Subject lines may name a ballot but must not reveal a member's vote or an identifiable choice.
4. **Link to the authoritative page.** Do not restate wording in email; link to the bound revision.
5. **Fail visibly.** A failed send must be recorded, not swallowed. A digest that silently sends nothing is an operational defect.
6. **Never claim delivery.** In-app creation is not delivery; email acceptance is not reading.
7. **Respect suppression.** Bounce and complaint state is authoritative.
8. **Keep PWA caches away from governance.** Never cache API responses or authenticated pages in the service worker.
9. **Fan out through the outbox.** Governance events are written to `notification_outbox` and delivered by the drain; never send inline from a route or scheduler transaction.
