# Coolify deployment for Engage

Status as of 2026-11-08 (cutover-readiness verification):

- **Staging is deployed by Coolify and verified healthy.**
- **The full trigger was exercised end to end:** a push to `main` was detected
  by the poller, Coolify queued deployment `ukwx3w1uoucblvt0orve5lpf`, and the
  replacement staging containers became healthy.
- **Production is configured in Coolify but intentionally not started.** The
  existing production stack is still running untouched. Cutover requires the
  explicit approval described in [the cutover checklist](coolify-cutover-checklist.md).
- **Cutover readiness has been verified without touching production.** A
  production image was prebuilt from `main` at `1b973faf...`, smoke-tested on a
  spare port, and protected from Coolify's image prune. That image is a
  **deployment rehearsal artifact**; it is not the final release and must not be
  deployed unless it independently matches the final approved Git commit. The
  no-rebuild deployment path and the last-moment custom start command were
  exercised on staging. The pre-cutover backup was restored into a disposable
  MongoDB and verified. Production still runs `engage-app-1`; the cutover
  remains approval-gated.
- **GitHub push triggers deployment through a poller on `nexus-debian`.**
  Coolify has no public HTTPS endpoint, so GitHub cannot deliver an inbound
  webhook. The poller calls Coolify's own deploy API when `main` moves.

> **Source of truth:** Coolify deploys `main`. The rehearsal commit
> `1b973fafbedb763e15bc868e5fdcad0e13486ae4` is **not** the final release
> identity. Before cutover, set `RELEASE_SHA` to the final integrated commit on
> `main`, rebuild and relabel the image from that exact commit, and record its
> image ID. Build production only from the approved `main` commit, not from a
> feature branch. See the release identity block in
> [the cutover checklist](coolify-cutover-checklist.md).

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
  - an automation token with `read`, `write`, `deploy`, `root` for setup; it
    was **revoked after configuration**;
  - a least-privilege poller token with `read`, `deploy`, which remains for the
    deployment trigger.
- Tokens are stored outside Git. Rotate the poller token if exposed.

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

Deployment `bm7ro3vyqdvczyr1pa9xzfeg` finished successfully, and the
end-to-end poller test produced deployment `ukwx3w1uoucblvt0orve5lpf` at commit
`ef8e9a8`, also finished and healthy. On the NUC:

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

To inspect staging from a workstation without exposing it on the LAN:

```sh
ssh -N -L 4400:127.0.0.1:4400 alpine
# then open http://127.0.0.1:4400
```

## 6.1 Storage and prebuilt production image verification (2026-11-08)

### Storage

Coolify's persistent data is on `/mnt/storage`; its Docker state is not.

| Location | Backing storage | Verified state |
| --- | --- | --- |
| Coolify persistent data (`/data/coolify`) | bind mount from `/mnt/storage/appdata/coolify` (mergerfs pool) | 17 T pool, 7.4 T free, 1% inodes used |
| Coolify PostgreSQL / Redis volumes | `/var/lib/docker/volumes` on Debian `/var` | DB 17 MB; `/var` 64 G, 16 G free, 16% inodes |
| Debian Docker images / containers / build cache | `/var/lib/docker` on Debian `/var` | 42.55 GB images across **all** workloads; build cache 0; 16 G free |
| NUC `/data/coolify` (generated compose/env) | NUC `/` LV | ~260 KB |
| NUC Docker images / containers / build cache | `/var/lib/docker` on NUC `/` LV | 10.43 GB images, 2.09 GB volumes, build cache 0; 23.1 G free after cleanup |
| Debian `/home` | `/dev/nvme0n1p4` | 704 MB free (98%); Coolify uses only the 24 KB poller directory. This is unrelated to Coolify. |

Notes:

- `/data/coolify` is the only Coolify path on `/mnt/storage`. PostgreSQL,
  Redis, Docker images, deployment helper containers, and build caches live
  under `/var/lib/docker`, not `/mnt/storage`.
- No storage was moved or reconfigured. Free space and inode availability are
  adequate for the cutover on both hosts.
