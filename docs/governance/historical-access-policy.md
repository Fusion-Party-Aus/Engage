# Historical Governance Accessibility — Visibility Rules & Access Matrix

Status: **Policy specification** (PR #23). Safe technical invariants (supersession cycle detection, read-only historical labelling, inaccessible-target suppression) are implemented alongside this specification. Broader changes to who may read archived proposals or retired policy wording require an explicit governance decision and are deferred.

## 1. Current visibility rules by record type

| Record type | Source of truth | Current visibility rule | Notes |
|---|---|---|---|
| **Active proposals (`propose`, `deliberate`, `decide`, `implement`)** | `canViewProposal` in `src/lib/store.ts` | `national`: public. `branch`: author, verified/following branch members (`activeBranchIds`), branch admins (`branchAdminIds`), national staff/admins. `private`: author, originating branch admins, national staff/admins. | `listProposals` omits `archived` by default unless `includeArchived: true`. |
| **Archived proposals (`stage === "archived"`)** | `canReviewArchivedProposal` in `src/lib/store.ts` | National staff/admins, proposal author, and originating branch admins (`branchAdminIds`). Ordinary members and non-author branch members receive `404` on `/proposals/[slug]/` and `/api/proposals/[id]`. | Active discovery (`/proposals/`, `/`, `/branches/`) excludes archived proposals. |
| **Proposal revisions (`proposal_revisions`)** | `listProposalRevisions` in `src/lib/store.ts` | Same as parent proposal (`canViewProposal` + `canReviewArchivedProposal` for archived proposals). `authorId` is stripped from public revision payloads. | Revisions are immutable snapshots with `parentRevisionId` and `contentHash`. |
| **Amendments (`amendments`, `amendment_revisions`)** | `src/pages/proposals/[slug].astro`, `src/pages/admin/proposals/[slug].astro` | Queried per visible proposal; `status: { $ne: "withdrawn" }` excludes withdrawn amendments from both member and admin proposal views. | Withdrawn amendment records remain in MongoDB for auditability. |
| **Ballot results (`ballot_results`)** | `src/pages/proposals/[slug].astro`, `src/pages/policies/[slug].astro` | Visible whenever the parent proposal or published policy is visible. Bound to exact `revisionId` and `decisionEventId`. | Cannot be replaced once recorded (`409` on duplicate). |
| **Policy registry (`policy_registry`)** | `src/pages/policies/[slug].astro`, `src/pages/policies/index.astro` | `/policies/` lists `publicationStatus: "published"`. `/policies/[slug]/` resolves `published`, `withdrawn`, and `superseded`. `unpublished` (ratified, awaiting publication) is admin-only. | Retired (`withdrawn`, `superseded`) policy pages display status, authority, source proposal link, and successor link, while hiding `approvedWording` so retired text is not mistaken for current policy. |

## 2. Proposed historical-access matrix

This matrix distinguishes **safe current behaviour** from **proposed expansions requiring governance approval**:

| Record & state | Ordinary / verified member | Branch admin (own branch) | National staff / admin | Governance decision needed? |
|---|---|---|---|---|
| **Archived proposal that reached a formal ballot (`ballotRevisionId` set) in `national` or member's `branch` scope** | Read-only historical view (wording, ballot outcome, reasons, successor link) | Read-only review | Full review | **Yes — deferred.** Currently blocked by `canReviewArchivedProposal`. Must confirm whether pre-vote deliberation comments on archived proposals should also remain readable. |
| **Archived proposal that never reached a ballot (`private` or withdrawn draft)** | No access (unless author) | Read-only review (originating branch) | Full review | **No** — preserve current restriction to avoid exposing abandoned or private drafts. |
| **Superseded proposal (active or archived)** | Read-only successor notice if successor is visible to the viewer; otherwise generic "Superseded" without revealing target ID/title | Same + branch review | Full review | **No** — safe to enforce target-visibility filtering now. |
| **Withdrawn amendments** | Hidden from active amendment register; optionally summarised as withdrawn count/outcome in future audit log | Visible in read-only audit log if approved | Visible in audit log | **Yes — deferred.** Decide whether withdrawn wording text should be hidden or shown as read-only history. |
| **Superseded / withdrawn policy (`policy_registry`)** | Status, metadata, decision link, and successor link visible; current `approvedWording` suppressed | Same | Full record in `/admin/policies/` | **Yes — deferred** if members should also be able to inspect historical retired wording under a "No longer current" banner. |

## 3. Non-negotiable invariants

1. **Preserve scope boundaries:** Original `private`, `branch`, and `national` boundaries must never be weakened by historical navigation, related-proposal lists, or successor links.
2. **Read-only history:** Archived, withdrawn, and superseded records must never reopen closed ballots or present active participation controls.
3. **No broken or leaking links:** Successor links (`supersededByProposalId`, `supersededBy`) must only display target identifiers/titles when the viewer is authorised to view the target.
4. **Acyclic supersession chains:** `supersededByProposalId` must never form self-references or multi-hop cycles (`A → B → A`).
5. **Immutable ballot records:** Supersession, archival, or withdrawal metadata must never alter substantive proposal wording or revision-bound ballot results.
