# Engage Privacy Policy and Terms of Use — review record

> **Document status: Historical.** This is a dated review record (8 November
> 2026). It is not current legal advice, and parts of it have been overtaken by
> shipped work:
>
> - Plausible analytics is implemented and enabled only on the production host
>   (`src/lib/analytics.ts`, `src/layouts/SiteLayout.astro`).
> - Underground CRM membership verification is implemented, gated by
>   `ENGAGE_CRM_VERIFICATION_ENABLED` and disabled by default.
> - Seconding, scheduled advancement and automatic ballot closure are
>   implemented.
> - The participation-API legal-acceptance enforcement and ballot privacy notice
>   described in sections 10.3 and 10.4 are applied. The gate remains inactive
>   because the documents are still `owner-authorised`.
> - Cloudflare Turnstile and shared rate limiting were added.
>
> These change the "not implemented" list in section 5. Current capability status
> is in [status/capability-matrix.md](status/capability-matrix.md); current
> authorisation is in
> [architecture/api-and-authorisation.md](architecture/api-and-authorisation.md).

**Date:** 8 November 2026 (Australia/Melbourne)  
**Scope:** `/privacy/`, `/terms/`, supporting legal content and rendering, related tests  
**Status:** Owner authorised for publication preparation. Formal publication approval, effective date and qualified legal review remain outstanding. The documents are not yet operative terms.  
**Release constraint:** No production deployment, production data change, policy corpus import, ballot migration, Git history reconstruction, commit, push, merge, Coolify change, indexing or analytics implementation.

This record is internal working material. It is not legal advice. It distinguishes implemented behaviour from proposed or deferred functionality, and it records the matters that require an authorised Fusion decision before the public pages are published as final documents.

---

## 1. Implementation evidence inspected

| Area | Files inspected |
| --- | --- |
| Authentication and sessions | `src/lib/auth.ts`, `src/pages/api/auth/[...all].ts`, `src/pages/api/session.ts` |
| Database and seeding | `src/lib/db.ts`, `src/lib/vote-storage.ts` |
| Proposals, comments, votes, members | `src/lib/store.ts`, `src/lib/types.ts` |
| Ballot privacy | `src/lib/ballot-privacy.ts` |
| Revisions, amendments, branches | `src/lib/proposal-revision.ts`, `src/lib/amendments.ts`, `src/lib/ballot-binding.ts`, `src/lib/branch-access.test.ts` |
| Public and member pages | `src/pages/index.astro`, `src/pages/proposals/[slug].astro`, `src/pages/member/index.astro`, `src/pages/branches/index.astro`, `src/pages/policies/index.astro`, `src/pages/policies/[slug].astro` |
| Administration | `src/pages/admin/index.astro`, `src/pages/admin/members.astro`, `src/pages/admin/branches/index.astro`, `src/pages/admin/policies/index.astro`, `src/pages/admin/proposals/index.astro` |
| API routes | `src/pages/api/**`, including `/api/proposals`, `/api/votes`, `/api/comments`, `/api/admin/*`, `/api/v1/*` |
| Public policy projection | `src/lib/public-policy.ts`, `src/lib/public-api.ts` |
| Layout and design | `src/layouts/SiteLayout.astro`, `src/styles/global.css`, `DESIGN.md` |
| Deployment and operations | `docs/operations.md`, `docs/coolify-deployment.md`, `docs/engage-production-readiness-audit-2026-11-08.md`, `docs/engage-governance-api.md` |
| Existing organisational material | `national-neon-site/2026-01-03-privacy-policy-fusion-party.md`, `national-neon-site/2026-01-03-code-of-conduct-fusion-party.md`, `national-neon-site/2026-01-03-constitution-fusion-party.md` |

The existing website privacy policy is not an Engage policy. It describes the main NationBuilder-era website and names Google Analytics, NationBuilder, Facebook and Twitter. None of those integrations exist in the Engage application code. The Engage pages therefore describe Engage only, and the relationship with the existing policy remains an organisational decision.

### 1.1 Assessment of the existing website privacy policy

The supplied existing policy is undated in the captured page. Its substantive positions are:

- It says the main website uses "third party services" including Google Apps, Google Analytics, NationBuilder, Facebook and Twitter, and that those services may collect cookies, IP address, approximate location, connected social accounts and other identifying information.
- It says data is used to analyse campaign effectiveness and identify people interested in the party, and that information is not sold.
- It says the website and its services are hosted in foreign jurisdictions by foreign companies, and discusses possible interception and ISP data retention.
- It says private browsing will prevent the party from identifying a visitor, while acknowledging that other techniques and law enforcement may still identify them.
- It implements Google Analytics demographic, location and interest features and links to Google's opt-out plugin.
- It carries a party authorisation line that is not a privacy contact and should not be reused as one.

These statements should **not** be imported into the Engage policy:

| Existing statement | Engage evidence | Draft treatment |
| --- | --- | --- |
| Google Analytics and advertising cookies | No analytics or advertising script in Engage | Engage policy says no third-party analytics or tracking cookies in this release |
| NationBuilder, Facebook, Twitter, Google Apps | No such integrations in Engage | Not listed as Engage processors |
| Data used to analyse campaign effectiveness and identify interested people | Engage uses data for participation, governance and operations; no campaign-profiling code | Engage policy describes participation and governance purposes only |
| Hosted in foreign jurisdictions by foreign companies | Engage application/database are self-hosted for Fusion; Google/Resend are conditional external providers | Engage policy distinguishes self-hosted infrastructure from Google/Resend and flags locations for confirmation |
| Private browsing prevents identification | Engage accounts and participation are identified; private browsing does not change that | Not repeated; Engage policy warns that voting is identifiable to national administrators |
| Broad third-party collection of cookies, location and social accounts | Not implemented in Engage | Not repeated |
| "We do not sell your information" | No sale or brokerage code or integration | Retained as a consistent statement in the Engage policy |

**Recommendation:** keep the existing main-site policy in place for the main site, add a clear scope note that it does not describe Engage, and publish the Engage policy separately. Alternatively, replace both with a single layered policy. That is an organisational decision, not something the Engage pages should assume. The existing policy also needs its own review: it refers to services and practices that may have changed since it was written, and its surveillance and "private browsing" statements are not appropriate for a signed-in governance platform.

