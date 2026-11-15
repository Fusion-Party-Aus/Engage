# Perimeter security: headers, CSP and origin checks

**Status:** Implemented; the browser harness runs in CI · **Recorded:** 15 November 2026
**Issue:** #38 (security headers, CSP and Origin/CSRF coverage) · **Programme:** RFC 0001 I10
**Related:** [Turnstile and abuse protection](turnstile.md), [API and authorisation](../architecture/api-and-authorisation.md), [Known gap 15](../status/known-gaps.md)

This document is the operating contract for the application perimeter: the
response headers, the Content Security Policy, and the rule for state-changing
requests. It records what is enforced, what Astro already enforces, what is
deliberately allowed, and what is still missing.

## Header set

`src/middleware.ts` applies these headers to every response it sees. The
decision logic is in `src/lib/security-perimeter.ts` so it can be tested
without a server.

| Header | Value | Why |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | Stop a browser re-interpreting a JSON, CSV or PDF response as another type. |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Send a full path to this origin, only the origin to anyone else. |
| `X-Frame-Options` | `DENY` | No page may be framed. Complements `frame-ancestors 'none'` for older clients. |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=()` | Deny capabilities Engage does not use. The list is intentionally short; adding a feature requires removing its denial deliberately. |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | Only sent when HSTS applies (see below). |
| `Content-Security-Policy` | Astro renders the document policy; non-document responses get `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` | See below. |

### HSTS is conditional

HSTS is sent **only** when all of the following are true:

1. `APP_MODE` is exactly `production`.
2. HTTPS is provable: the first `X-Forwarded-Proto` value is `https`, **or**
   the request URL is HTTPS, **or** the trusted public origin
   (`PUBLIC_ORIGIN`, falling back to `BETTER_AUTH_URL`) is HTTPS.

A development, test or preview server never sends it, and a production server
whose request, forwarded protocol and configured public origin are all HTTP
does not either. This avoids pinning a localhost or plain-HTTP host for a year.
`includeSubDomains` is included; `preload` is deliberately not submitted.

## Content Security Policy

The policy is configured with Astro's built-in CSP in `astro.config.mjs`.
Astro hashes its own inline scripts and styles at build time, so `script-src`
uses hashes rather than `'unsafe-inline'`. For on-demand pages Astro renders
the policy as a `Content-Security-Policy` **response header**; a static page
would use a `<meta>` element, where `frame-ancestors` would be ignored.

### Directives

```
default-src 'self'
base-uri 'self'
object-src 'none'
frame-ancestors 'none'
form-action 'self'
img-src 'self' https:
font-src 'self'
connect-src 'self' https://challenges.cloudflare.com https://analytics.fusionparty.org.au
frame-src https://challenges.cloudflare.com
manifest-src 'self'
worker-src 'self'
script-src 'self' https://challenges.cloudflare.com https://analytics.fusionparty.org.au <Astro hashes>
style-src 'self' <Astro hashes>
style-src-attr 'unsafe-inline'
```

### Every external host, and why

| Host | Directives | Reason |
|---|---|---|
| `challenges.cloudflare.com` | `script-src`, `frame-src`, `connect-src` | Cloudflare Turnstile. `api.js` is the widget script, the challenge renders in a frame, and the client talks to the challenge endpoint. See [turnstile.md](turnstile.md). |
| `analytics.fusionparty.org.au` | `connect-src`, `script-src` | First-party Plausible. The bundled tracker posts events to `/api/event` with `fetch`; the script source is allowed for the hosted tracker variant. See [analytics-tracking.md](../analytics-tracking.md). |

`img-src` allows any HTTPS origin because a proposal attachment may be an
absolute URL (`saveProposal` accepts `https://…`). Everything else is
same-origin: fonts, bundles, the web manifest and the service worker.

### The one deliberate `'unsafe-inline'`

`style-src-attr 'unsafe-inline'` is required by existing inline `style`
attributes. A hash-based `style-src` cannot cover attributes, and the
application uses them for dynamic widths and offsets:

- `src/components/ui/ProposalBallot.tsx` (tally bars)
- `src/pages/index.astro` (participation progress)
- `src/pages/admin/proposals/[slug].astro` (vote tallies)
- `src/components/member/AttentionQueue.astro`, `MemberOnboarding.tsx`,
  `src/components/BranchWork.tsx`, `src/components/ui/toggle-group.tsx`

The allowance is scoped to attributes only: `<style>` elements and stylesheet
links remain restricted to `'self'` plus Astro's hashes. `script-src` has no
`'unsafe-inline'`, and no directive anywhere permits `'unsafe-eval'`.

If the inline attributes are removed, delete this resource from
`CSP_STYLE_ATTRIBUTE_RESOURCES` and the browser check will keep it honest.

