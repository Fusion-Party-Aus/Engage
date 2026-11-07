# Engage final release verification — 2026-11-08

**Scope:** integrated release line combining application remediation, ballot
revision compatibility, legal documents and acceptance controls, and the
Coolify deployment workstream.

**Release identity:** the commit that contains this document. Verify it with:

```sh
git rev-parse HEAD
git log -1 --format='%H %s'
```

**Production state at verification:** unchanged. `engage-app-1` and
`engage-mongo-1` remained healthy on `127.0.0.1:4321` and `127.0.0.1:27041`.
No production migration, deployment, policy import or data write was performed.

---

## 1. Integration inventory

| Workstream | Integration |
| --- | --- |
| Application RC remediation | Integrated in this release line: insert-only startup seeding, entity rendering, revision labels, trusted canonical origin, SSR warning removal, proposal/ballot visibility, national-administrator-only identifiable ballots, explicit empty policy registry. |
| Ballot revision compatibility | Deterministic bulk-binding library, CLI, admin binding reuse, transaction rollback, fail-closed inventory and 37-ballot/194-vote rehearsal evidence. |
| Privacy Policy and Terms of Use | `/privacy/` and `/terms/`, owner-authorised metadata, confirmed entity/ABN/contact/address, scoped disclosures, `noindex, nofollow`. |
| Legal acceptance | Server-side record, API, member gate and participation-endpoint enforcement. Inactive because the documents remain owner-authorised and are not yet published with an effective date. |
| Coolify deployment | `origin/main` deployment workstream merged, including staging Mongo image, poller systemd units, cutover checklist and deployment runbook. |
| Horizon/shadcn interface | Integrated header, footer, feature grid, legal components and member settings workspace. |
| Governance, registry and security | Existing versioned registry, revisions, branch administration, ballot records and privacy controls retained. |

Research/corpus material (`corpus/`, `national-neon-site/`, reconciliation and
extraction scripts) was preserved outside the release commit. It is not part of
this release.

---

## 2. Local verification

| Command | Result |
| --- | --- |
| `pnpm check` | 0 errors, 0 warnings, 14 hints from untracked research scripts |
| `pnpm build` | Pass |
| `pnpm test` (real MongoDB 8.0 single-node replica set) | **104 tests, 104 pass, 0 fail, 0 skipped** |

The real-MongoDB suite included startup idempotency, proposal revisions,
vote storage, ballot binding, migration rollback, proposal access, branch
eligibility, authentication, legal acceptance and public-origin regressions.

---

## 3. Ballot migration rehearsal

A read-only production snapshot was restored into a disposable database
(`engage_release_clone`). The restore reproduced **414 documents across 22
collections**, 81 proposals and 194 `proposal_votes`.

| Check | Result |
| --- | --- |
| Inventory | 37 ballots (36 Decide + 1 archived `GOV-002`), 194 votes |
| Classification | 37 supported, 0 ambiguous, 0 conflicting |
| Plan | No blockers |
| Dry run | No writes; 0 binding events |
| Apply | 37 ballots bound, 194/194 votes attached, 37 audit events, 37 revisions |
| Verification | 37 verified, 0 failures |
| Vote preservation | Before/after vote records identical (0 mismatches across identity, choice, reason and timestamp) |
| Idempotent retry | 37 idempotent results; no duplicate revisions, votes or events |
| Post-migration vote | New vote accepted on `POL-011`; tally 4 → 5; vote and ballot share the same revision |
| Startup | Repeated initialisation does not rewrite proposals or bind ballots |

The binding is retrospective and explicitly recorded as such. Backfilled
revisions are marked `provenance: legacy-backfill`; no vote-time revision
snapshot is claimed.

---

## 4. Browser verification

Headless Chrome 156 against the built release and the restored data clone.

| Viewport | Result |
| --- | --- |
| 390 × 844 mobile | All tested routes rendered; no horizontal overflow; no console errors |
| 768 × 1024 tablet | All tested routes rendered; no horizontal overflow; no console errors |
| 1440 × 1000 desktop | All tested routes rendered; no horizontal overflow; no console errors |