- Residual risk: Docker's root is not on `/mnt/storage` on either host. Monitor
  `/var` on Debian and `/` on the NUC. Do not prune
  `fusion-engage:review-20261106`, `fusion-engage:prod-1b973fafbedb`, or
  `engage_mongo_data`.
- The 42.55 GB of Debian images is shared by many unrelated stacks (media,
  CRM, analytics, etc.); Coolify's own control-plane images are roughly
  2 GB. `/home` being nearly full is the user's data, not Coolify.

### Prebuilt production image (2026-11-08 rehearsal artifact)

> This image is a rehearsal artifact and is **not** the final release. A final
> image must be rebuilt from `$RELEASE_SHA` using the checklist and then
> smoke-tested and re-protected.

| Item | Value |
| --- | --- |
| Rehearsal commit | `1b973fafbedb763e15bc868e5fdcad0e13486ae4` (`main`) |
| Rehearsal image tag | `fusion-engage:prod-1b973fafbedb` |
| Rehearsal image ID | `sha256:49a05daf12783c9dcb727dcc6ed9c024eb6dcf06808f768570c0ed5b04cb62d6` |
| Size | 401.5 MB |
| Labels | `org.opencontainers.image.revision`, `.source`, `.created` |
| Protection container | `engage-prebuilt-prod-1b973fafbedb` (stopped, no ports) |

The image is built on the NUC with `DOCKER_BUILDKIT=0` from a `git archive` of
the exact commit, not from a working tree. It was smoke-tested on
`127.0.0.1:14321` attached to the staging network with staging environment
values: `/api/health` returned `{"ok":true,"status":"healthy"}` and `/`,
`/policies/`, `/member/`, and `/admin/` returned 200. Production port `4321`
was never bound by the test.

**Coolify image-prune caveat.** `CleanupDocker` deletes tagged images that no
container references. A prebuilt image will be removed before cutover unless it
is protected. The stopped placeholder container
`engage-prebuilt-prod-1b973fafbedb` keeps the image in use, so `docker rmi`
refuses to remove it. A real `CleanupDocker` run was executed on 2026-11-08 and
the image survived. Keep the placeholder until the cutover container has
started; remove it only after the new app is stable.

### No-rebuild deployment path

Coolify 4.6.0 builds Compose images before it stops the application's own
containers. For this app, Coolify's automatic image-reuse path is disabled
because `docker_compose_custom_build_command` is set. The verified cutover path
is:

1. Prebuild and smoke-test the image (above).
2. Set `APP_IMAGE_TAG` to the final release tag (see the release identity block
   in the cutover checklist), not the rehearsal tag.
3. Set `docker_compose_custom_build_command=true` (a no-op).
4. Install `/opt/engage/backups/fb.sh` (from
   `scripts/coolify-final-backup.sh`) and set
   `docker_compose_custom_start_command` to the 221-character sequence that
   stops `engage-app-1`, runs the script in a disposable `mongo:8.0` container
   to take a final quiescent backup, and starts the prebuilt image with
   `docker compose --project-name <uuid> up -d --no-build`. The script keeps
   the command inside Coolify's `varchar(255)` column.
5. Trigger the Coolify deployment. Coolify clones the commit, runs the no-op
   build, skips the registry pull, stops only its own containers (none on the
   first cutover), then runs the custom start command. The old app stays up
   until the custom start command runs; downtime is the stop, the tiny final
   backup, and the container start.
6. Coolify's health check verifies `/api/health`.

The no-op build and prebuilt-image start were tested on staging: the new
staging container ran the prebuilt image ID and the deployment log showed no
build. The custom start command was tested on staging against a disposable
stand-in container; it stopped the stand-in and started the app. The exact
production command, including `--project-name` and `--no-build`, was validated
with Coolify's own `injectDockerComposeFlags` and
`SHELL_SAFE_COMMAND_PATTERN`.

**Do not use Coolify's `/start` endpoint for the cutover start or rollback.**
It queues a full deployment and rebuilds the images (verified on staging on
2026-11-08). Use the deployment trigger with the no-op build/custom start, or
`docker compose up -d --no-build` directly.

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

