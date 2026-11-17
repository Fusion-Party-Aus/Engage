import {
  type Db,
  type Document,
  type IndexDescription,
} from "mongodb";
import { ensureBallotTallyIndexes } from "./ballot-tallies.ts";
import { ensureBallotResultsIndexes } from "./ballot-results-index-migration.ts";
import { ensureJobRunIndexes } from "./job-runs.ts";
import {
  OPERATIONAL_SETTINGS_COLLECTION,
  OPERATIONAL_SETTINGS_EVENTS_COLLECTION,
} from "./operational-settings.ts";
import { ensureVoteStorage } from "./vote-storage.ts";

/**
 * The database index catalogue and the schema half of startup.
 *
 * `initializeDatabase` in `db.ts` calls this and then seeds baseline content;
 * tests that govern their own content call `ensureDatabaseIndexes` directly.
 */

/** The index-shape options this file uses; command options are not indexes. */
interface IndexOptions {
  name?: string;
  unique?: boolean;
  partialFilterExpression?: Document;
  expireAfterSeconds?: number;
}

type IndexDefinition = [
  collection: string,
  key: IndexDescription["key"],
  options?: IndexOptions,
];

/**
 * Initialisation sends one `createIndexes` command per collection instead of
 * one command per index. Every command on a fresh collection is a journal
 * commit, so grouping roughly halves the cost; keys, names, uniqueness,
 * partial filters, TTL and `expireAfterSeconds` are passed through unchanged.
 */
const CORE_INDEXES: IndexDefinition[] = [
  ["sense_submissions", { branchId: 1, createdAt: -1 }],
  [
    "rate_limits",
    { expiresAt: 1 },
    { expireAfterSeconds: 0, name: "rate_limit_expiry" },
  ],
];

// Notification, verification and operational-settings indexes.
const SERVICE_INDEXES: IndexDefinition[] = [
  ["engagement_lifecycle_events", { memberId: 1, event: 1, at: 1 }],
  ["engagement_email_preferences", { memberId: 1 }, { unique: true }],
  ["engagement_email_outbox", { providerId: 1 }],
  ["engagement_email_outbox", { memberId: 1, createdAt: -1 }],
  ["engagement_email_events", { providerId: 1 }],
  ["engagement_reengagement_campaigns", { campaignId: 1 }, { unique: true }],
  ["push_subscriptions", { memberId: 1, endpoint: 1 }, { unique: true }],
  ["push_subscriptions", { subscriptionId: 1 }, { unique: true }],
  ["member_notifications", { memberId: 1, createdAt: -1 }],
  ["member_notifications", { notificationId: 1 }, { unique: true }],
  ["notification_deliveries", { dedupeKey: 1 }, { unique: true }],
  // Durable notification outbox (#33). `retainUntil` is a TTL that only
  // terminal rows carry, so unresolved work is never swept away.
  [
    "notification_outbox",
    { dedupeKey: 1 },
    { unique: true, name: "outbox_dedupe_unique" },
  ],
  ["notification_outbox", { status: 1, nextAttemptAt: 1 }, { name: "outbox_due" }],
  ["notification_outbox", { matterId: 1, event: 1 }, { name: "outbox_matter_event" }],
  [
    "notification_outbox",
    { memberId: 1, createdAt: -1 },
    { name: "outbox_member_created" },
  ],
  [
    "notification_outbox",
    { retainUntil: 1 },
    { expireAfterSeconds: 0, name: "outbox_retention" },
  ],
  ["crm_identity_links", { memberId: 1, application: 1 }, { unique: true }],
  ["crm_identity_links", { crmPersonId: 1 }],
  ["crm_identity_links", { application: 1, status: 1, nextCheckAt: 1 }],
  ["membership_verification_attempts", { status: 1, nextAttemptAt: 1 }],
  ["membership_verification_attempts", { status: 1, lockedAt: 1 }],
  ["membership_verification_reviews", { reviewId: 1 }, { unique: true }],
  ["membership_verification_reviews", { memberId: 1, status: 1 }],
  ["membership_verification_reviews", { status: 1, createdAt: 1 }],
  ["membership_verification_events", { eventId: 1 }, { unique: true }],
  ["membership_verification_events", { memberId: 1, createdAt: -1 }],
  // Operational settings are administrator-owned documents (#128): health
  // thresholds, CRM verification tuning and the scheduled-job gates. The event
  // index backs the "last changed" line on the settings page.
  [
    OPERATIONAL_SETTINGS_EVENTS_COLLECTION,
    { eventId: 1 },
    { unique: true },
  ],
  [OPERATIONAL_SETTINGS_EVENTS_COLLECTION, { createdAt: -1 }],
  [OPERATIONAL_SETTINGS_COLLECTION, { updatedAt: -1 }],
  // Public collaboration matters (#143). Contributions are private until an
  // explicit approval; media bytes live in their own collection so a list read
  // can never select them by accident.
  [
    "collaboration_initiatives",
    { slug: 1 },
    { unique: true, name: "collaboration_slug_unique" },
  ],
  [
    "collaboration_contributions",
    { contributionId: 1 },
    { unique: true, name: "collaboration_contribution_unique" },
  ],
  [
    "collaboration_contributions",
    { status: 1, createdAt: -1 },
    { name: "collaboration_status" },
  ],
  [
    "collaboration_media",
    { mediaId: 1 },
    { unique: true, name: "collaboration_media_unique" },
  ],
  ["collaboration_media", { contributionId: 1 }],
  [
    "collaboration_events",
    { eventId: 1 },
    { unique: true, name: "collaboration_event_unique" },
  ],
  ["collaboration_events", { contributionId: 1, at: -1 }],
  // Aggregate funnel counts (#143). One row per invitation, day and stage.
  [
    "collaboration_funnel",
    { initiativeSlug: 1, day: 1, stage: 1 },
    { unique: true, name: "collaboration_funnel_bucket" },
  ],
  [
    "collaboration_funnel",
    { expiresAt: 1 },
    { expireAfterSeconds: 0, name: "collaboration_funnel_retention" },
  ],
];

