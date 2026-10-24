#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ "${APP_MODE:-}" != "preview" ]]; then
  echo "Refusing backup: set APP_MODE=preview and use the isolated preview database." >&2
  exit 2
fi
: "${MONGODB_URI:?Set the isolated preview MongoDB URI}"
: "${MONGODB_DB_NAME:?Set the isolated preview database name}"
: "${BACKUP_DIR:?Set BACKUP_DIR to an access-controlled, encrypted storage location}"
command -v mongodump >/dev/null || { echo "mongodump is required (MongoDB Database Tools)." >&2; exit 127; }

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$BACKUP_DIR/${MONGODB_DB_NAME}-${stamp}.archive.gz"
mongodump --uri="$MONGODB_URI" --db="$MONGODB_DB_NAME" --archive="$archive" --gzip
chmod 600 "$archive"
test -s "$archive"
printf 'Backup created: %s\n' "$archive"
