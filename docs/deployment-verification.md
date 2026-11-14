# Local Docker deployment verification

Verified 2026-10-24 on the prefactor branch for PR #8. Application source was `09a97df`; the follow-up changes only two regression-test deadlines and documentation. This is a localhost synthetic preview, not a public or binding deployment.

## Environment and configuration

- Apple Silicon macOS; Colima 0.10.3 / Lima 2.2.1, Docker Engine 29.5.2, Compose 5.6.1 and Buildx 0.38.1. An isolated Colima profile (`engage-verification`, 2 CPUs / 4 GiB RAM / 20 GiB data disk) supplies the Docker daemon.
- The Docker CLI and Compose were present initially, but no daemon/runtime was installed. Colima and Buildx were installed for this verification; no application architecture change was required.
- Missing `.env` files caused the reported interpolation errors. Fresh random secrets were generated in ignored, mode-0600 `.env` files in the workspace and prefactor checkout. Existing environment files were not overwritten. Secret values were not printed or committed.
- Compose project `engage-verify` runs the actual `Dockerfile` and `docker-compose.yml`, with `APP_MODE=preview`, `FORMAL_BALLOTS_ENABLED=false`, and both published ports bound to `127.0.0.1` (app 4321, MongoDB 27017).

## Passed checks

| Check                      | Evidence                                                                                                                                                                                                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compose interpolation      | `docker compose config --quiet` succeeds in both checkouts after local configuration                                                                                                                                                                                                                           |
| Image build                | Frozen pnpm 10.28.0 install and Astro Node server build succeed in the Docker multi-stage build                                                                                                                                                                                                                |
| Fresh volume               | Actual Mongo entrypoint creates root/scoped users, replica key and single-node `engage` primary; Mongo and app report healthy                                                                                                                                                                                  |
| Least-privilege connection | Authenticated app user has only `readWrite` on the preview database; transactions commit and roll back as expected                                                                                                                                                                                             |
| Preview seed               | Repository seed script dry-run and confirmed preview write load 78 revisions and 39 ballots before the additional verification fixture                                                                                                                                                                         |
| Deployed routes            | `/`, `/policies/`, `/consultations/`, `/ballots/`, `/member/`, `/admin/` render HTTP 200; unauthenticated admin health API returns 401                                                                                                                                                                         |
| HTTP participation         | Synthetic member signs in and revotes three times, leaving one current selection on the verification ballot; vote receipts remain non-binding                                                                                                                                                                  |
| Decision/publication       | Admin closes the synthetic ballot, records one approved result and adopted revision; repeated close preserves result and a late vote returns 409                                                                                                                                                               |
| Restart                    | App and MongoDB restart preserve the signed preview session, current selection, recorded result and adopted revision                                                                                                                                                                                           |
| Container replacement      | Forced app-container recreation preserves the same session and decision; state is not confined to the old process/container                                                                                                                                                                                    |
| Authentication deployment  | Existing `test:auth` with `AUTH_TEST_DOCKER_IMAGE=fusion-engage:local` passes controlled Google-provider flow, persisted Better Auth session restoration in the real container, mounted login routes and container restart                                                                                     |
| Existing-volume upgrade    | A separate `engage-upgrade-check` project first runs the official image as authenticated standalone MongoDB; converting that same volume to the actual replica-set configuration preserves scoped credentials/data and permits a transaction                                                                   |
| Preview backup/restore     | App quiesced; existing preview scripts dump via the scoped account and restore via an operator account into a separately checked empty namespace. All 135 documents restore successfully; collection counts, unique vote index and recorded result are verified; source database retained; app returns healthy |

The backup source contained only the imported policy catalogue and synthetic preview activity. Membership and application-role collections were empty. The authentication test used a separate disposable Docker MongoDB at port 27029 and dropped its own test database. The existing-volume check used another disposable volume at port 27032; no production volume was converted.

## Regression verification and clock correction

`pnpm test` passes 20 Node tests plus seven Python checks against Docker MongoDB. `pnpm test:cutoff` passes all seven regressions, and `pnpm test:auth` passes its integration test with its optional real-container/restart checks enabled. No tests were skipped. `pnpm check` passes after the test correction.

> Historical note: this verification used the pre-rewrite `test:cutoff` and `test:auth` commands. Those package scripts no longer exist. Current CI runs the equivalent real-MongoDB voting and authentication suites through `pnpm test` with `VOTING_TEST_MONGODB_URI` and `AUTH_TEST_MONGODB_URI` set to a disposable CI replica set.

The first Docker-backed cutoff run exposed an invalid test assumption: MongoDB's VM clock was approximately 15 ms behind the Mac clock. Two tests assigned an allegedly expired deadline from host `Date.now()`, which was still in the database's future. They failed as expected under that offset. Those tests now set deadlines with MongoDB `$$NOW` / `$currentDate`. All seven pass without changing the application's database-clock admission rule. Production operators must still monitor host time synchronisation.

## Local operation

The preview is available at `http://localhost:4321`. From the prefactor checkout:

```sh
docker compose -p engage-verify ps
docker compose -p engage-verify up -d --wait
docker compose -p engage-verify stop
```

Use the same project name and its existing private `.env` to retain the verified volume and credentials. Starting a differently named project creates a different volume and can conflict on the published ports. If the local Docker VM is stopped, start it with `colima start --profile engage-verification`.

## Remaining boundaries

- Repeat the procedure on the actual deployment host before accepting that host; these results establish local ARM64 Docker behaviour, not remote NUC hardware/network readiness.
- The preview namespace restore does not certify encrypted off-host production recovery, production account/session data recovery, or a complete host-loss exercise.
- Controlled-provider tests do not prove live Google callbacks, secure cookies or HTTPS reverse-proxy configuration.
- GitHub-hosted CI remains blocked before runner allocation by account billing/spending limits. Local Docker success does not make that check green.
- Member-only deliberation reads, separate editor/reviewer/Election Officer duties, ballot-authorisation UX, independent security review and governance/organisational approvals remain M1 work. See [known gaps](status/known-gaps.md).

No public deployment, real member-data integration or binding activation was performed.
