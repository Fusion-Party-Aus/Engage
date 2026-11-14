# Self-hosted operations

> **Document status: Superseded.** The canonical build and deployment guidance is
> [architecture/build-deploy-operations.md](architecture/build-deploy-operations.md).
> This page records the earlier NUC/Compose procedure and is kept for host detail.
> Where it conflicts with the canonical page, the canonical page and the code win.

## Container stack

The initial host is a Docker-capable NUC. Docker Compose runs the Astro standalone Node server and a single-node MongoDB 8 replica set on a private Compose network. Vote writes, proposal writes and lifecycle transitions use MongoDB transactions when the driver supports sessions, so a replica set is required; standalone MongoDB is unsupported. This provides no host failover. MongoDB data persists in the `mongo_data` named volume (created as `<compose-project>_mongo_data`). The application connects with a database-scoped `readWrite` user; the MongoDB root credentials are used only for initialization and administration. This Compose topology needs no Cloudflare account, Atlas cluster or paid service; the deployed production topology differs and is described in [coolify-deployment.md](coolify-deployment.md).

Set up the host with Docker Engine and the Compose plugin, clone the reviewed branch, then create the local environment file:

```sh
cp .env.example .env
openssl rand -hex 32 # generate unique values for each password and SESSION_SECRET
```

Replace every example value in `.env`. Keep the Mongo app password consistent between `MONGO_APP_PASSWORD` and `MONGODB_URI`. Use hexadecimal passwords as shown so URI escaping is unnecessary. Keep `APP_BIND_ADDRESS=127.0.0.1` and `MONGO_BIND_ADDRESS=127.0.0.1`; MongoDB is not reachable from other hosts, and the app is available only to a reverse proxy on the NUC. Configure that proxy for HTTPS before remote access; production session cookies are Secure and require HTTPS. Do not expose port 27017 to the LAN or internet.

Start the app and database, then verify database connectivity through the app health check:

```sh
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:4321/api/health
```

`/api/health` pings MongoDB and returns `{"ok":true,"status":"healthy",…}`; it returns 503 when the database is unreachable. `docker compose ps` should report both services healthy.

Startup seeds `src/data/policies.json` (78 proposals and governance resolutions, insert-only) into an empty database. There is no preview fixture loader: the former `scripts/seed-preview.mjs` commands, and the synthetic ballots and consultation they produced, no longer exist. Synthetic data for performance runs is created by `scripts/rendering-performance.mjs` (`--seed`) in a separate database.

Set `APP_MODE=preview` only for a synthetic host; `development`, `test` and `preview` accept the development sign-in cookie and production ignores it. For real member participation configure `APP_MODE=production`, a separate database, and the Google and Better Auth settings listed in `.env.example`. Register the public HTTPS callback origin with Google. Grant the first administrator to an existing account with `scripts/grant-engage-admin.mjs` (see the repository README). Never reuse a synthetic preview database for members.

## CI verification prerequisites

Both GitHub workflows run `pnpm test` against an isolated, disposable single-node MongoDB replica set started with `docker run`. The runner must provide Docker, pnpm/node matching `.node-version`, and Python 3.x. The workflows export `VOTING_TEST_MONGODB_URI` and `AUTH_TEST_MONGODB_URI` for that isolated instance and assert that both variables are non-empty before running the suite, so the real MongoDB voting and authentication tests cannot be silently skipped. No workflow connects to the production database.

## Backups and restore drill

The MongoDB named volume protects against app container replacement, not host or disk failure. Run regular logical backups to storage outside the host with restricted access and encryption at rest, using `mongodump` / `mongorestore` from MongoDB Database Tools.

There is no repository preview backup or restore script: the former `scripts/backup-preview.sh` and `scripts/restore-preview.sh`, and the `BACKUP_DIR` / `MONGODB_TARGET_DB_NAME` variables they read, do not exist. Use the host procedure instead:

