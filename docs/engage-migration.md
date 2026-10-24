# Engage repository migration

Engage is the application and canonical repository: `Fusion-Party-Aus/Engage`. Reclaim is the initial 2026 AGM policy review programme. Its policy wording, provenance uncertainty, layered presentation and separate platform and Horizon identity review questions remain intact.

The migration starts at `Fusion-Party-Aus/reclaim-platform`, branch `codex/horizon-policy-platform`, commit `d98b40989e61faab32fa644b85bfd5bd26557318`. Source `main` is the older static export. Engage initially contained only its introductory README at `29113ec1cc06144dee06ffae0bc2d5188a3ce7d6`. A merge joins both histories without rewriting either. Merge the migration PR with a **merge commit** to retain those commits in main; squash or rebase would discard the intended ancestry.

The source repository and branch are preserved. Continue application development only in Engage after acceptance. Horizon and Underground are unchanged. No deployment, member-data transfer or real binding ballot activation is part of this migration. Existing database names and volume settings are retained to avoid silently selecting an empty database; production still requires a separate database and credentials.

The transferred implementation includes Astro and Horizon styling, Reclaim content and provenance, consultation and amendments, immutable revisions and publication, ballots, Better Auth and Google OAuth, manual verification, synthetic preview, Docker, migration scripts and tests. Product/package documentation identifies Engage without renaming legitimate Reclaim content.

## Correctness changes

Ballot finalisation now records one conditional, authoritative result before retryable publication and audit writes. It reports failures, retries incomplete closures and deduplicates effects. Finalised results are never recomputed from current vote records. Deadline and administrative closure share this path. Membership status and completed transition history now share one atomic document update. See [operations](operations.md) for recovery and audit locations.

## Validation and release

Validation uses Node 24.22.1 loaded through NVM and the pinned pnpm 10.28.0, with a frozen lockfile. Astro/type checks, 22 Node and seven Python tests, the production build, standalone MongoDB 8.0 governance regressions and the controlled Google-provider authentication/membership API test pass. Governance tests cover concurrent finalisers, publication/audit write failures, missing-revision recovery, stable results, membership audit atomicity and preview/production boundaries. Integration tests create and drop isolated test databases.

Docker container execution and restart checks could not run: the host has a Docker CLI but no daemon or Docker Desktop. A temporary standalone MongoDB 8.0 server was used instead, matching the deployment's lack of replica-set transactions. Sandbox cache and localhost restrictions were resolved through approved execution; they were not implementation failures.

No committed private environment files, database dumps or high-confidence credential patterns were found in the transferred history. Membership-related records in tests are controlled or synthetic fixtures.

Before release, complete live Google callback and cookie checks behind HTTPS, Docker deployment/restart validation, production backup/restore rehearsal, eligibility-review assignments, in-flight vote cutoff validation and governance authorisation. The provider test does **not** prove live Google authentication. Keep formal ballots disabled until the [release gates](release-gates.md) are met. Underground integration remains deferred pending coordination with Stewart and Owen; Firebase is not introduced.

## Subsequent M1 prefactor

The standalone MongoDB validation above is historical. [ADR 0003](adr/0003-reclaim-mvp-node-mongodb.md) supersedes that deployment boundary: voting admission and closure now require a replica set. The prefactor adds actual MongoDB cutoff regressions and CI; target Docker bootstrap/restart, live OAuth, production recovery and governance approval remain distinct release gates. See [remaining M1 work](mvp-roadmap.md).
