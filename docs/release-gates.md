# Production release gates

## Login and membership participation

Better Auth owns Google OAuth, provider accounts, MongoDB sessions and logout. Its durable user ID is Engage's application identity, also used by comments, amendments, votes and operational audit records. Identity is independent of email and provider subject. Account linking and implicit email linking are disabled. A future supported Underground provider must use authenticated linking or authorised account review before enabling it; never merge users by email. Membership eligibility is a separate boundary in `membership.ts`, currently backed by administrator-maintained MongoDB records. No Underground integration is required for initial use.

Configure production mode, a separate production MongoDB database, BETTER_AUTH_URL (the public HTTPS origin), BETTER_AUTH_SECRET (at least 32 random characters), GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. Register the exact `/api/auth/callback/google` redirect with Google. Confirm live Google callback, returning sign-in, logout and cookie security behind the deployment's HTTPS reverse proxy. Do not reuse the preview database. A configuration check reports configuration only; it does not certify a successful live Google login.

The Better Auth user record is the sole account. Missing membership records mean pending. Authorised administrators check authoritative party records and change pending/verified/suspended status at `/admin/members/`; Engage records the reviewer and timestamp. No extra personal membership details are collected. Bootstrap the first administrator by their **existing Better Auth user ID**, using the operator script; never grant by email or let a browser request assign roles. Assign verification responsibility and confirm the eligibility criteria before verifying real accounts. Opening authentic consultation rounds is an administrator action independent of ballot activation.

## Binding ballots

Login and verified membership do not authorise binding voting. FORMAL_BALLOTS_ENABLED defaults to false. Each ballot also requires a recorded authorisation with approvedBy, approvedAt and evidence for every safeguard, bindingBallotsEnabled=true, and an authentic revision. An administrator can open a draft ballot through `PATCH /api/admin/ballots/{ballotId}` with `status: "open"`, valid opening/closing dates and `authorizationEvidence` containing evidence references for `constitutionalEligibility`, `manualVerification`, `confidentiality`, `accessControls`, `backupRecovery`, and `governanceApproval`. The API records the approver and timestamp; evidence must reflect actual completed reviews, not invented text. There is no production authorisation UI. Keep formal voting disabled until the party has reviewed and recorded:

- Constitutional eligibility criteria, including waiting periods, suspension and relevant dates, and instructions for manual reviewers.
- A deployed MongoDB replica set and verified transaction capability for the scoped app user. Vote admission uses the current ballot and database clock in a transaction with the selection/audit write; closure contends on that ballot. Approve this admission instant as the legal cutoff and rehearse concurrent closure on the target deployment. A request received before the deadline can still be rejected if database admission is late. Standalone MongoDB fails closed. See [ADR 0003](adr/0003-reclaim-mvp-node-mongodb.md).
- Approved majority, tie and zero-vote rules, challenge and appeal procedures, returning-officer duties and governance authority to open each ballot.
- Enforced member-only deliberation reads, separate editor/wording-reviewer/Election Officer duties, and officer-restricted identifiable ballot access as recorded in issues #2/#6. Current public accepted-submission reads and broad moderator/admin roles do not satisfy those commitments. Complete confidentiality review of application/database access and backups. See [M1 blockers](mvp-roadmap.md).
- An encrypted production backup and successful restore rehearsal covering Better Auth users, provider accounts, sessions, membership and all policy/voting collections. Existing preview backup scripts deliberately refuse production use; a production recovery procedure remains a launch blocker.

A flag alone is not evidence. Record evidence and responsible approvers before production ballot activation. Initial ballots remain draft. No deployment or binding activation is performed by this implementation.

## Confidentiality and preview isolation

One current selection is stored per member/ballot; revotes overwrite the choice. Previously valid votes remain counted after membership revocation, while further restricted actions require current verification. Results expose aggregates; participation exposes only the signed-in member's own selection. Operational vote audit omits choices. This is application/database access control, with no claim of cryptographic secrecy.

Synthetic accounts and signed preview cookies are restricted to APP_MODE=preview, use a separate database and cannot enter binding ballots. Google login is restricted to production mode. Preview capability continues to use its isolated fixture identities; it is not a second real-member identity service.