The poller resolves the branch over public HTTPS. If the repository is made
private, give the poller a read-only GitHub token or an SSH deploy key before
the next poll; otherwise it will log an error and stop queuing deployments.

Because the SHA is recorded when the deployment is **queued**, a failed
deployment is not retried automatically. Inspect the Coolify deployment log,
fix the cause, then either trigger a deploy manually or remove
`state/<app-uuid>.sha` to let the poller queue the same commit again.

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
[`docs/coolify-cutover-checklist.md`](coolify-cutover-checklist.md). The
verified short version:

1. Obtain explicit approval and a maintenance window.
2. Freeze: pause the staging poller; confirm production auto-deploy is off, no
   production deployment is queued, and no scheduled task can redeploy
   production.
3. Prebuild and protect the exact production image from the approved `main`
   commit (section 6.1). Smoke-test it on a spare loopback port against the
   staging database. Record the image ID and revision label.
4. Take a fresh logical backup, restore-test it into a disposable MongoDB, and
   copy it off-host to `/mnt/storage/data/engage-backups/` on `nexus-debian`.
5. Configure the production app with a temporary `read`+`write`+`deploy` token:
   `APP_IMAGE_TAG=prod-<sha>`, `docker_compose_custom_build_command=true`, and
   the last-moment custom start command described in section 6.1.
6. Trigger the Coolify production deployment. The old app stays up during
   clone/prep; the custom start command then stops `engage-app-1`, takes the
   final quiescent backup, and starts the prebuilt image with `--no-build`.
7. Copy the final post-stop backup off-host and verify its SHA-256.
8. Verify `/api/health`, the main routes, logs, DB access, the container image
   ID, and the public HTTPS endpoint.
9. Keep `engage-app-1` stopped (not removed) for 24–48 hours as the rollback.
10. After the window, restore the normal build command, remove the custom start
    command and placeholder, and revoke the temporary token.

This is the only step that interrupts the existing deployment, which is why it
is gated on approval. The old app is stopped by the cutover deployment itself,
not by a separate manual stop before the build, so the downtime does not
include a build.

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

Use the same commit-based rollback for a later code rollback. The app container
is replaced; the Mongo container, volume, and network are untouched.

**Do not use `POST /api/v1/applications/{uuid}/start` as a pure start.** It
queues a full deployment and rebuilds the images (verified on staging on
2026-11-08). For the cutover start, use the no-op build + custom start path in
section 6.1; for rollback, use `docker start engage-app-1`.

### Production (legacy stack)

If the Coolify app is unhealthy or the cutover must be abandoned:

```sh
# 1. Stop the Coolify-managed app. The stop action removes its container and
#    releases port 4321. It does not touch engage-app-1 or MongoDB.
curl -sS -X POST "$COOLIFY_URL/api/v1/applications/$PROD_UUID/stop" \
  -H "Authorization: Bearer $COOLIFY_TOKEN"

# 2. Verify the Coolify container is gone and port 4321 is free
ssh alpine 'docker ps -a --filter name=k4jns8zq5ctcnzixaadzza4k'
ssh alpine 'ss -ltnp | grep 4321 || echo "port 4321 free"'

# 3. Restart the preserved legacy container. This does not rebuild anything.
ssh alpine 'docker start engage-app-1'
ssh alpine 'curl -sf http://127.0.0.1:4321/api/health'
curl -sf https://engage.fusionparty.org.au/api/health
```

The stop path was verified on staging: Coolify stopped and removed only its own
app containers, and the loopback port was free afterwards. The legacy image
`fusion-engage:review-20261106` was also started on a spare port against the
staging database and served `/api/health`, `/`, `/policies/`, and `/member/`
successfully. `docker start engage-app-1` reuses the existing container and
image; it never builds.

Alternatively recreate the old app from the preserved release:

```sh
ssh alpine
cd /opt/engage/current
docker compose -p engage --env-file /opt/engage/.env \
  -f docker-compose.yml -f compose.nuc.yml up -d --no-build --wait app
```

