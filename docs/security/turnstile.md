# Turnstile and abuse protection

**Status:** Implemented on `feat/turnstile-abuse-protection` · **Recorded:** 14 November 2026
**Decision:** [D32](../governance/decision-register.md) — Cloudflare Turnstile is part of the security programme for abuse-prone unauthenticated actions. Server-side verification is mandatory. Routine challenges must not interrupt authenticated voting.
**Related:** [Known gap 15](../status/known-gaps.md), RFC 0001 I10, issue #38.

This document is the operating contract for Cloudflare Turnstile and the shared
rate limiter on Engage. It covers what is protected, how enforcement is
configured, what fails and how, what is sent to Cloudflare, and what is still
missing.

## Protected actions

Only unauthenticated actions that spend money, send email, create an account or
publish user content are challenged. The set is deliberately small.

| Action | Route | Turnstile action | Shared rate limit |
|---|---|---|---|
| Public priority submission | `POST /api/sense-box` | `sense-box` | 10 per 10 minutes per address |
| Magic-link sign-in and first-time registration | `POST /api/auth/sign-in/magic-link` | `signin` | 10 per 10 minutes per address |
| Email sign-up, if it is ever enabled | `POST /api/auth/sign-up/email` | `signup` | 5 per hour per address |

Magic-link requests are the only reachable account-creation path today: the
first sign-in with a new email creates the account. Password sign-in and
password reset are **not enabled** in this deployment, so there is no reset
route to protect. `/sign-up/email` is protected defensively in
`src/lib/turnstile-guard.ts` so enabling email/password later cannot silently
expose it.

### Deliberately not challenged

- Authenticated voting (`POST /api/votes`), deliberation and endorsements
  (`POST/PATCH/PUT/DELETE /api/comments`), amendments and all other
  authenticated writes. These already require a verified session, and D32 says
  routine challenges must not interrupt authenticated voting.
- Passkey sign-in, Google OAuth initiation and callbacks, session reads.
- Transactional endpoints authenticated by their own secret: the Resend webhook
  (signature), cron jobs (bearer token), and unsubscribe links (signed token).
- Public reads, including the read-only `/api/v1` catalogue.

A route test proves authenticated voting succeeds without any Turnstile call
and without consuming a rate-limit slot.

## Configuration

| Variable | Where | Purpose |
|---|---|---|
| `TURNSTILE_SECRET_KEY` | Server only | Siteverify secret. Never sent to the browser, never logged. |
| `PUBLIC_TURNSTILE_SITE_KEY` | Rendered to the browser | Site key for the widget. Public by design. |
| `TURNSTILE_ENFORCEMENT` | Server | `on` forces enforcement; `off` disables it; unset uses the default. |
| `TURNSTILE_EXPECTED_HOSTNAME` | Server, optional | When set, a siteverify response for another hostname is refused. |
| `RATE_LIMIT_SECRET` | Server, optional | Key for hashing client addresses. Falls back to `BETTER_AUTH_SECRET`, then `SESSION_SECRET`. |

### Enforcement states

`turnstileConfiguration()` in `src/lib/turnstile.ts` resolves one state:

| Mode | Keys | State | Protected routes |
|---|---|---|---|
| Production (default) | secret + site key | `enforced` | Require a valid token |
| Production (default) | either missing | `misconfigured` | **Fail closed**: `503` and an operational error |
| Any, `TURNSTILE_ENFORCEMENT=on` | secret + site key | `enforced` | Require a valid token |
| Any, `TURNSTILE_ENFORCEMENT=on` | either missing | `misconfigured` | Fail closed |
| Non-production, unset | any | `disabled` | Allowed without a challenge |
| Any, `TURNSTILE_ENFORCEMENT=off` | any | `disabled` | Allowed without a challenge |

Rules that matter operationally:

- Production never silently allows a protected request because Turnstile is not
  configured. It reports `503` and logs `turnstile_misconfigured` (at most once
  a minute) so the deployment is visibly broken rather than silently open.
