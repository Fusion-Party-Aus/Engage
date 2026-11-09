# Proposal metrics, deadlines and member engagement

## Member experience

- Proposal highlights on the member homepage and proposal browser, plus sort options. These reuse already-visible summaries and never export identifiable ballot records.
- Most divisive: highest `4 × approve × reject / (approve + reject)²`, requiring both sides and at least five decisive votes. A 50/50 split scores highest; ties prefer greater turnout then proposal ID.
- Most approved: highest approve share of approve/reject votes, at least five decisive votes. Abstentions are displayed but excluded from that denominator. This does not imply formal adoption.
- Most active: all-time formal proposal ballots plus discussion posts. Amendment ballots and pending preferences are excluded. This measures contributions, not unique people.
- My Engage includes eligible unvoted ballots closing within seven days (including bound amendment ballots), explicit Melbourne deadlines, participation follow-through, and email preferences. Existing activity and catch-up views remain available.
- Existing accounts default to reminders on; new accounts default off until they opt in. At first startup, a durable `engagement_email_rollouts` record snapshots the existing account IDs. Repeated startups never expand this cohort. Explicit preferences and unsubscribe records always override the default, and bounce/complaint suppression blocks delivery. Existing users do not need to return or complete onboarding to receive reminders. Onboarding explains the applicable default, timing, unsubscribe and delivery reporting, with a direct reminder preference form. Verification/sign-in emails are separate.
- Inline HTML email uses Horizon violet, cyan, lavender and Newsreader/Georgia + Outfit/Arial fallbacks; includes plain text and a visible unsubscribe link. No choices or vote reasons appear in email or provider tracking metadata.

## Apply the requested current-ballot deadline

Nine November 2026 + 45 calendar days is Thursday **24 December 2026**. Voting runs through 11:59 pm Australia/Melbourne. The stored exclusive cutoff is `2026-12-24T13:00:00.000Z` (25 December 00:00 AEDT).

Run inside the production application environment with its existing `MONGODB_URI` and `MONGODB_DB_NAME`:

```sh
pnpm ballots:schedule
pnpm ballots:schedule --apply
```

The first command previews IDs and previous deadlines; it does not write. `--apply` sets deadlines on currently open proposal (`stage: decide`) and amendment (`status: voting`) ballots, excludes already-expired ballots, and saves before/after audit data in a transaction. A replica set is required. Concurrent stage/deadline edits abort the transaction. The script refuses to run after the fixed deadline and never falls back to the development database. New ballots opened later are outside this one-time update. Amendments subsequently opened against a scheduled proposal inherit its deadline.

Deadline enforcement blocks new/changed formal votes, saved pending preferences, and promotion after verification; expired ballots leave the outstanding queue. It does **not** invent a result, ratify policy, or change stage. Returning officers continue to record decisions explicitly.

This script has not been applied to production by this change. Production credentials are not available in the implementation workspace.

## Configure email delivery

The existing Resend account and verified `AUTH_EMAIL_FROM` are reused. Set server-only values:

| Variable | Purpose |
| --- | --- |
| `ENGAGE_DIGEST_ENABLED` | `true` to enable the scheduled sender, otherwise disabled |
| `ENGAGE_EMAIL_SECRET` | Stable random secret for unsubscribe signatures; keep stable so old links remain valid |
| `ENGAGE_CRON_SECRET` | Independent random bearer secret for the job endpoint |
| `RESEND_WEBHOOK_SECRET` | Signing secret for this Resend webhook (`whsec_…`) |
| `PUBLIC_ORIGIN` / `BETTER_AUTH_URL` | Production HTTPS Engage origin |
| `RESEND_API_KEY`, `AUTH_EMAIL_FROM` | Existing provider sending configuration |

Create a Resend webhook pointing to `/api/email/webhook` for `email.delivered`, `email.bounced`, `email.complained`, `email.failed`, and `email.delivery_delayed`. Optional opened/clicked events are recorded if supplied by the provider; provider tracking settings are not modified by the application. The verifier follows [Svix raw-payload signature verification](https://docs.svix.com/receiving/verifying-payloads/how-manual), including the five-minute timestamp tolerance.

Configure the deployment scheduler to POST `/api/email/digest` every 15 minutes with `Authorization: Bearer <ENGAGE_CRON_SECRET>`. Store the header as a deployment secret. Each invocation sends at most 25 digests, groups outstanding eligible ballots, and uses durable member/day claims plus [Resend idempotency keys](https://resend.com/docs/api-reference/emails/send-email). Repeated jobs exclude already-reminded ballot revision/deadline keys. A changed revision or deadline can be reminded again. Members without verified email/verified membership or with disabled accounts, opt-outs, bounces or complaints are skipped.

Provider timeouts or unclear responses create a `held` outbox row; it blocks automatic resend of those ballot keys. A crashed `sending` row also blocks resend. Inspect the provider before any manual retry. Do not delete a hold merely because an HTTP call timed out: the email may have been sent. This initial release intentionally does not automate recovery of ambiguous sends.

Delivery webhooks are verified before parsing, stored by unique event ID, and correlated to the provider email ID. Early webhooks remain durable and are reconciled on the next enabled job. Bounce/complaint events suppress reminders. Provider event payloads, addresses and click URLs are not retained. Monitor `/admin/engagement/` for unique-message delivery/bounce/complaint/failure rates, optional opens/clicks, subscriptions, unsubscribes, suppression and held sends. Rates use provider-accepted messages created within the last 30 days; unknown delivery is not counted as delivered. This is email delivery reporting, not ballot-choice profiling.

Unsubscribe supports RFC 8058 list-unsubscribe POST and a human confirmation page. GET requests never unsubscribe, protecting against link scanners. The link needs no login and affects only reminders. Preferences can also be changed in My Engage. After suppression, resolve delivery and have an administrator review the suppression record before the member opts in again.

## Verification and rollout

- Run `pnpm check`, `pnpm test`, and `pnpm build`.
- Focused tests exercise metric samples/denominators, deadline boundaries, vote/preference/promotion blocking, electorate/visibility boundaries, token tampering, escaped markup, webhook replay/tamper checks, bounce suppression, opt-in sending and held-send behaviour.
- Real MongoDB integration tests require `VOTING_TEST_MONGODB_URI`; the memory database does not prove MongoDB transaction or unique-index behaviour.
- Browser screenshots were attempted; this executor prevents Chromium from creating its process singleton socket (`Operation not permitted`). Visual verification and actual inbox rendering remain rollout checks.
- No real email was sent, no Resend settings changed, and the production deadline migration was not applied during implementation.

## Notification categories

My Engage → Notifications offers three independently saved categories:

- Essential account notifications: account administration and critical voting-related information, default on. The membership-verification notice honours this setting; security and sign-in emails always send.
- Engage digests: weekly summaries, closing-soon ballots, unvoted proposals and participation updates belong to this category. The current automated sender delivers the closing-soon ballot digest; this change does not add a weekly-summary sender. Existing accounts default on via the immutable rollout snapshot; new accounts must opt in. Digest unsubscribe links change only this category.
- General communications: newsletters, campaigns and broader party updates, default off in Engage. The preference is stored separately; no external party mailing list is synchronised by this application. Future senders must call `notificationEnabled(preference,"general")` rather than reuse digest consent.

Preference changes and email-link unsubscribes write category-scoped `engagement_notification_events`; delivery/bounce/complaint events remain correlated to provider message IDs. Existing false preferences, unsubscribe records and suppressions are never overwritten by rollout defaults. The existing-account snapshot is captured automatically before the first startup completes, so no return visit is needed. Back up and preserve `engagement_email_rollouts` across releases.
