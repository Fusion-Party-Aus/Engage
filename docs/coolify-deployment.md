# Coolify deployment for Engage

Status as of 2026-11-08:

- **Staging is deployed by Coolify and verified healthy.**
- **Production is configured in Coolify but intentionally not started.** The
  existing production stack is still running untouched. Cutover requires the
  explicit approval described in [the cutover checklist](coolify-cutover-checklist.md).
- **GitHub push triggers deployment through a poller on `nexus-debian`.**
  Coolify has no public HTTPS endpoint, so GitHub cannot deliver an inbound
  webhook. The poller calls Coolify's own deploy API when `main` moves.

## 1. Topology

| Component | Value |
| --- | --- |
| Git repository | `Fusion-Party-Aus/Engage` |
| Deployment branch | `main` |
| Coolify host | `nexus-debian` / `192.168.86.134` / Coolify `4.6.0` |
| Coolify URL | `http://192.168.86.134:8000` (LAN only, no TLS) |
| Remote Docker host | `nuc-alpine-01` / `192.168.86.199` |
| Remote Docker | Docker `26.1.5`, Compose `2.27.0`, Alpine `3.23.4` |
| Staging app | `127.0.0.1:4400` on the NUC |
| Staging MongoDB | `127.0.0.1:27042`, database `engage_staging` |
| Production app | `127.0.0.1:4321` on the NUC |
| Production MongoDB | `127.0.0.1:27041`, database `engage_production` |
| Production volume | `engage_mongo_data` (unchanged) |
| Production network | `engage_default` (unchanged) |
| Public endpoint | `https://engage.fusionparty.org.au` via Cloudflare Tunnel to `127.0.0.1:4321` |
| Coolify reverse proxy on NUC | **disabled** (`proxy.type = NONE`) |

The NUC's host Caddy listens on `:8000` and only proxies
`analytics.fusionparty.org.au` to `127.0.0.1:8081`. It was not changed. The
Cloudflare Tunnel container on the NUC is remote-managed by token; its Engage
ingress rule still points at `http://127.0.0.1:4321`. No DNS, tunnel, firewall,
or reverse-proxy routing was changed.

## 2. Critical constraints and how they were honored

| Constraint | Action |
| --- | --- |
| Do not reinstall Coolify | Reused the existing `coollabsio/coolify:4.6.0` installation. Only enabled its API, added an SSH key, and created resources. Auto-update was disabled to keep the version pinned. |
| Do not install a second Coolify on Alpine | No Coolify control plane was installed on the NUC. Coolify installed only its normal `coolify-sentinel` agent (no published ports) and created the `coolify` Docker network. |
| Do not interrupt existing Engage | `engage-app-1`, `engage-mongo-1`, `engage_mongo_data`, `engage_default`, and the Cloudflare tunnel were left running. Production was not deployed or restarted. |
| Do not delete/recreate/migrate production containers, DB, or volumes | None were removed, recreated, or migrated. A logical backup was written to `/opt/engage/backups/`. |
| Do not change reverse-proxy routing without validating replacement | No routing was changed. Coolify's proxy is disabled, and the production Compose file binds the same `127.0.0.1:4321`. |
| Do not enable automatic production deploys before staging verification | Staging was deployed and verified. Production `is_auto_deploy_enabled=false`; the poller targets staging only. |
| Do not assume Coolify can adopt existing containers | Assessed and confirmed: Coolify creates its own containers. The production design is a controlled **app-container-only** migration that reuses the existing Mongo container, volume, and network. |
| Keep CI out of scope | No GitHub Actions workflow was added or enabled. The trigger is a host poller, not CI. |

## 3. Why this is a controlled migration, not container adoption

Coolify does not import or adopt pre-existing Docker containers. It generates
its own Compose project and containers from the Git repository. The production
design therefore keeps everything stateful outside Coolify:

- The existing `engage-mongo-1` container, `engage_mongo_data` volume, and
  `engage_default` network remain in place.
