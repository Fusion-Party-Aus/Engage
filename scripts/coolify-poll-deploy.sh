#!/usr/bin/env bash
# Trigger Coolify deployments: Deploy Staging first, verify it's green, then deploy Production.
#
# Why this exists: the Coolify instance on nexus-debian is LAN-only, so
# github.com cannot deliver an inbound webhook. This poller runs on the Coolify
# host, watches the branch, and orchestrates the staging-to-production promotion
# pipeline via Coolify's API.
#
# Install:
#   /usr/local/sbin/engage-coolify-poll
#   /etc/engage-coolify-poll.env          (root:root 0600)
#   engage-coolify-poll.service + .timer  (see deploy/systemd/)
set -euo pipefail

CONFIG="${ENGAGE_COOLIFY_POLL_CONFIG:-/home/ethan/engage-coolify-poll/poll.env}"
# shellcheck source=/dev/null
. "$CONFIG"

: "${COOLIFY_URL:?COOLIFY_URL is required}"
: "${COOLIFY_TOKEN:?COOLIFY_TOKEN is required}"
: "${STAGING_APP_UUID:=${APP_UUID:?STAGING_APP_UUID is required}}"
: "${PROD_APP_UUID:?PROD_APP_UUID is required}"
: "${REPO_URL:?REPO_URL is required}"
: "${BRANCH:?BRANCH is required}"
STATE_DIR="${STATE_DIR:-/home/ethan/engage-coolify-poll/state}"
STAGING_HEALTH_URL="${STAGING_HEALTH_URL:-http://192.168.86.199:4400/api/health}"

umask 077
mkdir -p "$STATE_DIR"
exec 9>"$STATE_DIR/poll.lock"
flock -n 9 || exit 0

log() { printf '%s %s\n' "$(date -Is)" "$*"; }

current="$(git ls-remote "$REPO_URL" "refs/heads/$BRANCH" | awk 'NR==1 {print $1}')"
if [ -z "$current" ]; then
  log "ERROR could not resolve $REPO_URL refs/heads/$BRANCH"
  exit 1
fi

staging_state="$STATE_DIR/$STAGING_APP_UUID.sha"
prod_state="$STATE_DIR/$PROD_APP_UUID.sha"
last_prod="$(cat "$prod_state" 2>/dev/null || true)"

if [ "$current" = "$last_prod" ]; then
  exit 0
fi

deploy_app() {
  local uuid="$1"
  local label="$2"
  local resp
  resp="$(curl -fsS -X POST "$COOLIFY_URL/api/v1/deploy" \
    -H "Authorization: Bearer $COOLIFY_TOKEN" \
    -H 'Content-Type: application/json' \
    --data "{\"uuid\":\"$uuid\"}")" || return 1
  printf '%s' "$resp" | sed -n 's/.*"deployment_uuid":"\([^"]*\)".*/\1/p'
}

get_deployment_status() {
  local dep_uuid="$1"
  curl -fsS -H "Authorization: Bearer $COOLIFY_TOKEN" "$COOLIFY_URL/api/v1/deployments/$dep_uuid" 2>/dev/null | \
    sed -n 's/.*"status":"\([^"]*\)".*/\1/p'
}

log "branch $BRANCH moved ${last_prod:-<none>} -> $current; starting Staging deployment ($STAGING_APP_UUID)"

staging_dep="$(deploy_app "$STAGING_APP_UUID" "staging")"
if [ -z "$staging_dep" ]; then
  log "ERROR: Failed to queue Coolify deployment for staging"
  exit 1
fi

log "queued Staging deployment $staging_dep at commit $current; waiting for Staging build..."

# Wait up to 35 minutes for Staging deployment (Astro compile can take significant CPU time on low-power hosts)
max_wait=2100
interval=15
elapsed=0
staging_success=0

while [ "$elapsed" -lt "$max_wait" ]; do
  sleep "$interval"
  elapsed=$((elapsed + interval))
  status="$(get_deployment_status "$staging_dep")"
  
  if [ "$status" = "finished" ]; then
    log "Staging build finished successfully in ${elapsed}s"
    staging_success=1
    break
  elif [ "$status" = "failed" ] || [ "$status" = "error" ] || [ "$status" = "cancelled" ]; then
    log "ERROR: Staging deployment ended with status '$status'. Aborting promotion to production."
    exit 1
  fi
done

if [ "$staging_success" -ne 1 ]; then
  log "ERROR: Staging deployment timed out after ${max_wait}s. Aborting promotion to production."
  exit 1
fi

printf '%s\n' "$current" > "$staging_state"

# Verify Staging Health Check
log "Verifying Staging health at $STAGING_HEALTH_URL..."
health_ok=0
for i in {1..12}; do
  if curl -fsS -m 5 "$STAGING_HEALTH_URL" >/dev/null 2>&1; then
    health_ok=1
    break
  fi
  sleep 5
done

if [ "$health_ok" -ne 1 ]; then
  log "ERROR: Staging health check failed after deployment. NOT promoting to production."
  exit 1
fi

log "Staging is 100% HEALTHY and GREEN! Promoting commit $current to Production ($PROD_APP_UUID)..."

prod_dep="$(deploy_app "$PROD_APP_UUID" "production")"
if [ -z "$prod_dep" ]; then
  log "ERROR: Failed to queue Coolify deployment for production"
  exit 1
fi

log "queued Production deployment $prod_dep at commit $current"
printf '%s\n' "$current" > "$prod_state"
