# Branch policy import

**Status:** Current · **Verified:** 15 November 2026

Import an existing branch policy registry into Engage without pretending a
ballot produced it. This is a provenance operation, not a normal proposal flow.

Victorian branch policy is the only authorised source (decision register D34).
The National Neon baseline remains deferred (#36); this procedure does not
generalise to it.

## What the import writes

For each source policy the import writes two records:

| Record | Purpose |
|---|---|
| `policy_registry` | The published, adopted policy the rest of Engage reads. |
| `policy_revisions` | The exact source document, hashed and immutable. |

The registry record carries:

- `status: "adopted"` and `publicationStatus: "published"`;
- `jurisdictionBranchId` and `governanceAuthorityBranchId` set to the branch;
- `recordOrigin: "branch-import"`, so it is distinguishable from Engage-ratified policy;
- `import.authorityBasis`, the recorded reason the records are authoritative;
- `import.contentHash`, the hash of the exact source policy object;
- provenance lineage to the published page and the source feed.

`ratification` is `null`. The public page says the policy was adopted by the
branch executive and links the original.

## What the import will not do

- It will not import a source record whose `status` is not `adopted`.
- It will not overwrite an existing record. A changed source is reported as a
  **changed** conflict; new wording must come through a change proposal (#37).
- It will not republish a record that has since been withdrawn, superseded or
  repealed.
- It will not delete a record that disappears from the feed. It reports it as
  **missing from source**.
- It will not infer authority. A missing `--authority-basis` fails closed.

## Before running

1. Confirm the branch has been seeded: `pnpm branches:migrate`.
2. `--branch` accepts either the internal branch identifier or the branch's
   public slug. A branch that predates the standard identifiers (production's
   Victorian branch) carries an explicit `slug` field; do not create a second
   branch record for it.
3. Confirm the authority basis with the branch executive and keep the wording
   you pass on the command line.
4. Take a database backup. Imports are insert-only and idempotent, but a backup
   is still the correct operational habit.

## Preview

```sh
pnpm policies:import-branch \
  --source https://vic.fusionparty.org.au/api/policies.json \
  --branch vic \
  --dry-run \
  --report /tmp/vic-policy-import-preview.json
```

A preview writes nothing. Review every entry marked `changed`, `conflict`,
`invalid` or `missing`.

## Import

```sh
pnpm policies:import-branch \
  --source https://vic.fusionparty.org.au/api/policies.json \
  --branch vic \
  --authority-basis "Adopted by the Victorian branch executive. Confirmed by the Engage maintainer on 2026-11-15 that all live Victorian branch policies are ratified and adopted." \
  --report /tmp/vic-policy-import.json
```

The command prints created / unchanged / changed / conflict / invalid / missing
counts. Exit code `2` means at least one record needs review. It does not mean
the import failed.

## Verify

- `/policies/vic/` lists 41 current policies, grouped by the branch's topics.
- `/policies/vic/complete-neighbourhoods/` resolves the branch path; the older
  `/policies/vic-complete-neighbourhoods/` address redirects to it.
- `/api/v1/policies?branch=<branch-id>` returns the same records; the API filters
  by the internal branch identifier, not the public slug.
- Open one policy: the wording, key commitments and authority should match the
  branch's published page.
- `/admin/policies/` shows the records with origin "Imported branch policy".
- `GET /api/v1/policies` includes `branchSlug`, `policySlug` and
  `canonicalPath` for each record.

## Re-running

Re-running the same feed is safe. Unchanged records are reported as
`unchanged`; nothing is rewritten. A later source change appears as `changed`
and requires a member proposal against the published policy. Publishing that
proposal supersedes the imported record with full lineage.