- The Coolify production application runs **only the app container**. It joins
  `engage_default` as an external network and connects to the existing `mongo`
  service with the exact existing `MONGODB_URI`.
- The app still binds `127.0.0.1:4321`, so the Cloudflare Tunnel origin does not
  change.
- Cutover is a single app-container swap: stop `engage-app-1`, start the
  Coolify-managed app on the same port, verify, or restart `engage-app-1` to
  roll back.

This is why the production Compose file has no `mongo` service and no volume.

## 4. What was configured

### 4.1 Coolify instance

- Existing admin user reused; no new admin was created.
- API enabled (`is_api_enabled=true`).
- Auto-update disabled (`is_auto_update_enabled=false`) so the deployment path
  stays on `4.6.0` until an operator upgrades deliberately.
- Registration remains disabled.
- Two API tokens were created:
  - an automation token with `read`, `write`, `deploy`, `root` for setup;
  - a least-privilege poller token with `read`, `deploy`.
- Tokens are stored outside Git. Rotate them if exposed.

### 4.2 Remote server

- Server name: `alpine-nuc-01`.
- Address: `192.168.86.199:22`, user `root`.
- SSH key: `alpine-nuc-coolify` (dedicated ed25519 key, public key appended to
  `/root/.ssh/authorized_keys` on the NUC).
- Proxy type: `NONE` — no Traefik/Caddy was installed on the NUC.
- Validation passed: reachable and usable; Docker `26.1.5`; Compose `2.27.0`.
- `jq` was installed on the NUC because Coolify requires it.
- Coolify installed `coolify-sentinel` (healthy, no published ports) and created
  the `coolify` Docker network.

### 4.3 Git authentication

- A read-only GitHub deploy key was added to
  `Fusion-Party-Aus/Engage` (key id `169098251`, title
  `Coolify nexus-debian (read-only)`).
- The matching private key is stored in Coolify as `engage-github-deploy`.
- Coolify clones over SSH (`git@github.com:Fusion-Party-Aus/Engage.git`). The
  repository is currently public, but the deploy key keeps the setup working if
  it becomes private and avoids embedding a personal token.

### 4.4 Project and environments

- Project: `Engage` (`mneir3m6u2xtrrvp5f3epeoe`).
- Environments: `production` and `staging`.

### 4.5 Applications

| | Staging | Production |
| --- | --- | --- |
| Coolify UUID | `sgo3uctmylpzyyszoj8drskb` | `k4jns8zq5ctcnzixaadzza4k` |
| Environment | `staging` | `production` |
| Compose file | `docker-compose.coolify-staging.yml` | `docker-compose.coolify-production.yml` |
| Services | `app` + isolated `mongo` | `app` only |
| App port | `127.0.0.1:4400` | `127.0.0.1:4321` |
| Mongo port | `127.0.0.1:27042` | existing `127.0.0.1:27041` |
| Database | `engage_staging` | `engage_production` |
| Volume | `sgo3uctmylpzyyszoj8drskb_mongo-data` | existing `engage_mongo_data` |
| Network | `sgo3uctmylpzyyszoj8drskb_staging` | existing `engage_default` (external) |
| Auto-deploy in Coolify | enabled | **disabled** |
| Deployed? | **yes, healthy** | **no, by design** |
| Health check | `/api/health` port `4321` | `/api/health` port `4321` |

Both applications use the same custom build command:

```text
DOCKER_BUILDKIT=0 docker compose build --pull
```

This is required because Coolify's build helper could not resolve
`registry.npmjs.org` through BuildKit on this host. The classic builder uses the
host network namespace and resolves DNS correctly. It is a build-time setting
only; runtime networking is unchanged.

### 4.6 Repository files added

