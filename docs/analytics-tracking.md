# Engage product analytics

Updated 9 November 2026. Production domain: `engage.fusionparty.org.au`.
Collector: `https://analytics.fusionparty.org.au/api/event`.

## What Stewart can learn

Use the existing Pages, Sources and device reports for traffic and engagement.
Use custom events below for navigation choices, discovery, reading and participation.
Filter reports to a proposal URL to examine its engagement; `proposal_stage` distinguishes
the stage at the time of the event. Member pages include `member_view` (`overview`,
`activity`, `account`) because query strings are deliberately removed.

| Event | Trigger | Properties | Question |
| --- | --- | --- | --- |
| `navigation_clicked` | Internal link activated, including React links | `area`, `destination`, `section`, `view`, `stage`, `intent` | Which entry points, member tabs and next actions are used? |
| `listing_viewed` | Proposal/policy results rendered | `collection`, `results`, `has_query` | Are visitors landing on empty results? |
| `search_submitted` | Search/filter form submitted | `collection`, `has_query` | How often is discovery used? |
| `filter_changed` | Supported dropdown changed, before auto-submit | `filter`, `value` | Which discovery controls are used? |
| `form_started` | First focus within each contribution/email form per document | `form` | Where do people start without submitting? |
| `section_viewed` | At least 10% of a tracked section enters a visible viewport, once per section per document | `section` | Are wording, history, discussion and ballot areas reached? |
| `contribution_attempted` | Valid action enters its request handler | `action` | How many people try to participate? |
| `contribution_result` | Request succeeds, fails, or saves a pending ballot | `action`, `outcome` | Which actions succeed and where is there friction? |
| `signin_attempted` | Email, Google, manual/automatic passkey flow starts | `method` | Which sign-in routes are used? |
| `signin_result` | Auth result, link delivery, callback error, or authenticated email/Google arrival | `method`, `outcome` | Are links delivered and sign-ins completed? |
| `passkey_enrollment` | Onboarding passkey setup starts/returns | `mode`, `outcome` | Are members adopting passkeys from onboarding? |
| `onboarding_action` | Guide/nudge dismissed or exploration CTA clicked | `action` | Do people use or dismiss onboarding? |
| `share_copied` | Ballot share link copied successfully | none | Are participants sharing proposals? |

`action`: proposal, deliberation, amendment, ballot, amendment_ballot, endorsement.
Contribution outcomes: success, pending_verification, failed. A pending preference is
never counted as a successfully cast ballot. No stance or ballot direction is recorded.
Search result counts are buckets: 0, 1–5, 6–20, 21+. Topic/branch/jurisdiction values
are only all/selected; stage and sort use fixed enumerations.

## Dashboard setup and interpretation

Create custom-event goals using the exact event names above in Plausible's settings
for **engage.fusionparty.org.au**, then use property breakdowns. This change does not
modify the Plausible account or deploy production.

Useful views:

1. Navigation: `navigation_clicked` by destination, then area and view.
2. Discovery: search submissions, filter usage, and listing views with results=0.
3. Reading: `section_viewed` by section, filtered to a proposal URL/stage.
4. Participation: form starts → attempts → results, broken down by action/outcome.
5. Access: sign-in attempts → email link_sent → success; compare methods separately.
6. Onboarding: manual enrollment attempts → success and guide/nudge dismissals.

Counts are aggregate usage observations, not an individual member journey or a
governance audit. Repeated submissions can produce multiple attempts/results;
email links can be opened on another device. Do not infer precise abandonment by
subtracting unrelated totals. Browser blocking, offline navigation and failed
deliveries mean analytics is incomplete. Plausible's own engagement requests
retain its existing scroll-depth/time measurement; custom section/listing views
are non-interactive so observation alone does not reduce bounce rate.

## Privacy and reliability

- One shared initializer uses the installed tracker; automatic pageviews remain
  enabled. No additional manual pageviews or generic automatic form submissions.
- Production hostname only, including calls from React components; server imports
  and local/staging calls are harmless. Respect the tracker's ignore flag/blockers.
- Strip **all** query strings and fragments from page URLs and referrers. This
  intentionally removes UTM campaign parameters too; source-origin reports remain.
- Retain public proposal/policy paths. Group all admin paths as `/admin/` and
  unrecognised routes as `/other/`; exclude API/auth paths entirely.
- Never send names, email addresses, member IDs, form text, search terms, ballot
  choices/reasons, comment IDs, exception text, or raw return URLs as properties.
- Event names/properties pass a runtime allowlist. No analytics cookies, persistent
  identifiers, session replay, fetch interception or server voting changes.
- Email/Google callbacks carry a bounded method marker. Count completion only on
  a server-rendered authenticated page, then remove that marker with replaceState.
  It preserves the existing callback destination, query and fragment.
- Tracking errors are swallowed; API success is checked before recording success.
  Section views indicate viewport exposure, not proof of reading.

The pending privacy notice has been updated to describe this behaviour; publication
and legal-acceptance configuration remain with the release owner.

## Verification

Implementation validation: 102 tests passed, 14 existing database-dependent tests
skipped without MongoDB test URIs. Astro production build passed. Type checking
reports the pre-existing `config.repositoryUrl`/`SiteConfig.repoUrl` mismatch in
`src/pages/admin/settings/index.astro`; no analytics errors remain.

A temporary jsdom integration fixture exercised the real bundled tracker and React
ballot component: one pageview, navigation/filter/search/form/section events,
authenticated email callback completion and marker removal, exactly one successful
ballot result and one failed result, with no choice/query/identity leakage.
This fixture intercepted every request and did not contact production. Chromium
was attempted but could not launch because the environment blocks its process
socket (`Operation not permitted`), so this does not claim a real-browser smoke test.

- `pnpm test`: includes the real tracker in isolated browser-like Node processes,
  verifying initial/path pageviews, no query-only duplicate, custom event payloads,
  staging exclusion and privacy sanitization. MongoDB integration tests require
  their existing isolated database environment variables.
- `pnpm check` and `pnpm build` for Astro and React compilation.
- Release smoke check: with a production browser, inspect requests to `/api/event`
  while navigating, filtering, signing in and contributing. Confirm one pageview
  per document/path, expected event properties, no private query values, and
  matching custom goals. Use a test/staging collector for synthetic contributions;
  do not cast real ballots solely to test analytics.