### 1.2 Authoritative organisation check

Checked on 8 November 2026 against:

- [ABN Lookup — ABN 20 845 177 664](https://abr.business.gov.au/ABN/View?abn=20845177664)
- [AEC Register of Political Parties](https://www.aec.gov.au/parties_and_representatives/party_registration/Registered_parties/) (register file updated 6 November 2026)

Confirmed:

| Item | Confirmed value | Source |
| --- | --- | --- |
| Legal entity | **FUSION POLITICAL PARTY INCORPORATED** | ABN Lookup |
| ABN | **20 845 177 664** | ABN Lookup; active from 16 April 2022; entity type "Other Incorporated Entity" |
| Public name used in Engage | **Fusion Party Australia** | Organisational brief and existing public site |
| Registered political party name | **votefusion.org for big ideas** | AEC Register, updated 6 November 2026 |
| Registered abbreviation | **votefusion.org** | AEC Register |
| Legal correspondence address | **254 McLeod Lane, Mansfield VIC 3722** | Organisational brief; matches the AEC postal and registered-officer address |
| Approved contact | **contact@fusionparty.org.au** | Organisational brief |
| Governing law | **Victoria, Australia** | Constitution v1.8 cites the Associations Incorporation Reform Act 2012 (Vic); Mansfield VIC correspondence address. Confirm by legal review. |

The legal entity, the public name and the registered political party name are **not the same thing**. The documents now say so explicitly. They do not describe "Fusion Party Australia" as the registered party name, and they do not describe the incorporated association as the registered party.

The ABN record shows a main business location of NSW 2205. That is not used as the legal correspondence address. The AEC register and the organisational brief both support the Mansfield VIC 3722 correspondence address. Do not infer a registered office from the ABN main-business-location field.

No registered address beyond the confirmed correspondence address, no registration number and no registration date has been invented. The AEC register's registered-officer personal details are not reproduced in the public documents.

---

## 2. Evidence-based data practice summary

### 2.1 Account, identity and membership

| Item | Implemented behaviour | Visibility | Retention |
| --- | --- | --- | --- |
| Account record | Better Auth `user` document with MongoDB `_id` used as the member identifier, name, email, email-verification state, optional profile image, disabled flag and timestamps | Own account; national administrators in `/admin/members/`; branch administrators see name and email when assigning branch membership | No automatic deletion; disabling an account prevents sign-in but does not erase records |
| Platform role | `application_roles` records member, moderator or administrator, with grantedBy and grantedAt | National administrators | Retained as an access record |
| Membership status | `memberships` record with pending, verified or suspended, plus updatedBy and updatedAt | Own account; national administrators | Retained; no automatic deletion |
| Branch membership | `branch_memberships` with branchId, memberId, active/revoked status, member/administrator branch role, assignedBy/assignedAt, revokedBy/revokedAt | Own account; branch administrators and national administrators for the relevant branch | Current row plus `branch_membership_events` history |
| Branch / membership audit events | `branch_events`, `branch_membership_events` with actor, action, before/after snapshots and timestamp | Administrators; database | Retained as audit history |

Membership verification is manual. No external membership register, party database or automated eligibility service is called by the code. An administrator compares the account name and email with Fusion's records and sets the status. Branch membership is explicit and is not inherited from a parent branch.

### 2.2 Authentication

- Email sign-in uses Better Auth's magic-link plugin. The token is stored hashed, expires after 600 seconds and is rate-limited to five requests per 60-second window. Rate-limit state is stored in the database.
- Google sign-in is available only when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are configured. Better Auth links a provider account only where the provider reports a verified matching email.
- Better Auth session records may include the session identifier, user identifier, expiry, IP address and user-agent. The application sets secure cookies in production and disables cookie session caching.
- No password sign-in is configured in this release.
- A development-only cookie (`engage_dev_user`) is accepted only in `development`, `test` or `preview` modes. Production ignores it and production session creation rejects disabled accounts.

### 2.3 Proposals, comments and amendments

| Record | Stored content | Public visibility | Notes |
| --- | --- | --- | --- |
| Proposal | proposalId, slug, title, space, summary, outcomes, details, optional HTML, attachment URL/description, stage, kind, authorId, authorName, timestamps, provenance, branch fields, ballotRevisionId | Public by default; private proposals only author, originating branch administrator, staff or national administrator; branch proposals only active members of the jurisdiction/origin branch, author, branch administrator, staff or national administrator; archived proposals restricted to reviewers | The author's display name is shown publicly. `authorId` is stored but not shown on the public page. |
| Proposal revision | revisionId, proposalId, parentRevisionId, authorId, createdAt, snapshot, SHA-256 content hash, provenance | Public revision views omit `authorId` and `_id`; the page shows revision metadata and diffs | Immutable snapshot. Substantive text is locked once voting begins. |
| Comment / contribution | commentId, proposalId, memberId, authorName, stance, body, upvotes (member IDs), createdAt | Public with the proposal: display name, stance, body, date and endorsement count. Member IDs and the upvote list are not rendered. | Author or staff can delete. Deleting a proposal deletes its comments. |
| Formal amendment | amendmentId, proposalId, authorId, baseRevisionId, currentRevisionId, status, changes, conflict state, administrative reason, ballot binding fields | Public within the proposal's visibility. The page shows "You" for the current member and "Contributor" for others; revision IDs and dates are shown. `authorId` is stored but not shown to other members. | `amendment_revisions` are immutable snapshots with parent, authorId, timestamp, snapshot and hash. |
| Endorsement | Member IDs in the comment's `upvotes` array | Only the count is shown publicly | Stored member IDs are not exposed by the page. |

### 2.4 Ballots and voting

| Item | Implemented behaviour | Visibility |
| --- | --- | --- |
| Proposal vote | One current vote per member per proposal ballot (`ballotId = proposal:<proposalId>`), with memberId, authorName, choice (approve, abstain, reject), optional reason up to 500 characters, proposalId, revisionId and updatedAt. The unique index prevents duplicate current votes. | Public sees only aggregate tallies. The member sees their own vote and reason. National administrators receive identifiable records. |
| Amendment vote | Separate ballot (`ballotId = amendment:<amendmentId>`) bound to the frozen proposal revision and the amendment wording revision. Same member identity, choice, reason and timestamps. | Same boundary as proposal votes. |
| Ballot binding | `ballot_binding_events` records the actor, reviewed revision, decision event reference, reason and before/after state when an ambiguous legacy ballot is bound. | Administrators and audit readers. |
| Ballot result | `ballot_results` records proposalId, revisionId, result (successful, unsuccessful, inconclusive), decisionEventId, recordedBy and recordedAt. Results are immutable and one per proposal. Engage does not calculate a passing threshold. | Administrators; public policy records may expose the decision event and revision but not the recording member identifier. |
| Ratification | `policy_registry` ratification object with authority branch, decision event, ballot revision, ratified revision, adopted amendment IDs, ratifiedBy and ratifiedAt. | Public policy page shows authority branch, decision event, revisions and dates; `publicPolicy` omits `ratifiedBy`. |
| Publication | `publication_events` with event ID, idempotency key, policy ID, revision, status, provenance, publishedBy and timestamps. Withdrawal and supersession are separate events. | Public policy registry shows publication state, dates and provenance; actor identifiers are not in the public projection. |

**The critical privacy fact:** `canViewIdentifiableBallots` returns true for a national administrator (`user.isAdmin`) or a holder of the national-scope `ballots.view_identifiable` permission. `ballotRecordsForViewer` returns all records only to that boundary; every other viewer receives only their own vote with `memberId` and `authorName` removed, and anonymous viewers receive an empty list. The national admin activity feed also includes identifiable vote participation only when `canViewIdentifiableBallots` is true. Moderators and branch administrators who hold neither the administrator role nor that national permission do not receive identifiable ballot records through the application.

**Small-ballot disclosure:** the public proposal page displays approve, abstain, reject and total counts. In a ballot with one voter, or a very small number of voters, the aggregate tally can effectively reveal how those voters voted even though individual names are not shown. The privacy policy and terms now state this explicitly. This is an inherent limitation of publishing aggregate results, not a code defect, but it matters for small branch electorates and should be considered in governance design.

### 2.5 Branch and administrative records

- `branches` stores branchId, name, kind, parentBranchId, recognised, createdAt and update metadata. Recognised branch names, IDs, kinds and parent relationships are public through `/branches/` and `/api/v1/branches`.
- `branch_referrals` stores proposal, source/target branch, reason, status, referredBy and referredAt. Administrator-only.
- `branch_events` stores branch creation/update actions with actor and before/after snapshots.
- `branch_membership_events` stores assignment, role change and revocation events with actor and before/after records.
- `publication_events` records publication, withdrawal and supersession transitions.
- `legal_acceptances` records the member identifier, accepted Terms version and hash, acknowledged Privacy Policy version and hash, affirmative flags and acceptance timestamp. No IP address or user agent is added.
- Member administration stores `grantedBy`, `updatedBy` and similar actor fields. It does not provide a complete immutable audit trail for every account edit.

### 2.6 Technical and operational data

- The application and MongoDB run on Fusion-operated infrastructure. The database is bound to localhost in the documented deployment and is not intended to be publicly reachable.
- The application connects with a database-scoped read/write user; the MongoDB root user is for initialisation and administration.
- Production access is through a reverse proxy with HTTPS. The deployment documentation also describes Coolify and a poller for staging/cutover work; those are deployment workstreams, not application features.
- Server, Docker and reverse-proxy logs may contain IP address, user-agent, request path, timestamp, status and error information. Retention is not defined in the repository.
- Backups are described as `mongodump`/`mongorestore` logical backups to storage outside the host, with a recommendation for restricted access and encryption at rest. A live production backup/restore drill is not evidenced in the repository. This remains an operational confirmation item.
- Personnel who hold production database or host access can technically read stored records, including identifiable ballots. The repository does not document an operator access list, break-glass procedure or confidentiality policy. The privacy policy states that this access is restricted to authorised operators and should be subject to least-privilege controls, and flags who holds that access for confirmation.

### 2.7 Analytics, cookies and indexing

- No Google Analytics, advertising pixel or tag manager is present. Fusion-hosted Plausible analytics is implemented (`src/lib/analytics.ts`) and enabled only on the production host; it is cookieless and receives no names, email addresses, member identifiers, ballot choices or search text (`src/data/legal-documents.ts`).
- No analytics or advertising cookies are implemented.
- The application's own production cookie is the Better Auth session cookie. Development sign-in uses a separate cookie only in non-production modes.
- The legal pages are rendered with `noIndex` while they are drafts. Existing public pages retain their existing indexing behaviour. Search indexing remains outside this release; analytics is limited to the production-host Plausible implementation above.

---

## 3. Public visibility matrix

| Information | Public | Signed-in member | Branch administrator | Moderator | National administrator |
| --- | --- | --- | --- | --- | --- |
| Public proposal wording, provenance, revision history | Yes | Yes | Yes | Yes | Yes |
| Private proposal | No | Author only | Originating branch only | Yes (staff) | Yes |
| Branch-scoped proposal | No | Active branch members | Relevant branch | Yes (staff) | Yes |
| Comment display name, stance and body | Yes, with the proposal | Yes | Yes | Yes | Yes |
| Comment endorsements | Count only | Count only | Count only | Count only | Count only |
| Own vote and reason | No | Yes | Yes | Yes | Yes |
| Another member's vote, reason or identity | No | No | No, unless also national admin | No | Yes |
| Member email address | No | Own only | Yes, for branch membership work | No (member admin is national-admin only) | Yes |
| Membership status and role | No | Own only | Relevant branch membership only | No | Yes |
| Branch membership lists | No | Own branches | Relevant branch | No | Yes |
| Ballot results and ratification records | Aggregate/public policy fields only | Aggregate/public policy fields only | Relevant ballot outcome controls | Staff view | Yes |
| Audit events | No | No | Relevant branch events | Staff view | Yes |

This matrix is based on the code paths inspected. The national-administrator column includes a holder of the national `ballots.view_identifiable` permission. It is not a claim that every administrator will use access appropriately; access should be governed by organisational policy, confidentiality obligations and least-privilege practice.

---

## 4. Third-party processors and infrastructure

| Provider / service | Evidence | Personal information involved | Status |
| --- | --- | --- | --- |
| Google identity provider | `src/lib/auth.ts` configures Google only when both client credentials exist; Better Auth handles the OAuth flow | Google account identifier, name, email, email-verification state, profile image, provider tokens/account-linkage data | Conditional feature; confirm data processing terms and overseas locations |
| Resend | `src/lib/auth.ts` posts magic-link emails to `https://api.resend.com/emails`; `src/pages/api/admin/members.ts` posts verification notices | Recipient email address, name in verification notice, single-use sign-in URL, delivery metadata | Conditional on `RESEND_API_KEY` and `AUTH_EMAIL_FROM`; confirm data processing terms and overseas locations |
| Plausible analytics | `src/lib/analytics.ts`, `src/layouts/SiteLayout.astro`; sends to Fusion's own `analytics.fusionparty.org.au` | Aggregate page, navigation, search/filter and outcome events; no member identifiers, ballot choices, search terms or contribution text | Implemented after this review; production host only, cookieless |
| MongoDB | `src/lib/db.ts`, deployment docs | All application records | Self-hosted on Fusion-operated infrastructure; confirm host location and backup arrangements |
| Reverse proxy / host / Coolify | `docs/operations.md`, `docs/coolify-deployment.md` | Technical request data and deployment logs | Confirm which production components process request data and their retention |

No payment processor, advertising network, data broker, email marketing platform or analytics provider is integrated in the Engage code. The existing main-site privacy policy's references to NationBuilder, Facebook, Twitter and Google Analytics should not be carried into the Engage policy without new implementation evidence.

---

## 5. Implemented, proposed and deferred

### Implemented

- Public proposal browsing and published policy registry.
- Email magic-link and optional Google sign-in.
- Manual membership verification and explicit branch membership.
- Proposals, comments, stances, endorsements and immutable proposal revisions.
- Formal amendments and immutable amendment revisions.
- Separate proposal and amendment ballots bound to exact revisions.
- Ballot results, ratification, publication, withdrawal and supersession records.
- Branch administration, referrals and audit events.
- Identifiable ballot access limited to national administrators or a holder of the national `ballots.view_identifiable` permission.
- Owner-authorised legal pages at `/privacy/` and `/terms/` with confirmed entity, ABN, registered party name, contact and correspondence address.
- A server-side legal acceptance mechanism, API and member-page gate. It records the accepted Terms version and hash, Privacy Policy version and hash, member identifier and acceptance time. It is **inactive until publication**.
- Public legal links in the current concurrent `SiteFooter` implementation.

### Not implemented or not yet active (must not be described as available)

- The legal acceptance gate is not active because the documents remain owner-authorised, not because enforcement is missing. The participation-API enforcement patch and the ballot privacy notice are applied (sections 10.3 and 10.4).
- Automatic ratification.
- A separate Election Officer role.
- Self-service account deletion.
- Self-service email address change.
- Self-service data export.
- A formal moderation appeal workflow.
- An adopted ballot contingency policy. Technical controls can close a ballot or change its stage; the grounds, safeguards, notice and escalation rules are not yet adopted.
- Automated calculation of ballot thresholds.
- Advertising, tracking cookies or a cookie-consent UI.
- Search indexing of the legal pages; `noindex, nofollow` is retained.

### Deferred

- A broader analytics programme beyond the Plausible implementation described above.
- SEO work beyond the existing public metadata.
- Policy corpus import and ballot migration.

`FORMAL_BALLOTS_ENABLED` appeared in deployment configuration at the time of this review and is not read by the application. It is not present in `.env.example` today. It should not be described as a working feature flag.

---

## 6. Legal framework considered

### 6.1 Privacy Act 1988 (Cth) and the APPs

The Privacy Act 1988 (Cth) and the Australian Privacy Principles (APPs) regulate the handling of personal information by APP entities. The APPs cover open and transparent management, collection, notification, use and disclosure, cross-border disclosure, security, access and correction.

Relevant OAIC guidance:

- [Australian Privacy Principles](https://www.oaic.gov.au/privacy/australian-privacy-principles)
- [APP 1 — open and transparent management](https://www.oaic.gov.au/privacy/australian-privacy-principles/australian-privacy-principles-guidelines/chapter-1-app-1-open-and-transparent-management-of-personal-information)
- [APP 3 — collection of solicited personal information](https://www.oaic.gov.au/privacy/australian-privacy-principles/australian-privacy-principles-guidelines/chapter-3-app-3-collection-of-solicited-personal-information)
- [APP 11 — security of personal information](https://www.oaic.gov.au/privacy/australian-privacy-principles/australian-privacy-principles-guidelines/chapter-11-app-11-security-of-personal-information)
- [Consent to the handling of personal information](https://www.oaic.gov.au/privacy/your-privacy-rights/your-personal-information/consent-to-the-handling-of-personal-information)
- [Political parties and elections](https://www.oaic.gov.au/privacy/your-privacy-rights/more-privacy-rights/political-parties-and-elections)
- [Statutory tort for serious invasions of privacy](https://www.oaic.gov.au/privacy/your-privacy-rights/more-privacy-rights/statutory-tort-for-serious-invasions-of-privacy)

### 6.2 Political party exemption

The OAIC states that a registered political party is exempt from the Privacy Act 1988, as is a political representative carrying out an exempt political activity. Section 7C of the Act exempts political acts and practices connected with elections, referenda or another aspect of the political process for political representatives, contractors, subcontractors and volunteers. The precise scope of the registered-party exemption and its application to a member governance platform requires legal advice.

**Conclusion for the drafts:** the documents do not assert that the Privacy Act applies. They describe the handling with reference to the APPs as good practice, state the exemption position, and flag coverage as a decision for Fusion. If legal advice concludes that the Act applies (or Fusion opts in under s 6EA), the APPs and any applicable code would need to be applied, including APP 1, 3, 5, 6, 8, 11, 12 and 13.

Separately, the small business operator exemption in s 6D may apply to a not-for-profit with annual turnover of $3 million or less, unless an exception applies (for example, trading in personal information or providing a health service). Fusion should confirm its turnover and whether any Engage activity is a business. The political party exemption is the more directly relevant issue, but it should not be assumed to be the only applicable exception.

### 6.3 Sensitive information and consent

Political opinions and membership of a political association are sensitive information under s 6(1). If the APPs apply, APP 3.3 generally requires express consent to collect sensitive information unless an exception applies. The current sign-in flow has no separate consent checkbox. The privacy policy explains the handling and the public visibility of display names and contributions, but an express consent/acknowledgement step may be required before first participation. This is a legal and product decision, not something the legal copy can cure by itself.

### 6.4 Notifiable Data Breaches

The NDB scheme applies to APP entities. If Fusion is exempt for the relevant handling, the statutory NDB obligation may not apply; voluntary breach response is still expected. No incident response procedure is documented in the repository. The policy states that Fusion will contain, assess and notify where required or appropriate, and flags the procedure for confirmation.

### 6.5 Statutory tort for serious invasions of privacy

The statutory tort commenced on 10 June 2025 and is broader than the APPs: the OAIC states that it extends to individuals and entities that may not be APP entities. The policy refers to the tort in general terms and does not claim that it is excluded by the political party exemption. Legal review should consider the tort separately from APP coverage.

### 6.6 Automated decision-making transparency

From 10 December 2026, APP 1.7–1.9 require APP entities to describe certain computer programs that make, or do things substantially and directly related to making, decisions that could significantly affect an individual's rights or interests. Engage's eligibility checks are rule-based and depend on manual membership verification; the application does not calculate ballot thresholds or make disciplinary decisions. The drafts state that Engage does not calculate or apply a passing threshold. If future automation is introduced, the privacy policy must be updated before it operates.

### 6.7 Other laws

- The Spam Act 2003 (Cth) and Do Not Call Register Act 2006 (Cth) contain political party exceptions, but transactional sign-in and verification emails should still be sent only to the address the member supplied.
- The Australian Consumer Law may apply to any paid or consumer-facing supply; Engage is currently free. The Terms preserve non-excludable rights and do not make a broad waiver.
- Copyright and moral rights: contributors retain ownership; the Terms grant a limited licence for platform and governance use. Legal review should confirm the moral-rights wording and the scope of the licence for adapted or published policy wording.
- State or Territory privacy or electoral laws may apply to particular activities. These were not analysed and should be considered in legal review.

---

## 7. Resolved in this revision

| Item | Resolution |
| --- | --- |
| Legal entity | Confirmed as **FUSION POLITICAL PARTY INCORPORATED** (ABN Lookup). |
| ABN | Confirmed as **20 845 177 664**; active from 16 April 2022. |
| Registered political party | Confirmed from the AEC Register updated 6 November 2026 as **votefusion.org for big ideas**, abbreviation **votefusion.org**. |
| Public name | **Fusion Party Australia** is the public name used in Engage. The documents now distinguish it from both the legal entity and the registered party name. |
| Contact and correspondence | **contact@fusionparty.org.au** and **254 McLeod Lane, Mansfield VIC 3722**. The address matches the AEC postal and registered-officer address. |
| Owner authorisation | Recorded for this version. This is **not** a completed legal review, formal publication approval or effective date. |
| Automated access | The blanket prohibition on scraping, crawling and automated access has been replaced with a narrower prohibition on excessive, disruptive, access-control-bypassing or personal-information-harvesting automation. Reasonable public indexing of non-`noindex` pages, accessibility tools and limited research access are expressly distinguished. The `noindex` configuration is unchanged. |
| Public browsing and acceptance | The Terms no longer state that merely browsing Engage constitutes affirmative acceptance. Public browsing is distinguished from account creation, sign-in and participation. |
| Acceptance mechanism | Implemented as a server-side record, API and member-page gate. It records Terms version/hash, Privacy Policy version/hash, member identifier and timestamp. It remains inactive until both documents are published with an effective date and `LEGAL_ACCEPTANCE_ENABLED` is set. |
| Member-page integration | The acceptance gate and legal links have been added to `src/pages/member/index.astro`. Existing sessions and votes are untouched. |
| Footer integration | The concurrent `SiteFooter` implementation already includes `/privacy/` and `/terms/` links. It was not overwritten. |
| Ballot contingency | The Terms now describe the technical controls that administrators actually have, state that no complete contingency policy has been adopted, and flag the outstanding grounds, safeguards, member notice and escalation decision. They do not claim unrestricted discretion. |
| Approval metadata | Updated to record owner authorisation while stating that formal publication approval, the effective date and qualified legal review remain outstanding. |

### 7.1 Still requiring confirmation

The checklist and unresolved-questions sections below identify the remaining requirements. In summary:

- formal publication approval office-holder and approval date, if required by Fusion's rules;
- effective date;
- Privacy Act coverage and sensitive-information consent;
- retention, backups, log access and database/host operator access;
- Google and Resend terms and overseas processing;
- production hosting and any CDN, tunnel or reverse proxy;
- account correction/deletion and breach response;
- Victorian governing-law clause, minimum age and DRC pathway;
- activation of the acceptance gate after publication approval;
- application of the participation API enforcement patch;
- a published ballot contingency policy;
- the treatment of small ballot tallies;
- the relationship with the existing main-site privacy policy.

---

## 8. Legal and organisational approval checklist

### Authorised organisational approval

- [x] Confirm the full legal entity name and ABN: **FUSION POLITICAL PARTY INCORPORATED, ABN 20 845 177 664**.
- [x] Confirm the current federal party registration and distinguish registered name from legal entity: AEC Register updated 6 November 2026 lists **votefusion.org for big ideas** (abbreviation **votefusion.org**). Fusion Party Australia is the public name used in Engage.
- [x] Record owner authorisation for this version.
- [x] Confirm the approved contact and legal correspondence address: **contact@fusionparty.org.au**, **254 McLeod Lane, Mansfield VIC 3722**.
- [x] Implement the server-side acceptance record, API and member-page gate.
- [ ] Record the formal publication approval office-holder and date, if Fusion's rules require a separate publication approval. Owner authorisation is not the same as publication approval.
- [ ] Confirm the effective date. Version 1.0 is recorded; no effective date has been set.
- [ ] Confirm the complaints handling procedure and expected response times.
- [ ] Confirm the relationship between the Engage policy and Fusion's existing website privacy policy.
- [ ] Confirm the Victorian governing-law clause and the dispute-resolution pathway.
- [ ] Confirm minimum age and membership eligibility for Engage accounts.
- [ ] Confirm whether the existing Code of Conduct and Dispute Resolution Committee process is the correct pathway for platform conduct complaints.
- [ ] Confirm who owns the data breach response and member correction/deletion procedures.
- [ ] Apply the participation API enforcement patch before activating the acceptance gate.
- [ ] Set both legal documents to published status and enable `LEGAL_ACCEPTANCE_ENABLED` only after publication approval.

### Legal review

- [ ] Confirm whether the Privacy Act 1988 (Cth) applies to each Engage activity, including the effect of the political party exemption and any opt-in under s 6EA.
- [ ] If the Act applies, confirm APP 3 express consent for sensitive information and whether a first-sign-in acknowledgement is required.
- [ ] Confirm APP 5 collection notice placement at sign-in and at participation points.
- [ ] Confirm APP 6 use and disclosure boundaries, including administrator access to identifiable ballots.
- [ ] Confirm APP 8 cross-border disclosure for Google, Resend and any infrastructure provider.
- [ ] Confirm APP 11 security and retention, including log and backup periods.
- [ ] Confirm APP 12 access and APP 13 correction procedures and timeframes.
- [ ] Confirm NDB obligations or voluntary breach response.
- [ ] Confirm the statutory tort analysis separately from APP coverage.
- [ ] Confirm the automated decision-making position before 10 December 2026.
- [ ] Review the Terms' limitation of liability, content licence, moral-rights consent, moderation powers and governing-law clause.
- [ ] Review the interaction between platform moderation and the Constitution/Code of Conduct/DRC process.
- [ ] Review whether the public display of full names on political contributions creates an unacceptable risk and whether any alternative is feasible.
- [ ] Review the legal effect of public browsing and the implemented first-sign-in acceptance mechanism; confirm the Privacy Policy acknowledgement is not treated as blanket sensitive-information consent.
- [ ] Establish and publish the grounds, safeguards, member notice and escalation requirements for administrative ballot intervention.

### Risk-ranked legal review priorities

**High**

1. **Privacy Act coverage and the political-party exemption.** Confirm whether the Act applies to Engage, whether the party remains within the exemption, and whether Fusion should opt in under s 6EA. This determines whether APP obligations, NDB duties and OAIC complaint rights apply.
2. **Sensitive-information consent.** The acceptance mechanism records a Privacy Policy acknowledgement, not consent to every sensitive-information use. Confirm whether APP 3.3 express consent is required and, if so, implement separate consent wording and controls.
3. **Retention and deletion.** Confirm what must be retained for governance and what must be destroyed or de-identified when no longer needed, including votes, comments, backups and closed accounts.
4. **Cross-border disclosure.** Confirm Google, Resend and infrastructure processing locations and APP 8 compliance if the APPs apply.
5. **Ballot intervention authority.** Confirm the grounds, approval, notice, record-keeping, escalation and appeal requirements for closing or changing a ballot. Technical capability is not organisational authority.

**Medium**

6. **Content licence and moral rights.** Confirm the licence is limited to platform operation, governance records and policy publication, and that the moral-rights position is appropriate.
7. **Liability and governing law.** Confirm the liability clause, consumer-law carve-outs and the Victorian governing-law/forum clause.
8. **Notifiable Data Breaches and incident response.** Confirm obligations and the internal procedure, including who decides to notify.
9. **Small-ballot disclosure.** Decide whether aggregate tallies need suppression or further aggregation for very small electorates.
10. **Moderation powers.** Confirm the Terms do not create disciplinary powers inconsistent with the Constitution, Code of Conduct or DRC process.

**Lower**

11. **Spam Act and transactional email.** Confirm sign-in and verification emails remain transactional and do not become marketing without appropriate consent.
12. **State or Territory privacy or electoral laws.** Consider whether any apply to particular Engage activities.

### Operational and product confirmation

- [ ] Confirm off-host backup operation, encryption at rest, frequency, retention and restore drill.
- [ ] Confirm log retention and access controls.
- [ ] Confirm who holds production database and host access.
- [ ] Confirm whether account deletion, email correction or data export can be delivered administratively or requires product work.
- [ ] Confirm Google and Resend data processing terms and overseas processing locations.
- [ ] Confirm the production hosting location and any CDN, tunnel or reverse-proxy provider.
- [ ] Confirm whether small ballots should suppress or further aggregate public tallies.
- [ ] Confirm that no analytics or tracking script will be added before the policy is updated.
- [ ] Confirm that the legal pages remain `noIndex` until publication and that indexing is handled separately.

---

## 9. Unresolved factual or governance questions

1. **Publication approval and effective date:** Which office-holder or delegate is authorised to approve publication, and on what date? What effective date should be recorded? Owner authorisation is recorded, but formal publication approval (if required) and the effective date are not.
2. **Privacy Act coverage:** Does the political party exemption cover all Engage activities, or only some? Will Fusion opt in under s 6EA?
3. **Consent:** If the APPs apply, is the acceptance mechanism's Privacy Policy acknowledgement sufficient, or is separate express consent required for sensitive information?
4. **Acceptance activation:** The server-side mechanism is implemented but inactive. The participation API enforcement patch must be applied before the gate is enabled. Which release owner will apply it and verify direct API enforcement?
5. **Retention:** What periods apply to server logs, backups, expired sessions, closed accounts and deleted comments?
6. **Deletion:** What can Fusion actually delete while preserving vote, ballot, ratification and publication records? Who authorises deletion?
7. **Correction:** How will email address corrections and factual record corrections be handled when the admin UI does not currently edit email?
8. **Public attribution:** Is full-name public attribution appropriate for all members, including members in sensitive personal circumstances? Are alternative display names compatible with membership verification?
9. **Ballot identifiability:** Is national-administrator-only access the intended final governance boundary, or will a separate Election Officer role be created? Should small ballots suppress or further aggregate public tallies to avoid effectively revealing individual choices?
10. **Ballot contingency:** Administrators can technically close a ballot or change its stage. What are the authorised grounds, approval requirements, member notice, record-keeping, escalation and appeal requirements for doing so? These are not yet established.
11. **Moderation appeals:** How do platform moderation decisions interact with the Code of Conduct and DRC process?
12. **Governing law:** The Terms state Victoria, Australia, based on Constitution v1.8 and the Mansfield VIC address. Confirm that clause and the chosen forum with qualified legal review.
13. **Minimum age:** What age and membership rules apply to Engage accounts?
14. **Service providers:** What are the current Google and Resend contractual terms, sub-processors and processing locations?
15. **Infrastructure:** Which production CDN, tunnel, reverse proxy and hosting providers process request data? Who holds database and host access?
16. **Breach response:** Who leads incident response, and what notification template and timeline apply?
17. **Existing policy:** Should the existing main-site privacy policy be replaced, linked or expressly distinguished from this Engage policy? The existing policy names Google Analytics, NationBuilder, Facebook and Twitter, describes campaign profiling and foreign hosting, and says private browsing prevents identification. Those statements are inconsistent with Engage's current implementation and should not be carried across without a separate review.
18. **Registered name:** The AEC Register currently lists "votefusion.org for big ideas" with abbreviation "votefusion.org". Is that the intended long-term registered name, and should public materials explain its relationship to the Fusion Party Australia public name more prominently?

---

## 10. Integration status and remaining patch

### 10.1 Public footer — already integrated

The concurrent `src/components/site/SiteFooter.astro` implementation already includes:

```astro
<nav aria-label="Legal">
  <a href="/privacy/">Privacy</a>
  <a href="/terms/">Terms</a>
</nav>
```

No further footer change is required, and the file was not edited by this work.

### 10.2 Sign-in and member account — applied

`src/pages/member/index.astro` now:

- imports `LegalAcceptanceGate` from `src/components/legal/LegalAcceptanceGate.astro`;
- displays the approved Terms and Privacy Policy links in the signed-out sign-in header;
- renders the acceptance gate after the membership-status banner in the signed-in view.

The gate calls `GET /api/legal/acceptance` and remains hidden while the documents are unpublished or the member has already accepted the current versions. Existing accounts, sessions and votes are unaffected. It does not delete or invalidate a session.

### 10.3 Participation API enforcement — applied

The enforcement patch described in the original review has since been applied. `requireLegalAcceptance` (`src/lib/legal-acceptance.ts`) runs after authentication and before the write in:

- `src/pages/api/votes.ts` — `POST`;
- `src/pages/api/comments.ts` — `POST`, `PATCH` and `DELETE`;
- `src/pages/api/proposals/index.ts` — `POST`;
- `src/pages/api/proposals/[proposalId].ts` — `PATCH`;
- `src/pages/api/amendments.ts` — `POST`;
- `src/pages/api/proposals/[proposalId]/second.ts` — `POST`.

Public page routes, `GET` reads, `/api/session`, `/api/legal/acceptance` and the legal pages are not gated. Proposal deletion is not gated. The gate remains disabled while either document is `owner-authorised`, regardless of `LEGAL_ACCEPTANCE_ENABLED`; that interlock is verified by `buildLegalAcceptanceManifest`. The activation sequence in 10.5 still applies.

### 10.4 Ballot privacy notice — applied

`src/components/legal/BallotPrivacyNotice.astro` is created and rendered on the proposal page (`src/pages/proposals/[slug].astro`) beside the ballot. It states that a vote is identifiable to the national administrator or delegated national permission boundary, that aggregate totals are public and may reveal choices in a very small ballot, and links to the Privacy Policy. It is a context link only and does not change voting behaviour or tally logic.

### 10.5 Activation sequence

Do not activate the gate until all of the following are complete:

1. Formal publication approval has been recorded, if Fusion's rules require a separate approval.
2. The effective date has been set.
3. Both documents have `publicationStatus: "published"` and real effective dates in `src/data/legal-documents.ts`.
4. `LEGAL_ACCEPTANCE_ENABLED=true` is set in the runtime environment.
5. The release owner has verified direct API enforcement, member-page acceptance, existing-session compatibility and preservation of existing votes.

Setting `LEGAL_ACCEPTANCE_ENABLED=true` while either document remains `owner-authorised` intentionally leaves the gate disabled. This is a safety interlock, not an oversight.

### 10.6 Acceptance record

Acceptance records are stored in the `legal_acceptances` collection:

- `acceptanceId` — deterministic key from member ID, Terms hash and Privacy Policy hash;
- `memberId`;
- `termsVersion`, `termsHash`;
- `privacyVersion`, `privacyHash`;
- `termsAccepted: true`, `privacyAcknowledged: true`;
- `acceptedAt`.

No IP address or user agent is added by this feature. The Privacy Policy acknowledgement is recorded separately from Terms agreement and is **not** treated as consent to every sensitive-information use.

---

## 11. Verification results

| Check | Result |
| --- | --- |
| `pnpm test` | **103 tests, 90 passed, 13 skipped, 0 failed**. The legal-document and legal-acceptance tests passed. The skipped tests are real-MongoDB integration tests that require the isolated test database environment. |
| `pnpm check` | **0 errors, 0 warnings, 14 unrelated hints (149 files).** The earlier concurrent settings-component errors were resolved before the final run. |
| `pnpm build` | **Successful Astro server build.** |
| `GET /privacy/` | HTTP 200. Title "Engage Privacy Policy"; `noindex, nofollow`; entity, ABN, registered party name, contact and address present; no raw Markdown links. |
| `GET /terms/` | HTTP 200. Title "Engage Terms of Use"; `noindex, nofollow`; entity, ABN, registered party name, contact and address present; no raw Markdown links. |
| `GET /member/` | Built server on port 4401: HTTP 200 signed in with a development member cookie and HTTP 200 signed out. Signed-in page title "My Engage"; the acceptance gate is present but hidden because the documents remain owner-authorised. Signed-out legal links render with correct spacing. |
| `GET /api/legal/acceptance` | HTTP 200 on the current dev server with a signed-in development member. Returned `enabled:false`, `accepted:false`, `required:false` with both document versions. |
| `POST /api/legal/acceptance` | HTTP 409 `LEGAL_ACCEPTANCE_NOT_ACTIVE` while the documents remain owner-authorised. This is the intended safety interlock. |
| Acceptance persistence | Memory-DB tests cover version/hash recording, member and timestamp, idempotent repeat submission, incomplete actions, inactive gate and fresh acceptance after a version change. |
| Real MongoDB | Not available in this environment: Docker, `mongod` and `mongosh` are absent. The existing real-MongoDB suite remains skipped. Run the real-MongoDB acceptance persistence test in CI or on the staging host before activation. |
| Direct API enforcement | **Not yet verified** because the participation API patch in section 10.3 has not been applied. Do not enable the gate until it is applied and tested. |
| Existing account compatibility | The development member cookie continued to access `/member/`; no session was deleted or invalidated. No vote, proposal or comment data was changed. |
| Private information scan | No `memberId`, `ObjectId`, database URI, API key or unapproved email address in the rendered legal pages. The only email present is the approved `contact@fusionparty.org.au`. |
| Entity and approval metadata | Both pages show FUSION POLITICAL PARTY INCORPORATED, ABN 20 845 177 664, "votefusion.org for big ideas" (votefusion.org), the approved contact and the Mansfield correspondence address. Status is "Owner authorised · publication pending" and no effective date is invented. |
| Links | Internal links use `/privacy/` and `/terms/`; external links use HTTPS; the approved contact uses `mailto:`. |
| Browser layout — 390px | Chrome headless/CDP at 390px: legal pages and signed-in member page all have `window.innerWidth === document.documentElement.scrollWidth === 390`; no horizontal overflow. Screenshots inspected. |
| Browser layout — 768px | Chrome headless/CDP at 768px: legal pages and signed-in member page all have `window.innerWidth === document.documentElement.scrollWidth === 768`; no horizontal overflow. Screenshots inspected. |
| Browser layout — 1440px | Chrome headless/CDP at 1440px: legal pages and signed-in member page all have `window.innerWidth === document.documentElement.scrollWidth === 1440`; no horizontal overflow. Screenshots inspected. |
| Table of contents and anchors | Desktop TOC is sticky; mobile TOC is a disclosure. All section IDs are unique and the source tests validate anchor/link safety. |
| Focus states | Global `:focus-visible` outline is retained from the Horizon system. No focus styles were removed. |
| Analytics | No analytics script, event tracking or tracking cookie added. |
| Indexing | Legal pages remain explicitly `noIndex`; no sitemap or robots changes were made. |

---

## 12. Files changed

| File | Purpose |
| --- | --- |
| `src/data/legal-documents.ts` | Final entity, ABN, registered party, contact, address, approval and publication metadata; revised scraping, acceptance, ballot and licence wording |
| `src/components/legal/LegalText.astro` | Safe inline link rendering for legal copy, including mailto links |
| `src/components/legal/LegalDocument.astro` | Legal renderer with the expanded organisation metadata, owner-authorised notice and document-control status |
| `src/components/legal/LegalAcceptanceGate.astro` | Hidden-until-active member acceptance form with separate Terms agreement and Privacy Policy acknowledgement |
| `src/components/legal/BallotPrivacyNotice.astro` | Contextual ballot privacy notice; insertion into the proposal page remains a patch because that file is concurrently owned |
| `src/pages/privacy/index.astro` | `/privacy/` route |
| `src/pages/terms/index.astro` | `/terms/` route |
| `src/pages/api/legal/acceptance.ts` | Signed-in acceptance status and record endpoint; inactive until publication |
| `src/pages/member/index.astro` | Signed-out legal links and signed-in acceptance gate |
| `src/lib/legal-acceptance.ts` | Manifest, hashing, persistence, status, enforcement helper and safety interlock |
| `src/lib/legal-acceptance.test.ts` | Acceptance persistence, versioning, enforcement, inactive-gate and no-tracking tests |
| `src/lib/legal-documents.test.ts` | Entity, contact, approval, link and content tests |
| `docs/engage-legal-privacy-review-2026-11-08.md` | This review record, integration patch and activation checklist |

The concurrent `SiteLayout.astro`, `SiteHeader.astro`, `SiteFooter.astro`, proposal page, `ProposalBallot.tsx` and new settings-component workstreams were not overwritten. The footer already contains legal links. The proposal-page ballot notice and participation API enforcement remain explicit patches for the RC release owner. The member page was edited because it was not concurrently modified at the time; if the RC agent changes it, merge this small import/notice/gate insertion rather than overwriting their work.

No production deployment, production data write, migration, commit, push or merge was performed.

---

## 13. Publication recommendation

**CONDITIONAL GO** for the legal and privacy workstream. The legal pages and acceptance implementation are technically ready, with one deliberately inactive gate. They are not yet operative terms. The conditions are:

1. record formal publication approval and the effective date, if Fusion's rules require a separate approval;
2. complete qualified legal review of the high-priority matters in section 8;
3. apply the participation API enforcement patch in section 10.3;
4. apply the ballot privacy notice insertion in section 10.4;
5. set both documents to `publicationStatus: "published"` with real effective dates;
6. enable `LEGAL_ACCEPTANCE_ENABLED` only after steps 3–5;
7. run the real-MongoDB acceptance persistence test in CI or on staging;
8. confirm existing accounts, sessions and votes remain intact after activation;
9. re-run the active acceptance flow in a browser after publication and activation; the inactive gate was verified but the active form cannot be shown while the documents remain owner-authorised.

Until those conditions are met, keep `noindex, nofollow` and leave the acceptance gate disabled. The documents record owner authorisation but do not claim formal publication approval, completed legal review or an effective date. The final `pnpm check`, `pnpm build` and `pnpm test` runs pass; the only remaining release conditions are the legal/governance and enforcement-patch items above.