| File | Purpose |
| --- | --- |
| `docker-compose.coolify-staging.yml` | Isolated app + Mongo staging stack |
| `docker-compose.coolify-production.yml` | App-only production stack on `engage_default` |
| `docker/mongo.Dockerfile` | Bakes Mongo helper scripts into the staging Mongo image |
| `scripts/coolify-poll-deploy.sh` | Git branch poller that calls Coolify's deploy API |
| `deploy/systemd/engage-coolify-poll.service` | Optional systemd unit for the poller |
| `deploy/systemd/engage-coolify-poll.timer` | Optional systemd timer for the poller |
| `docs/coolify-deployment.md` | This document |
| `docs/coolify-cutover-checklist.md` | Production cutover and rollback checklist |

The staging Mongo helper scripts are baked into an image because Coolify's
Compose parser materialises relative file bind-mounts as directories. Baking
them avoids that behaviour and keeps the staging stack self-contained.

## 5. Environment and secrets

### 5.1 Staging

Staging uses its own generated secrets and its own database. It runs in
`preview` mode and is reachable only on the NUC loopback. It is not a production
identity or voting environment.

Keys configured in Coolify: `APP_MODE`, `MONGODB_DB_NAME`, `MONGO_INITDB_ROOT_USERNAME`,
`MONGO_INITDB_ROOT_PASSWORD`, `MONGO_APP_USER`, `MONGO_APP_PASSWORD`,
`SESSION_SECRET`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `RESEND_API_KEY`, `AUTH_EMAIL_FROM`,
`STAGING_APP_PORT`, `STAGING_MONGO_PORT`, `APP_IMAGE_TAG`.

### 5.2 Production

Production values were copied from the existing `/opt/engage/.env` and verified
against the running `engage-app-1` container by hashing each value. Every
existing runtime value matches exactly:

`APP_MODE`, `MONGODB_DB_NAME`, `MONGODB_URI`, `BETTER_AUTH_URL`,
`BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`RESEND_API_KEY`, `AUTH_EMAIL_FROM`, `SESSION_SECRET`.

`MONGODB_URI` in Coolify hashes identically to the URI in the running
container, so it points at the same `mongo:27017` service, the same
`engage_production` database, and the same replica-set options. The only extra
keys are `APP_PORT=4321` and `APP_IMAGE_TAG=coolify-production`, which the
Compose file needs.

### 5.3 Secret handling

- No secret is committed to Git. Compose files use `${...}` references only.
- `/opt/engage/.env` remains `0600` and was not modified.
- Coolify stores values in its encrypted database and redacts environment
  values in deployment logs.
- The poller configuration is `0600` under `/home/ethan/engage-coolify-poll/`.
- The deploy key is read-only.
- The production backup is `0600` under `/opt/engage/backups/`.

## 6. Staging verification evidence

Deployment `bm7ro3vyqdvczyr1pa9xzfeg` finished successfully. On the NUC:

```text
app-sgo3uctmylpzyyszoj8drskb-...    fusion-engage:coolify-staging    Up (healthy)   127.0.0.1:4400->4321
mongo-sgo3uctmylpzyyszoj8drskb-...  fusion-engage-mongo:coolify-staging Up (healthy) 127.0.0.1:27042->27017
```

```text
GET http://127.0.0.1:4400/api/health  ->  {"ok":true,"status":"healthy"}
GET /                                  ->  200
GET /policies/                         ->  301 (canonical redirect)
GET /member/                           ->  200
GET /admin/                            ->  302 (unauthenticated redirect)
```

Database check from inside the staging app container:

```text
ping 1
collections memberships,votes,proposals,comments,application_roles
```

The staging stack has its own Mongo container, replica set, database, volume,
network, and loopback ports. It cannot reach or modify `engage_production`.

## 7. Health checks, logs, and observability

### Health checks

- Coolify application health check: HTTP `GET /api/health` on port `4321`,
  every 10 s, timeout 5 s, 5 retries, 30 s start period.
- Compose container health check: the app image runs the same `/api/health`
  fetch every 30 s; Mongo runs the repository healthcheck script.
- A deployment is only considered successful after the health check passes.

### Logs

- Coolify UI: application → Logs, and deployment logs.
- API:
  - `GET /api/v1/applications/{uuid}/logs`
  - `GET /api/v1/deployments/{uuid}`
- On the NUC:
  - `docker logs <container>`
  - `cd /data/coolify/applications/<uuid> && docker compose --env-file .env logs --tail 200`
- Poller log: `/home/ethan/engage-coolify-poll/poll.log`.

### Sentinel

Coolify's `coolify-sentinel` agent runs on the NUC for metrics/terminal
support. It is not a second Coolify instance and publishes no host ports.

## 8. Automatic deployment trigger

### Current design: LAN poller

Because `nexus-debian` is LAN-only and Coolify has no public HTTPS endpoint,
GitHub cannot call a Coolify webhook. The poller runs on the Coolify host:

- Script: `/home/ethan/engage-coolify-poll/poll.sh`
- Config: `/home/ethan/engage-coolify-poll/poll.env` (`0600`)
- State: `/home/ethan/engage-coolify-poll/state/<app-uuid>.sha`
- Log: `/home/ethan/engage-coolify-poll/poll.log`
- Schedule: user cron, every 2 minutes
- Target: **staging only** (`sgo3uctmylpzyyszoj8drskb`)

On each run it:

1. resolves `refs/heads/main` with `git ls-remote`;
2. compares the SHA with the last queued SHA;
3. if changed, calls `POST /api/v1/deploy` with the staging app UUID;
4. records the SHA only after Coolify accepts the deployment.

The poller uses a `read` + `deploy` token. It runs no tests and builds nothing
itself; Coolify performs the build and deployment on the NUC.

Verify it:

```sh
ssh debian 'crontab -l | grep engage-coolify-poll'
ssh debian 'tail -50 /home/ethan/engage-coolify-poll/poll.log'
ssh debian 'ENGAGE_COOLIFY_POLL_CONFIG=/home/ethan/engage-coolify-poll/poll.env /home/ethan/engage-coolify-poll/poll.sh'
```

### Native webhook alternative

When Coolify is given a public HTTPS hostname (for example through a Cloudflare
Tunnel ingress rule to `http://coolify:8080`), replace the poller with a native
GitHub webhook:

