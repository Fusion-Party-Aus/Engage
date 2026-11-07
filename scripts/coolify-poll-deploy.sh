#!/usr/bin/env bash
# Trigger a Coolify deployment when the designated Git branch changes.
#
# Why this exists: the Coolify instance on nexus-debian is LAN-only, so
# github.com cannot deliver an inbound webhook. This poller runs on the Coolify
# host, watches the branch, and calls Coolify's own deploy API. It is a
# deployment trigger, not CI: it runs no tests and builds nothing itself.
#
# Install:
#   /usr/local/sbin/engage-coolify-poll
#   /etc/engage-coolify-poll.env          (root:root 0600)
#   engage-coolify-poll.service + .timer  (see deploy/systemd/)
set -euo pipefail

CONFIG="${ENGAGE_COOLIFY_POLL_CONFIG:-/etc/engage-coolify-poll.env}"
# shellcheck source=/dev/null
. "$CONFIG"

: "${COOLIFY_URL:?COOLIFY_URL is required}"
: "${COOLIFY_TOKEN:?COOLIFY_TOKEN is required}"
: "${APP_UUID:?APP_UUID is required}"
: "${REPO_URL:?REPO_URL is required}"
: "${BRANCH:?BRANCH is required}"
STATE_DIR="${STATE_DIR:-/var/lib/engage-coolify-poll}"

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

state_file="$STATE_DIR/$APP_UUID.sha"
last="$(cat "$state_file" 2>/dev/null || true)"
if [ "$current" = "$last" ]; then
  exit 0
fi

log "branch $BRANCH moved ${last:-<none>} -> $current; queuing Coolify deploy for $APP_UUID"

response="$(curl -fsS -X POST "$COOLIFY_URL/api/v1/deploy" \
  -H "Authorization: Bearer $COOLIFY_TOKEN" \
  -H 'Content-Type: application/json' \
  --data "{\"uuid\":\"$APP_UUID\"}")" || {
  status=$?
  log "ERROR Coolify deploy API failed (curl exit $status)"
  exit "$status"
}

deployment_uuid="$(printf '%s' "$response" | sed -n 's/.*"deployment_uuid":"\([^"]*\)".*/\1/p')"
if [ -z "$deployment_uuid" ]; then
  log "ERROR Coolify did not return a deployment_uuid: $response"
  exit 1
fi

printf '%s\n' "$current" > "$state_file"
log "queued deployment $deployment_uuid at commit $current"
