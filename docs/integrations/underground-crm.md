# Automatic membership verification from Underground CRM

Engage can verify a pending member from their existing Underground CRM record.
The CRM is authoritative for the person record, the Fusion organisational
membership and the electorate fields. Engage remains authoritative for the
account, platform membership status, branch participation, roles, ballots and
votes.

The integration is a read-only pull. It never creates or changes a CRM contact,
membership or electorate value.

## What is checked

A pending member is verified only when all of the following are true:

1. The Engage account exists, is not disabled, and has a verified email address.
2. Exactly one CRM person matches the account for initial linking.
3. The CRM record is an active person, is not deceased, and its email is not
   marked bad.
4. The CRM person has an active membership of one of the configured Fusion
   membership types.
5. The existing Engage membership is not suspended.

The result is applied through Engage's own services:

- `memberships.status` becomes `verified`, with `verificationSource`,
  `externalPersonId`, `verifiedAt` and `verifiedBy` recorded.
- A durable identity link is stored in `crm_identity_links` using the CRM person
  UUID. Email is only used for the first match.
- Pending vote preferences are promoted by the existing service.
- The existing verification notice and lifecycle event are used.
- An append-only `membership_verification_events` record is written.

Existing verified members, roles, historical votes, ballots, branch following
preferences and manual verification workflows are not changed.

## Identity and matching

- The CRM person UUID is the durable external identity.
- `crm_identity_links` is unique per Engage member. Multiple Engage accounts may
  link to the same CRM person; a CRM person is not assumed to have one account.
- Once linked, verification uses the UUID detail endpoint. A later change to
  either email address does not break the link.
- An existing link is never replaced by an email match. A conflicting link
  opens an administrator review.
- If a CRM person cannot be found, the link is retained so an administrator can
  investigate rather than silently relinking to somebody else.

## Geographic branch

The CRM exposes its existing `federal_district`, `state_upper_district`,
`state_lower_district`, `council_district` and `ward` fields. Engage owns the
mapping from those values to Engage branch IDs:

```json
{
  "federal_district": {
    "Cooper": "branch-vic"
  },
  "state_upper_district": {
    "Northern Metropolitan Region": "branch-vic"
  },
  "state_lower_district": {
    "Richmond": "branch-vic"
  }
}
```

Rules:

- CRM `MembershipType` is used only to identify Fusion membership. It is never
  treated as a branch identifier.
- All non-empty electorate fields are resolved. If they produce one branch, and
  that branch is a recognised state or territory branch, it is assigned as a
  `branch_memberships` fact with source `underground-crm`.
- If no field maps, the mapping is ambiguous, the branch is unavailable, or the
  branch is national or constituent, membership verification still succeeds but
  an administrator review is opened. No constituent branch is auto-assigned.
- If the member already has an active branch affiliation, it is preserved. A
  different CRM-derived branch opens a `branch_conflict` review and no branch
  fact is changed.
- `branch_subscriptions` are never touched. Following remains entirely
  Engage-owned.

## Exceptions and administrative review

The following cases leave the Engage membership pending (or leave an existing
verified status unchanged) and open an actionable review in
`membership_verification_reviews`:

| Reason | Meaning |
| --- | --- |
| `unmatched` | No CRM person matched the verified account email. |
| `ambiguous` | More than one CRM person matched. |
| `invalid_crm_person` | The CRM record is an organisation, inactive, deceased or has a bad email. |
| `crm_record_missing` | A previously linked CRM person no longer exists. |
| `no_active_membership` | No Fusion membership type is present. |
| `inactive_membership` | The Fusion membership is expired or suspended. |
| `suspended_membership` | The Engage membership is suspended; it is not overridden. |
| `identity_conflict` | The account is already linked to a different CRM person. |
| `membership_inactive` | A verified member's CRM membership is no longer active. Their Engage status is preserved. |
| `branch_*` | Membership verified, but the geographic branch needs review. |

Each review:

- is deduplicated per member and reason;
- is visible in **Admin → Member access → Verification reviews**;
- sends one in-app notification to national administrators with a link to the
  member search;
- is resolved when an administrator changes the member's status, or when a
  later automatic verification succeeds for a verification reason.

Reviews are audit records, not a second membership store.

## Outages, retries and alerts

- A CRM network failure, timeout, 429 or 5xx is an outage. The member's status
  is unchanged and no member review is opened.
- Attempts are retried with backoff: 5 minutes, 15 minutes, 1 hour, 6 hours,
  24 hours.
- After the configured threshold, administrators receive one deduplicated
  in-app alert per day. A later successful run verifies normally.
- An authentication or malformed-response failure blocks the attempt, changes
  no membership, and alerts administrators.
- No CRM outage, inactive CRM record or removed CRM person automatically
  revokes an existing verified membership.

## Running verification

Configuration (see `.env.example`):

```sh
ENGAGE_CRM_VERIFICATION_ENABLED=true
ENGAGE_CRM_BASE_URL=https://crm.example.org
ENGAGE_CRM_TOKEN=<the CRM people:read token>
ENGAGE_CRM_FUSION_MEMBERSHIP_TYPE_IDS=["<CRM MembershipType UUID>"]
ENGAGE_CRM_ELECTORATE_BRANCH_MAP={"federal_district":{"Cooper":"branch-vic"}}
ENGAGE_CRM_VERIFICATION_CRON_SECRET=<a separate scheduler secret>
```

The CRM token only needs the `people:read` scope. It cannot write CRM data. The plural membership-type list is a JSON array; a single legacy `ENGAGE_CRM_FUSION_MEMBERSHIP_TYPE_ID` is also accepted.

Manual commands:

```sh
# Report pending accounts and existing links; performs no CRM calls.
pnpm membership:verify

# Process due verification attempts and reconciliation.
pnpm membership:verify --apply

# Backfill attempts for existing pending memberships.
pnpm membership:verify --apply --backfill

# Reconcile linked members only.
pnpm membership:verify --apply --reconcile

# Verify one member by id.
pnpm membership:verify --apply --member <memberId>
```

Scheduled operation: POST `/api/cron/membership-verification` with
`Authorization: Bearer <ENGAGE_CRM_VERIFICATION_CRON_SECRET>`. This secret is
separate from the email-digest and CRM reconciliation secrets. The endpoint
returns `409` while verification is disabled.

New registrations queue an attempt after the account is created. An
administrator can request another attempt by setting the account back to
**Pending verification** in Member access; that also resolves any open review.
The worker runs outside the sign-up request, so CRM availability never delays
registration or sign-in. Existing pending accounts can be backfilled with the
command above.

## Deployment sequencing

1. Deploy Underground CRM's generic `people:read` API and create a dedicated
   token. Verify the endpoint from the Engage host.
2. Deploy Engage with `ENGAGE_CRM_VERIFICATION_ENABLED=false`. The code,
   collections and indexes are inert.
3. Run `pnpm membership:verify` and review the pending count. Run a focused
   `--apply --member <synthetic-member>` against a test account and confirm the
   CRM link, verified status and geographic branch.
4. Backfill existing pending accounts, then enable the cron call.
5. Monitor the first runs for `retried`, `blocked` and `reviews`. Do not enable
   production operation without explicit authorisation.

Rollback is to disable the cron call and set
`ENGAGE_CRM_VERIFICATION_ENABLED=false`. Existing verified memberships, branch
facts, links, votes and reviews remain. Re-enabling is idempotent.

## Tests

`src/lib/membership-verification.test.ts` covers successful verification,
unmatched and ambiguous identities, inactive and missing memberships, suspended
memberships, durable UUID links after email changes, electorate mapping and
conflicts, manual branch preservation, constituent/national exclusion,
outages, retries, alert deduplication, recovery, idempotency, review listing and
resolution, reconciliation without revocation, and the guarantee that the
integration only issues `GET` requests.
