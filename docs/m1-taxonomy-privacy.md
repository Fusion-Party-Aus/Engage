# M1 PR A: taxonomy and discussion privacy

Reclaim is a programme. Its two pillars and ten editorial headings remain intact, including all existing URLs. `programme`, `pillar` and `editorialHeading` describe that organisation; nullable `domain` describes the policy's subject independently. These are optional strings, not a national taxonomy registry. New programmes and standalone policies use the same fields.

`taxonomy.ts` holds the conservative subject crosswalk. Mixed or uncertain classifications remain null and display as unclassified. Editors can explicitly assign or clear taxonomy when creating a revision. New policies use `/policies/?policy=<id>`; creation does not create a ballot. Existing policy IDs, revisions, wording, provenance, consultation references and ballots remain unchanged.

## Migration

Use Node 24.22.1 and the locked dependencies. Set `MONGODB_URI` and `MONGODB_DB_NAME` for the intended database through the operator's environment. Review the dry-run before applying; this PR does not authorise production access or migration.

```sh
node scripts/migrate-policy-taxonomy.mjs
node scripts/migrate-policy-taxonomy.mjs --apply
```

The script updates only revision taxonomy metadata and marks it `taxonomyVersion: 1`. It retains historical route fields and `division` for compatibility, records the old editorial `domain` as `editorialHeading`, and preserves existing subject values where they were already distinct from Reclaim headings. Version-1 records are left alone. Rerunning is safe. Legacy reads use the same mapping, so migration is not a prerequisite for deploying the compatible reader. Stop editorial writers while applying a real migration; back up first. Roll back application changes only to a version that understands these taxonomy fields, or restore the pre-migration backup with writers stopped.

## Discussion boundary

Public catalogue loading never queries member discussion. Consultation APIs and rendered policy/consultation pages require current verified membership before reading it. Pending and suspended accounts are denied even if they hold an administrator or moderator role. Moderation retains its existing role requirement. Membership administration remains available to existing administrators so they can perform verification.

Protected HTML is private and non-cacheable. Preview identities read only synthetic discussion; production identities read only Engage discussion. Existing preview identities are reused, and controlled authentication tests transition one account through pending, verified and suspended states.

## Validation and follow-up

Run `pnpm check`, `pnpm test`, `pnpm test:cutoff`, `pnpm build`, then `AUTH_TEST_SSR=true pnpm test:auth`. Integration commands require isolated replica-set URLs in `GOVERNANCE_TEST_MONGODB_URI` and `AUTH_TEST_MONGODB_URI`; the rendered checks use localhost port 4339. CI builds before enabling these checks. The authentication suite also tests migration dry-run, application and rerun against disposable records.

PR B follows review of PR A: improve the existing admin journey and implement only the accepted minimum editor/reviewer/Election Officer separation, preserving ballot authorisation gates. No identifiable-vote retrieval endpoint without an operational need, ordinary-review transactions without a demonstrated consistency failure, workflow framework or recovery subsystem. Existing ballot administration remains in place; the new-policy form no longer manufactures a draft ballot.

M1 still requires governance separation, usable evidence entry, organisational approvals, security review, human pilot, live OAuth/HTTPS and production recovery/host acceptance. Nothing here enables binding voting or constitutes a policy decision. M2 scope remains deferred.
