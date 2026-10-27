# Engage NUC Deployment

Deployed at `https://engage.fusionparty.org.au/` on `root@192.168.86.199` (`nuc-alpine-01`, `linux/amd64`).

## Release Configuration

- **Compose project**: `engage`
- **Release directory**: `/opt/engage/releases/nuc-20261027-crud`
- **Private environment**: `/opt/engage/.env` (`0600`)
- **Image**: `fusion-engage:nuc-20261027-crud` (`linux/amd64`)
- **Database**: `engage_production` on MongoDB 8.0 replica set (`127.0.0.1:27041`)
- **Application binding**: `127.0.0.1:4321` routed via Cloudflare tunnel to `https://engage.fusionparty.org.au`

## Operator Commands

```sh
ssh -i ~/.ssh/engage_nuc root@192.168.86.199
cd /opt/engage/releases/nuc-20261027-crud
docker compose -p engage --env-file /opt/engage/.env -f docker-compose.yml -f compose.nuc.yml ps
docker compose -p engage --env-file /opt/engage/.env -f docker-compose.yml -f compose.nuc.yml logs --tail 100 app
docker compose -p engage --env-file /opt/engage/.env -f docker-compose.yml -f compose.nuc.yml up -d --no-build --wait
```

## Administrator Bootstrap

After an operator signs in with email magic link or Google OAuth, grant administrator privileges using their Better Auth user ID:

```sh
docker compose -p engage --env-file /opt/engage/.env -f docker-compose.yml -f compose.nuc.yml exec app node scripts/grant-engage-admin.mjs <userId>
```
