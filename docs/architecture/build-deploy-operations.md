# Build, deployment and operations

**Status:** Current · **Verified:** 15 November 2026

This page is the engineering path. For host-specific procedures, the older deployment documents remain useful but must be read with their dates: `docs/coolify-deployment.md`, `docs/coolify-cutover-checklist.md`, `docs/operations.md`, `docs/nuc-deployment.md`. Where they conflict with this page, treat this page as current and record the drift.

## Local development

```sh
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` regenerates the changelog snapshot, then starts Astro.

If `MONGODB_URI` is absent and `APP_MODE` is not `production`, Engage uses an in-memory database seeded with the 78 baseline proposals from `src/data/policies.json`. This is a development convenience, not a production mode. It does not enforce indexes, projections or transactions.

Development sign-in is available only when `APP_MODE` is exactly `development`, `test` or `preview`. A missing or unknown mode fails closed. The dev cookie is ignored in production.

## Environment

Configuration is read through `runtimeEnv(locals)` and typed as `PlatformEnv`. `.env.example` is the reference. Groups:

| Group | Variables |
|---|---|
| Runtime | `APP_MODE`, `PUBLIC_ORIGIN`, `BETTER_AUTH_URL`, `SESSION_SECRET` |
| Database | `MONGODB_URI`, `MONGODB_DB_NAME`, initial Mongo credentials for Compose |
| Auth | `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| Email | `RESEND_API_KEY`, `AUTH_EMAIL_FROM`, `RESEND_WEBHOOK_SECRET` |
| Jobs | `ENGAGE_CRON_SECRET`, `ENGAGE_EMAIL_SECRET`, `ENGAGE_DIGEST_ENABLED` |
| Operations | `GOVERNANCE_SCHEDULER_WARN_HOURS`, `GOVERNANCE_SCHEDULER_STALE_HOURS`, `DIGEST_WARN_HOURS`, `DIGEST_STALE_HOURS`, `MEMBERSHIP_VERIFICATION_WARN_HOURS`, `MEMBERSHIP_VERIFICATION_STALE_HOURS`, `BALLOT_CLOSURE_GRACE_HOURS`, `EMAIL_DELIVERY_WINDOW_HOURS` (optional; defaults in the health section) |
| CRM | `ENGAGE_CRM_*` (base URL, token, membership types, verification flag) |
| Ballots | `BALLOT_ENCRYPTION_MODE`, `BALLOT_ENCRYPTION_KEYS`, active key ID, blind-index key |
| Push | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` |
| Site | `ENGAGE_ALLOW_INDEXING`, CTA, social/state-site JSON, repo URL, OG image |
| Legal | `LEGAL_ACCEPTANCE_ENABLED` |

Rules:

- Never commit `.env` or secrets.
- Production requires a real `MONGODB_URI`; the app throws rather than falling back.
- `BETTER_AUTH_SECRET` must be at least 32 characters.
- Setting `ENGAGE_ALLOW_INDEXING=false` or serving from a non-production host adds `noindex`.
- `FORMAL_BALLOTS_ENABLED` appears in a local env file but is not read by code. Do not rely on it.
- `ENGAGE_PUBLIC_PULSE_POLL` is an inert public-sentiment flag; no poll is implemented.

## Checks and tests

```sh
pnpm check          # astro check (TypeScript + Astro)
pnpm test           # node --test --experimental-strip-types src/**/*.test.ts
pnpm build          # regenerate changelog, then astro build
```

The ordinary suite covers domain logic, API contracts, RBAC, branch participation, revisions, ballot separation, legal acceptance, notifications and security regressions.

Some suites require real MongoDB and are skipped unless configured:

- `voting-mongo.test.ts` (vote uniqueness, encryption, migration)
- parts of `governance-api.test.ts` and migration suites

CI provisions a single-node MongoDB 8.0 replica set. Use the same when changing persistence, indexes, transactions or vote storage. Do not claim a persistence change is verified from the in-memory fallback alone.

### Continuous integration