### Non-document responses

Astro only renders a document policy for pages. The middleware adds
`default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`
to JSON, CSV and PDF responses that do not already have a policy, so an API
response can never be framed or treated as a document. It never replaces a
policy Astro already rendered.

### Development limitation

Astro does not support CSP hashing in `astro dev` (upstream limitation), so the
development server sends the other headers but no CSP. The policy is verified
against a production build with `npm run build` and a standalone server, which
is the deployment shape.

## Origin and CSRF rule

### What Astro already covers

`astro.config.mjs` keeps `security.checkOrigin: true`. Astro's middleware runs
before user middleware and refuses a form-like, unsafe request when any of
these hold:

- `Sec-Fetch-Site` has a value other than `same-origin` or `none` (so
  `cross-site` and `same-site` are refused regardless of `Origin`), or
  `Sec-Fetch-Site` is absent and `Origin` differs from the request URL origin.

`GET`, `HEAD` and `OPTIONS` are skipped, and so is any content type that is not
form-like (`application/x-www-form-urlencoded`, `multipart/form-data`,
`text/plain`). It deliberately exempts JSON and other content types because a
browser preflights those, and it allows a request with no `Origin` when
`Sec-Fetch-Site` is absent. It compares against the **request URL** origin,
which behind a TLS-terminating proxy is localhost unless
`security.allowedDomains` matches the public host. The configuration now trusts
`engage.fusionparty.org.au` over HTTPS so that form posts are compared against
the real public origin in production.

### What the middleware adds

For `POST`, `PUT`, `PATCH` and `DELETE` on every route, including `/api/auth/*`
and `/api/v1/*`:

| Condition | Result |
|---|---|
| `Sec-Fetch-Site: cross-site` | **403**, whatever the content type or Origin |
| `Origin` present and not equal to the trusted public origin | **403** |
| `Origin` present and equal to the trusted public origin | allowed |
| `Origin` absent, no session or dev cookie | allowed (cron, webhook, server-to-server) |
| `Origin` absent, session or dev cookie present | **403** |
| `Origin: null` | **403** |
| `GET`, `HEAD`, `OPTIONS`, `TRACE` | not checked |

The trusted origin is resolved by `resolvePublicOrigin`: `PUBLIC_ORIGIN`, then
`BETTER_AUTH_URL`, then the request origin. Forwarded `Host` headers are never
trusted for this decision.

Rejections are `403` with the plain-text body `Cross-site request blocked.`,
`cache-control: no-store`, and the normal perimeter headers. Nothing about the
request (cookies, tokens, origin) is logged or echoed.

**Why reject an absent Origin with a cookie?** Every current browser sends
`Origin` on state-changing `fetch` and form submissions. A cookie-authenticated
request without it is either a very old client or an attempt to avoid the
check. Bearer-authenticated cron jobs and provider webhooks carry no browser
cookie and continue to work. This was the preferred behaviour in the issue.

### Deliberate exemptions

- **Bearer cron** (`/api/email/digest`, `/api/cron/membership-verification`)
  and provider webhooks (Resend, unsubscribe) send no Origin and no cookie.
- **Same-origin fetch from admin and member pages** sends a matching Origin.
- **Better Auth callback routes** are GET redirects; passkey and sign-in POSTs
  are same-origin and carry Origin.
- **Native form posts** (the member notification preference form) are
  same-origin and carry Origin.
- No per-route Origin check was removed. Routes that compare Origin themselves
  keep that check as defence in depth.

## Verification

Unit tests: `src/lib/security-perimeter.test.ts` (19 tests) cover the exact
headers on HTML and JSON responses, the HSTS condition, every origin outcome,
the cookie detector, the CSP hosts and directives, the absence of
`unsafe-eval`, and that `astro.config.mjs` keeps `checkOrigin` and wires the
policy.

Browser evidence (production build, real Chromium, Cloudflare and Plausible
intercepted locally):

```sh
npm run build
ENGAGE_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
  node scripts/security-perimeter-browser.mjs
```

`npm run perimeter:browser` runs the same file. Both forms need a fresh
`npm run build` and a Playwright module supplied outside the application
(`ENGAGE_PLAYWRIGHT_MODULE`); Playwright is never added as a dependency.

Observed on 15 November 2026: zero CSP violations, console errors or failed
requests on `/`, a proposal page, `/member/` and `/sense-box/`; the Turnstile
script and frame requests and the Plausible script and event requests reached
the network layer; JSON API headers and the non-document policy were present;
same-origin fetch returned 200 and a native same-origin form post returned 303;
a browser cross-origin POST returned 403; a JSON cross-origin POST and an
absent-Origin request with a dev session cookie each returned 403; a server-to-server
POST returned 200 and a Bearer cron call returned 409 (CRM disabled) rather
than 403.

