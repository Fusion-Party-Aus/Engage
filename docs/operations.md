# Self-hosted operations

## Container stack

The initial host is a Docker-capable NUC. Docker Compose runs the Astro standalone Node server and MongoDB 8 on a private Compose network. MongoDB data persists in the `mongo_data` named volume. The application connects with a database-scoped `readWrite` user; the MongoDB root credentials are used only for initialization and administration. No Cloudflare account, Atlas cluster, or paid service is required for this deployment.

Set up the host with Docker Engine and the Compose plugin, clone the reviewed branch, then create the local environment file:

```sh
cp .env.example .env
openssl rand -hex 32 # generate unique values for each password and SESSION_SECRET
```

Replace every example value in `.env`. Keep the Mongo app password consistent between `MONGO_APP_PASSWORD` and `MONGODB_URI`. Use hexadecimal passwords as shown so URI escaping is unnecessary. Keep `APP_BIND_ADDRESS=127.0.0.1` and `MONGO_BIND_ADDRESS=127.0.0.1`; MongoDB is not reachable from other hosts, and the app is available only to a reverse proxy on the NUC. Configure that proxy for HTTPS before remote access because preview session cookies are Secure. Do not expose port 27017 to the LAN or internet.

Start the app and database, then verify database connectivity through the app health check:

```sh
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:4321/api/ballots
```

The response is successful even before seeding (an empty ballot list). `docker compose ps` should report both services healthy. To load the intended 36 draft ballots, the isolated synthetic consultation, and four synthetic simulation ballots:

```sh
docker compose run --rm app node /app/scripts/seed-preview.mjs --dry-run
docker compose run --rm app node /app/scripts/seed-preview.mjs --confirm-preview
```

Preview defaults to `APP_MODE=preview` with formal ballots disabled. For real member participation configure `APP_MODE=production`, a separate database, the Google OAuth credentials and Better Auth settings listed in `.env.example`. Register the public HTTPS callback origin with Google. Follow [release gates](release-gates.md) for administrator bootstrap, verification responsibilities and independent binding-ballot authorisation. Never reuse the synthetic preview database for members.

## Backups and restore drill

The MongoDB named volume protects against app container replacement, not host or disk failure. Run regular logical backups to storage outside the NUC with restricted access and encryption at rest. The repository scripts require preview mode and use `mongodump` / `mongorestore`; install MongoDB Database Tools on the host. Load the ignored environment file into the shell first so the URI points to the host-published localhost port:

```sh
set -a
. ./.env
set +a
APP_MODE=preview BACKUP_DIR=/secure/fusion-preview-backups scripts/backup-preview.sh
```

Restore only into a new, empty database. The restore script refuses the source database and does not use `--drop`:

```sh
MONGODB_TARGET_DB_NAME=fusion_horizon_restore_drill \
  scripts/restore-preview.sh /secure/fusion-preview-backups/<archive>.archive.gz
```

Verify the target contains the expected collections, indexes, policy revisions, draft ballots, consultation records, and synthetic preview fixtures. Remove the restore-drill database when verification is complete. Record only the drill date, operator, and pass/fail result; never include member identity or vote choices. Scripts were syntax-checked and exercised with safety failure cases. A live backup and restore drill must be completed on the NUC before relying on the backup process.

## Upgrade and rollback

Build and retain each release under its commit tag. Keep the previous image tag available until the new version passes the preview smoke checks:

```sh
export APP_IMAGE_TAG="$(git rev-parse --short HEAD)"
docker compose build app
docker compose up -d app
docker compose ps
curl --fail http://127.0.0.1:4321/api/ballots
```

To roll back, set `APP_IMAGE_TAG` to the previous known-good tag and run `docker compose up -d app`. Keep the MongoDB volume unchanged during app rollback. Back up the database before any schema migration or restore operation. The public Reclaim site and any production hostname remain outside this deployment.
