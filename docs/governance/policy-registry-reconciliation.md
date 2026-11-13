# Policy Registry Reconciliation — Misclassified Governance Resolutions

Date: 13 November 2026.

## Cause

Prior to this fix, `POST /api/admin/policies/ratify` did not reject governance resolutions (`kind: "resolution"` or legacy `GOV-*` records). If a governance resolution such as `GOV-001` (*Adopt the Reclaim policy platform structure*) had a successful ballot and reached the `implement` stage, it could be ratified into `policy_registry` with `status: "adopted"` and `publicationStatus: "unpublished"`, causing it to appear in **Urgent — Adopted policy not yet published** on `/admin/` and in `/admin/policies/`.

## Code-level Protection

- `isGovernanceResolution` (`src/lib/store.ts`) now delegates to `normalizeKind`, preferring canonical `proposal.kind` (`"policy"` vs `"resolution"`) and falling back to the `GOV-` prefix only when `kind` is legacy or unset.
- `isPolicyRegistryRecordForResolution` (`src/lib/store.ts`) evaluates `policy_registry` entries against their linked proposal record (or fallback `kind`/`proposalId`) so misclassified resolution records are excluded from:
  - `/admin/` dashboard **Needs attention** queues (`awaitingRatification` and `awaitingPublication`)
  - `/admin/policies/` registry table, stats, successor options, and ratification queue
  - `/admin/proposals/[slug]/` and `/proposals/[slug]/` policy status panels
  - `/api/admin/reports/proposal-pdf`
  - `/policies/`, `/policies/[slug]/`, `/api/v1/policies`, and `/api/v1/policies/[id]`
- `POST /api/admin/policies/ratify`, `publish`, `withdraw`, `supersede`, and `reconcile` now reject governance resolutions server-side with `409 Conflict` (or skip them in `reconcile`).

## Safe Production Data Reconciliation

Do **not** delete `proposals`, `proposal_revisions`, `ballot_results`, `votes`, or `publication_events` records. Only invalid `policy_registry` entries for governance resolutions should be archived and removed.

1. **Inspect (read-only):**

   ```js
   db.policy_registry.aggregate([
     {
       $lookup: {
         from: "proposals",
         localField: "proposalId",
         foreignField: "proposalId",
         as: "proposal",
       },
     },
     { $unwind: { path: "$proposal", preserveNullAndEmptyArrays: true } },
     {
       $match: {
         $or: [
           { "proposal.kind": "resolution" },
           {
             $and: [
               { "proposal.kind": { $ne: "policy" } },
               { policyId: { $regex: "^GOV-", $options: "i" } },
             ],
           },
         ],
       },
     },
     {
       $project: {
         _id: 0,
         policyId: 1,
         proposalId: 1,
         title: 1,
         status: 1,
         publicationStatus: 1,
         "proposal.kind": 1,
         "proposal.stage": 1,
       },
     },
   ]);
   ```

2. **Archive before removal:** Copy any matched documents into a non-active backup collection (`policy_registry_reconciliation_backup`) with `reconciledAt` and `reason` metadata before deleting them from `policy_registry`.
3. **Verify:** Confirm `GOV-001` no longer appears in **Urgent — Adopted policy not yet published** on `/admin/`, and still appears with its recorded ballot result and implementation/closure workflow under `/admin/proposals/adopt-reclaim-policy-platform-structure/`.
