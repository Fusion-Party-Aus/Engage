# Production cutover checklist — Engage on Coolify

This is the approval-gated step that moves production traffic from the existing
`engage-app-1` container to the Coolify-managed production application. It is
the only step that interrupts the existing deployment.

Read [coolify-deployment.md](coolify-deployment.md) first, especially
section 6.1 (storage and prebuilt-image verification) and section 9.

**Verified values from 2026-11-08** (re-check before the window; update if the
approved commit changes):

> **Release identity.** The `1b973faf...` / `prod-1b973fafbedb` values below are
> the **2026-11-08 deployment rehearsal artifact**. They are not the final
> release. Set `RELEASE_SHA`, `RELEASE_IMAGE_TAG`, `RELEASE_IMAGE` and
> `PROTECTION_CONTAINER` from the final integrated commit on `main` before using
> any command on this page. Rebuild, relabel, smoke-test and re-protect the
> image. Never deploy the rehearsal image as the final release.
>
> ```sh
> RELEASE_SHA=$(git rev-parse HEAD)          # final integrated commit on main
> RELEASE_IMAGE_TAG="prod-${RELEASE_SHA:0:12}"
> RELEASE_IMAGE="fusion-engage:${RELEASE_IMAGE_TAG}"
> PROTECTION_CONTAINER="engage-prebuilt-${RELEASE_IMAGE_TAG}"
> ```

| Item | Value |
| --- | --- |
| Release commit (`main`) | `$RELEASE_SHA` — set from the final integrated commit |
| Release image | `$RELEASE_IMAGE` — build from `$RELEASE_SHA` |
| Release image ID | Record after the final build |
| Image-protection container | `$PROTECTION_CONTAINER` (stopped) |
| Previous rehearsal artifact — **do not deploy** | `1b973fafbedb763e15bc868e5fdcad0e13486ae4` / `fusion-engage:prod-1b973fafbedb` |
| Coolify production UUID | `k4jns8zq5ctcnzixaadzza4k` |
| Legacy container / image | `engage-app-1` / `fusion-engage:review-20261106` |
| Production MongoDB | `engage-mongo-1`, `engage_mongo_data`, `engage_default`, `127.0.0.1:27041` |
| Public endpoint | `https://engage.fusionparty.org.au` → `127.0.0.1:4321` |
| Off-host backup path | `/mnt/storage/data/engage-backups/` on `nexus-debian` |

## Approval gate

- [ ] Written approval from the Engage owner for a maintenance window.
- [ ] Operator understands the site will be unavailable for roughly 15–60
      seconds while `engage-app-1` is stopped, the final backup is taken, and
      the prebuilt image starts. No image is built after the old app stops.
- [ ] Rollback owner and contact are known.
- [ ] No ballot closure, voting deadline, or member communication is scheduled
      in the window.
- [ ] `FORMAL_BALLOTS_ENABLED` is `false` in the existing production `.env`
      (current state), or the owner has explicitly accepted the change.
- [ ] The approved commit is on `main`, the staging deployment at that commit
      is healthy, and the prebuilt image was built from that exact commit.
- [ ] A temporary Coolify token with `read` + `write` + `deploy` is available
      for the configuration steps, and will be revoked after the cutover.
      (The poller token is `read` + `deploy` only and cannot PATCH the app.)

## Preflight (read-only)

```sh
# Existing stack is healthy
ssh alpine 'docker ps --filter name=engage-app-1 --filter name=engage-mongo-1'
ssh alpine 'curl -sf http://127.0.0.1:4321/api/health'

# Public endpoint is healthy
curl -sf https://engage.fusionparty.org.au/api/health

# Coolify production app is configured but not running; auto-deploy is off
curl -s "$COOLIFY_URL/api/v1/applications/$PROD_UUID" \
  -H "Authorization: Bearer $COOLIFY_TOKEN"

# No deployment is already in progress and no production deployment exists
curl -s "$COOLIFY_URL/api/v1/deployments/applications/$PROD_UUID" \
  -H "Authorization: Bearer $COOLIFY_TOKEN"

# Port 4321 is owned only by the old app
ssh alpine 'ss -ltnp | grep 4321'

# The release image and its protection container still exist
ssh alpine "docker image inspect '$RELEASE_IMAGE' \
  --format '{{.Id}} {{json .Config.Labels}}'"
ssh alpine "docker ps -a --filter name='$PROTECTION_CONTAINER' \
  --format '{{.Names}} {{.Status}}'"

# The final-backup helper is installed and executable
ssh alpine 'test -x /opt/engage/backups/fb.sh && echo "backup helper OK"'
```

