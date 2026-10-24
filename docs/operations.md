# Self-hosted operations

## Container stack

The initial host is a Docker-capable NUC. Docker Compose runs the Astro standalone Node server and a single-node MongoDB 8 replica set on a private Compose network. Transactions are required for vote admission and closure; standalone MongoDB is unsupported for voting. This provides no host failover. MongoDB data persists in the `mongo_data` named volume. The application connects with a database-scoped `readWrite` user; the MongoDB root credentials are used only for initialization and administration. No Cloudflare account, Atlas cluster, or paid service is required for this deployment.

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

## Ballot closure and recovery

MongoDB must run as a replica set. Admission conditionally writes the current open ballot using database time, then saves the selection and choice-free audit in one transaction. Closure writes that same ballot through a transaction, waiting for admitted votes to commit or abort. Deadline and administrative closure therefore cannot race past a selection write. The admission interval is opening-inclusive and closing-exclusive. The recorded closure time comes from the database write, not the time a close request arrived. See [ADR 0003](adr/0003-reclaim-mvp-node-mongodb.md). Both deadline and administrator closure call `finalizeBallot`. Closure records its actor and timestamp, then a conditional write records one authoritative tally. Results endpoints use that stored tally. A closed ballot cannot reopen; create a new ballot for another decision.

Approved revision publication and operational audit writes are retryable effects of that recorded result. `finalizedAt` and `publishedRevisionId` are set only after those writes succeed. Publication uses a conditional revision update; audit events use deterministic IDs. Concurrent calls and retries preserve the tally, closure provenance and completed effects. Database failures propagate rather than being treated as successful closure.

To locate incomplete closures, inspect `ballots` with `{ status: "closed", finalizedAt: { $exists: false } }`. Restore a missing revision or resolve a conflicting publication, then repeat the administrator's close request. Normal ballot/catalogue reads also retry incomplete closures. Do not clear results or manually recalculate a recorded outcome. A published revision can exist before a failed audit write is repaired; the ballot remains incomplete until recovery succeeds. Older finalised records without results require restoration of the authoritative record, not an invented tally.

Membership transitions are audited in `memberships.auditHistory`, atomically with the status change. Each entry records actor, previous status, new status and timestamp. `auditVersion` prevents two reviewers from overwriting the same transition. A conflict requires reloading and retrying; an unchanged status adds no completed transition. Legacy `operational_audit` request entries remain historical requests and must not be interpreted as completed verification. Back up membership documents with their embedded history.

## Replica-set bootstrap and upgrade

`docker/mongo-start.sh` retains an internal replica key at `/data/db/engage-replica.key`, readable only by MongoDB. The official image still creates the existing root and database-scoped app users. The authenticated health check initialises replica set `engage` after the temporary user-creation server exits, and only reports healthy when the final server is primary. Health failure blocks app startup. The existing `mongo_data` volume/database names are unchanged.

Back up an existing volume before upgrading; stop the old app before switching MongoDB to replica mode. Start only MongoDB, check primary status and the scoped app user's transaction capability, then start the reviewed app. Do not run old and new app writers together. A one-node replica set adds atomic transactions, not a second copy of the data. Monitor time synchronisation: MongoDB time governs admission.

The Compose replica advertises `mongo:27017`; app-only development via the host port must use `replicaSet=engage&directConnection=true` as in `.env.example`. Do not expose that port remotely. For preview backup scripts, these URI options must be quoted when exporting in a shell; sourcing `.env` with a raw unquoted `&` is unsafe. Use the quoted example in `.env.example`.

For a disposable integration replica set (no real data or credentials), start:

```sh
docker run -d --name engage-auth-test -p 127.0.0.1:27029:27017 mongo:8.0 --replSet engage-test --bind_ip_all
docker exec engage-auth-test mongosh --quiet --eval 'rs.initiate({_id:"engage-test",members:[{_id:0,host:"localhost:27017"}]})'
docker exec engage-auth-test mongosh --quiet --eval 'db.hello().isWritablePrimary'
```

Wait for the last command to print `true`; do not run integration tests against an uninitialised or standalone server. Use `mongodb://127.0.0.1:27029/?directConnection=true` for the test URI. The CI workflow performs bounded readiness polling and fails if election does not complete. Each integration runner creates and drops its own uniquely named test database; never point it at a production service.

Before deployment acceptance, rehearse new-volume bootstrap, existing-volume conversion, scoped-user vote transactions, app/MongoDB restart and restored-data operation on the actual Docker host. Native replica-set tests cannot certify the entrypoint scripts. Keep the previous application image for non-voting rollback, but never restore a writer with the old admission race after real voting starts. Do not remove the volume or discard authoritative results as a rollback strategy.

## Local verification evidence

The actual Docker image and Compose stack have passed local bootstrap, scoped-user transactions, HTTP participation, restarts/container replacement, a disposable standalone-volume upgrade and preview backup/restore. See [the verification report](deployment-verification.md) for commands, limits and the host/database clock regression correction. Repeat acceptance on the target host; production encrypted off-host recovery and live HTTPS/OAuth remain unverified.
