# Member engagement administration repair

## Production diagnosis

On 9 November 2026, an unauthenticated POST to the production test endpoint with the correct public Origin reproduced HTTP 403, `Cross-site POST form submissions are forbidden`. With JSON content type, it passed Astro's form guard and returned the endpoint's HTTP 403 `Invalid origin`. Neither request reached authentication or Resend. The source compared Origin to the adapter request URL rather than the configured public origin, consistent with an internal HTTP origin from the reverse proxy.

This establishes a pre-provider blocker. Production Resend credentials, sender-domain verification, suppression state and inbox delivery remain unverified. No production message or receipt was obtained. Zero member digest counts were not used as evidence of test failure.

## Repair and dashboard

JSON submission now uses explicit trusted configured-origin validation, retaining admin authentication and cross-site rejection without trusting forwarded host headers. Success requires provider acceptance, recipient and message ID. Sending state, actionable errors and safe receipt details are visible. Explicit provider 4xx rejection is recorded as failed; network uncertainty, malformed acceptance and provider server failures remain held for inspection. Raw provider bodies and credentials are never exposed.

Self-only admin history contains the latest five tests and reconciles early webhook receipts even with the scheduler off. The existing atomic calendar-minute claim is retained: one test per administrator per calendar minute. The actual Horizon sample template is retained and tests remain excluded from member statistics. Test bounce/complaint receipts do not mutate member preferences.

The dashboard provides responsive KPI cards, delivery bars, 7/30/90-day email periods, participation denominators, eligibility preview and expandable diagnostics. Bars use mutually exclusive current states. Unsubscribe rate uses accepted recipients in the selected period and opt-outs dated within it. Participation covers all mature tracked cohorts, separately labelled. Zero and unavailable values differ. No raw API instructions appear in the interface.

## Verification evidence

- Three regressions failed on the old source and passed after repair: proxy-origin rejection, misleading status for explicit provider rejection, missing recipient confirmation.
- Full Node suite: 159 tests, 144 passed, 15 skipped, zero failed. Optional real-MongoDB cases require `VOTING_TEST_MONGODB_URI`.
- `astro check`: zero errors, zero warnings, five existing unused-import hints.
- `astro build`: passed.
- `node scripts/admin-engagement-http.mjs`: real Astro HTTP stack, synthetic accounts and mocked Resend; dashboard render, trusted proxy origin, 401 anonymous, 403 member/cross-site, accepted receipt and recipient, 429 repeat send, history and read-only preview all passed. Exactly one mocked provider call and zero production sends.
- Happy DOM interaction harness: sending/disabled state, JSON request, recipient acceptance, provider receipt, actionable rejection and read-only preview passed. This does not verify browser layout.

## Outstanding requirements

Not deployed. A controlled deployment and authenticated production self-test are required. Verify Resend sender/domain, provider acceptance, final receipt and signed webhook. Configuration presence alone does not establish validity. Do not enable scheduled digests or bulk communications or change member preferences during verification.

Desktop and approximately 390px screenshots are not complete. Local Chromium failed with `socket() failed: Operation not permitted`; official alternative headless downloads failed; the shared browser could not reach the isolated preview and its policy refused local-file access. No screenshots are presented as verified evidence. Capture before/after on the base and repair branches and verify overflow, keyboard focus, disclosures, announcements and all feedback states before release.

Historical per-member ballot-availability intervals do not exist. The dashboard labels opportunity-available and no-opportunity groups unavailable and reports mature members as availability unknown. It does not infer no opportunity from no vote, no visit or today's ballots. Reliable opportunity-adjusted return metrics need prospective complete ballot/electorate history, including revisions and membership changes. They cannot safely be reconstructed from current lifecycle data alone.
