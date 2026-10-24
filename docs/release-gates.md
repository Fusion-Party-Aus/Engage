# Production release gates

## Underground identity and eligibility

The reviewed Underground CRM exposes login sessions, a CRM-password JWT endpoint, and `/api/me/`, but no standards-based external login issuer and no endpoint returning the stable member identifier plus constitutional voting eligibility. Its optional Discord eligibility endpoint is disabled by default and does not establish all relevant eligibility criteria. The platform does not share CRM cookies, collect CRM passwords, scrape member pages, or infer membership from email or an upstream provider identity.

Production identity resolution therefore fails closed. The expected future integration is direct Authorization Code + PKCE login with an already-linked upstream provider and a narrow read-only Underground interface mapping verified issuer/subject to stable CRM person ID and current eligibility. No Underground code, database, or deployment is changed by this repository.

## Governance

The initial 36 ballots remain draft. Before activation, the party must record:

- The constitutional eligibility interpretation applied to policy ballots, including acceptance, waiting period, suspension, and relevant dates.
- The approved simple-majority rule and treatment of ties, invalid ballots, and challenges.
- Who may challenge or invalidate a ballot, the evidence and appeal process, and how exceptional intervention is recorded.
- Returning-officer duties and certification procedure.
- Approval of policy versions and explicit authority to open each binding round.

Certification verifies the result yielded by the predetermined rule; it is not discretionary administrator approval. No preview interface action can activate a binding ballot. No ballot activation or production cutover is included in this branch.

## Security boundary

Preview identities, consultations, votes, and results are synthetic. MongoDB stores one current selection per member/ballot; superseded choices are overwritten, not copied into audit records. Audit records contain operational events and omit vote choices. Application and database roles restrict access to vote records. The ordinary access-control model is confidentiality protection, not a claim of cryptographic ballot secrecy.
