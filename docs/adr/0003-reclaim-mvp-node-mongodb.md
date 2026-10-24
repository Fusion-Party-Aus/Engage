# ADR 0003: Reclaim MVP on Astro Node, Docker and MongoDB

## Status

Accepted for M1 by the MVP prefactor brief, 2026-10-24. Supersedes the Astro/Workers/D1 architecture referenced as ADR 0002 (`docs/adr/0002-astro-workers-d1.md`) in [EPIC #1's accepted-decision comment](https://github.com/Fusion-Party-Aus/Engage/issues/1#issuecomment-6127974214).

That comment also references ADR 0001 (`0001-reclaim-policy-ratification-in-engage.md`). Neither file is present in current main (`3374cc2`) or its locally available history. This record follows their documented `docs/adr/NNNN-name.md` naming convention, preserves the issue comment as historical evidence, and does not recreate or rewrite missing ADR contents. The decision to make Reclaim the first review programme remains in force. The accepted [#2](https://github.com/Fusion-Party-Aus/Engage/issues/2#issuecomment-6127974312) and [#6](https://github.com/Fusion-Party-Aus/Engage/issues/6#issuecomment-6127974236) commitments to member-only deliberation, separate editors/wording reviewers/Election Officers and officer-restricted identifiable ballots are not superseded. Current implementation gaps remain M1 blockers.

## Context

Engage already implements Reclaim's catalogue, layered policy presentation, provenance, member consultation, immutable settled revisions and individual asynchronous ballots. Replacing the existing application with Workers/D1 would add migration work without unblocking the AGM review. M1 needs trustworthy participation and operations; national tenancy and integrations are M2.

## Decision

- Keep Astro server rendering with the Node adapter, deployed in Docker behind an HTTPS reverse proxy.
- Keep MongoDB and its existing collections and identifiers. Use a **single-node MongoDB 8 replica set** for atomic vote admission; no new database layer or service.
- Keep Better Auth with Google OAuth. Better Auth owns account/session identity; `membership.ts` owns manual verification against authoritative Fusion membership records; application roles and server-side handlers own authorisation. Login alone never grants participation or voting authority.
- Keep Horizon's existing visual identity and Reclaim's content and four-layer presentation. Engage is the product; Reclaim is its first programme. Retain historical database/volume/cookie names where renaming could disrupt data or sessions.
- Defer Underground authentication/eligibility, Signal, Sanity, tenancy and additional voting methods to M2. Introduce no Firebase, D1, alternate auth stack or generic workflow/integration engine.

## Vote admission and deployment consequences

The previous Compose deployment was standalone MongoDB. Standalone servers cannot run multi-document transactions. A transaction is the smallest reliable way to retain separate ballot and vote records while ordering admission against closure; application locks/leases would add crash recovery and cross-worker coordination.

A vote transaction conditionally writes the current open ballot using MongoDB's clock (`opensAt <= $$NOW < closesAt`), records that same database admission instant and a fresh admission ID (ensuring a real write even for simultaneous revotes), then upserts the member's current selection and writes a choice-free audit event. Closure writes the same ballot through a transaction. The shared ballot write serializes the two operations. If closure wins, admission fails; if admission wins, closure waits for commit or rollback and then tallies it. Driver retries recheck the current ballot and database time. A request received before cutoff has no reserved right to vote: its **database admission instant** must precede cutoff. A response can arrive later. An admitted transaction holds closure until its selection commits or aborts.

After closure, admission cannot change the votes. The existing conditional authoritative result and retryable/idempotent publication and audit effects remain. Earlier valid votes survive membership suspension. The two-choice strict-majority calculation is preserved as existing behaviour; governance approval is still required before binding use.

The preview fake serializes these same callbacks and rolls failed writes back; it is not evidence of MongoDB correctness. CI runs the concurrency tests on a real replica set. A real standalone server fails closed rather than using an unsafe voting fallback.

Compose retains the existing volume and scoped database user, adds a persistent internal replica key, and initialises a single voting primary. Use `directConnection=true` when accessing its published local port; the replica advertises `mongo:27017` inside Compose. This adds transaction capability, **not high availability**. Host/disk recovery still requires encrypted off-host backups. Production remains a separate database with separate credentials and no preview identities.

Before upgrading an existing volume: back it up, stop the old application, start the replica-enabled MongoDB, verify primary status and a transaction with the scoped application user, and rehearse application/container restart and recovery. Do not roll back to a writer that lacks admission transactions after accepting real votes. No production deployment or binding activation is authorised by this ADR.

## Sources

- [MongoDB atomicity](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/): multi-document writes require transactions for atomicity.
- [Transaction write conflicts](https://www.mongodb.com/docs/manual/core/transactions-production-consideration/): a common document write prevents stale concurrent admission.
- [Node driver transactions](https://www.mongodb.com/docs/drivers/node/v6.x/crud/transactions/): session propagation, automatic retries and sequential operations within a transaction.
- [Official Mongo image entrypoint](https://github.com/docker-library/mongo/blob/master/docker-entrypoint.sh): initial user creation runs on a temporary standalone server; replica initialisation must follow it.