### In CI

`.github/workflows/ci.yml` runs this harness in the step
`Perimeter security browser verification`, after `pnpm build` and after the
Playwright 1.57.0 install. It reuses the module the member lifecycle step
installed through the same `ENGAGE_PLAYWRIGHT_MODULE` path; nothing is
installed twice and Playwright stays out of the application.

The harness is safe to run unattended:

- an overall 180-second deadline (`ENGAGE_PERIMETER_TIMEOUT_MS`) stops the run
  and fails the step instead of hanging the job;
- Chromium and the spawned preview server are always stopped, including after a
  failed assertion, with a `SIGKILL` fallback if `SIGTERM` does not finish;
- any failed assertion, console error, page error, failed request or CSP
  violation exits non-zero, including one that appears after a page's own check;
- Cloudflare and Plausible are intercepted and the database is the in-memory
  seed, so the run contacts no external service.

On every pull request it therefore proves the header set and document policy on
four pages, the non-document policy on JSON, that every allowed external host is
still permitted by the policy, that same-origin fetches and native form posts
are accepted, and that cross-origin and cookie-without-Origin writes are
refused.

`src/lib/ci-workflow.test.ts` fails the suite if the step is removed, moved
before the build or before the Playwright install, installs its own copy, or if
`perimeter:browser` and the harness file drift apart.

**Remaining gap:** CI runs the production build directly on the runner with the
in-memory database, not through Cloudflare/Coolify or a real MongoDB. It proves
the application's own policy and origin rule, not the proxy path (headers on
static assets, Astro's early 403) or a real Turnstile or Plausible deployment.
Production responses remain a deployment check.

## Residual risk and what remains

- **Astro's early 403 has no perimeter headers.** Astro's origin middleware runs
  before user middleware, so a cross-site form post it refuses is returned
  before this middleware can add headers. It is a 403 plain-text response, so
  the impact is small; a reverse proxy should add the same headers if complete
  coverage is required.
- **Static assets bypass middleware.** `@astrojs/node` serves `/_astro/*`,
  icons and other built files before the application handler. They do not get
  `nosniff` or the other headers. The reverse proxy (Cloudflare/Coolify) should
  add them.
- **No CSRF tokens.** The design relies on Origin, `Sec-Fetch-Site` and
  `SameSite=Lax` cookies. There is no per-request token or double-submit
  cookie. A browser that omits both Origin and `Sec-Fetch-*` while sending a
  cookie is refused, but a compromised same-origin script is not addressed by
  CSRF controls. A cookieless browser request without Origin is
  indistinguishable from a server-to-server call; the public state-changing
  routes (Sense Box, magic-link sign-in) additionally require Turnstile and a
  rate-limit slot.
- **`security.allowedDomains` names the production host.** Staging or a second
  deployment on another hostname still falls back to the adapter's localhost
  origin for Astro's form-post check. The middleware's own comparison uses
  `PUBLIC_ORIGIN`, so JSON writes remain protected; native form posts on such a
  host would need the host added (or the deployment moved to the production
  hostname).
- **Hash-based CSP only.** There is no nonce and no `'strict-dynamic'`. If a
  future feature needs runtime-injected inline scripts, it must add a nonce or
  supply hashes; do not add `'unsafe-inline'` to `script-src`.
- **Production requires a configured origin.** If `PUBLIC_ORIGIN` and
  `BETTER_AUTH_URL` are missing or non-HTTPS in production, the fallback is
  the request origin, which behind the proxy is localhost; state-changing
  browser requests would then be refused. Set the public origin as part of the
  deployment.
- **No reporting endpoint.** There is no `report-uri`, `report-to` or
  `Reporting-Endpoints` configuration, so violations are visible only in a
  developer console or browser telemetry.
- **Inline style attributes remain permitted** (see above). Removing them is
  the only way to tighten `style-src-attr`.
- **`img-src https:` is broad** because proposal attachments may be external.
  Restrict it to `'self'` if attachments become same-origin only.
- **HSTS `includeSubDomains` and no preload.** It applies to subdomains of
  `engage.fusionparty.org.au` (there are none today) and does not broaden to
  `fusionparty.org.au`. Preload is a separate decision and is not requested
  here.
- **Production headers were not observed** through Cloudflare/Coolify in this
  slice. The build and standalone server were verified; the proxy path remains
  a deployment check.
- **The browser script runs in CI but is not a production check.** It runs the
  production build against the in-memory seed, with Cloudflare and Plausible
  intercepted, so a real provider outage, the proxy path and production data are
  not covered. The unit tests remain the fast regression gate.
- **Shiki/Markdown.** Astro warns that Shiki emits inline styles that a hash
  policy cannot allow. Engage has no Markdown pages today; do not add one
  without addressing its styles.