// Matter, discussion, governance, branch and membership indexes.
const CONTENT_INDEXES: IndexDefinition[] = [
  ["proposals", { proposalId: 1 }, { unique: true }],
  ["proposals", { slug: 1 }, { unique: true }],
  ["proposals", { stage: 1, space: 1 }],
  ["comments", { commentId: 1 }, { unique: true }],
  ["comments", { proposalId: 1, createdAt: 1 }],
  ["comments", { proposalId: 1, parentCommentId: 1, createdAt: 1 }],
  ["comments", { memberId: 1, createdAt: 1 }],
  // Public profile history (#113): visible, non-deleted comments per member.
  ["comments", { memberId: 1, deletedAt: 1, createdAt: -1 }],
  ["proposal_votes", { proposalId: 1, updatedAt: -1 }],
  ["proposal_votes", { memberId: 1, updatedAt: 1 }],
  ["proposals", { authorId: 1, createdAt: 1 }],
  ["ballots", { ballotId: 1 }, { unique: true }],
  ["ballots", { matterId: 1, status: 1 }],
  // One immutable quorum closure record per ballot.
  [
    "ballot_quorum_records",
    { ballotId: 1 },
    { unique: true, name: "ballot_quorum_ballot_unique" },
  ],
  ["ballot_quorum_records", { matterId: 1, closedAt: -1 }],
  ["governance_events", { eventId: 1 }, { unique: true }],
  ["governance_events", { matterId: 1, createdAt: -1 }],
  ["governance_relationships", { sourceMatterId: 1, relationshipType: 1 }],
  ["governance_relationships", { targetMatterId: 1, relationshipType: 1 }],
  ["memberships", { memberId: 1 }, { unique: true, name: "membership_member_unique" }],
  ["memberships", { status: 1 }],
  [
    "application_roles",
    { memberId: 1, role: 1 },
    { unique: true, name: "member_role_unique" },
  ],
  ["branches", { branchId: 1 }, { unique: true }],
  ["proposal_revisions", { revisionId: 1 }, { unique: true }],
  ["proposal_revisions", { proposalId: 1, createdAt: 1 }],
  ["policy_registry", { policyId: 1 }, { unique: true }],
  ["policy_revisions", { revisionId: 1 }, { unique: true }],
  ["policy_revisions", { policyId: 1, createdAt: 1 }],
  ["policy_import_runs", { runId: 1 }, { unique: true }],
  ["publication_events", { eventId: 1 }, { unique: true }],
  ["ballot_binding_events", { eventId: 1 }, { unique: true }],
  ["amendments", { amendmentId: 1 }, { unique: true }],
  ["amendments", { proposalId: 1, status: 1, createdAt: 1 }],
  // Public profile history (#113): amendments authored by one member.
  ["amendments", { authorId: 1, createdAt: -1 }],
  ["amendment_revisions", { revisionId: 1 }, { unique: true }],
  ["amendment_revisions", { amendmentId: 1, createdAt: 1 }],
  ["branch_memberships", { branchId: 1, memberId: 1 }, { unique: true }],
  ["branch_memberships", { memberId: 1, status: 1, branchRole: 1, branchId: 1 }],
  ["branch_memberships", { branchId: 1, status: 1 }],
  ["branch_memberships", { source: 1, branchId: 1 }],
  [
    "branch_subscriptions",
    { memberId: 1, branchId: 1 },
    { unique: true, name: "branch_subscription_member_unique" },
  ],
  ["branch_subscriptions", { branchId: 1, status: 1 }],
  ["branch_subscriptions", { memberId: 1, status: 1 }],
  ["branch_subscription_events", { eventId: 1 }, { unique: true }],
  ["branch_subscription_events", { memberId: 1, createdAt: -1 }],
  ["branch_membership_events", { eventId: 1 }, { unique: true }],
  ["branch_membership_events", { branchId: 1, memberId: 1, createdAt: 1 }],
  ["branch_events", { eventId: 1 }, { unique: true }],
  ["branch_events", { branchId: 1, createdAt: 1 }],
  ["branch_referrals", { proposalId: 1, targetBranchId: 1 }, { unique: true }],
  ["branch_referrals", { referralId: 1 }, { unique: true }],
  ["site_settings_events", { eventId: 1 }, { unique: true }],
  ["site_settings_events", { createdAt: -1 }],
  [
    "data_migrations",
    { migrationId: 1 },
    { unique: true, name: "data_migration_unique" },
  ],
];