- Local development, preview and CI work without keys because enforcement is
  off outside production. Do not set `TURNSTILE_ENFORCEMENT=on` there unless
  you also have keys.
- `TURNSTILE_ENFORCEMENT=off` is an incident control. Turning it on in
  production removes the challenge for the protected routes above; record why
  and restore it.
- The public site key and the server secret must belong to the same Cloudflare
  Turnstile widget.

Adding a protected action means adding a rule in `RATE_LIMITS`
(`src/lib/rate-limit.ts`) and an entry in `PROTECTED_AUTH_ROUTES` or a guard
call in the route. Do not invent per-route limits.

## Failure behaviour

All messages are plain language and safe to show in the interface. None includes
a token, a secret, a stack trace or a Cloudflare error code.

| Situation | HTTP | Code | What the user sees |
|---|---|---|---|
| No token supplied | 400 | `TURNSTILE_REQUIRED` | "Complete the verification check and try again." |
| Token rejected (`invalid-input-response`) | 400 | `TURNSTILE_INVALID` | "The verification check didn’t pass. Try it again." |
| Token expired or already used (`timeout-or-duplicate`) | 400 | `TURNSTILE_EXPIRED` | "That verification check has expired. Complete it again." |
| Action or hostname mismatch | 400 | `TURNSTILE_INVALID` | Same as a rejected token |
| Cloudflare timeout, 5xx, non-JSON response | 503 | `TURNSTILE_UNAVAILABLE` | "Verification is temporarily unavailable. Try again in a moment." |
| Secret or site key missing while enforcement is required | 503 | `TURNSTILE_MISCONFIGURED` | "Verification is temporarily unavailable. Try again later." |
| Over the shared limit | 429 | `RATE_LIMITED` | "Too many attempts. Please wait a few minutes and try again." |

Siteverify is called with a 5-second abort signal. A malformed body from
Cloudflare is treated as unavailable, not as a pass. Tokens are single-use:
Cloudflare's `timeout-or-duplicate` response is reported as expired, which is
what a replayed token looks like.

## Client widget

`src/components/ui/turnstile.tsx` renders the Cloudflare widget with explicit
rendering and writes the token to a hidden `cf-turnstile-response` field, so
normal form serialisation carries it. It is used on the Sense Box form and the
magic-link sign-in form.

- With no `PUBLIC_TURNSTILE_SITE_KEY` it renders nothing. Enforcement remains a
  server decision; the form still works where enforcement is disabled.
- The script is loaded once per page. Failure to load shows an inline warning
  with a **Try again** action, not a blocking dialog.
- The widget container reserves its height, so loading it does not shift the
  form.
- `theme: "auto"` follows the operating-system colour scheme. The component
  adds no motion of its own; the widget honours the platform's reduced-motion
  setting.
- A rejected submission dispatches `engage:turnstile-reset`, which asks the
  widget for a fresh token. Tokens are single-use, so retrying with an old token
  would always fail.
- Errors are announced by an `alert` region; the verification prompt is
  associated with the widget group for screen readers.

## Privacy: what is sent to Cloudflare

- The browser loads Cloudflare's Turnstile script and widget. Cloudflare sees
  the same connection metadata any third-party embed receives.
- Siteverify is called **server to server** with the token and the secret. No
  member identity, email address, ballot choice, session cookie or client IP is
  sent. `remoteip` is deliberately omitted.
- Verification results are not stored. Only the allow/refuse outcome affects the
  request.
- The application log records the failure reason and Cloudflare's error codes,
  never the token, secret or client address.

## Shared rate limiting

`src/lib/rate-limit.ts` implements a MongoDB fixed-window counter. It is shared
by every application instance, unlike a per-process memory limiter.

- Collection: where the deployment already keeps operational data
  (`rate_limits`).
- Document: `_id` (derived hash), `action`, `identifierHash`,
  `windowStart`, `expiresAt`, `count`.
- Identifier: HMAC-SHA256 of `action:address` keyed with `RATE_LIMIT_SECRET`
  (or the auth/session secret). A plain digest of an IPv4 address is reversible,
  so raw addresses are never stored.
