#!/bin/sh
# Quiescent pre-cutover backup for the Coolify custom start command.
#
# Install on the NUC as /opt/engage/backups/fb.sh (0700). The Coolify custom
# start command runs:
#
#   docker stop engage-app-1 \
#     && docker run --rm --network engage_default \
#          -v /opt/engage/.env:/tmp/e:ro \
#          -v /opt/engage/backups:/b \
#          mongo:8.0 sh /b/fb.sh \
#     && docker compose --project-name <uuid> up -d --no-build
#
# /tmp/e is the host production .env mounted read-only. Only the Mongo keys
# are extracted, so the spaces in AUTH_EMAIL_FROM do not break shell parsing.
# /b is the host /opt/engage/backups directory; mongodump writes the archive
# there. The old app has already been stopped when this runs, so the archive
# contains every write up to the cutover.
set -eu

U=$(sed -n 's/^MONGO_APP_USER=//p' /tmp/e)
P=$(sed -n 's/^MONGO_APP_PASSWORD=//p' /tmp/e)
D=$(sed -n 's/^MONGODB_DB_NAME=//p' /tmp/e)

OUT="/b/pre-cutover-$(date +%Y%m%d-%H%M%S).archive.gz"

mongodump --host mongo --port 27017 --username "$U" --password "$P" \
  --authenticationDatabase "$D" --db "$D" --gzip --archive="$OUT"

chmod 600 "$OUT"