Before the cutover, verify the preserved legacy release is intact:

```sh
ssh alpine 'docker inspect engage-app-1 --format "{{.Config.Image}} {{.Image}} {{.HostConfig.RestartPolicy.Name}}"'
ssh alpine 'docker image inspect fusion-engage:review-20261106 --format "{{.Id}}"'
ssh alpine 'cd /opt/engage/current && docker compose -p engage --env-file /opt/engage/.env \
  -f docker-compose.yml -f compose.nuc.yml config --quiet && echo "compose OK"'
```

Do not remove `engage-app-1`, its image, `engage_mongo_data`, or the release
directory until the Coolify-managed production app has been stable for an
agreed period.

### Rollback trigger and safeguards

Trigger a rollback if any of these is true after the cutover:

- No healthy container within 60 seconds of `engage-app-1` stopping.
- `/api/health` returns non-200, or the container restarts repeatedly.
- Logs show database authentication or connection errors.
- Main routes return 5xx, or the public HTTPS endpoint stays unavailable.
- The new container's image ID does not match the recorded prebuilt image ID.

Safeguards verified before the cutover:

- Production `is_auto_deploy_enabled = false`; preview deployments are off.
- The poller targets staging only; production has zero deployments queued.
- No enabled scheduled task exists for production.
- The production GitHub webhook secret is present but inert while auto-deploy
  is off; Coolify is LAN-only and must not be exposed during the window.
- `engage-app-1`, `fusion-engage:review-20261106`, `/opt/engage/current`,
  `/opt/engage/.env`, `engage-mongo-1`, `engage_mongo_data`, and
  `engage_default` are preserved.
- `engage-app-1` has `RestartPolicy=unless-stopped`, so it does not restart by
  itself while intentionally stopped during the cutover.

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

### Restore verification (2026-11-08)

`gzip -t` only proves the archive is not corrupt. The archive was restored into
a disposable, network-isolated `mongo:8.0` container using a tmpfs database
(no production access, no published ports):

```text
mongorestore --archive=... --gzip \
  --nsFrom='engage_production.*' --nsTo='engage_restore_test.*'

414 document(s) restored successfully. 0 document(s) failed to restore.
```

All 22 collections were present, with counts matching production exactly:

```text
account 6, application_roles 5, ballots 0, comments 10, consultation_rounds 0,
consultation_submissions 0, deployment_checks 1, memberships 31,
mutation_rate_limits 0, operational_audit 3, policies 0, policy_revisions 0,
proposal_votes 194, proposals 81, rateLimit 3, review_revisions 1, reviews 1,
schema_migrations 1, session 42, user 31, verification 0, votes 4
```

Indexes were recreated (`memberships` 2, `proposals` 4, `proposal_votes` 2,
`votes` 4, `mutation_rate_limits` 3), and representative documents retained
their expected fields. `engage_production` was not modified.

### Taking a backup

```sh
ssh alpine
STAMP=$(date +%Y%m%d-%H%M%S)
docker run --rm --network engage_default --env-file /opt/engage/.env \
  -v /opt/engage/backups:/backup mongo:8.0 \
  sh -c 'mongodump --host mongo --port 27017 \
    --username "$MONGO_APP_USER" --password "$MONGO_APP_PASSWORD" \
    --authenticationDatabase "$MONGODB_DB_NAME" --db "$MONGODB_DB_NAME" \
    --gzip --archive=/backup/pre-cutover-'"$STAMP"'.archive.gz'
chmod 600 /opt/engage/backups/pre-cutover-"$STAMP".archive.gz
gzip -t /opt/engage/backups/pre-cutover-"$STAMP".archive.gz
```

The cutover custom start command takes the **final** backup automatically
after `engage-app-1` stops and before the new app starts, so it contains every
write up to the cutover. The backup logic is the small host script
`/opt/engage/backups/fb.sh` (source:
`scripts/coolify-final-backup.sh`). The command runs that script in a
disposable `mongo:8.0` container with the host `/opt/engage/.env` mounted
read-only at `/tmp/e` and `/opt/engage/backups` at `/b`. The script extracts
only the Mongo keys, so the spaces in `AUTH_EMAIL_FROM` do not break shell
parsing, and the Docker CLI does not need to read the host env path itself.
The script keeps the custom start command at 221 characters, inside Coolify's
`varchar(255)` column. It was tested against the staging database on
2026-11-08 and the archive passed `gzip -t`.

