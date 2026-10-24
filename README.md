# Engage

Fusion Party Australia’s ongoing policy development, consultation and member decision platform. Engage is the product; Reclaim is its initial policy review programme for the 2026 AGM. The public Reclaim static export remains in the repository as the migration source until the replacement is accepted.

Canonical repository: **Fusion-Party-Aus/Engage**. The application was transferred with its history from `Fusion-Party-Aus/reclaim-platform`, branch `codex/horizon-policy-platform` (`d98b409`). The source repository is retained as a historical reference; continue application development in Engage only. Reclaim policy content and the separate Reclaim platform and Horizon branding decisions are preserved.

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

The preview uses synthetic identities with environment safeguards (`APP_MODE=preview`, `FORMAL_BALLOTS_ENABLED=false`) while exercising the unified consultation, revision, and ballot workflows. `.env` is ignored by Git and configures a local MongoDB container (when running app-only in preview mode without MongoDB reachable, an in-memory seeded preview database is used automatically). For the complete containerized stack, run `docker compose up -d --build`; the app binds to localhost by default and MongoDB is not exposed beyond localhost. Put an HTTPS reverse proxy in front before allowing remote access. Do not use this preview for genuine member identities, consultation data, or binding votes.

Seed the local MongoDB preview once to load the 76 baseline policy revisions, settled revision `POL-010:v2-settled`, the 36 AGM Round 1 policy ballots (4 open in preview for immediate voting), the 2 separate platform/Horizon identity adoption ballots, and the follow-on `POL-077` proposal in `continuous-policy-round-2027-q1`:

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

Production uses Better Auth with Google OAuth and manual membership verification. Configure the production auth environment and a separate MongoDB database, then bootstrap an administrator using `node scripts/grant-engage-admin.mjs <existing-Better-Auth-user-ID>`. Accounts await verification before comments, amendments or voting. Underground is a future integration, independent of current login and eligibility. See [release gates](docs/release-gates.md).

## Authentication acceptance checks

Use Node 24 (`nvm use`) and run `pnpm check`, `pnpm test` and `pnpm build`. For the MongoDB-backed authentication/API tests, start an isolated server (for example `docker run -d --name engage-auth-test -p 127.0.0.1:27029:27017 mongo:8.0`) and run:

```sh
AUTH_TEST_MONGODB_URI=mongodb://127.0.0.1:27029 pnpm test:auth
```

The test creates and drops a unique test database. It uses Better Auth's supported controlled Google provider options; it does not claim live Google authentication. It checks account creation/returning identity, PKCE authorisation initiation, session restoration/logout, manual verification, API access, revotes, revocation, email-linking rejection and ballot safeguards. To also verify the actual Docker application and a container restart, build `docker build -t engage-auth-verified:test .`, then add `AUTH_TEST_DOCKER_IMAGE=engage-auth-verified:test` to that test command (requires Docker Desktop, the test MongoDB port 27029 and free app port 4329). The test removes its app container.
