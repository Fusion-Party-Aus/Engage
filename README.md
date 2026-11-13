# Engage

Fusion Party Australia's participatory governance platform: proposals, deliberation, formal ballots and the published policy record.

`https://engage.fusionparty.org.au/`

## What it does

- **Proposals (`/proposals/`)** — verified members create matters, discuss them, endorse contributions, propose structured amendments, and vote when a ballot opens. Wording is versioned; a ballot is bound to an exact immutable revision.
- **Published policy (`/policies/`)** — the authoritative registry of policies that have been ratified and published. A fresh deployment starts with an empty registry: the 78 seeded records in `src/data/policies.json` are proposals and governance resolutions, not adopted policy.
- **Member account (`/member/`)** — passwordless email sign-in, Google and passkeys; verification status; outstanding ballots, activity, notifications, branch following and membership.
- **Branches** — geographic and constituent participation. Following a branch is not membership; only verified branch members can vote in that branch's ballots.
- **Admin workspace (`/admin/`)** — proposal and amendment workflow, ballot binding and result recording, member verification, branch governance, roles, reports, migrations and policy registry operations.
- **Public API (`/api/v1/`)** — read-only published policy with versions, ETags and OpenAPI.

A vote is not a decision. A decision is not automatically published policy. Deliberation stances (`support`, `concern`, `amendment`, `comment`) are not ballots (`approve`, `abstain`, `reject`). These distinctions are enforced in code.

## Documentation

Start at **[docs/README.md](docs/README.md)**. The canonical set covers the product definition, Fusion ecosystem, domain model, governance model and lifecycle, architecture, API and authorisation, notifications, deployment, contribution guidance, agent orientation, capability status and known gaps.

`AGENTS.md` is normative for UX, visual design, governance invariants, Git discipline and verification. `DESIGN.md` defines the Horizon implementation contract.

## Local development

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Without `MONGODB_URI` and outside `APP_MODE=production`, Engage runs against an in-memory database seeded from `src/data/policies.json`. One-click local sign-in is available only when `APP_MODE` is exactly `development`, `test` or `preview`; a missing or unknown mode fails closed.

Copy `.env.example` to `.env` for a configured environment. Never commit `.env`.

## Checks and tests

```sh
pnpm check
pnpm test
pnpm build
```

The ordinary test run uses an in-memory database for most suites. Vote storage, some governance API tests and migration tests require real MongoDB; CI provisions a MongoDB 8.0 replica set.

## Deployment

Production runs on Coolify; the NUC path uses GitHub Actions and a health-checked release. Both build a Node standalone Astro server in Docker.

- Engineering overview: [docs/architecture/build-deploy-operations.md](docs/architecture/build-deploy-operations.md)
- Coolify guide: [docs/coolify-deployment.md](docs/coolify-deployment.md) (older; check its status notes)
- Cutover and rollback: [docs/coolify-cutover-checklist.md](docs/coolify-cutover-checklist.md)

To grant administrator permissions to an existing signed-in user:

```sh
docker compose -p engage --env-file /opt/engage/.env -f docker-compose.yml -f compose.nuc.yml \
  exec app node scripts/grant-engage-admin.mjs <userId>
```

## Governance and security

Never alter ballot eligibility, voting semantics, revision binding, policy authority, ratification or server-side permissions without an explicit governance specification. See [docs/domain/governance-model.md](docs/domain/governance-model.md), [docs/domain/governance-lifecycle.md](docs/domain/governance-lifecycle.md) and [docs/status/known-gaps.md](docs/status/known-gaps.md).

## Status

Implemented and partial capabilities are listed in [docs/status/capability-matrix.md](docs/status/capability-matrix.md). Planned functionality is labelled as planned; it is not described as operational.
