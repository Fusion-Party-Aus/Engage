# Build, deployment and operations

**Status:** Current · **Verified:** 13 November 2026

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
- Playwright browser journeys (`scripts/*-browser.mjs`)

CI provisions a single-node MongoDB 8.0 replica set. Use the same when changing persistence, indexes, transactions or vote storage. Do not claim a persistence change is verified from the in-memory fallback alone.

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
- A failed health poll triggers the NUC rollback path.
- Database changes are not rolled back by an app rollback. A migration must be backward compatible or have an explicit reversal.
- Keep a current backup before a release that changes schema or indexes.

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
- Review admin attention queues: verification reviews, ballots without results, failed migrations.
- Check email delivery failures and suppressions.
- Confirm scheduled jobs are actually running (digest, CRM verification).
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
- **Scheduler absent:** nothing opens or closes automatically; governance acts still work manually.
- **Suspected ballot compromise:** preserve logs and records, do not delete votes, involve the authorised officer boundary.

## What is not automated

- Ballot opening and closing schedules.
- Eligibility snapshots.
- Result computation.
- Policy publication to external sites.
- Backups (host-level).
- Alerting (no metrics/tracing backend).
- Dependency and secret scanning beyond standard repository settings.
