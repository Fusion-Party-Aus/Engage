# Lifecycle event specification

Backend events are private operational records in `engagement_lifecycle_events`, not Plausible payloads. They contain a member key, event name and timestamp only: never vote choice, reason, selection or email. Restrict database access and apply the deployment's retention policy. The application exposes only aggregate funnel counts to national administrators.

| Event | Source | Counting/reporting rule |
| --- | --- | --- |
| `registration_completed` | Better Auth account-create hook; administrator account creation | One per account after successful creation |
| `verification_requested` | Same account creation path | One per account; registration implies pending admin verification, no separate application API exists |
| `verification_approved` | `saveMember`, actual transition into verified | One first observed approval per member; historical timestamps are not invented |
| `verification_notification_queued` | Durable verification outbox claim | One per member/status; queued is not sent/delivered |
| `verification_notification_delivered` | Verified Resend webhook correlated by provider ID | One per member/status; replay-safe |
| `verification_notification_bounced` | Verified Resend webhook | One per member/status; also activates suppression |
| `verification_notification_failed` | Pre-handoff configuration failure or verified delivery-failure webhook | One per member/status; held outcomes are not called confirmed failures |
| `my_engage_viewed` | Authenticated server render | One per member per UTC day for recent-activity exclusion; views are not conversions |
| `first_eligible_ballot_viewed` | Proposal render after server electorate/deadline checks; Decide + bound revision | One per member; anonymous/ineligible visits do not count |
| `first_vote_submitted` | Successful formal proposal or amendment vote persistence | One per newly observed first-time voter; changes/retries do not create another conversion |
| `participation_day` | Same successful formal vote path | One per member per UTC day; no choices, ballot IDs or reasons |
| `historical_participant` | Before a formal vote, existing vote found without tracked first-vote event | Excludes existing voters from newly observed first-vote cohorts |
| `digest_preferences_changed` | Authenticated preference endpoint; Engage setting actually changes | Each persisted change; not a form pageview or unchanged save |
| `verification_cta_clicked` | Plausible, verification source arrival | Aggregate landing interaction, no custom properties; scanner/reload/login arrivals can inflate this, not a unique conversion |
| `my_engage_viewed` | Plausible, authenticated browser arrival | Aggregate view interaction, no custom properties; backend event is separate |
| `digest_cta_clicked` | Plausible, digest source arrival | Aggregate landing interaction, no custom properties; scanner/reload effects apply |

The fixed `source=verification` / `source=digest` markers contain no identity. Existing tracker sanitization strips all query strings/fragments and sensitive referrer paths before network submission. The source marker is removed from browser history after interaction tracking. APIs are excluded and staging remains disabled. Do not add person-specific CTA tokens, member IDs, email addresses or voting choices to Plausible. Provider click events remain estimated email engagement, not proof of a human voter.

## Conversion denominators

**Seven-day first-vote conversion:** denominator = unique observed verified accounts whose first recorded approval is at least seven elapsed days old. Numerator = those accounts whose first submitted formal vote is between approval and approval + seven days, inclusive. Recent approvals remain immature and are excluded. Report counts and `numerator / denominator`; show no percentage for a zero denominator. Historical activity is not reconstructed from mutable records.

**Thirty-day returning participation:** denominator = tracked first-time voters with at least 30 elapsed days of observation since their first vote. Numerator = those with a successful subsequent voting day at least 24 hours after first vote and no later than day 30. Multiple votes in the first session/day do not imply a return. This measures returning voting participation, not merely opening the site.

Both metrics appear in Administration → Member engagement and use backend records rather than Plausible visitors, pageviews or email opens. Repeated pageviews cannot increase either numerator. These are prospective cohorts, not historical estimates. Auto-promoted saved preferences are existing formal participation, not a new manual-submission event.

No member identifiers are sent to Plausible for cross-session attribution. Accordingly, Plausible cannot provide person-level verification-to-vote funnels; use the backend cohort report for that purpose. Evidence/data failures after a voting write can leave gaps and need operational reconciliation; do not interpret missing analytics as proof a member did not vote.
