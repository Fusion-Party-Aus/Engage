# Engage NUC Deployment

Deployed at `https://engage.fusionparty.org.au/` on `root@192.168.86.199` (`nuc-alpine-01`, `linux/amd64`).

## Release Configuration

- **Compose project**: `engage`
- **Release directory**: `/opt/engage/releases/nuc-20261028-vote-fix` (also `/opt/engage/current`)
- **Private environment**: `/opt/engage/.env` (`0600`)
- **Image**: `fusion-engage:nuc-20261028-vote-fix` (`linux/amd64`, pinned in the release's `compose.nuc.yml`)
- **Database**: `engage_production` on MongoDB 8.0 replica set (`127.0.0.1:27041`)
- **Application binding**: `127.0.0.1:4321` routed via Cloudflare tunnel to `https://engage.fusionparty.org.au`

## Operator Commands

```sh
ssh -i ~/.ssh/engage_nuc root@192.168.86.199
cd /opt/engage/current
docker compose -p engage --env-file /opt/engage/.env -f docker-compose.yml -f compose.nuc.yml ps
docker compose -p engage --env-file /opt/engage/.env -f docker-compose.yml -f compose.nuc.yml logs --tail 100 app
docker compose -p engage --env-file /opt/engage/.env -f docker-compose.yml -f compose.nuc.yml up -d --no-build --wait
```

## Administrator Bootstrap

The voting migration `proposal-votes-v1` was applied on 2026-10-28 after backup and
restore rehearsal. See [voting storage migration](voting-storage-migration.md) for
backup location, verification and rollback restrictions. Do not restart the old
writer after new votes have been accepted into `proposal_votes`.

After an operator signs in with email magic link or Google OAuth, grant administrator privileges using their Better Auth user ID:

```sh
docker compose -p engage --env-file /opt/engage/.env -f docker-compose.yml -f compose.nuc.yml exec app node scripts/grant-engage-admin.mjs <userId>
```
