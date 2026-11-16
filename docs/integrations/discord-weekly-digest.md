# Discord weekly digest — Attention Debt

**Status:** implemented behind an off-by-default feature flag; requires in-app setup and an hourly external trigger. Issue [#125](https://github.com/Fusion-Party-Aus/Engage/issues/125).

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

## Message format

Each weekly post is one Discord embed: a Horizon accent rule, an intro line, one field per featured proposal (stage, activity figure and a direct Engage link) and a short footer inviting participation. The embed title links to Engage. The test post is titled `TEST — Engage this week` and its footer states that it went to the test server.

Only the configured `@Tuned` role is mentioned, in the message content above the embed. Proposal titles are escaped and mention-neutralised before they enter the embed, and `allowed_mentions` stays restricted to the configured role, so a title cannot ping anyone or inject link formatting.

## Configuration in Engage

Open **Admin → Platform settings → Discord**. The integration is disabled by default.

1. Create a Discord webhook in a separate test server, paste it into **Test webhook URL**, optionally enter the test role ID and save.
2. Use **Preview digest** and **Send to test Discord**. The test message is clearly labelled, limited to one attempt per administrator per minute, and cannot use the live webhook.
3. Once approved, enter the production channel webhook and the numeric `@Tuned` role ID. Set the desired weekday and hour (Melbourne time) in Engage.
4. Enable **Post weekly digests** and save. This does not itself create the external scheduler.

Webhooks are stored **encrypted at rest** in `discord_settings` (AES-256-GCM with a key derived from Engage's existing `BETTER_AUTH_SECRET`). Settings GET responses and admin pages return only configured/not-configured flags, never webhook values. Change history logs the actor and changed *field names*, not secrets. To rotate a webhook, paste the new one; to revoke it, use **Remove webhook**. Removing the live webhook also disables live sending.

The existing bootstrap secret must be backed up. If it changes, encrypted webhooks need to be re-entered. No additional Discord-specific environment variables are required.

Discord webhooks use the canonical `https://discord.com/api/webhooks/<id>/<token>` URL. The server validates the host and path; no arbitrary HTTP destinations or URL query strings are accepted. The test and production URLs must be different. The webhook URL is never returned by the admin API.

`@Tuned` is inserted by its **numeric role ID**, not a literal `@Tuned` string. To receive mentions, the server's role settings and webhook permissions must permit mentioning the role. The outgoing webhook sets `allowed_mentions` to exactly the configured role; incidental mentions in user-provided titles are disabled. A live digest has at most one configured role mention.

## Test in isolation

1. In **Admin → Platform settings → Discord**, save the webhook for a separate test server. Leave live posting disabled.
2. Select **Preview digest**. This loads a read-only preview without posting.
3. Select **Send to test Discord**. A clearly labelled **TEST** digest goes to the test server only.
4. Inspect the test message, links, wording, mentions and line breaks. Tests are limited to one attempt per administrator per minute.

A network timeout means delivery may have happened. The send record is held and not automatically retried, so inspect the Discord channel first.

## Weekly scheduling

After approving the test, configure the production webhook, role, weekday and hour **in Engage**. Enable weekly posts there.

Configure an **hourly** external job (for example via Coolify) to call:

```http
POST /api/cron/discord-digest
Authorization: Bearer <ENGAGE_CRON_SECRET>
```

The cron job is only a trigger. The application decides whether the selected Melbourne weekday/hour has arrived, and the database enforces one posting attempt per Melbourne calendar week. If that slot was missed, the next hourly trigger later in the same Melbourne week may catch up; it does not post early. You can change the weekly posting time without editing the external scheduler. The existing `ENGAGE_CRON_SECRET` remains an infrastructure secret; it is not a Discord integration setting.

Do not call the endpoint with a browser GET. Do not place the bearer secret in Git, documentation, screenshots or Discord.

No job is automatically installed by merging this PR: the external hourly trigger is an operator setup step; destinations and schedule are configured in Engage. The cron handler uses the existing `withJobRun` ledger. `discord_digest_runs` has an immutable per-week idempotency key (the Monday date in Melbourne time); a second run in the same week does not repost. Uncertain sends become `held` and require manual investigation.

The message is not personalised and does not claim that anyone has or has not voted. A proposal ballot's aggregate participation count appears only when the public tally projection is credible and fresh; otherwise the message says participation figures are updating. Quorum progress must not be claimed until the separate quorum work is authorised and implemented.

## Troubleshooting

- **No message:** Confirm the webhook is saved in Platform settings and that the hourly cron trigger exists, or explicitly use admin test-send for the separate server.
- **No role ping:** Check that the role ID belongs to the target Discord server and can be mentioned; role names alone do not work.
- **Already attempted:** The weekly key or per-minute test key already exists. Inspect Discord and the `discord_digest_runs` status before assuming nothing was sent.
- **Held:** Delivery confirmation was not received. Check the channel before considering a manual resending strategy.
- **No candidates:** All public proposals are closed or unavailable; the scheduled digest does not send an empty weekly post.

The webhook is one-way; no Discord bot, OAuth connection, Discord user mapping or new email consent is required.