**109 checks, 0 failures** for the full route and interaction matrix, plus
**14 dedicated 390px ballot checks, 0 failures** after the member-ballot
refinement.
Routes covered: `/`, `/proposals/`, proposal detail,
`/how-it-works/`, `/policies/`, `/privacy/`, `/terms/`, `/member/`, `/admin/`,
`/admin/proposals/`, `/admin/members/`, `/admin/branches/`, `/admin/policies/`.

The refined member ballot was validated at 390 × 844:

- a single-row segmented Approve / Abstain / Reject control, no option cards or
  floating radio indicators;
- one compact results presentation, with a plain empty-state message when no
  votes have been recorded;
- a full-width primary action whose radius matches the segmented control, with
  a neutral disabled treatment and the Horizon accent reserved for an enabled
  action;
- `Reason (optional)` above the field and a live `0/500` counter below;
- a persistent one-line privacy disclosure with a Privacy Policy link;
- human-readable revision metadata after the privacy line;
- arrow-key selection and checked-state semantics;
- closed-ballot read-only treatment;
- no horizontal overflow and no console errors.

Additional checks:

- footer legal links present;
- legal pages carry `noindex, nofollow`;
- operator, ABN, registered party, contact and correspondence address present;
- no editorial placeholders in public legal copy;
- privacy discloses identifiable ballots, national-administrator access and
  small-ballot re-identification risk;
- no analytics integration;
- ballot privacy notice present;
- human-readable revision label and no exposed legacy identifier;
- member voting succeeds and tally increments;
- signed-out member page links the legal documents;
- acceptance gate is hidden while the documents are owner-authorised and the API
  returns `LEGAL_ACCEPTANCE_NOT_ACTIVE`;
- anonymous admin access redirects to `/member/`.

Production-mode checks:

- development login returns 403;
- forged development cookie yields no identity;
- canonical URL and public API `Link` header use
  `https://engage.fusionparty.org.au`;
- anonymous admin access redirects;
- no React SSR warnings in the server log.

---

## 5. Legal status

- Documents: owner-authorised, **publication pending**.
- Effective date: not set.
- Legal review: not claimed.
- Acceptance: implemented and enforced server-side, but **inactive**. Activation
  requires both documents to be published with real effective dates and
  `LEGAL_ACCEPTANCE_ENABLED=true`.
- This is the correct state for the release. Activating acceptance against
  owner-authorised drafts would breach the release safety interlock.

---

## 6. Release decision

| Milestone | State |
| --- | --- |
| Code complete | Yes |
| Local verification | Yes |
| Ballot migration rehearsed | Yes |
| Git pushed | Recorded separately after push |
| Release image built from release commit | Recorded in the cutover log after build |
| Cutover approved | **No written approval recorded** |
| Production deployed | **No** |

**Application release: GO.**

**Production cutover: NO-GO at this time.** Blocking conditions:

1. No written production cutover approval.
2. No confirmed maintenance window.
3. No named cutover operator and rollback owner recorded for this release.
4. Staging has not yet been verified at the final release commit; the last
   verified staging deployment is the `1b973faf...` readiness commit.
5. The final production image must be rebuilt, relabelled and smoke-tested from
   the final release commit; the `prod-1b973fafbedb` image is a rehearsal
   artifact and must not be deployed.

Items 4 and 5 are deployment operations that can be completed before the
approval gate. Items 1–3 require an explicit owner decision and must not be
inferred from a successful push or verification run.

---

## 7. Cutover preconditions still to record

- approved release commit SHA and image ID;
- Coolify staging deployment at that SHA, healthy;
- final image labels (`org.opencontainers.image.revision`) matching the SHA;
- image protection container present and stopped;
- final quiescent backup checksum and off-host copy;
- migration inventory counts and zero blockers re-confirmed against production;
- named operator, rollback owner, maintenance window and written approval.

Do not start the production cutover until every item is recorded and the
GO/NO-GO assessment is repeated.
