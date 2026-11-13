# Member branch choices

Verified Fusion members receive a National membership on authenticated access after the National branch has been seeded through admin migrations. Pending accounts do not receive membership.

My Engage → My branches provides independent membership and following controls. A member can hold one state/territory membership based on their residence declaration and one constituent membership. Joining replaces the active membership in that group. Leaving is allowed; National remains included. Membership changes affect subsequent eligibility checks; stored ballots are not rewritten. These operations never grant administrator roles.

Sense Box is available from primary navigation, the footer and My Engage. It accepts concerns without authentication or membership.

Self-service switches use a database lock per member to prevent overlapping changes across server instances. If a process terminates during a switch, the lock intentionally fails closed. An operator must confirm no request is still running, inspect that member's membership events and records, and remove their `branch_membership_locks` record before retrying. Retrying a selection repairs a partially completed switch. Never remove a live lock.

Manual admin assignments and external membership synchronisation remain separate operational paths; administrators should follow the same one-per-group rule when maintaining memberships.