- [ ] Existing app and Mongo healthy.
- [ ] Public HTTPS health check passes.
- [ ] Coolify production app is `exited`/not running, auto-deploy `false`, no
      custom build/start command left over from a previous test.
- [ ] `APP_IMAGE_TAG` and the production runtime env still hash-match the
      running `engage-app-1` container (see deployment doc section 6.1).
- [ ] No deployment in progress; zero production deployments in Coolify.
- [ ] Port `4321` is owned only by `engage-app-1`.
- [ ] Prebuilt image revision label equals the approved commit; the stopped
      placeholder container is present.
- [ ] Final-backup helper `/opt/engage/backups/fb.sh` is installed, mode 0700,
      and was tested against the staging database.
- [ ] `/mnt/storage` has ample free space and inodes; `/var` on Debian and `/`
      on the NUC have at least 10 GiB free.

## Freeze

```sh
# Pause the staging poller so it cannot queue work during the window
ssh debian 'crontab -l > /tmp/engage-crontab.before'
ssh debian 'crontab -l | sed "s#^\(\*/2 .*engage-coolify-poll.*\)#\#\1#" | crontab -'

# Confirm production auto-deploy is off and no scheduled task can redeploy it
ssh debian "docker exec coolify-db psql -U coolify -d coolify -c \
  \"select a.name, s.is_auto_deploy_enabled from applications a \
    join application_settings s on s.application_id=a.id;\""
ssh debian "docker exec coolify-db psql -U coolify -d coolify -c \
  \"select id,name,command,frequency,enabled from scheduled_tasks where application_id=2;\""
```

- [ ] Poller paused (crontab saved for restoration).
- [ ] Production `is_auto_deploy_enabled = false`.
- [ ] No enabled scheduled task for production.
- [ ] No production GitHub webhook can reach the LAN-only Coolify instance.
      `manual_webhook_secret_github` is present but inert while auto-deploy is
      off; do not expose Coolify publicly during the window.

## Fresh backup, restore test, and off-host copy

Take a fresh logical backup before the window. This is the rollback/disaster
copy; the **final** quiescent backup is taken automatically by the custom start
command after `engage-app-1` stops (see Cutover).

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

Restore-test it into a disposable, network-isolated MongoDB (tmpfs only):

```sh
ssh alpine 'bash -s' <<'EOF'
set -euo pipefail
ARCHIVE=$(ls -t /opt/engage/backups/pre-cutover-*.archive.gz | head -1)
NAME=engage-restore-test-$$
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
docker run -d --rm --name "$NAME" --tmpfs /data/db:rw,size=1g \
  --network none mongo:8.0 --bind_ip 127.0.0.1 >/dev/null
for i in $(seq 1 40); do
  docker exec "$NAME" mongosh --quiet --eval 'db.adminCommand({ping:1}).ok' \
    >/dev/null 2>&1 && break; sleep 1
done
docker cp "$ARCHIVE" "$NAME:/tmp/backup.archive.gz"
docker exec "$NAME" mongorestore --archive=/tmp/backup.archive.gz --gzip \
  --nsFrom='engage_production.*' --nsTo='engage_restore_test.*'
docker exec "$NAME" mongosh --quiet engage_restore_test --eval \
  'db.getCollectionNames().sort().forEach(c => print(c+" "+db.getCollection(c).countDocuments()))'
EOF
```

Compare the counts with production. The 2026-11-08 verification restored 414
documents across all 22 collections with 0 failures and all indexes; the
counts matched production exactly. Do not restore over `engage_production`.

Copy the fresh backup off-host (different host, `/mnt/storage` pool):

```sh
ssh debian 'mkdir -p /mnt/storage/data/engage-backups && chmod 700 /mnt/storage/data/engage-backups'
ssh debian "scp -q root@192.168.86.199:/opt/engage/backups/pre-cutover-<stamp>.archive.gz \
  /mnt/storage/data/engage-backups/ && chmod 600 /mnt/storage/data/engage-backups/pre-cutover-<stamp>.archive.gz"
ssh debian 'sha256sum /mnt/storage/data/engage-backups/pre-cutover-<stamp>.archive.gz'
ssh alpine 'sha256sum /opt/engage/backups/pre-cutover-<stamp>.archive.gz'
```

