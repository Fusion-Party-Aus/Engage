# Engage

Fusion Party Australia’s member policy library, discussion, and decision platform (`https://engage.fusionparty.org.au/`).

## Overview

Engage is a streamlined CRUD application built with **Astro (Node standalone SSR)**, **MongoDB**, and **Better Auth**:
- **Policies (`/policies/` & `/policies/[slug]/`)**: Browse all 76 baseline policies by topic or stage (`Open for discussion`, `Open for voting`, `Adopted`), read the commitment and outcomes in plain English, post comments or wording amendments, and cast `Approve` / `Reject` votes directly on each policy page.
- **Member Account (`/member/`)**: Passwordless email sign-in link (via Resend) and Google OAuth, displaying membership verification status and a personal log of votes and comments.
- **Admin Workspace (`/admin/` & `/admin/members/`)**: Create, edit, delete, or change the stage of any policy proposal, and verify member accounts or assign moderator/administrator roles.

## Local Development

```sh
pnpm install --frozen-lockfile
pnpm dev
```

When `MONGODB_URI` is not set in local development (`APP_MODE !== 'production'`), Engage automatically runs against an in-memory database seeded with the 76 baseline policies from `src/data/policies.json` and enables one-click local development sign-in on `/member/`.

## Checks & Tests

```sh
pnpm check
pnpm test
pnpm build
```

## Production Deployment (Docker Compose)

```sh
cp .env.example .env
# Populate production secrets in .env
docker compose -p engage --env-file /opt/engage/.env -f docker-compose.yml -f compose.nuc.yml up -d --no-build --wait
```

To grant administrator permissions to an existing signed-in user in production:

```sh
docker compose -p engage --env-file /opt/engage/.env -f docker-compose.yml -f compose.nuc.yml exec app node scripts/grant-engage-admin.mjs <userId>
```
