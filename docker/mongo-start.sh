#!/usr/bin/env bash
set -euo pipefail
# Internal replica authentication key; retained with the existing database volume.
key=/data/db/engage-replica.key
if [[ ! -s "$key" ]]; then
  umask 077
  openssl rand -base64 756 > "$key"
fi
chmod 400 "$key"
chown mongodb:mongodb "$key"
exec /usr/local/bin/docker-entrypoint.sh mongod --replSet engage --keyFile "$key" --bind_ip_all