- [ ] Backup written, `0600`, `gzip -t` OK.
- [ ] Restore test passed; counts and indexes match production.
- [ ] Off-host copy exists and its SHA-256 matches the NUC copy.
- [ ] The final post-stop backup will be produced by the custom start command
      and copied off-host immediately after the cutover.

## Prebuild and protect the production image (no production impact)

If the image from the 2026-11-08 verification is still present with the correct
revision label, skip the build and go to the protection check. Otherwise build
it from the exact final release commit on the NUC. The commands below use the
release variables defined at the top of this page:

```sh
# On the workstation, from the repository that tracks the approved commit:
SHA="$RELEASE_SHA"
git archive --format=tar.gz --prefix=engage-src/ "$SHA" -o /tmp/engage-src.tar.gz
scp -q /tmp/engage-src.tar.gz alpine:/tmp/engage-src.tar.gz

# On the NUC:
ssh alpine
rm -rf /tmp/engage-build && mkdir -p /tmp/engage-build
tar -xzf /tmp/engage-src.tar.gz -C /tmp/engage-build
cd /tmp/engage-build/engage-src
DOCKER_BUILDKIT=0 docker build \
  --label "org.opencontainers.image.revision=$SHA" \
  --label "org.opencontainers.image.source=https://github.com/Fusion-Party-Aus/Engage" \
  -t "$RELEASE_IMAGE" -f Dockerfile .
```

Smoke-test on a spare loopback port against the staging database (never
production port 4321):

```sh
ssh alpine 'bash -s' <<'EOF'
set -euo pipefail
NAME=engage-prebuilt-smoke-$$
ENVF=/tmp/engage-prebuilt-smoke-$$.env
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -f "$ENVF"' EXIT
APP=$(docker ps --filter name=app-sgo3uctmylpzyyszoj8drskb --format '{{.Names}}' | head -1)
docker inspect "$APP" --format '{{range .Config.Env}}{{println .}}{{end}}' > "$ENVF"
docker run -d --rm --name "$NAME" \
  --network sgo3uctmylpzyyszoj8drskb_staging \
  --env-file "$ENVF" -p 127.0.0.1:14321:4321 \
  "$RELEASE_IMAGE"
for i in $(seq 1 40); do
  curl -sf http://127.0.0.1:14321/api/health && break; sleep 1
done
for p in / /policies/ /member/ /admin/; do
  echo "$p $(curl -sL -o /dev/null -w '%{http_code}' http://127.0.0.1:14321$p)"
done
EOF
```

**Protect the image from Coolify's image prune.** Coolify's `CleanupDocker`
deletes tagged images that no container references. A stopped placeholder
container keeps the image alive:

```sh
ssh alpine "docker inspect '$PROTECTION_CONTAINER' >/dev/null 2>&1 || \
  docker create --name '$PROTECTION_CONTAINER' \
    --label engage.rollback-protected=true '$RELEASE_IMAGE'"
```

- [ ] Image built from the approved commit and labelled with the revision.
- [ ] Smoke test healthy on `127.0.0.1:14321`; main routes return 200.
- [ ] Placeholder container exists and is stopped.
- [ ] A Coolify `CleanupDocker` run leaves the image in place (verified
      2026-11-08).
- [ ] Production port `4321` was never bound by the test.

## Install the final-backup helper

Coolify's `docker_compose_custom_start_command` column is `varchar(255)`, so the
backup logic lives in a small host script rather than an inline command. Copy
[`scripts/coolify-final-backup.sh`](../scripts/coolify-final-backup.sh) to the
NUC:

```sh
scp scripts/coolify-final-backup.sh alpine:/opt/engage/backups/fb.sh
ssh alpine 'chmod 700 /opt/engage/backups/fb.sh'
```

The script reads `/tmp/e` (the host `/opt/engage/.env` mounted read-only),
extracts only `MONGO_APP_USER`, `MONGO_APP_PASSWORD`, and `MONGODB_DB_NAME`,
and writes `pre-cutover-<timestamp>.archive.gz` with mode 0600 to `/b` (the
host `/opt/engage/backups`). It was tested on 2026-11-08 against the staging
database; the archive passed `gzip -t`.

- [ ] Script installed at `/opt/engage/backups/fb.sh`, mode 0700.
- [ ] Script test produced a valid gzip archive.

## Configure Coolify for the prebuilt-image start

Use the temporary write token. Keep the real build command for later; the
no-op build command and custom start are only for the cutover deployment.

