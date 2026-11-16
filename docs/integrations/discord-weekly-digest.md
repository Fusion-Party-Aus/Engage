# Discord weekly digest — Attention Debt

**Status:** implemented behind an off-by-default feature flag; requires manual configuration and a weekly external scheduler. Issue [#125](https://github.com/Fusion-Party-Aus/Engage/issues/125).

## Purpose

The Discord digest is a *public participation invitation*, not a voting recommendation and not a substitute for personalised email or the member inbox. It highlights proposals that have received comparatively little engagement and encourages members to read them.

Only public national proposals in Deliberate or open Decide are included. It does not publish private/branch-only proposals, Sense Box inbox items, names, votes by individual members, identifiable choices or comment text.

## Attention Debt algorithm (initial version)

Each proposal earns a score between roughly 0 and 100:

- **65% engagement deficit:** Discussions with fewer contributions and open ballots with fewer participants score higher. A missing or outdated ballot-tally projection is *unknown*, not zero; it receives a conservative score informed by discussion activity.
- **25% exposure deficit:** Proposals featured less often over the last 12 weeks get priority.
- **10% deadline urgency:** An open ballot receives an equal urgency boost when it is within 14 days of closure, with the largest boost in its final seven days.
- **Two-week cooldown:** A recently featured proposal receives a significant temporary penalty. It is not banned.
- **Controlled exploration:** A seeded, reproducible weighted lottery among the high-attention-debt half of candidates chooses each slot. Ordinarily there are two discussions, two open ballots and one wildcard, with unused slots filled from other eligible proposals.

**Launch-cohort rule:** All proposals open at the initial Engage launch opened together. Historical `createdAt` or `secondedAt` values therefore must not alter their ranking. The inaugural formula ignores publication age entirely. Future age-normalisation requires reliable stage-entry timestamps and a deliberate algorithm version change.

The score never uses proposal subject, political position, author, votes for/against, or how someone voted. It allocates attention, not approval.

Preview and live selection for the same Melbourne calendar week use the same lottery seed. Featured IDs persist in `discord_digest_runs` to support rotation and ensure attempted posts do not get repeated.

## Configuration

Create a Discord text channel and webhook in a **separate test server** first. The webhook URL is a secret and must be set in Coolify/environment settings, not Git.

| Variable | Description |
|---|---|
| `ENGAGE_DISCORD_TEST_WEBHOOK_URL` | **Separate test server** Discord webhook |
| `ENGAGE_DISCORD_TEST_ROLE_ID` | Optional test server role to mention |
| `ENGAGE_DISCORD_WEBHOOK_URL` | Production Discord channel webhook |
| `ENGAGE_DISCORD_ROLE_ID` | Production `@Tuned` Discord role ID |
| `ENGAGE_DISCORD_DIGEST_ENABLED` | `false` by default. Must be exactly `true` for live sends |
| `ENGAGE_CRON_SECRET` | Existing bearer secret for authorised scheduled jobs |
| `PUBLIC_ORIGIN` | Trusted Engage website origin for proposal links |

Discord webhooks use the canonical `https://discord.com/api/webhooks/<id>/<token>` URL. The server validates the host and path; no arbitrary HTTP destinations or URL query strings are accepted. The test and production URLs must be different. The webhook URL is never returned by the admin API.

`@Tuned` is inserted by its **numeric role ID**, not a literal `@Tuned` string. To receive mentions, the server's role settings and webhook permissions must permit mentioning the role. The outgoing webhook sets `allowed_mentions` to exactly the configured role; incidental mentions in user-provided titles are disabled. A live digest has at most one configured role mention.

## Test in isolation

1. Configure only `ENGAGE_DISCORD_TEST_WEBHOOK_URL` (and optionally `ENGAGE_DISCORD_TEST_ROLE_ID`) on the Engage environment. Leave live sending disabled.
2. Open **Admin → Member engagement → Discord weekly digest**.
3. Select **Preview next digest**. This loads a current read-only preview without posting anything.
4. Select **Send to test Discord**. A clearly labelled **TEST** digest is posted to the test server only.
5. Inspect the test message, links, wording, mentions and line breaks. Tests are limited to one attempt per administrator per minute.

A network timeout means delivery may have happened. The send record is held and not automatically retried, so inspect the Discord channel first.

## Weekly scheduling

After approving the test, set the **production** webhook and role ID and change `ENGAGE_DISCORD_DIGEST_ENABLED=true`. Configure a weekly external job (suggested: Monday evening, Australia/Melbourne) to call:

```http
POST /api/cron/discord-digest
Authorization: Bearer <ENGAGE_CRON_SECRET>
```

Do not call the endpoint with a browser GET. Do not place the bearer secret in Git, documentation, screenshots or Discord.

No job is automatically installed by merging this PR: deployment and scheduler configuration are operator steps. The cron handler uses the existing `withJobRun` ledger. `discord_digest_runs` has an immutable per-week idempotency key (the Monday date in Melbourne time); a second run in the same week does not repost. Uncertain sends become `held` and require manual investigation.

The message is not personalised and does not claim that anyone has or has not voted. A proposal ballot's aggregate participation count appears only when the public tally projection is credible and fresh; otherwise the message says participation figures are updating. Quorum progress must not be claimed until the separate quorum work is authorised and implemented.

## Troubleshooting

- **No message:** Confirm the webhook is configured and that the weekly cron job exists, or explicitly use admin test-send for the separate server.
- **No role ping:** Check that the role ID belongs to the target Discord server and can be mentioned; role names alone do not work.
- **Already attempted:** The weekly key or per-minute test key already exists. Inspect Discord and the `discord_digest_runs` status before assuming nothing was sent.
- **Held:** Delivery confirmation was not received. Check the channel before considering a manual resending strategy.
- **No candidates:** All public proposals are closed or unavailable; the scheduled digest does not send an empty weekly post.

The webhook is one-way; no Discord bot, OAuth connection, Discord user mapping or new email consent is required.