1. Set `manual_webhook_secret_github` on the application.
2. Add a GitHub webhook to
   `https://<coolify-host>/webhooks/source/github/events/manual` with content
   type `application/json` and the same secret.
3. Subscribe to `push` events for `main`.
4. Remove the cron entry.

This requires Cloudflare DNS/tunnel API or dashboard access, which was not
available for this task. Do not expose port `8000` directly to the internet.

### Production auto-deploy policy

Production auto-deploy is **off**. Do not point the poller at the production
app, and do not enable a production webhook, until:

- the staging deployment has been verified (done);
- the production cutover has been approved and completed; and
- the operator has confirmed rollback works.

## 9. Production cutover (requires explicit approval)

The full checklist is in
[`docs/coolify-cutover-checklist.md`](coolify-cutover-checklist.md). The short
version:

1. Obtain explicit approval and a maintenance window.
2. Take/confirm a fresh logical backup.
3. Confirm the Coolify production app config and that port `4321` is held only
   by `engage-app-1`.
4. `docker stop engage-app-1` (do not remove it).
5. Trigger the Coolify production deployment.
6. Verify `/api/health`, the main routes, logs, and the public HTTPS endpoint.
7. Keep `engage-app-1` stopped for 24–48 hours as the rollback.
8. If unhealthy, stop the Coolify app and `docker start engage-app-1`.

This is the only step that interrupts the existing deployment, which is why it
is gated on approval.

## 10. Rollback

### Staging

Redeploy the previous commit through Coolify:

```sh
# PATCH the application with the previous commit SHA, then deploy
curl -X PATCH "$COOLIFY_URL/api/v1/applications/$STAGING_UUID" \
  -H "Authorization: Bearer $COOLIFY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"git_commit_sha":"<previous-sha>"}'
curl -X POST "$COOLIFY_URL/api/v1/deploy" \
  -H "Authorization: Bearer $COOLIFY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"uuid\":\"$STAGING_UUID\"}"
```

