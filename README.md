# Fusion Horizon Policy Platform

Reconstructed Astro application for Fusion’s policy library, member consultation, and policy ballot workflows. The public Reclaim static export remains in the repository as the migration source until the replacement is accepted.

## Local development

Requirements: Docker with Compose for the full app and MongoDB stack. For app-only development, Node.js 24 (or 22.23.4 or newer) and pnpm 10.28.0.

```sh
cp .env.example .env
# Replace all example secrets; use `openssl rand -hex 32` for each password/secret.
docker compose up -d mongo
set -a
. ./.env
set +a
pnpm install --frozen-lockfile
pnpm dev
```

The preview is synthetic-only and formal ballots are disabled. `.env` is ignored by Git and configures a local MongoDB container. For the complete containerized stack, run `docker compose up -d --build`; the app binds to localhost by default and MongoDB is not exposed beyond localhost. Put an HTTPS reverse proxy in front before allowing remote access. Do not use this preview for genuine member identities, consultation data, or binding votes.

Seed the local preview once to load the migrated policy revisions, 36 draft formal ballots, one synthetic consultation, and four simulation ballots:

```sh
docker compose run --rm app node /app/scripts/seed-preview.mjs --dry-run
docker compose run --rm app node /app/scripts/seed-preview.mjs --confirm-preview
```

It creates no member accounts or votes.

## Checks

```sh
pnpm check
pnpm test
pnpm build
python3 scripts/test-policy-migration.py
```

## Self-hosted deployment

The Docker Compose stack runs Astro’s standalone Node server and MongoDB on the same host. It persists MongoDB in a named Docker volume, creates a database-scoped application user, keeps synthetic preview mode on, and forces formal ballots off. See [operations](docs/operations.md) for deployment, connectivity checks, backup/restore, and rollback.

Underground remains the authoritative identity and eligibility service. No supported independent login plus constitutional eligibility interface was found, so the production adapter fails closed. Do not use member email or CRM passwords as a fallback. See [release gates](docs/release-gates.md).