```sh
export COOLIFY_URL='http://192.168.86.134:8000'
export COOLIFY_TOKEN='<temporary read/write/deploy token>'
export PROD_UUID='k4jns8zq5ctcnzixaadzza4k'

# 1. Pin the immutable prebuilt image tag
curl -sS -X PATCH "$COOLIFY_URL/api/v1/applications/$PROD_UUID/envs" \
  -H "Authorization: Bearer $COOLIFY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"key\":\"APP_IMAGE_TAG\",\"value\":\"$RELEASE_IMAGE_TAG\"}"

# 2. No-op build: Coolify skips the real build and the registry pull
curl -sS -X PATCH "$COOLIFY_URL/api/v1/applications/$PROD_UUID" \
  -H "Authorization: Bearer $COOLIFY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"docker_compose_custom_build_command":"true"}'

# 3. Last-moment stop + final quiescent backup + start the prebuilt image.
#    The backup logic is in /opt/engage/backups/fb.sh (see above). The flag
#    injector adds -f and --env-file to the compose command automatically.
curl -sS -X PATCH "$COOLIFY_URL/api/v1/applications/$PROD_UUID" \
  -H "Authorization: Bearer $COOLIFY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"docker_compose_custom_start_command":"docker stop engage-app-1 && docker run --rm --network engage_default -v /opt/engage/.env:/tmp/e:ro -v /opt/engage/backups:/b mongo:8.0 sh /b/fb.sh && docker compose --project-name k4jns8zq5ctcnzixaadzza4k up -d --no-build"}'
```

The custom start command is 221 characters, fits Coolify's `varchar(255)`
column, and was validated with Coolify's own `injectDockerComposeFlags` and
`SHELL_SAFE_COMMAND_PATTERN`. It expands to:

```text
docker stop engage-app-1
&& docker run --rm --network engage_default \
     -v /opt/engage/.env:/tmp/e:ro -v /opt/engage/backups:/b \
     mongo:8.0 sh /b/fb.sh
&& docker compose -f <deployment>/docker-compose.yaml \
     --env-file <deployment>/.env \
     --project-name k4jns8zq5ctcnzixaadzza4k up -d --no-build
```

- [ ] `APP_IMAGE_TAG` is `$RELEASE_IMAGE_TAG`.
- [ ] `docker_compose_custom_build_command` is `true`.
- [ ] `docker_compose_custom_start_command` is set exactly as above.
- [ ] Port `4321` is still owned by `engage-app-1` (nothing has deployed yet).

## Cutover

```sh
# Trigger the Coolify production deployment. The old app stays up while
# Coolify clones and prepares; the custom start command then stops it,
# takes the final backup, and starts the prebuilt image.
curl -sS -X POST "$COOLIFY_URL/api/v1/deploy" \
  -H "Authorization: Bearer $COOLIFY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"uuid\":\"$PROD_UUID\"}"

# Record the deployment UUID from the response, then poll it:
curl -sS "$COOLIFY_URL/api/v1/deployments/<deployment_uuid>" \
  -H "Authorization: Bearer $COOLIFY_TOKEN"
```

- [ ] Deployment queued; record the deployment UUID.
- [ ] Old app stopped by the custom start command (not by a separate manual
      stop), so downtime starts at the last possible moment.
- [ ] Final backup `pre-cutover-<timestamp>.archive.gz` written to
      `/opt/engage/backups/` while the old app was stopped.
- [ ] New container starts on `127.0.0.1:4321` from the prebuilt image, with
      `--no-build`.
- [ ] Deployment finishes `finished` (not `failed`).

Immediately copy the final post-stop backup off-host:

```sh
ssh debian 'scp -q root@192.168.86.199:/opt/engage/backups/pre-cutover-<timestamp>.archive.gz \
  /mnt/storage/data/engage-backups/'
ssh debian 'chmod 600 /mnt/storage/data/engage-backups/pre-cutover-<timestamp>.archive.gz'
ssh debian 'sha256sum /mnt/storage/data/engage-backups/pre-cutover-<timestamp>.archive.gz'
ssh alpine 'sha256sum /opt/engage/backups/pre-cutover-<timestamp>.archive.gz'
```

## Verify

```sh
# Container identity: image ID must match the prebuilt image
ssh alpine 'docker ps --filter name=k4jns8zq5ctcnzixaadzza4k \
  --format "{{.Names}} {{.Image}} {{.Status}} {{.Ports}}"'
ssh alpine 'docker inspect <new-container> --format "{{.Image}}"'
ssh alpine 'curl -sf http://127.0.0.1:4321/api/health'
ssh alpine 'docker logs <new-container> --tail 100'

# Routes (follow redirects)
for p in / /policies/ /member/ /admin/; do
  curl -sL -o /dev/null -w "$p %{http_code}\n" "http://127.0.0.1:4321$p"
done

# Public endpoint (Cloudflare Tunnel unchanged)
curl -sf https://engage.fusionparty.org.au/api/health
```