### Off-host policy

Engage backups were previously local to the NUC only. The verified off-host
path is now:

```text
/mnt/storage/data/engage-backups/ on nexus-debian
```

`nexus-debian` can pull from the NUC as root. After each backup (including the
final post-stop backup):

```sh
ssh debian 'mkdir -p /mnt/storage/data/engage-backups && chmod 700 /mnt/storage/data/engage-backups'
ssh debian "scp -q root@192.168.86.199:/opt/engage/backups/<file>.archive.gz \
  /mnt/storage/data/engage-backups/"
ssh debian 'chmod 600 /mnt/storage/data/engage-backups/<file>.archive.gz'
ssh debian 'sha256sum /mnt/storage/data/engage-backups/<file>.archive.gz'
ssh alpine 'sha256sum /opt/engage/backups/<file>.archive.gz'
```

The existing `pre-coolify-20261108-002730.archive.gz` was copied there and its
SHA-256 matched on both hosts. This is a manual step; no scheduled off-host job
exists yet. Treat "off-host copy missing" as a cutover blocker.

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
| Cutover deployment starts a build even though the prebuilt image exists | Coolify's automatic image reuse is disabled when a custom build command is set. Set `docker_compose_custom_build_command=true` for the cutover and start with `docker compose ... up -d --no-build`. |
| Prebuilt image disappears before cutover | `CleanupDocker` prunes tagged images that no container references. Rebuild and keep a stopped placeholder container (`docker create`) using the image; verify it survives a cleanup run. |
| Custom start command fails with `No such container: engage-app-1` | The legacy container was removed. Recreate it from `/opt/engage/current` with `up -d --no-build`, or remove the `docker stop engage-app-1` prefix before retrying. |
| Custom start creates `j57..._staging` or the wrong Compose project | The custom start command omitted `--project-name <uuid>`. Include it explicitly; the flag injector only adds `-f`/`--env-file`. |
| Custom start command rejected or truncated | `docker_compose_custom_start_command` is `varchar(255)`. Keep the backup logic in `/opt/engage/backups/fb.sh`; the 221-character command fits. |
| `POST /applications/{uuid}/start` rebuilds the app | Expected in Coolify 4.6.0. Do not use it for a pure start or rollback. Use the no-op build path for cutover and `docker start engage-app-1` for rollback. |
| Final backup missing after cutover | The custom start command chains `docker stop`, the `mongodump` container, and `docker compose ... up`. If the dump fails, the new app does not start. Check `/opt/engage/backups` and the deployment log, then roll back. |

Host notes:

- The NUC has `23.1 GiB` free on `/` after the 2026-11-08 cleanup; Debian has
  `4.7 GiB` free on `/`, `16 GiB` on `/var`, and `704 MiB` on `/home`. Builds
  run on the NUC, not Debian. Monitor both hosts before enabling more Coolify
  resources.
- Coolify's persistent data is on `/mnt/storage` (17 T, 7.4 T free). Docker's
  root (`/var/lib/docker`) is not on `/mnt/storage` on either host. This is
  acceptable today but is the main storage risk.
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
  store them in the team password manager. The cutover needs a temporary
  `read`+`write`+`deploy` token; revoke it immediately after the window.
- **Docker root is not on `/mnt/storage`.** Coolify's persistent data is on the
  storage pool, but `/var/lib/docker` (images, build cache, PostgreSQL/Redis
  volumes) is on `/var` on Debian and `/` on the NUC. Monitor free space; do
  not prune the legacy or prebuilt images during the rollback window.
- **Prebuilt image protection is manual.** A stopped placeholder container
  keeps the image alive through `CleanupDocker`. Remove it only after the new
  app is stable.
