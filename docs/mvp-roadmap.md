# Engage delivery milestones

Reconciled against EPIC #1 and issues #2–#6 on 2026-10-24, starting at main `3374cc2`. This is delivery scope, not a declaration of governance approval. Existing broad issue commitments remain open; moving an item to M2 does not complete or cancel it.

## M1 — Reclaim AGM Policy Review

Deliver the existing catalogue and four-layer presentation, provenance/comparison, verified-member comments and amendments, moderation, settled immutable revisions, individual policy ballots under approved rules, permanent decisions and adopted publication in Engage. Use Better Auth, Google login, manual Fusion membership verification and Horizon. Public users browse policies; deliberation is member-only. Named editors prepare revisions, a separate wording reviewer checks them, and a different Election Officer controls each ballot. Votes are secret from other members/public; identifiable records are limited to Election Officers. These accepted commitments are recorded in [#2](https://github.com/Fusion-Party-Aus/Engage/issues/2#issuecomment-6127974312) and [#6](https://github.com/Fusion-Party-Aus/Engage/issues/6#issuecomment-6127974236); current broad admin/moderator roles do not implement their separation. Security, accessibility, testing, recovery and responsible operators are part of M1.

| Area / issue | Implemented evidence | M1 acceptance still needed |
| --- | --- | --- |
| Catalogue and provenance, #1/#2 | 76 baseline policies, layered `DomainPolicyReview.astro`, searchable catalogue, original wording/lineage and explicit uncertainty | Human acceptance of content/provenance and all four layers; preserve separate platform/Horizon questions |
| Consultation and settlement, #2/#6 | Member comments, amendments and alternatives; moderation responses; immutable revision creation; admin scheduling | Rehearse reviewer responsibilities and full public/member/admin journey; resolve defects discovered in pilot |
| Decisions and publication, #2/#6 | Individual ballots, one current selection, revotes, strict majority, permanent result, retryable adopted-revision publication | Approve rules/authority and decision rationale; demonstrate synthetic end-to-end acceptance with returning officer |
| Identity and eligibility, #6 | Better Auth/Google, MongoDB sessions, pending/verified/suspended membership, atomic reviewer history | Live HTTPS Google callback/cookie checks; approved manual verification criteria and responsible reviewers |
| UI/design, #3 | Existing Horizon assets, responsive layouts and semantic/focus styles | Mobile/keyboard/accessibility acceptance; clearer participant and authorisation flows (below) |
| Operations, #1 | Docker, scoped MongoDB user, rate limits, health/audit endpoints, preview recovery scripts, rollback notes | Replica-set Compose/restart rehearsal, production backup/restore, monitoring/support ownership and security review |
| Prefactor | Transactional vote cutoff with real MongoDB regression tests; one CI workflow | Green hosted CI and target deployment verification; no permission to launch or enable binding voting |

The synthetic lifecycle test covers consultation → amendment review → settled revision → individual vote → recorded result → adopted publication; API tests also create a synthetic proposal. These are automated demonstrations, not an executive/branch pilot or proof of approved governance.

## M2 — Ongoing Engage Platform

Keep these commitments tracked without treating them as M1 dependencies:

- National/branch tenancy, branding and scoped permissions, with isolation tests before any branch-sensitive use.
- General public idea intake and public participation beyond browsing the M1 catalogue.
- Signal intake (#4), including authenticated events, deduplication and human evidence review.
- Sanity publishing and policy/version integration.
- Underground authentication and/or CRM-backed eligibility integration; manual verification is sufficient for M1.
- Policy implementation/influence tracking (#5), evidence-based claims and correction/review triggers.
- Coordinator assignment, duplicate detection, advanced research stages, notifications and escalation (#2).
- Additional voting methods, quorum/threshold configuration, eligibility snapshots or cryptographic ballot secrecy beyond M1 officer-restricted access only where authorised rules require it (#6). If an M1 rule or confidentiality review requires one, record the concrete dependency and promote that item before activation.
- Versioned design-system skill consumption and branch themes (#3). Keep the existing Horizon identity for M1; do not wait for a new skill repository.

## Existing issue reconciliation

| Issue | M1 responsibility | M2 commitment retained |
| --- | --- | --- |
| #1 EPIC | Parent of both milestones; M1 acceptance and launch gates | Full national platform vision and remaining workstreams |
| #2 Internal workflow | Reclaim import/provenance, moderation, settlement, auditable decision/publication and confirmed authority | Independent internal sign-off without member voting, configurable stages, assignments, notifications, FusionPolicy reuse audit and Sanity handoff; branch isolation before branch use |
| #3 Design system | Preserve Horizon and functional accessible public/member/admin pages | Pinned shared skill, upstream maintenance and branch-specific themes |
| #4 Signal | No dependency | Entire issue |
| #5 Implementation tracking | Preserve policy IDs, revisions and provenance | Entire tracking/evidence workflow |
| #6 Participation | Manual verification, member deliberation, individual ballots, synthetic pilot and security review | Public intake, CRM/Underground integration, additional authorised ballot capabilities |

## Remaining M1 blockers

### Code defects / delivery gaps

- **Member-only deliberation:** `listPublicSubmissions`, the public consultation API and catalogue render accepted submission bodies without member verification. Restrict deliberation reads to the authorised member audience and test public/pending/suspended access. Public policy/provenance browsing remains available. This is a concrete privacy defect against the accepted #2/#6 scope, not a request for M2 public consultation.
- **Separation of duties:** current roles are member/moderator/administrator. The same moderator/admin can settle revisions and control ballots; no separate wording-review sign-off or Election Officer-only identifiable-record boundary exists. Implement and test the accepted editor → independent wording reviewer → separate Election Officer controls before live M1 voting. Do not treat broad database/operator access as proof of ballot confidentiality.

- The admin UI cannot provide the `authorizationEvidence` required to open a production ballot; the API supports it. Provide a minimal authorised-operator flow or an explicitly accepted, documented API procedure before pilot acceptance. Do not bypass the evidence gate.
- The public governance page states the majority/no-quorum rules categorically, while release gates still require their approval. Confirm and align that wording before live participation; do not imply this prefactor approves those rules.
- No additional reproducible lifecycle defect is asserted by this audit. The cutoff defect is fixed by this change, subject to deployment verification. Pilot failures become concrete M1 fixes rather than justification for a workflow rewrite.

### Testing / deployment verification

- Run hosted CI with the real replica set and all integration commands; require its check for merge through repository settings if not already required.
- Rehearse the actual Compose bootstrap and existing-volume upgrade, scoped-user transactions, restart and recovery on the Docker host. A native MongoDB replica-set test does not verify the container bootstrap.
- Complete live Google OAuth/returning login/logout and secure cookie checks behind HTTPS.
- Create and rehearse an encrypted production backup/restore procedure. Preview-only scripts deliberately refuse production. Include accounts, sessions, membership history, revisions, ballots, results and audits.
- Conduct independent security/confidentiality review and browser/mobile/keyboard/accessibility acceptance. Complete a non-binding human pilot with a durable decision record.

### Governance / organisational approvals

- Confirm constitutional eligibility, verification criteria, suspension treatment, authorised reviewers, returning officer, decision authority and required rationale/evidence.
- Approve strict majority, ties, zero votes, revoting, database admission cutoff, early administrative closure and challenge/recount/appeal procedures. Confirm the implementation meets the already recorded member-only deliberation, separate-duty and officer-restricted ballot requirements; any stronger confidentiality rules create explicit additional dependencies.
- Agree privacy/consent and retention handling; name deployment, monitoring, recovery and support owners.
- Record separate approvals for real member data, each binding ballot and public launch. Keep `FORMAL_BALLOTS_ENABLED=false` until the actual evidence gates are satisfied.

### Later M2 enhancements

All M2 items above remain open. None is an M1 blocker without an explicit security, correctness or governance dependency.

## UX follow-up; no redesign in this prefactor

Keep the primary journey about reading, commenting and deciding policy. Reclaim's original content, four layers and provenance remain intact. Follow up on these observed issues:

- Admin settlement/ballot pinning asks operators to type policy/revision IDs; select known revisions and expose their wording during the next focused UI improvement.
- Production ballot opening offers an action without a corresponding evidence-entry UI; preserve the API gate and give operators an intelligible route.
- The member page loads participation serially for every ballot and lacks a clear overall error state if those requests fail. Validate performance/error recovery during the pilot before broadening APIs.
- Keep raw revision IDs, audit diagnostics and internal release-gate jargon in the operator workspace. Public rule explanations should be accurate, concise and conditional on approval.

## Prefactor verification

On Node 24.22.1 / pinned pnpm 10.28.0, `pnpm check`, `pnpm test`, `pnpm test:cutoff`, `pnpm test:auth` and `pnpm build` pass: 20 existing Node tests, seven real-MongoDB cutoff regressions, one controlled-provider authentication/API integration test and seven Python checks, with no skips. Integration tests used a separate native MongoDB 8 single-node replica set and dropped their test databases. Three new regressions failed before the fix (late admission after closure, stale deadline, and saved selection after audit failure). A deliberate closing-inclusive mutation was also caught by the exact-boundary test and restored.

Local limitations: this host has neither a running Docker daemon nor the Compose plugin. Container bootstrap, scoped-user replica transactions, existing-volume upgrade/restart and production recovery were not verified here. Controlled Google tests do not prove live Google OAuth. Hosted CI execution and target-host verification remain separate evidence, not inferred from local success. No public deployment, production member-data migration or binding activation was performed.