- [ ] Container image ID equals the release image ID recorded before the window.
- [ ] `/api/health` returns `{"ok":true,"status":"healthy"}`.
- [ ] Main routes render; no 5xx.
- [ ] Logs show no DB/auth errors and no restart loop.
- [ ] Public HTTPS endpoint works through the existing tunnel.
- [ ] A real member sign-in / admin read-only smoke check passes (if approved).
- [ ] Final backup exists on both hosts with matching SHA-256.

## If verification fails — rollback immediately

Trigger: health check fails for more than 60 seconds, repeated 5xx, DB/auth
errors, a restart loop, broken main routes, or the public endpoint stays down.

```sh
# 1. Stop the Coolify-managed app and let it remove its container
curl -sS -X POST "$COOLIFY_URL/api/v1/applications/$PROD_UUID/stop" \
  -H "Authorization: Bearer $COOLIFY_TOKEN"

# 2. Confirm the Coolify app is gone and port 4321 is free
ssh alpine 'docker ps -a --filter name=k4jns8zq5ctcnzixaadzza4k'
ssh alpine 'ss -ltnp | grep 4321 || echo "port 4321 free"'

# 3. Restart the preserved legacy container. This does not rebuild anything.
ssh alpine 'docker start engage-app-1'
ssh alpine 'curl -sf http://127.0.0.1:4321/api/health'
curl -sf https://engage.fusionparty.org.au/api/health
```

Do **not** use Coolify's `/start` endpoint for rollback or cutover start: it
queues a full deployment and rebuilds the images (verified 2026-11-08).

If `engage-app-1` was accidentally removed, recreate it from the preserved
release without building:

```sh
ssh alpine
cd /opt/engage/current
docker compose -p engage --env-file /opt/engage/.env \
  -f docker-compose.yml -f compose.nuc.yml up -d --no-build --wait app
```

- [ ] Coolify app stopped; port `4321` free.
- [ ] `engage-app-1` restarted and healthy.
- [ ] Public endpoint healthy.
- [ ] Incident note recorded.
- [ ] `engage_mongo_data` untouched.
- [ ] Production auto-deploy remains off.

## Post-cutover

- [ ] Leave `engage-app-1` stopped (not removed) for 24–48 hours.
- [ ] Keep `fusion-engage:review-20261106`, `/opt/engage/current`,
      `$RELEASE_IMAGE`, and the placeholder container intact
      during the rollback window.
- [ ] Monitor logs, health, disk, and the public endpoint for the agreed period.
- [ ] After the window, restore the normal build command and remove the custom
      start command:
      `docker_compose_custom_build_command=DOCKER_BUILDKIT=0 docker compose build --pull`,
      `docker_compose_custom_start_command=null`.
- [ ] For the next deliberate production release, set `APP_IMAGE_TAG` to the
      new commit's SHA and rebuild; do not silently reuse the old prebuilt tag.
- [ ] Remove the placeholder container
      (`docker rm "$PROTECTION_CONTAINER"`) only after the new app is
      stable and the old container is no longer needed for rollback.
- [ ] Restore the poller crontab (`crontab /tmp/engage-crontab.before`) only
      after the cutover is stable. The poller still targets staging; do not
      point it at production.
- [ ] Rotate/revoke the temporary write token.
- [ ] Update [coolify-deployment.md](coolify-deployment.md) status.

## Success / failure criteria

Success:

- Coolify production deployment `finished`.
- Container runs the prebuilt image ID, healthy on `127.0.0.1:4321`.
- `/api/health`, main routes, logs, and the public HTTPS endpoint pass.
- Final quiescent backup exists on the NUC and off-host with matching checksums.

Failure / rollback trigger:

- No healthy container within 60 seconds of the old app stopping.
- Health endpoint returns non-200 or the container restarts repeatedly.
- DB authentication/connection errors in logs.
- Public endpoint unavailable or main routes broken.
- The deployment starts from a different image ID than the recorded prebuilt
  image.

## Explicitly out of scope

- No database migration or volume recreation.
- No Cloudflare DNS or tunnel ingress change.
- No changes to the host Caddy analytics route.
- No CI workflow changes.
- No automatic production deployment.