- [Coolify deployment §11](coolify-deployment.md#11-backup-and-restore) records the manual `mongodump` command, the off-host copy path and the restore-into-a-new-database rule.
- `scripts/coolify-final-backup.sh` is the quiescent pre-cutover dump installed on the host as `/opt/engage/backups/fb.sh`.

Restore only into a new, empty database and verify it before switching the application. Verify the target contains the expected collections, indexes, policy revisions, ballots and vote records. Record only the drill date, operator and pass/fail result; never include member identity or vote choices. A live backup and restore drill on the target host is still required before relying on the process.

## Upgrade and rollback

Build and retain each release under its commit tag. Keep the previous image tag available until the new version passes the preview smoke checks:

```sh
export APP_IMAGE_TAG="$(git rev-parse --short HEAD)"
docker compose build app
docker compose up -d app
docker compose ps
curl --fail http://127.0.0.1:4321/api/health
```

To roll back, set `APP_IMAGE_TAG` to the previous known-good tag and run `docker compose up -d app`. Keep the MongoDB volume unchanged during app rollback. Back up the database before any schema migration or restore operation. The public Reclaim site and any production hostname remain outside this deployment.

## Ballot deadlines, closure and results

MongoDB must run as a replica set: vote writes, proposal writes and lifecycle transitions use transactions when the driver supports sessions.

The implemented model differs from [ADR 0003](adr/0003-reclaim-mvp-node-mongodb.md), which describes a transactional ballot-admission protocol. Admission is not serialised against a ballot document:

- `castVote` (`src/lib/store.ts`) checks `ballotExpired` (`src/lib/ballot-deadline.ts`) against application time before writing, then writes the vote and participation record inside `runInTransaction` (`src/lib/db.ts`).
- Uniqueness is enforced by the partial unique indexes in `ensureProposalVoteIndex` (`src/lib/vote-storage.ts`): one plaintext vote per `(ballotId, memberId)` and one encrypted vote per `(ballotId, voterBlindIndex)`.
- No ballot document is conditionally written, no database-clock admission instant is recorded, and the vote transaction writes no admission ID or choice-free audit event.
- Because the deadline is checked before the transaction rather than inside it, a vote that passes the check can commit after the deadline.

Closure is not a `finalizeBallot` step and does not calculate a tally. `scripts/run-governance-scheduler.ts` (`npm run governance:scheduler`, dry-run by default) calls `src/lib/governance-scheduler.ts`, which for each due ballot conditionally sets `ballotClosedAt` and records one `ballot.closed` event in a transaction. It does not change the stage, record a result or certify an outcome. Leaving Decide or setting a new deadline clears `ballotClosedAt` so the next ballot instance can close; the historical event remains.

Officers record the outcome separately through `POST /api/admin/ballots/result` (`recordFormalDecision`), which requires `ballots.record_result` and matching governance authority and jurisdiction. The recorded result is immutable. Proposal and result reads use `ballot_results` plus the live vote tally; there is no closure-written tally to repair.

To find ballots that cannot close automatically, run `npm run governance:migration-report` (read-only). It lists ballots with a missing or malformed deadline, open `ballots` projection rows with no `closesAt`, and proposals in Deliberate with no deliberation clock. Recover a missing deadline through an authorised officer or migration, then let the scheduler close the ballot. Do not invent a tally or delete votes.

Membership status changes set `updatedBy` and `updatedAt` on the `memberships` record and, when a member becomes verified, write an `engagement_lifecycle_events` record (`verification_approved`). The application does not maintain an embedded `memberships.auditHistory` array, an `auditVersion` field, or a separate membership audit event beyond those records. Proposal edits detect conflicts by matching `updatedAt`. Legacy `operational_audit` request entries remain historical requests and must not be interpreted as completed verification. Back up membership documents with their lifecycle events.

## Replica-set bootstrap and upgrade

`docker/mongo-start.sh` retains an internal replica key at `/data/db/engage-replica.key`, readable only by MongoDB. The official image still creates the existing root and database-scoped app users. The authenticated health check initialises replica set `engage` after the temporary user-creation server exits, and only reports healthy when the final server is primary. Health failure blocks app startup. The existing `mongo_data` volume/database names are unchanged.

Back up an existing volume before upgrading; stop the old app before switching MongoDB to replica mode. Start only MongoDB, check primary status and the scoped app user's transaction capability, then start the reviewed app. Do not run old and new app writers together. A one-node replica set adds atomic transactions, not a second copy of the data. Monitor time synchronisation: the ballot deadline check uses the application clock.

The Compose replica advertises `mongo:27017`; app-only development via the host port must use `replicaSet=engage&directConnection=true` as in `.env.example`. Do not expose that port remotely. `MONGODB_URI` and other values containing `&` must be quoted when exported in a shell; sourcing `.env` with a raw unquoted `&` is unsafe. Use the quoted example in `.env.example`.

For a disposable integration replica set (no real data or credentials), start:

```sh
docker run -d --name engage-auth-test -p 127.0.0.1:27029:27017 mongo:8.0 --replSet engage-test --bind_ip_all
docker exec engage-auth-test mongosh --quiet --eval 'rs.initiate({_id:"engage-test",members:[{_id:0,host:"localhost:27017"}]})'
docker exec engage-auth-test mongosh --quiet --eval 'db.hello().isWritablePrimary'
```

Wait for the last command to print `true`; do not run integration tests against an uninitialised or standalone server. Use `mongodb://127.0.0.1:27029/?directConnection=true` for the test URI. The CI workflow performs bounded readiness polling and fails if election does not complete. Each integration runner creates and drops its own uniquely named test database; never point it at a production service.

Before deployment acceptance, rehearse new-volume bootstrap, existing-volume conversion, scoped-user vote transactions, app/MongoDB restart and restored-data operation on the actual Docker host. Native replica-set tests cannot certify the entrypoint scripts. Keep the previous application image for non-voting rollback, but verify its admission and deadline behaviour before restoring it against data accepted under the current rules. Do not remove the volume or discard authoritative results as a rollback strategy.

## Local verification evidence

As recorded in the 2026-11-08 verification report, the Docker image and Compose stack passed local bootstrap, scoped-user transactions, HTTP participation, restarts/container replacement, a disposable standalone-volume upgrade and preview backup/restore. See [the verification report](deployment-verification.md) for commands, limits and the host/database clock regression correction. Repeat acceptance on the target host; production encrypted off-host recovery and live HTTPS/OAuth remain unverified.
