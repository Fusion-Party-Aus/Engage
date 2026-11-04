#!/usr/bin/env bash
set -euo pipefail

# Engage NUC Deployment Script
# Usage: ./scripts/deploy-nuc.sh [IMAGE_TAG_OR_NAME]
# Example: ./scripts/deploy-nuc.sh ghcr.io/fusion-party-aus/engage:sha-116d9d7

ENGAGE_DIR="/opt/engage"
RELEASES_DIR="${ENGAGE_DIR}/releases"
ENV_FILE="${ENGAGE_DIR}/.env"
CURRENT_LINK="${ENGAGE_DIR}/current"
COMPOSE_PROJECT="engage"
HEALTHCHECK_URL="http://127.0.0.1:4321/api/health"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Error: Private environment file ${ENV_FILE} not found." >&2
  exit 1
fi

IMAGE_REF="${1:-${APP_IMAGE:-ghcr.io/fusion-party-aus/engage:latest}}"
GIT_SHA="${GITHUB_SHA:-$(echo "${IMAGE_REF}" | awk -F: '{print $NF}' | tr -cd '[:alnum:]-')}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
RELEASE_ID="nuc-${TIMESTAMP}-${GIT_SHA:0:7}"
NEW_RELEASE_DIR="${RELEASES_DIR}/${RELEASE_ID}"

echo "=== Deploying Engage to NUC ==="
echo "Target Release: ${RELEASE_ID}"
echo "Container Image: ${IMAGE_REF}"
echo "Release Directory: ${NEW_RELEASE_DIR}"

# 1. Pull the container image if not building locally
if [[ "${1:-}" != "--build" ]]; then
  echo "--> Pulling container image: ${IMAGE_REF}..."
  docker pull "${IMAGE_REF}"
fi

# 2. Prepare new release directory
echo "--> Creating release directory: ${NEW_RELEASE_DIR}..."
mkdir -p "${NEW_RELEASE_DIR}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Copy compose definitions, docker assets, and runtime scripts
cp "${ROOT_DIR}/docker-compose.yml" "${NEW_RELEASE_DIR}/"
cp "${ROOT_DIR}/compose.nuc.yml" "${NEW_RELEASE_DIR}/"
cp -r "${ROOT_DIR}/docker" "${NEW_RELEASE_DIR}/"
cp -r "${ROOT_DIR}/scripts" "${NEW_RELEASE_DIR}/"

cd "${NEW_RELEASE_DIR}"

# 3. Store active release record
PREVIOUS_RELEASE_DIR=""
if [[ -L "${CURRENT_LINK}" ]]; then
  PREVIOUS_RELEASE_DIR="$(readlink -f "${CURRENT_LINK}")"
fi

# 4. Deploy container
echo "--> Updating Docker Compose service..."
APP_IMAGE="${IMAGE_REF}" docker compose \
  -p "${COMPOSE_PROJECT}" \
  --env-file "${ENV_FILE}" \
  -f docker-compose.yml \
  -f compose.nuc.yml \
  up -d --no-build --wait app

# 5. Verify Healthcheck
echo "--> Verifying application health endpoint (${HEALTHCHECK_URL})..."
HEALTHY=false
for attempt in $(seq 1 15); do
  if curl -sf --max-time 3 "${HEALTHCHECK_URL}" > /dev/null 2>&1; then
    HEALTHY=true
    break
  fi
  echo "Waiting for healthcheck (attempt ${attempt}/15)..."
  sleep 2
done

if [[ "${HEALTHY}" != "true" ]]; then
  echo "ERROR: Application health check failed at ${HEALTHCHECK_URL}!" >&2
  echo "--> Showing recent container logs:" >&2
  docker compose -p "${COMPOSE_PROJECT}" --env-file "${ENV_FILE}" -f docker-compose.yml -f compose.nuc.yml logs --tail 50 app >&2

  if [[ -n "${PREVIOUS_RELEASE_DIR}" && -d "${PREVIOUS_RELEASE_DIR}" ]]; then
    echo "--> Rolling back to previous release: ${PREVIOUS_RELEASE_DIR}..." >&2
    cd "${PREVIOUS_RELEASE_DIR}"
    docker compose -p "${COMPOSE_PROJECT}" --env-file "${ENV_FILE}" -f docker-compose.yml -f compose.nuc.yml up -d --no-build --wait app
  fi
  exit 1
fi

# 6. Update current symlink
ln -sfn "${NEW_RELEASE_DIR}" "${CURRENT_LINK}"
echo "--> Current release updated: $(readlink -f "${CURRENT_LINK}")"

# 7. Retention cleanup: keep last 5 releases
echo "--> Cleaning up old releases (keeping last 5)..."
cd "${RELEASES_DIR}"
ls -dt nuc-* 2>/dev/null | tail -n +6 | while read -r old_release; do
  if [[ "${RELEASES_DIR}/${old_release}" != "$(readlink -f "${CURRENT_LINK}" 2>/dev/null)" ]]; then
    echo "Removing retired release: ${old_release}"
    rm -rf "${old_release}"
  fi
done

# Prune unused dangling images to maintain disk space
docker image prune -f > /dev/null 2>&1 || true

echo "=== Deployment to NUC Succeeded ==="
echo "Active Image: ${IMAGE_REF}"
echo "URL: https://engage.fusionparty.org.au"
