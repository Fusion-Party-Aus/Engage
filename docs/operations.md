# Preview operations

## Runtime and secrets

Deploy the app as a Worker using `wrangler.jsonc`. Use a dedicated MongoDB Atlas Free Tier preview cluster and database. Configure `MONGODB_URI` and `SESSION_SECRET` as Worker secrets, and `MONGODB_DB_NAME` as a non-secret Worker variable. Use a random session secret of at least 32 characters. Never use the production database or Underground infrastructure for preview. The Worker config always sets `APP_MODE=preview` and `FORMAL_BALLOTS_ENABLED=false`.

Astro/MongoDB connectivity is verified by calling `GET /api/ballots` after deployment. A successful response contains the seeded draft and synthetic simulation ballot metadata. `503` indicates missing secrets, Atlas network allow-list, or runtime connection failure. The live endpoint check must be completed after Cloudflare login and Atlas preview credentials are available; it cannot be inferred from a successful local build.

To seed a newly created preview database:

```sh
APP_MODE=preview node scripts/seed-preview.mjs --dry-run
APP_MODE=preview node scripts/seed-preview.mjs --confirm-preview
```

The seed is idempotent. It imports immutable policy revisions and 36 intended ballots as draft, plus a separate synthetic consultation and four synthetic simulation ballots. It creates no sample member records or votes.

## Backups and restore drill

Atlas Free Tier regular snapshots are not generally available; this platform does not enable paid backup features. `mongodump`/`mongorestore` is the supported backup path. Store archives only in an access-controlled, encrypted location with restricted operator access. Keep the URI and backup credentials in the existing secret manager or a restricted operator environment; do not place them in tracked files or a shell history.

Install MongoDB Database Tools on the operator workstation, then make a preview backup:

```sh
APP_MODE=preview BACKUP_DIR=/secure/fusion-preview-backups \
  scripts/backup-preview.sh
```

For a restore drill, use a **new empty database** on the isolated preview cluster. The script refuses to restore into the source database and does not use `--drop`:

```sh
APP_MODE=preview MONGODB_TARGET_DB_NAME=fusion_horizon_restore_drill \
  scripts/restore-preview.sh /secure/fusion-preview-backups/<archive>.archive.gz
```

Verify the restored database has all expected collections, indexes, policy revisions, draft ballots, consultation records, and synthetic preview data, then remove the restore-drill database. Record the drill date and operator in the issue. Never include member identity or vote choices in the drill report. Restored counts and indexes can be checked with `mongosh` connected to the isolated target database.

The scripts enforce preview-mode and separate-database guards. They were syntax-checked and exercised with safe-failure cases; a real Atlas backup/restore and Worker connectivity test still requires the isolated Atlas URI and a current Cloudflare deployment login.

## Deployment and rollback

From a logged-in operator environment, deploy the branch to the isolated Worker name from `wrangler.jsonc`, then confirm `/api/ballots`, `/api/session`, consultations, and synthetic sign-in. Keep the existing public Reclaim site untouched. If preview is unhealthy, roll back the Worker to its last known-good version from the Cloudflare deployment history, then verify the preview endpoint and database remain available. Do not route the public Reclaim hostname or enable binding ballots as part of preview release.
