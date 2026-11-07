# Production cutover checklist — Engage on Coolify

This is the approval-gated step that moves production traffic from the existing
`engage-app-1` container to the Coolify-managed production application. It is
the only step that interrupts the existing deployment.

Read [coolify-deployment.md](coolify-deployment.md) first.

## Approval gate

- [ ] Written approval from the Engage owner for a maintenance window.
- [ ] Operator understands the site will be unavailable while the old app is
      stopped and the new image is built/started.
- [ ] Rollback owner and contact are known.
- [ ] No ballot closure, voting deadline, or member communication is scheduled
      in the window.
- [ ] `FORMAL_BALLOTS_ENABLED` is `false` in the existing production `.env`
      (current state), or the owner has explicitly accepted the change.

## Preflight (read-only)

```sh
# Existing stack is healthy
ssh alpine 'docker ps --filter name=engage-app-1 --filter name=engage-mongo-1'
ssh alpine 'curl -sf http://127.0.0.1:4321/api/health'

# Public endpoint is healthy
curl -sf https://engage.fusionparty.org.au/api/health

# Coolify production app is configured but not running
curl -s "$COOLIFY_URL/api/v1/applications/$PROD_UUID" \
  -H "Authorization: Bearer $COOLIFY_TOKEN"

# Production app env matches the running container (hashes, no values)
# See Appendix C of coolify-deployment.md for the verification used.

# No deployment is already in progress
curl -s "$COOLIFY_URL/api/v1/deployments" \
  -H "Authorization: Bearer $COOLIFY_TOKEN"

# Port 4321 is owned only by the old app
ssh alpine 'ss -ltnp | grep 4321'
```

- [ ] Existing app and Mongo healthy.
- [ ] Public HTTPS health check passes.
- [ ] Coolify production app is `exited`/not running, auto-deploy `false`.
- [ ] `MONGODB_URI` hash matches the running container.
- [ ] No deployment in progress.
- [ ] Port `4321` is owned only by `engage-app-1`.

## Freeze and backup

```sh
# Pause the staging poller so it cannot queue work during the window
ssh debian 'crontab -l | sed "s#^\(\*/2 .*engage-coolify-poll.*\)#\#\1#" | crontab -'

# Fresh logical backup
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

- [ ] Poller paused.
- [ ] Backup written, `0600`, gzip OK.
- [ ] Backup copied off-host or confirmed covered by the off-host policy.

## Cutover

```sh
# 1. Stop the old app but keep the container and image for rollback
ssh alpine 'docker stop engage-app-1'
ssh alpine 'ss -ltnp | grep 4321 || echo "port 4321 free"'

# 2. Deploy the Coolify production app
curl -s -X POST "$COOLIFY_URL/api/v1/deploy" \
  -H "Authorization: Bearer $COOLIFY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"uuid\":\"$PROD_UUID\"}"
```

- [ ] `engage-app-1` stopped, not removed.
- [ ] Port `4321` free.
- [ ] Deployment queued; record the deployment UUID.
- [ ] Build completes; container starts on `127.0.0.1:4321`.

## Verify

```sh
ssh alpine 'docker ps --filter name=k4jns8zq5ctcnzixaadzza4k --format "{{.Names}} {{.Status}} {{.Ports}}"'
ssh alpine 'curl -sf http://127.0.0.1:4321/api/health'
ssh alpine 'docker logs <new-container> --tail 100'

# Routes (follow redirects)
for p in / /policies/ /member/ /admin/; do
  curl -sL -o /dev/null -w "$p %{http_code}\n" "http://127.0.0.1:4321$p"
done

# Public endpoint (Cloudflare Tunnel unchanged)
curl -sf https://engage.fusionparty.org.au/api/health
```

- [ ] Container healthy on `127.0.0.1:4321`.
- [ ] `/api/health` returns `{"ok":true,"status":"healthy"}`.
- [ ] Main routes render.
- [ ] Logs show no DB/auth errors.
- [ ] Public HTTPS endpoint works through the existing tunnel.
- [ ] A real member sign-in / admin read-only smoke check passes (if approved).

## If verification fails — rollback immediately

```sh
# Stop the Coolify-managed app
curl -s -X POST "$COOLIFY_URL/api/v1/applications/$PROD_UUID/stop" \
  -H "Authorization: Bearer $COOLIFY_TOKEN"

# Restart the preserved old container
ssh alpine 'docker start engage-app-1'
ssh alpine 'curl -sf http://127.0.0.1:4321/api/health'
curl -sf https://engage.fusionparty.org.au/api/health
```

If the container was removed, recreate it from the preserved release:

```sh
ssh alpine
cd /opt/engage/current
docker compose -p engage --env-file /opt/engage/.env \
  -f docker-compose.yml -f compose.nuc.yml up -d --no-build --wait app
```

- [ ] Old app restarted and healthy.
- [ ] Public endpoint healthy.
- [ ] Incident note recorded.
- [ ] Do not touch `engage_mongo_data`.

## Post-cutover

- [ ] Leave `engage-app-1` stopped for 24–48 hours.
- [ ] Keep `fusion-engage:review-20261106` and `/opt/engage/current` intact.
- [ ] Monitor logs, health, and disk for the agreed period.
- [ ] If stable and approved, point the poller at the production app UUID (or
      add a production entry) and re-enable cron.
- [ ] If automatic production deploys are desired, document the approval and
      verify a rollback deployment first.
- [ ] Update [coolify-deployment.md](coolify-deployment.md) status.
- [ ] Rotate setup tokens and store the poller token in the password manager.

## Explicitly out of scope

- No database migration or volume recreation.
- No Cloudflare DNS or tunnel ingress change.
- No changes to the host Caddy analytics route.
- No CI workflow changes.