/**
 * Create the indexes in one command per collection. Some content indexes were
 * always best-effort: a pre-existing index with conflicting options must not
 * stop startup. A grouped command has no per-index tolerance, so a failed group
 * is retried one index at a time to restore the previous tolerance.
 */
async function applyIndexes(
  db: Db,
  definitions: IndexDefinition[],
  { tolerateFailures = false }: { tolerateFailures?: boolean } = {},
): Promise<void> {
  const grouped = new Map<string, IndexDefinition[]>();
  for (const definition of definitions) {
    const group = grouped.get(definition[0]) ?? [];
    group.push(definition);
    grouped.set(definition[0], group);
  }
  await Promise.all(
    [...grouped].map(async ([collection, group]) => {
      try {
        await db
          .collection(collection)
          .createIndexes(
            group.map(([, key, options]) => ({ key, ...options })),
          );
      } catch (error) {
        if (!tolerateFailures) throw error;
        await Promise.all(
          group.map(([, key, options]) =>
            db
              .collection(collection)
              .createIndex(key, options)
              .catch(() => {}),
          ),
        );
      }
    }),
  );
}

/**
 * Schema half of initialisation: the job-run ledger, index definitions and the
 * reviewed index migrations. Idempotent, and the only half a test needs when it
 * governs its own content.
 */
export async function ensureDatabaseIndexes(db: Db): Promise<void> {
  await ensureJobRunIndexes(db);
  await applyIndexes(db, CORE_INDEXES);
  await applyIndexes(db, SERVICE_INDEXES);
  await ensureVoteStorage(db);
  await ensureBallotTallyIndexes(db);
  await Promise.all([
    applyIndexes(db, CONTENT_INDEXES, { tolerateFailures: true }),
    // The ballot_results index shape is migrated explicitly, never as a
    // silent startup side effect (#55). See ballot-results-index-migration.ts.
    ensureBallotResultsIndexes(db),
  ]);
}
