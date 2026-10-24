# Engage — product scope

Engage is Fusion's layered policy library, transparent provenance review space, and member consultation and voting system. It satisfies the AGM policy review requirements—distinguishing existing approved policies (repackaged for readability) from materially revised proposals, new proposals, draft-derived proposals, and unverified lineage mappings—while supporting continuous policy development after the AGM without a generic workflow engine or separate demo/production voting stacks.

The canonical application repository is `Fusion-Party-Aus/Engage`. Reclaim is its initial 2026 AGM policy review programme. The original `reclaim-platform` repository and `codex/horizon-policy-platform` branch are preserved as historical references; ongoing application work belongs in Engage.

Every policy follows a unified lifecycle:
`Existing policy → proposed wording → provenance/comparison → member review (comments & amendments) → settled immutable revision → individual ballot vote → recorded outcome & adopted wording`.

The initial identity approach is Better Auth with Google OAuth and MongoDB-backed accounts and sessions. Engage administrators manually verify eligibility against authorised Fusion membership records, and server-side checks enforce participation rules. Authentication and membership eligibility remain separate from the policy and voting systems. Underground integration is deferred until coordination with Stewart and Owen; no connector, shared authentication package or Firebase is required. Preview mode (`APP_MODE=preview`) exercises the exact same consultation, revision, and ballot collections and business logic using synthetic identities and explicit environment safeguards so synthetic participation can never become binding.

Alongside individual policy review, the platform preserves the two separate member review questions requested for the Reclaim platform and the Horizon visual identity (including the logo).

Website copy follows the [editorial policy](docs/editorial-policy.md). Page-specific copy belongs in content data; presentation components should render it without owning or duplicating page claims.

Delivery is split into [M1 — Reclaim AGM Policy Review and M2 — Ongoing Engage Platform](docs/mvp-roadmap.md). M2 integrations and branch tenancy are not M1 prerequisites unless an explicit security, correctness or governance dependency requires them. Architecture is recorded in [ADR 0003](docs/adr/0003-reclaim-mvp-node-mongodb.md); existing behaviour is not evidence of governance approval.