After verification, set `git_commit_sha` back to `HEAD`. Compose images are
rebuilt from the selected commit; do not rely on a floating `latest` tag.

### Production (Coolify-managed app)

Use the same commit-based rollback. The app container is replaced; the Mongo
container, volume, and network are untouched.

### Production (legacy stack)

If the Coolify app is unhealthy or the cutover must be abandoned:

```sh
ssh alpine 'docker stop <coolify-production-app-container>'
ssh alpine 'docker start engage-app-1'
ssh alpine 'curl -sf http://127.0.0.1:4321/api/health'
```

Alternatively recreate the old app from the preserved release:

```sh
ssh alpine
cd /opt/engage/current
docker compose -p engage --env-file /opt/engage/.env \
  -f docker-compose.yml -f compose.nuc.yml up -d --no-build --wait app
```

Do not remove `engage-app-1`, its image, `engage_mongo_data`, or the release
directory until the Coolify-managed production app has been stable for an
agreed period.

### Database

There is no database rollback in this change. Never delete or recreate
`engage_mongo_data` as a rollback strategy. If a restore is ever required,
restore into a new database with explicit approval and verify before switching
the app.

## 11. Backup and restore

A pre-cutover logical backup was taken on 2026-11-08:

```text
/opt/engage/backups/pre-coolify-20261108-002730.archive.gz  (180 KiB, mode 0600)
gzip -t: OK
```

It was produced with the Mongo image's `mongodump`, the existing app
credentials, and the existing `engage_default` network. No database writes were
performed.

To take another backup:

```sh
ssh alpine
STAMP=$(date +%Y%m%d-%H%M%S)
docker run --rm --network engage_default --env-file /opt/engage/.env \
  -v /opt/engage/backups:/backup mongo:8.0 \
  sh -c 'mongodump --host mongo --port 27017 \
    --username "$MONGO_APP_USER" --password "$MONGO_APP_PASSWORD" \
    --authenticationDatabase "$MONGODB_DB_NAME" --db "$MONGODB_DB_NAME" \
    --gzip --archive=/backup/pre-coolify-'"$STAMP"'.archive.gz'
chmod 600 /opt/engage/backups/pre-coolify-"$STAMP".archive.gz
```

Restore only into a new, empty database and only with approval. Never restore
over `engage_production`.

## 12. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Build fails at `pnpm install` with `EAI_AGAIN registry.npmjs.org` | Coolify's BuildKit helper has broken DNS on this host. Keep `DOCKER_BUILDKIT=0 docker compose build --pull` as the app's custom build command. |
| Mongo container restarts with `engage-mongo-start.sh: Is a directory` | Coolify materialises relative file bind-mounts as directories. The staging Mongo image bakes the scripts in; do not reintroduce `./docker/*.js` bind-mounts in a Coolify Compose file. |
| Production deploy fails with `port is already allocated` | `engage-app-1` still owns `127.0.0.1:4321`. This is expected until cutover. Stop the old container only with approval. |
| App cannot resolve `mongo` | The production app must join the external `engage_default` network. Check `docker network inspect engage_default` and the parsed Compose networks. |
| Server validation says `jq` is missing | Install `jq` on the NUC (`apk add jq`) and re-run validation. |
| Coolify UI/API unreachable from GitHub | Expected: the instance is LAN-only. Use the poller or add a public tunnel ingress. |
| `docker compose` warns about orphan containers | Use the Coolify project name/UUID shown in `/data/coolify/applications/<uuid>`. Do not run a second Compose project against the production stack. |

Host notes:

- The NUC has `18.1 GiB` free on `/`; Debian has `4.7 GiB` free on `/` and
  `726 MiB` on `/home`. Builds run on the NUC, not Debian. Monitor Debian disk
  before enabling more Coolify resources.
- The NUC's `/etc/apk/repositories` points at Alpine `v3.20` while the OS is
  `3.23.4`. This pre-dates this work. Only `jq` was added; review before a
  future `apk upgrade`.
- The Coolify UI is published on `0.0.0.0:8000` without TLS. Restrict it to the
  LAN/VPN or put it behind an authenticated tunnel before exposing it.