`.github/workflows/ci.yml` runs on every pull request to `main` and on pushes to `main`, `fix/**` and `codex/**`: install, an isolated MongoDB replica set, `pnpm check`, the documentation link check, `pnpm test`, `pnpm build`, the member lifecycle browser journey, then the perimeter security browser harness.

The perimeter harness (`scripts/security-perimeter-browser.mjs`, also `pnpm perimeter:browser`) starts the built server on the in-memory database and drives real Chromium with Cloudflare and Plausible intercepted. It proves the response headers and CSP, that every allowed external host still reaches the network layer, that same-origin fetches and native form posts are accepted, and that cross-origin and cookie-without-Origin writes are refused. It has a hard 180-second deadline and always stops Chromium and the preview server, so a hung page fails the step instead of the job. Playwright is installed once per job and reused through `ENGAGE_PLAYWRIGHT_MODULE`; it is not an application dependency.

`src/lib/ci-workflow.test.ts` enforces the wiring: the suite fails if the step disappears, moves before the build or before the Playwright install, installs a second copy, or if `perimeter:browser` and the harness file drift apart.

Local use:

```sh
pnpm build
ENGAGE_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs pnpm perimeter:browser
```

The gap: CI runs the production build directly on the runner, not through Cloudflare/Coolify or a real MongoDB. Proxy headers on static assets, Astro's early cross-site 403 and production responses are still deployment checks.

### Verification expectations

For a user-facing change:

- type check, tests and build pass;
- success, empty, loading, error and unauthorised paths are exercised;
- the rendered page is inspected at mobile and desktop widths where possible;
- console errors and failed requests are checked;
- the server enforces the same rule as the UI;
- raw-control and undefined-token audits in `AGENTS.md` are clean.

Passing CI is necessary, not evidence of good UX.

## Build

```sh
pnpm build
pnpm start          # node ./dist/server/entry.mjs
```

Output is a Node standalone server. The build step regenerates `src/data/changelog.json` from the last 80 non-merge commits. If Git is unavailable, the committed snapshot is preserved, so production builds work without `.git`.

The Dockerfile:

- builds on `node:24-alpine` with corepack/pnpm;
- prunes development dependencies;
- copies `dist`, `src/data`, migration scripts and `vote-storage.ts`;
- runs as the non-root `node` user on port 4321.

`engines.node` is `>=22.23.4` while the image is Node 24. This is a benign skew today; keep it in mind when using Node APIs.

## Deployment topologies

### Docker Compose (Mongo plus app)

`docker-compose.yml` runs MongoDB as a single-node replica set with init and health scripts, plus the app. Ports are loopback-bound and capabilities dropped. `compose.nuc.yml` adds resource caps.

```sh
docker compose -p engage --env-file /opt/engage/.env \
  -f docker-compose.yml -f compose.nuc.yml up -d --no-build --wait
```

### NUC / GitHub Actions

`.github/workflows/nuc-cicd.yml` validates, builds and pushes `ghcr.io/<repo>:sha-<short>` for `linux/amd64`, then deploys to a self-hosted `nuc` runner using `scripts/deploy-nuc.sh`.

The deploy script:

1. pulls the image;
2. writes a release directory under `/opt/engage/releases/<id>`;
3. switches the `current` symlink;
4. runs `docker compose up -d --wait app`;
5. polls `/api/health` up to 15 times;
6. rolls back on failure.

### Coolify

- `docker-compose.coolify-production.yml` runs the app only, on an external `engage_default` network, with 256 MB / 0.75 CPU limits and a `/api/health` healthcheck.
- `docker-compose.coolify-staging.yml` provisions an isolated MongoDB replica set and app.
- The Coolify instance is LAN-only. GitHub cannot reach it, so promotion is polled from the LAN (`scripts/coolify-poll-deploy.sh`, `deploy/systemd/engage-coolify-poll.*`).
- Coolify production has no scheduled tasks enabled. Digest and CRM verification require an external scheduler.

### Health and rollback

