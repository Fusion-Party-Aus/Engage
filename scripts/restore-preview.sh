#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ "${APP_MODE:-}" != "preview" ]]; then
  echo "Refusing restore: set APP_MODE=preview and use the isolated preview cluster." >&2
  exit 2
fi
: "${MONGODB_URI:?Set the isolated preview MongoDB URI}"
: "${MONGODB_DB_NAME:?Set the source preview database name}"
: "${MONGODB_TARGET_DB_NAME:?Set a new, separate restore-test database name}"
if [[ "$MONGODB_TARGET_DB_NAME" == "$MONGODB_DB_NAME" ]]; then
  echo "Restore target must be a separate database; the source will not be overwritten." >&2
  exit 2
fi
archive="${1:?Usage: scripts/restore-preview.sh /secure/path/backup.archive.gz}"
test -s "$archive" || { echo "Backup archive does not exist or is empty." >&2; exit 2; }
command -v mongorestore >/dev/null || { echo "mongorestore is required (MongoDB Database Tools)." >&2; exit 127; }

# Restore into a new database without --drop. This keeps the source and any existing data intact.
mongorestore --uri="$MONGODB_URI" --archive="$archive" --gzip \
  --nsFrom="${MONGODB_DB_NAME}.*" --nsTo="${MONGODB_TARGET_DB_NAME}.*"
printf 'Restore completed to separate database: %s\n' "$MONGODB_TARGET_DB_NAME"