## 13. Known limitations and follow-ups

- **Production is not cut over.** This is deliberate. See the checklist.
- **No native GitHub webhook.** The poller adds up to ~2 minutes of latency.
  Replace it with a webhook once Coolify has a public HTTPS endpoint.
- **No CI.** GitHub Actions remains unavailable and out of scope. The poller
  deploys whatever is on `main`; it does not run tests.
- **Existing GitHub Actions workflows are untouched.** In particular,
  `.github/workflows/nuc-cicd.yml` still describes a self-hosted-runner deploy.
  Disable or reconcile it before GitHub Actions is re-enabled, or it could
  compete with Coolify for the NUC.
- **Coolify UI exposure.** Bind/restrict port `8000` before treating this as a
  production control plane.
- **Token rotation.** Rotate the setup and poller tokens after handover and
  store them in the team password manager.

## Appendix A: Identifiers

| Object | UUID / value |
| --- | --- |
| Project `Engage` | `mneir3m6u2xtrrvp5f3epeoe` |
| Server `alpine-nuc-01` | `oo1d8km6npuflkjehiezeut1` |
| Staging application | `sgo3uctmylpzyyszoj8drskb` |
| Production application | `k4jns8zq5ctcnzixaadzza4k` |
| Staging deployment verified | `bm7ro3vyqdvczyr1pa9xzfeg` |
| GitHub deploy key | id `169098251`, read-only |
| Coolify SSH key | `alpine-nuc-coolify` |
| Coolify Git key | `engage-github-deploy` |

## Appendix B: Useful API calls

Set these in the shell without committing them:

```sh
export COOLIFY_URL='http://192.168.86.134:8000'
export COOLIFY_TOKEN='<token>'
export APP_UUID='<application-uuid>'
```

```sh
# Application state
curl -s "$COOLIFY_URL/api/v1/applications/$APP_UUID" \
  -H "Authorization: Bearer $COOLIFY_TOKEN"

# Deployment history for the application
curl -s "$COOLIFY_URL/api/v1/deployments/applications/$APP_UUID" \
  -H "Authorization: Bearer $COOLIFY_TOKEN"

# Trigger a deployment
curl -s -X POST "$COOLIFY_URL/api/v1/deploy" \
  -H "Authorization: Bearer $COOLIFY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"uuid\":\"$APP_UUID\"}"

# Stop/start
curl -s -X POST "$COOLIFY_URL/api/v1/applications/$APP_UUID/stop" \
  -H "Authorization: Bearer $COOLIFY_TOKEN"
curl -s -X POST "$COOLIFY_URL/api/v1/applications/$APP_UUID/start" \
  -H "Authorization: Bearer $COOLIFY_TOKEN"
```

## Appendix C: Verification log

| Check | Result |
| --- | --- |
| Existing Coolify health | healthy (`coollabsio/coolify:4.6.0`) |
| Debian → Alpine SSH | `nuc-alpine-01` reachable as root with dedicated key |
| Coolify server validation | reachable, usable, Docker 26.1.5, Compose 2.27.0 |
| Coolify proxy on NUC | `NONE`; no Traefik/Caddy installed |
| Existing Engage app | `engage-app-1` healthy, `127.0.0.1:4321` |
| Existing MongoDB | `engage-mongo-1` healthy, `127.0.0.1:27041` |
| Existing public endpoint | Cloudflare Tunnel → `127.0.0.1:4321` (unchanged) |
| Production DB auth from `engage_default` | ping `1`, 22 collections |
| Production URI hash vs running container | exact match |
| Production runtime env hashes | all exact matches |
| Staging deployment | finished, both containers healthy |
| Staging health | `{"ok":true,"status":"healthy"}` |
| Staging DB | ping `1`, collections present |
| Pre-cutover backup | 180 KiB, gzip OK, mode 0600 |
| GitHub deploy key | read-only, SSH clone verified |
| Poller dry run | exits 0 when SHA unchanged |