- `/api/health` pings MongoDB and reports latency. It is the container healthcheck.
- It also publishes two coarse status strings, `governanceScheduler` and `jobs`. Those never fail the probe: a database failure is 503, while a degraded or failing job still returns 200 so a restart loop cannot hide a missing scheduler. See [Operational health and job records](#operational-health-and-job-records-39).
- A failed health poll triggers the NUC rollback path.
- Database changes are not rolled back by an app rollback. A migration must be backward compatible or have an explicit reversal.
- Keep a current backup before a release that changes schema or indexes.

## Operational health and job records (#39)

**This slice is partial.** Scheduled runs are now recorded and health is inspectable from a command. Production cron wiring, alert delivery and production verification are **not** done here; see [What is still missing](#what-is-still-missing).

There is no in-process scheduler and no metrics backend. Evidence comes from two places:

- the `job_runs` collection, written by every authorised scheduled run;
- live counts of the governance, verification and email collections.

### Job-run ledger

| Field | Meaning |
|---|---|
| `job` | `governance-scheduler`, `ballot-digest` or `membership-verification` |
| `startedAt`, `finishedAt` | Run window. `startedAt` carries a 90-day TTL index |
| `ok` | The job completed without throwing. Counts belong in `summary` |
| `mode` | `apply` or `dry-run` |
| `summary` | Small counts and flags from the job's own report |
| `error` | Short human message. Never a secret, token or provider response |

Rules:

- Only authorised runs are recorded. A `401` or a `409` "not enabled" response is not a scheduled run.
- A dry-run is a real run for observability but performs no governance writes. Health uses apply runs only.
- A failed ledger write is logged as `job_run_ledger_write_failed` and **never** fails the job. The job's own result and error are unchanged either way.
- The ledger is operational evidence, not a governance record. It is retained for 90 days and is not an audit trail; governance events remain authoritative.

### Job cadence

Cadence means how often the external scheduler should call the job. Each job has two recency thresholds:

- **Warn** — the job has missed several expected ticks. `ops:health` reports `degraded` and exits `2`.
- **Fail** — the job's guarantee has definitely not been met. `ops:health` reports `failing` and exits `1`.

A job that has never run reports `failing`, because the absence of evidence is the operational problem.

| Job | Invocation | Documented cadence | Warn (default) | Fail (default) |
|---|---|---|---|---|
| Governance scheduler | `npm run governance:scheduler -- --apply` from cron or a Coolify job | Every 15 minutes is safe; hourly is the practical minimum for deadline accuracy | 2 hours (`GOVERNANCE_SCHEDULER_WARN_HOURS`) | 26 hours (`GOVERNANCE_SCHEDULER_STALE_HOURS`) |
| Ballot digest | `POST /api/email/digest` with `Authorization: Bearer $ENGAGE_CRON_SECRET` | Every 15 minutes while `ENGAGE_DIGEST_ENABLED=true` | 1 hour (`DIGEST_WARN_HOURS`) | 24 hours (`DIGEST_STALE_HOURS`) |
| Membership verification | `POST /api/cron/membership-verification` with `Authorization: Bearer $ENGAGE_CRM_VERIFICATION_CRON_SECRET` | Every 15 minutes while CRM verification is enabled | 2 hours (`MEMBERSHIP_VERIFICATION_WARN_HOURS`) | 24 hours (`MEMBERSHIP_VERIFICATION_STALE_HOURS`) |

Warn is a small multiple of cadence — roughly 4–8 expected ticks, or two hourly scheduler ticks — not a single missed tick. A scheduler jitter, a slow run or one failed provider call must not page anyone: those are covered by the run's own `ok` and error evidence. An exhausted warn threshold means ticks are being missed repeatedly, which is worth knowing within an hour or two rather than a day. Fail is the wide outer bound where the job's guarantee is clearly broken and someone must act.

The digest and verification endpoints are documented as running every 15 minutes, so a 24-hour-only alert would hide 96 missed ticks. The two tiers close that blind spot while keeping normal operation quiet.

### Health command

```sh
MONGODB_URI='mongodb://…' MONGODB_DB_NAME=engage npm run ops:health
MONGODB_URI='mongodb://…' MONGODB_DB_NAME=engage npm run ops:health -- --human
```

`MONGODB_URI` is required; the command never reads the in-memory development database. JSON is the default because it is the alerting input. `--human` prints the same report as a short checklist.

| Exit | Overall state | Meaning |
|---|---|---|
| `0` | `healthy` | Every check is `ok` |
| `2` | `degraded` or `unknown` | Something needs attention but nothing is proven broken, or a check could not run |
| `1` | `failing` | A check proves a scheduled guarantee is not being met, or the database was unreachable |

Overall state is the worst check, ordered `ok < unknown < degraded < failing`.

### Checks and thresholds

| Check | What it reads | States |
|---|---|---|
| `governance-scheduler` | Newest apply entry in `job_runs` | `ok` inside warn; `degraded` past warn, or when the last run completed with errors; `failing` past fail, when the last run failed, or when there is no run |
| `ballot-deadlines` | Matters in Decide whose `ballotClosesAt` passed without `ballotClosedAt` | `ok`; `degraded` within the grace window (the next run will close them); `failing` beyond it |
| `digest` | Newest apply digest entry | `unknown` when digest email is disabled; otherwise `ok` inside warn; `degraded` past warn or when the last run held messages; `failing` past fail, when the last run failed, or when there is no run |
| `membership-verification` | Newest apply entry plus due attempts | `unknown` when the feature is disabled; otherwise `ok` inside warn; `degraded` past warn or when attempts are due; `failing` past fail, when the last run failed, or when there is no run |
| `email-delivery` | Recent `engagement_email_outbox` rows with status `failed` or `held` | `ok` or `degraded` |
| `turnstile` | Existing Turnstile configuration helper | `ok` enforced, `ok` outside production when not enforced, `degraded` when disabled in production, `failing` when misconfigured in production |

Thresholds are named in the report and in every check that applied one. Change them with environment variables; the report records each value, its variable name and whether it is the default or came from the environment. Every job check has both a warn and a fail threshold. If a configured warn value is not below the fail value, that check reports `unknown` with the conflicting values rather than quietly picking one.

| Variable | Default | Effect |
|---|---|---|
| `GOVERNANCE_SCHEDULER_WARN_HOURS` | 2 | Degraded when the last apply run is older |
| `GOVERNANCE_SCHEDULER_STALE_HOURS` | 26 | Failing when the last apply run is older |
| `DIGEST_WARN_HOURS` | 1 | Degraded when the last digest apply run is older |
| `DIGEST_STALE_HOURS` | 24 | Failing when the last digest apply run is older |
| `MEMBERSHIP_VERIFICATION_WARN_HOURS` | 2 | Degraded when the last verification apply run is older |
| `MEMBERSHIP_VERIFICATION_STALE_HOURS` | 24 | Failing when the last verification apply run is older |
| `BALLOT_CLOSURE_GRACE_HOURS` | 2 | Grace before an unclosed deadline is failing rather than degraded |
| `EMAIL_DELIVERY_WINDOW_HOURS` | 24 | Window counted for failed or held email |

### What each state means

- **Governance scheduler degraded.** Runs are being missed past the warn threshold, or the last run left blockers or errors. Nothing advances or closes until a run succeeds.
- **Governance scheduler failing.** Nothing advances at the deliberation deadline or records ballot closure. Voting still refuses an expired ballot at vote time, and officers can still act manually. Run the scheduler with `--apply` and read its report.
- **Ballot deadlines failing.** The scheduler ran (or did not) and a ballot stayed open past its deadline with no closure record. This is evidence about closure, not about a result: no result is recorded by closure.
- **Digest degraded.** The digest is late past its warn threshold, or the last run held messages. Members may not receive ballot reminders.
- **Digest failing.** Members receive no ballot reminders. Check the endpoint's bearer secret, `ENGAGE_DIGEST_ENABLED`, and delivery holds.
- **Membership verification degraded.** The cycle is late past its warn threshold, or attempts are queued. The next successful cycle clears the backlog.
- **Membership verification failing.** Membership status stops tracking the CRM. Existing statuses are unchanged; no one is suspended by a failed run.
- **Email delivery degraded.** Failed or held outbox rows need review in email administration. Bounced or complained addresses stay suppressed.
- **Turnstile degraded or failing.** In production a missing key fails protected actions closed, so magic-link sign-in and public submission stop working. Set both Turnstile keys.
- **Unknown.** The feature is not enabled in this deployment, a warn/fail threshold pair is invalid, or a check could not read its evidence. It is not proof of health.

### Escalation

**Owner:** maintainer (currently Ethan Cornwill, `@finneh4249`). This is a placeholder until the party nominates an operations rota.

- Exit `1` or a `503` from `/api/health`: acknowledge immediately, follow the runbook action on the failing check, escalate to the maintainer if it is not resolved within one hour.
- Exit `2` naming a scheduled job, email delivery or ballot deadlines: investigate the same day, because a warn state becomes failing if the job keeps missing.
- Exit `2` otherwise: review on the next working day.
- No paging integration exists. Alerting is the operator's external monitor invoking `ops:health`; do not claim alerts are delivered.

### Runbook actions

1. Run `npm run ops:health` against production and read the failing checks and their next actions.
2. Confirm the external scheduler exists, is enabled, and sends the expected bearer secret. Coolify production currently has none configured.
3. For governance scheduling, run `npm run governance:scheduler` (dry-run) then `--apply`, and read the JSON report for blockers and errors.
4. For email, check the provider key, sender domain and outbox holds; a suppressed address cannot be re-enabled by the member.
5. For verification, check CRM availability and configuration first; a failure leaves memberships untouched.
6. Record what changed in the incident notes below and confirm the next run appears in `job_runs`.

### What is still missing

- **No scheduler is enabled in Coolify production.** This slice records and reports runs; it does not create them. #39 stays open until an external scheduler is configured and observed.
- **No production verification.** Everything here was verified against a local replica set. There is no evidence of a production run.
- **No metrics, traces or alert delivery.** The health command is the alerting input; nothing sends alerts yet.
- **No admin page.** Health is a command and a coarse probe in this slice.


## Changelog

`/changelog/` is a public, generated record.

- `scripts/generate-changelog.mjs` reads Git history, parses Conventional Commits and categorises entries.
- It writes `src/data/changelog.json`.
- `pnpm dev` and `pnpm build` regenerate it.
- The page prefers a live Git log and falls back to the bundled snapshot.
- Run `pnpm changelog` after meaningful commits, and commit the snapshot.
- Do not fabricate entries or rewrite history. A `chore(changelog)` commit should not recursively regenerate itself.

## Operational runbook

### Daily / weekly

- Check `/api/health` and container health.
- Run `npm run ops:health`: exit `0` healthy, `2` degraded, `1` failing.
- Review admin attention queues: verification reviews, ballots without results, failed migrations.
- Check email delivery failures and suppressions.
- Confirm scheduled jobs are actually running (digest, CRM verification) by checking `job_runs` recency as reported by `ops:health`.
- Review audit events for unexpected role or governance changes.

### Before a governance-sensitive release

- Rehearse against a restored production clone.
- Verify ballot binding and result immutability with real MongoDB.
- Confirm encrypted-vote configuration if encryption is enabled.
- Confirm the public API still serves only published policy.
- Confirm no migration rewrites votes or revisions.
- Have a rollback plan that accounts for data changes.

### Incident notes

- **Email down:** members cannot sign in by magic link. Google/passkey users may still access. Treat as high severity.
- **CRM down:** verification pauses; existing memberships remain. Do not suspend anyone.
- **Mongo down:** the app cannot serve production pages or APIs; health fails.
- **Scheduler absent:** nothing opens or closes automatically; governance acts still work manually. `ops:health` reports the governance scheduler as failing.
- **Suspected ballot compromise:** preserve logs and records, do not delete votes, involve the authorised officer boundary.

## What is not automated

- Ballot opening and closing schedules. Closure is recorded by the scheduler; running the scheduler is still an external cron.
- Eligibility snapshots.
- Result computation.
- Policy publication to external sites.
- Backups (host-level).
- Alerting (no metrics/tracing backend and no alert delivery; `ops:health` is only the input to an external monitor).
- Production cron wiring for the digest, verification and governance scheduler (#39).
- Dependency and secret scanning beyond standard repository settings.
