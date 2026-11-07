# Engage production cutover — 2026-11-08

**Status:** Production cutover completed and verified. The legacy application is
preserved, stopped, for the rollback window.

## Authorisation and roles

| Item | Value |
| --- | --- |
| Written approval | Recorded in the release session before cutover |
| Cutover operator | Ethan Cornwill |
| Rollback owner | Ethan Cornwill, available for the window |
| Maintenance window | Immediate from 2026-11-08 03:02 AEDT until verification completed |
| Release commit | `466069059cf072947e949fe7965ca34d3dca8d0d` |
| Release image | `fusion-engage:prod-466069059cf0` |
| Image ID | `sha256:f23d5b5c0dafabd9b4f6759e82b16653d4ffeef12a5bb9b7a501df66f790107f` |
| Image protection container | `engage-prebuilt-prod-466069059cf0` (stopped) |

## Preflight

| Check | Result |
| --- | --- |
| Existing application | `engage-app-1`, `fusion-engage:review-20261106`, healthy |
| Existing MongoDB | `engage-mongo-1`, healthy, `engage_mongo_data`, `engage_default` |
| Public endpoint | `https://engage.fusionparty.org.au/api/health` returned 200 before cutover |
| Port 4321 | Owned only by `engage-app-1` |
| Production auto-deploy | Disabled (`is_auto_deploy_enabled = false`) |
| Scheduled Coolify tasks | None for the production application |
| Ballot deadlines | No deadline/closure fields on any Decide proposal; `ballots` collection empty |
| Scheduled member communications | No scheduler or scheduled task exists in the application |
| Staging | Deployed at `4660690`, healthy on `127.0.0.1:4400` |
| Staging poller | Paused for the window; crontab saved at `/tmp/engage-crontab.before` |

## Backups

| Backup | Result |
| --- | --- |
| Fresh pre-cutover backup | `pre-cutover-20261108-030222.archive.gz`; gzip OK; SHA-256 `4ceaaea2483663ab0ed89e7bbfba8171264b3e67579ff7edadd747e5fb3ce57d` |
| Restore test | 414 documents across 22 collections restored; 0 failures; counts matched production |
| Off-host copy | `/mnt/storage/data/engage-backups/`; checksum matched |
| Final quiescent backup | `pre-cutover-20261107-160511.archive.gz`, taken after `engage-app-1` stopped; gzip OK; SHA-256 `45b3b90bec2dc7cc1b45967d1cf059cd4403ff692ad1f4026a69341f39e0a2ba` |
| Final off-host copy | `/mnt/storage/data/engage-backups/`; checksum matched |
| Backup helper | `/opt/engage/backups/fb.sh`, mode 0700; exercised against production before the cutover |

## Deployment

| Item | Value |
| --- | --- |
| Coolify deployment UUID | `5utlg5gsyogifs5ayooi00pa` |
| Coolify status | `finished` |
| Deployment commit | `466069059cf072947e949fe7965ca34d3dca8d0d` |
| Started | 2026-11-07T16:04:12Z (03:04:12 AEDT) |
| Finished | 2026-11-07T16:05:14Z (03:05:14 AEDT) |
| New container | `app-k4jns8zq5ctcnzixaadzza4k-20261107T160452` |
| Running image | `fusion-engage:prod-466069059cf0`; image ID matched the protected image |
| Port | `127.0.0.1:4321` |
| Restart count | 0 |
| Build mode | Prebuilt image, `--no-build`; no image rebuilt after the old app stopped |

## Ballot migration

| Item | Result |
| --- | --- |
| Inventory | 37 ballots (36 Decide + 1 archived), 194 votes |
| Classification | 37 supported, 0 ambiguous, 0 conflicting |
| Plan | 37 bind actions, 0 blockers |
| Apply | Committed; 37/37 verified, 0 failures |
| Votes bound | 194 / 194 |
| Decide ballots bound | 36 / 36 |
| Binding events | 37, all with actor, reason and decision-event reference |
| Batch ID | `engage-legacy-ballots-2026-11-08-cutover` |
| Actor | Ethan Cornwill |
| Preservation comparison | 194 production votes vs 194 in the pre-migration backup; 0 mismatches across ballot, proposal, member, choice, author name, reason and timestamp |
| Ballot consistency | 0 inconsistent Decide ballots after binding |

The migration was applied after the new application started. Existing Decide
ballots with votes were unbound before the migration, so the application
refused new votes on them during the short interval. No synthetic vote was
written to production.

## Verification

| Check | Result |
| --- | --- |
| Container image | Matched `sha256:f23d5b5c0dafabd9b4f6759e82b16653d4ffeef12a5bb9b7a501df66f790107f` |
| `/api/health` | `{"ok":true,"status":"healthy"}` |
| Public health | `https://engage.fusionparty.org.au/api/health` returned 200 after cutover |
| Main routes | `/`, `/proposals/`, `/how-it-works/`, `/policies/`, `/privacy/`, `/terms/`, `/member/` all 200 |
| Logs | No DB, auth, unhandled or restart errors |
| Stability | Still healthy after 60 seconds; restart count 0 |
| Development login | `POST /api/session` returned 403 in production |
| Forged development cookie | Returned no identity |
| Anonymous admin access | Redirected to `/member/` |
| Anonymous ballot API | `votesList` empty; no member identifiers or names |
| Legal pages | `/privacy/` and `/terms/` 200; operator/ABN present |
| Indexing | `noindex, nofollow` remains in place |
| Analytics | No Plausible or Google Analytics markup on checked pages |

## Preserved for rollback

- `engage-app-1` remains stopped, not removed.
- `fusion-engage:review-20261106` and `/opt/engage/current` remain intact.
- `engage_mongo_data` and `engage_default` were not recreated or altered.
- The release image and its protection container remain present.
- Production auto-deploy remains disabled.
- The staging poller was restored after verification; it targets staging only.
- The temporary Coolify write token was revoked.
- Coolify's custom no-build/start commands remain in place for the rollback
  window. Restore the normal build command and clear the custom start command
  after 24–48 hours of stability.

## Residual items

- Legal acceptance remains inactive until the legal documents are published with
  an effective date and `LEGAL_ACCEPTANCE_ENABLED` is set. This is intentional.
- Exact revision identifiers remain available in the member-facing revision
  history and audit views, as designed. The ballot action itself uses the
  human-readable revision label.
- Search indexing remains disabled (`noindex`), and analytics remain out of
  scope.
- GitHub Actions remains outside this release.