- Address source order: `cf-connecting-ip`, `x-real-ip`,
  `x-forwarded-for` (first value), then the adapter's socket address. This
  matches the order Better Auth uses. Forwarded headers are trusted because the
  deployment terminates at Cloudflare and a single reverse proxy.
- Atomicity: the increment and its result come from one `findOneAndUpdate`, so
  concurrent instances cannot lose counts. A duplicate-key race on the first
  insert is retried once.
- Expiry: `expiresAt` has a TTL index (`expireAfterSeconds: 0`). TTL cleanup is
  best effort; the window index is part of the key, so a late delete can never
  grant extra requests in a later window.
- Responses carry `Retry-After` and set `cache-control: private, no-store`.

Rate limiting runs before verification, so an unauthenticated flood cannot
amplify calls to Cloudflare.

## Operational runbook

1. **Protected forms return 503 with `TURNSTILE_MISCONFIGURED`.** The secret or
   site key is missing while enforcement is required. Set both from the same
   Cloudflare widget. This is intentional fail-closed behaviour.
2. **Protected forms return 503 with `TURNSTILE_UNAVAILABLE`.** Cloudflare is
   unreachable, slow, or returning an error. Check outbound HTTPS from the app
   container and Cloudflare's status. Do not disable enforcement as the first
   response.
3. **Everyone is rate limited.** Check the proxy headers reaching the app. If
   `cf-connecting-ip` is absent and all requests share one socket address, the
   limiter correctly treats them as one client. Confirm the reverse proxy
   forwards the header.
4. **Confirm configuration without a browser.** `turnstileConfiguration()` and
   the enforcement matrix above are covered by tests; the state also appears in
   the `turnstile_*` operational log events.
5. **Rotate the secret.** Update `TURNSTILE_SECRET_KEY` and restart. Existing
   tokens issued for the old widget stop verifying; users retry the widget.

## Verification

| Behaviour | Test |
|---|---|
| Enforcement states, including production fail-closed | `src/lib/turnstile.test.ts` |
| Success, invalid, expired/replay, timeout, malformed response, action and hostname mismatch | `src/lib/turnstile.test.ts` |
| Missing/JSON/form token extraction, secret never in a result | `src/lib/turnstile.test.ts` |
| Windows, expiry, hashed identifiers, concurrent budget on real MongoDB, TTL index | `src/lib/rate-limit.test.ts` |
| Sense Box refused without a token, accepted with one, replay reported, 429 after the budget | `src/lib/turnstile-routes.test.ts` |
| Magic-link route refusal and pass-through, route mapping | `src/lib/turnstile-routes.test.ts` |
| Authenticated voting is not challenged and consumes no budget | `src/lib/turnstile-routes.test.ts` |

No test contacts Cloudflare. The verification transport is injected and is
ignored in production, so the seam cannot become a runtime bypass. The
real-MongoDB cases run when `VOTING_TEST_MONGODB_URI` is set, as in CI.

## Not implemented

- **CSP, HSTS, `X-Frame-Options`, `X-Content-Type-Options`.** Separate issue
  #38. Turnstile works without them; adding a CSP requires allowing
  `https://challenges.cloudflare.com` in `script-src` and `frame-src` and must
  not break the widget.
- **General API rate limiting.** Only the actions above are limited. Reads, the
  public `/api/v1` catalogue and authenticated writes are not.
- **CSRF/origin coverage for every state-changing route.** Only some handlers
  compare `Origin`. See [known gap 15](../status/known-gaps.md).
- **Metrics and alerting.** Failures appear in structured logs; there is no
  dashboard or alert on `turnstile_misconfigured` or on 429 volume.
- **Email verification and password reset.** Not enabled, therefore not
  protected. If they are enabled, add them to `PROTECTED_AUTH_ROUTES` and to the
  table above in the same change.
- **Spam scoring of Sense Box content.** Turnstile and the honeypot bound
  automation; they do not judge whether a submission is genuine.
