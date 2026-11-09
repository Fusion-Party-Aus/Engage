# Member onboarding, verification and retention

Implementation date: 9 November 2026 (Australia/Melbourne).
Baseline: `3dc0f7661feac1ac2969b413bc3260e13dc6f0fa`, including merged digest work (PR #14). Changed existing files were compared by blob SHA against this commit before publication.

## Audit and root causes

| Area | Existing implementation | Finding / resulting change |
| --- | --- | --- |
| Registration/authentication | Better Auth, Mongo adapter, email magic links, Google, passkeys; server-authorised session roles | Retained. Account creation enters pending membership; there is no separate member-submitted verification application or rejected status. Creation is recorded as the verification request. Registration explains new-account digest opt-in. |
| Verification | Administrator members POST/PATCH; `saveMember` persists status and promotes eligible pending preferences | Approval sent directly through Resend in plain text. No durable message claim, provider receipt or webhook correlation. Concurrent PATCH requests could send twice, re-enabling an account sent another approval, and failures were only exposed in the request result. Added durable claims and branded notices. |
| Rejection | Status enum is pending / verified / suspended | No rejection notification existed. Do not invent a rejected state or equate suspension with application rejection. A verified-to-suspended change now has a separate account-status notice. |
| Email infrastructure | Resend, `engagement_email_outbox`, signed webhooks, receipt reconciliation, bounce/complaint suppression | Reused those collections and verification webhook handler. Verification messages carry `kind: verification`; digest rate denominators exclude these. Early verification receipts reconcile immediately after provider acceptance even while the digest job is disabled. |
| Historical approval | Previous code did not store notification receipts | Absence is unknown history, not proof of non-delivery or consent. Unknown verification dates are held for review in re-engagement rather than inferred from mutable membership timestamps. |
| My Engage | Onboarding, outstanding decisions, closing within seven days, participation history, proposal activity, catch-up, branch activity, passkeys, preferences | Preserved. Added a state-aware primary action, persistent copyable Engage URL, bound-revision discovery checks, all eligible amendment ballots (including undated ballots), and a fixed voting anchor. The dashboard and digest share their outstanding-ballot discovery logic. |
| Preferences/digests | Independent essential, Engage digest and general categories; fixed existing-account cohort; new accounts opt in; RFC8058 unsubscribe; suppression; existing cron route | Preserved. No scheduler, preference migration, weekly sender, live cohort recapture or duplicate reminder implementation added. |
| Eligibility | Backend verified membership, recognised branch + active electorate, visibility, deadline and bound ballot checks | Discovery now excludes unbound proposal ballots and matches votes against the current ballot revision. Does not change voting permissions, choices, result calculations or revision binding. |
| Analytics | Existing Plausible tracker with hostname gate and strict property/URL allowlist | Extended allowlist with three property-free interaction events. Private backend records support authoritative transitions and conversion cohorts. |

## Transactional delivery

A fixed `_id` (`verification:<status>:<memberId>`) in the existing outbox prevents duplicate claims under MongoDB's built-in unique `_id` index. Resend receives the same idempotency key. One approval is attempted per account, including concurrent approvals and disabled/enabled toggles. This deliberately does not announce repeated re-approvals. Status notices use a separate claim.

The approval email confirms verification, qualifies ballot eligibility, contains **Start voting**, links to `/member/?intent=vote&source=verification#outstanding-ballots`, and includes the persistent `/member/` URL. It includes responsive Horizon HTML and plain text. Sign-in preserves this fixed return destination for email/Google/passkey flows. The shared redirect validator rejects off-origin, backslash, control-character and API destinations.

Account-notification opt-outs and suppression are checked before dispatch. Digest opt-outs do not disable verification notices. No unsubscribe token is attached to transactional email. Member preferences remain available through its footer.

State meanings: `queued` = claimed, `sending` = handoff about to occur, `sent` = accepted by provider (not proof of delivery), `held` = ambiguous outcome, `failed` = configuration failed before handoff, `suppressed` = blocked by preferences/suppression. Signed webhooks add delivered/bounced/failed timestamps and suppress bounce/complaint recipients. Administration → Member engagement shows verification outcomes separately.

Never delete or resend a held/sending row just because the request failed. Inspect the provider first. There is no automatic resend of ambiguous outcomes. Configuration failures and stranded queued/sending claims require operator review; no additional worker or scheduler was added.

The existing member write and outbox insert are separate database operations. A process crash in between can still leave a verified member without a claim. This is an explicit remaining reliability limit; a future atomic membership/outbox transaction or approved reconciliation flow is needed to close it. A crash after claim never automatically creates a second message. Do not run historical reconciliation as a deployment side effect.

## My Engage states

| Backend state | Primary action |
| --- | --- |
| Pending (including accounts with no membership document) | View application status; confirm account details |
| Suspended | Review membership status and contact an administrator |
| Verified, no votes, eligible outstanding ballots | Cast your first vote |
| Verified, no votes, no eligible outstanding ballots | Explore open ballots; explicit no-eligible-ballots explanation |
| Active participant, outstanding ballots | Review outstanding ballots |
| Active participant, caught up | View participation history |

There is no invented 'unverified application' distinction. Existing account/onboarding controls, history and notification categories remain the source of their respective detail screens. Server eligibility is checked on every visit and vote.

## Re-engagement preview

See [the consent assessment](consent-assessment.md) for the Australian framework, historical disclosure evidence and consent-state rules. Only national administrators can GET `/api/admin/email/reengagement?cutoff=2026-10-01`. Choose the real historical rollout cutoff after confirming release history; the example is not a recommended live cutoff. The endpoint reads collections and returns aggregate eligible/excluded/suppressed/needs-review counts and reason buckets. National administrators can add `&include=members` to inspect member IDs, consent states, classifications and reasons for audience review; this returns no addresses or vote choices. Both modes respond with `Cache-Control: private, no-store`. It sends nothing and writes nothing. There is intentionally no campaign-send endpoint.

Eligibility requires a verified, enabled account with proven email; a known historical verification window; no Engage opt-out or suppression; no accepted/pending/held verification notice; no formal vote; and no recent session/My Engage/eligible-ballot activity. Explicit Engage opt-in qualifies; legacy members without recorded preferences are retained for scoped lawful-basis assessment. A reviewed inferred basis can qualify them without general-communications permission. General/newsletter preferences are separate and do not control this audience. Unknown cohort, legal basis or verification dates appear as needs-review rather than refusal/exclusion. See `consent-assessment.md` for evidence requirements.

`synthetic-campaign-dry-run.json` is a ten-member regression fixture: **2 eligible, 5 excluded, 1 suppressed, 2 needing review**. These are not production counts. One synthetic legacy assessment is included to demonstrate inferred-consent qualification without express consent; it is not evidence about real members. No live database or delivery credentials were available. Run the read-only endpoint against the authorised deployment to obtain the actual report.

The proposed one-time [message copy](reengagement-message.md) remains a draft. Audience review and sending require explicit approval. This implementation cannot send a historical campaign, even accidentally.

## Validation and deployment notes

- `npm run check`: passed with zero errors/warnings and five pre-existing unused-import hints.
- `npm test` locally: 136 passed, 15 conditional MongoDB tests skipped, zero failures. Final CI: 151 passed, zero skips/failures. Covers concurrent claim deduplication, repeat status updates, suppression/preferences, ambiguous sends, early webhook reconciliation, redirect validation, HTML escaping, lifecycle states, mature conversion cohorts, historical voter exclusion, dry-run access/eligibility/read-only behaviour and existing digest opt-outs.
- Built-server render smoke checks: `/member/`, `/member/?view=notifications`, and an anonymous verification CTA arrival all returned 200 and included the expected copy controls, digest controls and preserved post-login destination. These render checks do not establish visual layout or browser interactions.
- `npm run build`: passed. `git diff --check`: passed. No lint script is defined by this repository; no new lint stack was introduced.
- GitHub CI run `42570606219` passed all 150 tests against an isolated MongoDB replica set, with zero skips; typecheck and build also passed.
- Real MongoDB tests are conditional on `VOTING_TEST_MONGODB_URI` / `AUTH_TEST_MONGODB_URI`. No service is configured here. In-memory coverage does not establish real MongoDB concurrency or authentication integration behaviour.
- Local Chromium failed at process singleton/socket startup. The isolated CI browser then captured **10 actual screenshots**: sign-in, verified My Engage with no eligible outstanding ballots, Notifications, approval email and suspension email, each at 1440×1000 and 390×844. Copy-URL interaction, lifecycle/email horizontal-overflow checks and uncaught-browser-error checks passed. The first browser run found a mobile email overflow; fixed table sizing and text wrapping, then reran successfully. Full keyboard/a11y audit, other lifecycle states in-browser, actual inbox delivery and real email-client rendering remain rollout checks. `verification-approved.html` and `verification-suspended.html` are exact synthetic templates, with no real member data.
- Final source verification: [CI run 42571174992](https://github.com/Fusion-Party-Aus/Engage/actions/runs/42571174992) at `8d457fc48abea97a103a221833475f52e17a8253` passed typecheck, all 151 tests against MongoDB, production build and browser checks. Its `member-lifecycle-screenshots` artifact contains ten PNGs plus `verification.json`. Playwright is installed only into a temporary CI directory, outside application dependencies. The browser script disables real email delivery and uses only preview memory data.
- No production deploy, member communications, historical backfill, live preference changes or provider-setting changes were performed.

Before an authorised deployment: back up existing collections, run the MongoDB integration suite on an isolated replica set, inspect desktop/mobile My Engage states and both email templates, confirm canonical HTTPS origin and existing Resend sender/webhook configuration. Use a synthetic account to verify approval → one accepted receipt → one delivered receipt → sign-in → eligible ballot → successful vote. Check admin funnel and a read-only campaign preview. Do not enable or reconfigure the digest scheduler as a side effect of this release. No production action is authorised by these notes.

## CI fixture compatibility

The first PR run (`42570218816`) failed before application checks: MongoDB 8.0 exited with fatal message 12257600 on the hosted runner kernel, followed by `ECONNREFUSED`. The [runner maintainers recommend temporarily using Ubuntu 22.04](https://github.com/actions/runner-images/issues/15005); MongoDB tracks Ubuntu kernel detection in [SERVER-131779](https://jira.mongodb.org/browse/SERVER-131779). The application-check job now uses Ubuntu 22.04 while retaining the same MongoDB 8.0 replica set and test suite. Production images and deployment workflows are unchanged. Revisit the runner pin once a published compatible MongoDB 8.0 patch has been verified.