- **Off-host backup is manual.** The verified path is
  `/mnt/storage/data/engage-backups/` on `nexus-debian`, copied with `scp` and
  checked by SHA-256. No scheduled off-host job exists yet.
- **Production webhook secret is present but inert.** `manual_webhook_secret_github`
  is set on the production app, but `is_auto_deploy_enabled=false` means a
  webhook cannot queue a deployment. Do not expose Coolify publicly while
  auto-deploy is off; clear or rotate the secret before enabling webhooks.
- **Coolify `/start` is not a pure start.** It rebuilds the images. Use the
  no-op build + custom start path for cutover and `docker start engage-app-1`
  for rollback.
- **Branch note.** The deployed source of truth is `main`. These operational
  docs were integrated from the Coolify workstream and now live with the release
  line. Rebuild the production image from the final integrated `main` commit;
  the `1b973faf...` image is only the readiness rehearsal artifact.

## Appendix A: Identifiers

| Object | UUID / value |
| --- | --- |
| Project `Engage` | `mneir3m6u2xtrrvp5f3epeoe` |
| Server `alpine-nuc-01` | `oo1d8km6npuflkjehiezeut1` |
| Staging application | `sgo3uctmylpzyyszoj8drskb` |
| Production application | `k4jns8zq5ctcnzixaadzza4k` |
| Staging deployment verified | `bm7ro3vyqdvczyr1pa9xzfeg` |
| Rehearsal production commit (not final) | `1b973fafbedb763e15bc868e5fdcad0e13486ae4` |
| Rehearsal production image | `fusion-engage:prod-1b973fafbedb` / `sha256:49a05daf...` |
| Rehearsal image protection container | `engage-prebuilt-prod-1b973fafbedb` (stopped) |
| Off-host backup path | `/mnt/storage/data/engage-backups/` on `nexus-debian` |
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
| Poller end-to-end deployments | `ukwx3w1uoucblvt0orve5lpf` at `ef8e9a8`; `nlf1wyw42ncaazzkxpufdz2n` at `cffc1a0` |
| Staging health | `{"ok":true,"status":"healthy"}` |
| Staging DB | ping `1`, collections present |
| Pre-cutover backup | 180 KiB, gzip OK, mode 0600 |
| Backup restore test | 414 documents, 22 collections, 0 failures, indexes recreated, counts match production |
| Off-host backup copy | `/mnt/storage/data/engage-backups/`, SHA-256 matches NUC copy |
| Coolify persistent data | `/data/coolify` bind-mounted from `/mnt/storage/appdata/coolify` |
| Storage free/inodes | `/mnt/storage` 7.4 T free, 1% inodes; Debian `/var` 16 G free; NUC `/` 23.1 G free |
| Docker root | `/var/lib/docker` on Debian `/var` and NUC `/` (not `/mnt/storage`) |
| Production runtime env hashes | all 10 exact matches vs `engage-app-1` |
| Production auto-deploy / scheduled tasks | `false` / none; zero production deployments |
| Rehearsal production image | `fusion-engage:prod-1b973fafbedb`, ID `sha256:49a05daf...`, revision `1b973faf...` (not the final release) |
| Prebuilt smoke test | port `14321` against staging DB; health + `/`, `/policies/`, `/member/`, `/admin/` 200 |
| Image survives Coolify cleanup | real `CleanupDocker` run; placeholder container kept the image |
| No-op build staging deploy | deployment finished; container ran the prebuilt image ID; no build in log |
| Custom start command staging test | stopped a stand-in container, started the app; injected command validated |
| Coolify stop path | stopped/removed only its app containers; loopback port released |
| Coolify `/start` behaviour | queues a full deployment and rebuilds images (do not use for pure start) |
| Legacy image restart evidence | `fusion-engage:review-20261106` healthy on spare port; compose config valid |
| Production final state | `engage-app-1` and `engage-mongo-1` healthy, port `4321` unchanged, no cutover performed |
| GitHub deploy key | read-only, SSH clone verified |
| Poller dry run | exits 0 when SHA unchanged |
