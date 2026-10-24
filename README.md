# Fusion Horizon Policy Platform

Reconstructed Astro application for Fusion’s policy library, member consultation, and policy ballot workflows. The public Reclaim static export remains in the repository as the migration source until the replacement is accepted.

## Local development

Requirements: Node.js 22.12.0 or newer and pnpm 10.28.0.

```sh
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars
pnpm dev
```

The local preview uses synthetic identities only. MongoDB settings go in `.dev.vars`; do not put credentials in tracked files. To create isolated test data, set `APP_MODE=preview`, use a dedicated preview database, then run:

```sh
APP_MODE=preview node scripts/seed-preview.mjs --dry-run
APP_MODE=preview node scripts/seed-preview.mjs --confirm-preview
```

The seed command creates the 36 intended formal ballots in draft state, an isolated preview consultation, and synthetic simulation ballots. It creates no member accounts or votes.

## Checks

```sh
pnpm check
pnpm test
pnpm build
python3 scripts/test-policy-migration.py
```

## Preview deployment

The Cloudflare Worker uses `wrangler.jsonc`. Deployment requires a current Cloudflare login and Worker secrets for `MONGODB_URI` and `SESSION_SECRET`; set `MONGODB_DB_NAME` to a dedicated preview database. The Worker config hard-codes preview mode and binding ballots disabled. See [operations](docs/operations.md) for deployment, connectivity checks, backup/restore, and rollback.

Underground remains the authoritative identity and eligibility service. No supported independent login plus constitutional eligibility interface was found, so the production adapter fails closed. Do not use member email or CRM passwords as a fallback. See [release gates](docs/release-gates.md).
