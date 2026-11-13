# Notifications, email, PWA and scheduled work

**Status:** Current · **Verified:** 13 November 2026

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
- `notification_deliveries` provides dedupe with a unique `_id` of `inapp:<member>:<dedupeKey>`.
- `/api/notifications/inbox` supports `mark_read` and `mark_all_read`.
- The header bell hydrates `NotificationCenter`.

**Wiring caveat:** `dispatchMemberNotification` is fully implemented and tested, but has **no production caller**. Membership verification creates in-app notices. New-ballot and governance-outcome fan-out is built but not wired into ballot opening or result recording. Do not tell members that every governance event produces an inbox item.

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

## Scheduled work

There is **no in-process scheduler**. `setInterval` is not used. Scheduled work is an HTTP endpoint called by an external scheduler.

| Job | Endpoint | Secret | Gate |
|---|---|---|---|
| Ballot digest email | `POST /api/email/digest` | `ENGAGE_CRON_SECRET` | `ENGAGE_DIGEST_ENABLED === "true"` |
| CRM membership verification | `POST /api/cron/membership-verification` | `ENGAGE_CRM_VERIFICATION_CRON_SECRET` | CRM verification enabled (409 when off) |
| Health probe | `GET /api/health` | None | Always available |

The documented digest cadence is every 15 minutes. Coolify production currently has **no enabled scheduled tasks**; the operator must configure them. The systemd units in `deploy/systemd/` run the LAN-only Coolify poller, not application jobs.

Consequences of missing schedulers:

- No digest email is sent.
- No automatic CRM verification cycle runs.
- No ballot opens or closes automatically; closure is enforced by deadline at vote time.
- No reminder is sent unless a digest job is run.

## Scripts

`scripts/` contains operational and migration tooling, not application runtime code.

| Script | Purpose |
|---|---|
| `generate-changelog.mjs` | Build the changelog snapshot from Git history |
| `ballot-migration.ts` | Legacy Decide-stage ballot inventory/migration |
| `migrate-proposal-votes.mjs` / `.ts` | Move legacy votes into `proposal_votes` |
| `migrate-encrypted-votes.ts` | Encrypt existing votes; supports dry run and rotation |
| `schedule-open-ballots.ts` | One-off deadline assignment for open ballots |
| `seed-branches.ts` | Seed standard branches |
| `migrate-branch-participation.ts` | Branch participation migration |
| `membership-verification.ts` | CRM verification/reconcile/backfill CLI |
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
