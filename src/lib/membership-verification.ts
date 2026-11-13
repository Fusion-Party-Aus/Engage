import { randomUUID } from "node:crypto";
import { ObjectId, type Db } from "mongodb";
import { applyExternalMembership } from "./branch-participation.ts";
import { recordLifecycle } from "./member-lifecycle.ts";
import { createInAppNotification } from "./notifications.ts";
import { logOperationalEvent } from "./resilience.ts";
import { listMembers, promotePendingVotePreferences } from "./store.ts";
import { sendVerificationNotice } from "./verification-email.ts";
import {
  CRM_APPLICATION,
  CRM_MEMBERSHIP_SOURCE,
  CrmAuthorizationError,
  CrmConfigurationError,
  CrmUnavailableError,
  CrmRequestError,
  createIdentityLink,
  fetchCrmPersonByEmail,
  fetchCrmPersonById,
  findIdentityLink,
  fusionMembershipState,
  isEligibleCrmPerson,
  readUndergroundCrmConfig,
  resolveElectorateBranch,
  touchIdentityLink,
  type CrmPerson,
  type UndergroundCrmConfig,
} from "./underground-crm.ts";

/**
 * Automatic membership verification from Underground CRM.
 *
 * The worker:
 *  - only links an Engage account with a verified email to one unambiguous CRM
 *    person;
 *  - stores a durable CRM person UUID and never depends on the email later;
 *  - verifies the Engage platform membership only when the CRM person has an
 *    active membership of the configured Fusion membership type;
 *  - assigns a geographic branch from the CRM electorate fields using
 *    Engage-owned mapping, without creating or changing CRM data;
 *  - preserves existing verified members, manual branch affiliations, roles,
 *    votes and ballots;
 *  - treats a CRM outage as a retryable operational failure, never as a
 *    verification failure and never as a reason to revoke a membership.
 */

export const VERIFICATION_ATTEMPTS = "membership_verification_attempts";
export const VERIFICATION_REVIEWS = "membership_verification_reviews";
export const VERIFICATION_EVENTS = "membership_verification_events";

export const DEFAULT_BATCH_SIZE = 25;
export const OUTAGE_ALERT_AFTER_ATTEMPTS = 3;
export const DEFAULT_RECONCILE_INTERVAL_MINUTES = 24 * 60;
export const PROCESSING_LEASE_MINUTES = 15;
export const MAXIMUM_BATCH_SIZE = 100;

export type VerificationReviewReason =
  | "unmatched"
  | "ambiguous"
  | "invalid_crm_person"
  | "crm_record_missing"
  | "no_active_membership"
  | "inactive_membership"
  | "suspended_membership"
  | "identity_conflict"
  | "branch_unmapped"
  | "branch_ambiguous"
  | "branch_unavailable"
  | "branch_not_geographic"
  | "branch_conflict"
  | "branch_assignment_failed"
  | "membership_inactive";

export const REVIEW_REASON_LABELS: Record<VerificationReviewReason, string> = {
  unmatched: "No matching CRM person",
  ambiguous: "More than one CRM person matched",
  invalid_crm_person: "CRM record is inactive, deceased or not a person",
  crm_record_missing: "The linked CRM person no longer exists",
  no_active_membership: "No active Fusion membership",
  inactive_membership: "Fusion membership is not active",
  suspended_membership: "Engage membership is suspended",
  identity_conflict: "This account is linked to a different CRM person",
  branch_unmapped: "No electorate mapping for the CRM district",
  branch_ambiguous: "CRM electorate fields map to different branches",
  branch_unavailable: "The mapped branch is not available",
  branch_not_geographic: "The mapped branch is not a state or territory branch",
  branch_conflict: "The existing branch affiliation conflicts with the CRM record",
  branch_assignment_failed: "The geographic branch could not be assigned",
  membership_inactive: "A verified member's CRM membership is no longer active",
};

const REVIEWS_CLEARED_ON_SUCCESS = new Set<VerificationReviewReason>([
  "unmatched",
  "ambiguous",
  "invalid_crm_person",
  "crm_record_missing",
  "no_active_membership",
  "inactive_membership",
]);

export interface VerificationReview {
  reviewId: string;
  memberId: string;
  reason: VerificationReviewReason;
  status: "open" | "resolved";
  details: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt?: Date;
  resolvedBy?: string;
  resolutionNote?: string;
}

interface VerificationAttempt {
  _id: string;
  memberId: string;
  status: "queued" | "processing" | "retrying" | "completed" | "blocked";
  attempts: number;
  outageAttempts: number;
  nextAttemptAt: Date;
  createdAt: Date;
  updatedAt: Date;
  lastOutcome?: string;
  lastErrorCategory?: string;
  source?: string;
  lockedAt?: Date | null;
}

export type VerificationOutcome =
  | {
      kind: "verified";
      memberId: string;
      crmPersonId: string;
      branchId: string | null;
      branchOutcome: string;
    }
  | {
      kind: "already_verified";
      memberId: string;
      crmPersonId: string;
      branchId: string | null;
      branchOutcome: string;
    }
  | {
      kind: "review";
      memberId: string;
      reviewId: string;
      reason: VerificationReviewReason;
    }
  | {
      kind: "retry";
      memberId: string;
      reason: "crm_unavailable";
      nextAttemptAt: Date;
    }
  | {
      kind: "blocked";
      memberId: string;
      reason: "crm_authorization" | "crm_response" | "configuration";
    }
  | {
      kind: "skipped";
      memberId: string;
      reason: "account_missing" | "email_unverified" | "disabled";
    };

export interface VerificationCycleReport {
  processed: number;
  verified: number;
  alreadyVerified: number;
  reviews: number;
  retried: number;
  blocked: number;
  skipped: number;
  backfilled: number;
  reconciled: number;
}

function userIdFor(memberId: string): ObjectId | string {
  return ObjectId.isValid(memberId) ? new ObjectId(memberId) : memberId;
}

async function findUserById(
  db: Db,
  memberId: string,
): Promise<Record<string, any> | null> {
  const candidate = userIdFor(memberId);
  const user = await db.collection("user").findOne({ _id: candidate as any });
  if (user || candidate === memberId) return user;
  return db.collection("user").findOne({ _id: memberId as any });
}

async function recordVerificationEvent(
  db: Db,
  input: {
    memberId: string;
    action: string;
    outcome: string;
    reason?: string;
    crmPersonId?: string;
    branchId?: string;
    actorId?: string;
    metadata?: Record<string, unknown>;
    now: Date;
  },
): Promise<void> {
  await db.collection(VERIFICATION_EVENTS).insertOne({
    eventId: randomUUID(),
    memberId: input.memberId,
    action: input.action,
    outcome: input.outcome,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.crmPersonId ? { crmPersonId: input.crmPersonId } : {}),
    ...(input.branchId ? { branchId: input.branchId } : {}),
    actorId: input.actorId ?? "system:underground-crm",
    ...(input.metadata ? { metadata: input.metadata } : {}),
    createdAt: input.now,
  });
}

async function listAdministratorIds(db: Db): Promise<string[]> {
  const rows = await db
    .collection<{ memberId: string; role: string }>("application_roles")
    .find({ role: "administrator" })
    .toArray();
  return [...new Set(rows.map((row) => String(row.memberId)))];
}

async function notifyAdministrators(
  db: Db,
  input: {
    title: string;
    body: string;
    href: string;
    dedupeKey: string;
    now: Date;
  },
): Promise<void> {
  const adminIds = await listAdministratorIds(db);
  for (const adminId of adminIds) {
    await createInAppNotification(db, {
      memberId: adminId,
      topic: "account_membership",
      title: input.title,
      body: input.body,
      href: input.href,
      dedupeKey: input.dedupeKey,
      now: input.now,
    });
  }
}

async function openReview(
  db: Db,
  input: {
    memberId: string;
    reason: VerificationReviewReason;
    details?: Record<string, unknown>;
    now: Date;
  },
): Promise<VerificationReview> {
  const existing = await db
    .collection<VerificationReview>(VERIFICATION_REVIEWS)
    .findOne({ memberId: input.memberId, reason: input.reason, status: "open" });
  if (existing) return existing;

  const review: VerificationReview = {
    reviewId: randomUUID(),
    memberId: input.memberId,
    reason: input.reason,
    status: "open",
    details: input.details ?? {},
    createdAt: input.now,
    updatedAt: input.now,
  };
  await db.collection<VerificationReview>(VERIFICATION_REVIEWS).insertOne(review);
  await recordVerificationEvent(db, {
    memberId: input.memberId,
    action: "review-opened",
    outcome: "review",
    reason: input.reason,
    metadata: input.details,
    now: input.now,
  });

  const user = await findUserById(db, input.memberId);
  const search = user?.email ? encodeURIComponent(String(user.email)) : "";
  const branchReview = input.reason.startsWith("branch_");
  const membershipChange = input.reason === "membership_inactive";
  const title = branchReview
    ? "Branch affiliation needs review"
    : membershipChange
      ? "Verified member's CRM membership changed"
      : "Membership verification needs review";
  const body = branchReview
    ? `Membership verification succeeded, but the geographic branch needs review: ${REVIEW_REASON_LABELS[input.reason]}.`
    : membershipChange
      ? "A verified member's CRM membership is no longer active. Their Engage status has not been changed."
      : `Automatic membership verification could not complete: ${REVIEW_REASON_LABELS[input.reason]}.`;
  await notifyAdministrators(db, {
    title,
    body,
    href: search ? `/admin/members/?q=${search}` : "/admin/members/",
    dedupeKey: `membership-review:${review.reviewId}`,
    now: input.now,
  });
  return review;
}

export async function resolveOpenVerificationReviews(
  db: Db,
  memberId: string,
  input: {
    actorId: string;
    note: string;
    reasons?: VerificationReviewReason[];
    now?: Date;
  },
): Promise<number> {
  const now = input.now ?? new Date();
  const filter: Record<string, unknown> = { memberId, status: "open" };
  if (input.reasons) filter.reason = { $in: input.reasons };
  const rows = await db
    .collection<VerificationReview>(VERIFICATION_REVIEWS)
    .find(filter)
    .toArray();
  let resolved = 0;
  for (const review of rows) {
    const result = await db
      .collection<VerificationReview>(VERIFICATION_REVIEWS)
      .updateOne(
        { reviewId: review.reviewId, status: "open" },
        {
          $set: {
            status: "resolved",
            resolvedAt: now,
            resolvedBy: input.actorId,
            resolutionNote: input.note,
            updatedAt: now,
          },
        },
      );
    if (result.matchedCount) {
      resolved += 1;
      await recordVerificationEvent(db, {
        memberId,
        action: "review-resolved",
        outcome: "resolved",
        reason: review.reason,
        actorId: input.actorId,
        now,
      });
    }
  }
  return resolved;
}

export async function listOpenVerificationReviews(
  db: Db,
  limit = 25,
): Promise<
  Array<{
    reviewId: string;
    memberId: string;
    name: string;
    email: string;
    reason: VerificationReviewReason;
    reasonLabel: string;
    createdAt: Date;
  }>
> {
  const reviews = await db
    .collection<VerificationReview>(VERIFICATION_REVIEWS)
    .find({ status: "open" })
    .sort({ createdAt: 1 })
    .limit(Math.min(Math.max(1, limit), 100))
    .toArray();
  if (reviews.length === 0) return [];
  const members = await listMembers(db, "");
  const byId = new Map(members.map((member) => [member.memberId, member]));
  return reviews.map((review) => {
    const member = byId.get(review.memberId);
    return {
      reviewId: review.reviewId,
      memberId: review.memberId,
      name: member?.name ?? "",
      email: member?.email ?? "",
      reason: review.reason,
      reasonLabel: REVIEW_REASON_LABELS[review.reason],
      createdAt: review.createdAt,
    };
  });
}

function backoffMinutes(attempts: number): number {
  const steps = [5, 15, 60, 360, 1440];
  return steps[Math.min(Math.max(attempts, 1) - 1, steps.length - 1)]!;
}

export async function enqueueVerificationAttempt(
  db: Db,
  memberId: string,
  options: { source?: string; force?: boolean; now?: Date } = {},
): Promise<boolean> {
  const now = options.now ?? new Date();
  const existing = await db
    .collection<VerificationAttempt>(VERIFICATION_ATTEMPTS)
    .findOne({ _id: memberId });
  if (
    existing &&
    !options.force &&
    ["queued", "processing", "retrying", "completed", "blocked"].includes(
      existing.status,
    )
  ) {
    return false;
  }
  await db.collection<VerificationAttempt>(VERIFICATION_ATTEMPTS).updateOne(
    { _id: memberId } as any,
    {
      $setOnInsert: {
        _id: memberId,
        memberId,
        attempts: 0,
        outageAttempts: 0,
        createdAt: now,
      },
      $set: {
        status: "queued",
        nextAttemptAt: now,
        updatedAt: now,
        ...(options.source ? { source: options.source } : {}),
      },
    },
    { upsert: true },
  );
  return true;
}

/**
 * Queue existing accounts that have no membership document yet. New
 * registrations are queued by the auth hook; this function is for the one-off
 * backfill of accounts created before the integration existed. It is not run on
 * every cron cycle because it scans the user collection.
 */
export async function backfillRegistrationAttempts(
  db: Db,
  options: { limit?: number; now?: Date } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const limit = Math.min(
    Math.max(1, options.limit ?? DEFAULT_BATCH_SIZE * 20),
    MAXIMUM_BATCH_SIZE * 20,
  );
  const users = await db
    .collection<{ _id: unknown; emailVerified?: boolean }>("user")
    .find({ emailVerified: true })
    .limit(limit)
    .toArray();
  let queued = 0;
  for (const user of users) {
    const memberId = String(user._id);
    const membership = await db
      .collection<{ status?: string }>("memberships")
      .findOne({ memberId });
    if (membership && membership.status !== "pending") continue;
    if (
      await enqueueVerificationAttempt(db, memberId, {
        source: "registration-backfill",
        now,
      })
    ) {
      queued += 1;
    }
  }
  return queued;
}

export async function backfillVerificationAttempts(
  db: Db,
  options: { limit?: number; now?: Date } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const limit = Math.min(
    Math.max(1, options.limit ?? DEFAULT_BATCH_SIZE * 4),
    MAXIMUM_BATCH_SIZE * 4,
  );
  const pending = await db
    .collection<{ memberId: string }>("memberships")
    .find({ status: "pending" })
    .limit(limit)
    .toArray();
  let queued = 0;
  for (const membership of pending) {
    if (
      await enqueueVerificationAttempt(db, String(membership.memberId), {
        source: "pending-membership",
        now,
      })
    ) {
      queued += 1;
    }
  }
  return queued;
}

async function recoverStaleAttempts(db: Db, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - PROCESSING_LEASE_MINUTES * 60_000);
  const stale = await db
    .collection<VerificationAttempt>(VERIFICATION_ATTEMPTS)
    .find({ status: "processing", lockedAt: { $lte: cutoff } } as any)
    .toArray();
  for (const attempt of stale) {
    await db.collection<VerificationAttempt>(VERIFICATION_ATTEMPTS).updateOne(
      { _id: attempt._id, status: "processing" } as any,
      {
        $set: {
          status: "retrying",
          nextAttemptAt: now,
          updatedAt: now,
          lastErrorCategory: "worker_lease_expired",
        },
      },
    );
  }
}

async function claimDueAttempts(
  db: Db,
  now: Date,
  limit: number,
): Promise<VerificationAttempt[]> {
  const due = await db
    .collection<VerificationAttempt>(VERIFICATION_ATTEMPTS)
    .find({
      status: { $in: ["queued", "retrying"] },
      nextAttemptAt: { $lte: now },
    } as any)
    .sort({ nextAttemptAt: 1 })
    .limit(limit)
    .toArray();
  const claimed: VerificationAttempt[] = [];
  for (const attempt of due) {
    const result = await db
      .collection<VerificationAttempt>(VERIFICATION_ATTEMPTS)
      .updateOne(
        {
          _id: attempt._id,
          status: attempt.status,
          nextAttemptAt: attempt.nextAttemptAt,
        } as any,
        { $set: { status: "processing", lockedAt: now, updatedAt: now } },
      );
    if (result.matchedCount) {
      claimed.push({ ...attempt, status: "processing", lockedAt: now });
    }
  }
  return claimed;
}

async function completeAttempt(
  db: Db,
  memberId: string,
  outcome: VerificationOutcome,
  now: Date,
): Promise<void> {
  await db.collection<VerificationAttempt>(VERIFICATION_ATTEMPTS).updateOne(
    { _id: memberId } as any,
    {
      $set: {
        status: "completed",
        lastOutcome: outcome.kind,
        updatedAt: now,
        lockedAt: null,
      },
    },
  );
}

async function retryAttempt(
  db: Db,
  env: Record<string, string | undefined>,
  memberId: string,
  now: Date,
): Promise<Date> {
  const attempt = await db
    .collection<VerificationAttempt>(VERIFICATION_ATTEMPTS)
    .findOne({ _id: memberId });
  const attempts = Number(attempt?.attempts ?? 0) + 1;
  const outageAttempts = Number(attempt?.outageAttempts ?? 0) + 1;
  const nextAttemptAt = new Date(
    now.getTime() + backoffMinutes(attempts) * 60_000,
  );
  await db.collection<VerificationAttempt>(VERIFICATION_ATTEMPTS).updateOne(
    { _id: memberId } as any,
    {
      $set: {
        status: "retrying",
        attempts,
        outageAttempts,
        nextAttemptAt,
        lastErrorCategory: "crm_unavailable",
        updatedAt: now,
        lockedAt: null,
      },
    },
  );
  const configuredThreshold = Number(
    env.ENGAGE_CRM_OUTAGE_ALERT_AFTER_ATTEMPTS ?? OUTAGE_ALERT_AFTER_ATTEMPTS,
  );
  const threshold =
    Number.isFinite(configuredThreshold) && configuredThreshold >= 1
      ? configuredThreshold
      : OUTAGE_ALERT_AFTER_ATTEMPTS;
  if (outageAttempts >= threshold) {
    const day = now.toISOString().slice(0, 10);
    await notifyAdministrators(db, {
      title: "CRM membership checks delayed",
      body: "Underground CRM is unavailable. Existing membership statuses are unchanged and verification will retry automatically.",
      href: "/admin/members/",
      dedupeKey: `crm-outage:${day}`,
      now,
    });
    await recordVerificationEvent(db, {
      memberId,
      action: "outage-alert",
      outcome: "retrying",
      reason: "crm_unavailable",
      now,
    });
  }
  await recordVerificationEvent(db, {
    memberId,
    action: "retry-scheduled",
    outcome: "retrying",
    reason: "crm_unavailable",
    now,
  });
  return nextAttemptAt;
}

async function blockAttempt(
  db: Db,
  memberId: string,
  reason: "crm_authorization" | "crm_response" | "configuration",
  now: Date,
): Promise<void> {
  await db.collection<VerificationAttempt>(VERIFICATION_ATTEMPTS).updateOne(
    { _id: memberId } as any,
    {
      $set: {
        status: "blocked",
        lastErrorCategory: reason,
        updatedAt: now,
        lockedAt: null,
      },
    },
  );
  await recordVerificationEvent(db, {
    memberId,
    action: "blocked",
    outcome: "blocked",
    reason,
    now,
  });
}

async function markMembershipVerified(
  db: Db,
  memberId: string,
  person: CrmPerson,
  now: Date,
): Promise<"verified" | "already" | "conflict"> {
  const memberships = db.collection("memberships");
  const existing = await memberships.findOne({ memberId });
  if (existing?.status === "suspended") return "conflict";
  if (existing?.status === "verified") return "already";

  const fields = {
    status: "verified",
    verifiedAt: now,
    verifiedBy: "system:underground-crm",
    verificationSource: CRM_MEMBERSHIP_SOURCE,
    externalPersonId: person.id,
    updatedAt: now,
    updatedBy: "system:underground-crm",
  };

  if (existing) {
    const result = await memberships.updateOne(
      { memberId, status: existing.status },
      { $set: fields },
    );
    if (result.matchedCount) return "verified";
    const refreshed = await memberships.findOne({ memberId });
    if (refreshed?.status === "verified") return "already";
    if (refreshed?.status === "suspended") return "conflict";
    return "conflict";
  }

  try {
    await memberships.insertOne({ memberId, ...fields });
    return "verified";
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    const refreshed = await memberships.findOne({ memberId });
    if (refreshed?.status === "verified") return "already";
    if (refreshed?.status === "suspended") return "conflict";
    return "conflict";
  }
}

interface PersonResolution {
  kind: "person";
  person: CrmPerson;
  linkedNow: boolean;
}

interface PersonResolutionFailure {
  kind: "review" | "retry" | "blocked";
  reason: VerificationReviewReason | "crm_unavailable" | "crm_authorization" | "crm_response";
}

async function resolveCrmPerson(
  db: Db,
  config: UndergroundCrmConfig,
  member: Record<string, any>,
  memberId: string,
  now: Date,
  fetchImpl: typeof fetch,
): Promise<PersonResolution | PersonResolutionFailure> {
  const link = await findIdentityLink(db, memberId);
  if (link) {
    const person = await fetchCrmPersonById(config, link.crmPersonId, fetchImpl);
    if (!person) {
      await touchIdentityLink(db, memberId, {
        now,
        outcome: "crm_record_missing",
        nextCheckAt: new Date(now.getTime() + 24 * 60 * 60_000),
      });
      return { kind: "review", reason: "crm_record_missing" };
    }
    if (!isEligibleCrmPerson(person)) {
      await touchIdentityLink(db, memberId, {
        now,
        outcome: "invalid_crm_person",
        nextCheckAt: new Date(now.getTime() + 24 * 60 * 60_000),
      });
      return { kind: "review", reason: "invalid_crm_person" };
    }
    await touchIdentityLink(db, memberId, {
      now,
      outcome: "resolved",
      crmUpdatedAt: person.updated_at,
    });
    return { kind: "person", person, linkedNow: false };
  }

  const email = String(member.email ?? "").trim().toLowerCase();
  const matches = await fetchCrmPersonByEmail(config, email, fetchImpl);
  if (matches.length === 0) {
    return { kind: "review", reason: "unmatched" };
  }
  if (matches.length > 1) {
    return { kind: "review", reason: "ambiguous" };
  }
  const person = matches[0]!;
  if (!isEligibleCrmPerson(person)) {
    return { kind: "review", reason: "invalid_crm_person" };
  }
  const stored = await createIdentityLink(db, { memberId, person, now });
  if (stored.crmPersonId !== person.id) {
    await touchIdentityLink(db, memberId, {
      now,
      outcome: "identity_conflict",
      nextCheckAt: new Date(now.getTime() + 24 * 60 * 60_000),
    });
    return { kind: "review", reason: "identity_conflict" };
  }
  await recordVerificationEvent(db, {
    memberId,
    action: "identity-linked",
    outcome: "linked",
    crmPersonId: person.id,
    now,
  });
  return { kind: "person", person, linkedNow: true };
}

async function assignGeographicBranch(
  db: Db,
  config: UndergroundCrmConfig,
  memberId: string,
  person: CrmPerson,
  now: Date,
): Promise<{ branchId: string | null; outcome: string }> {
  const resolution = resolveElectorateBranch(config, person);
  if (resolution.reason !== "resolved" || !resolution.branchId) {
    const reason: VerificationReviewReason =
      resolution.reason === "ambiguous" ? "branch_ambiguous" : "branch_unmapped";
    await openReview(db, {
      memberId,
      reason,
      details: { candidates: resolution.candidates },
      now,
    });
    return { branchId: null, outcome: reason };
  }

  const branch = await db
    .collection("branches")
    .findOne({ branchId: resolution.branchId, recognised: true });
  if (!branch) {
    await openReview(db, {
      memberId,
      reason: "branch_unavailable",
      details: { branchId: resolution.branchId },
      now,
    });
    return { branchId: null, outcome: "branch_unavailable" };
  }
  if (!["state", "territory"].includes(String(branch.kind))) {
    await openReview(db, {
      memberId,
      reason: "branch_not_geographic",
      details: { branchId: resolution.branchId, kind: String(branch.kind) },
      now,
    });
    return { branchId: null, outcome: "branch_not_geographic" };
  }

  const geographicBranches = await db
    .collection("branches")
    .find({ kind: { $in: ["state", "territory"] } })
    .project({ branchId: 1 })
    .toArray();
  const geographicBranchIds = new Set(
    geographicBranches.map((b: any) => String(b.branchId)),
  );
  const allExisting = await db
    .collection("branch_memberships")
    .find({ memberId, status: "active" })
    .toArray();
  const existing = allExisting.filter((row: any) => {
    const id = String(row.branchId);
    if (geographicBranchIds.size > 0) return geographicBranchIds.has(id);
    return id !== "branch-nat" && id !== "nat";
  });
  if (existing.length === 0) {
    try {
      await applyExternalMembership(db, {
        memberId,
        branchId: resolution.branchId,
        status: "active",
        externalId: person.id,
        verifiedAt: now,
        reason: "Geographic branch assigned from Underground CRM electorate.",
      });
      await recordVerificationEvent(db, {
        memberId,
        action: "branch-assigned",
        outcome: "active",
        branchId: resolution.branchId,
        now,
      });
      return { branchId: resolution.branchId, outcome: "assigned" };
    } catch (error) {
      logOperationalEvent("error", "crm_branch_assignment_failed", {
        branchId: resolution.branchId,
        code: error instanceof Error ? error.name : "unknown",
      });
      await openReview(db, {
        memberId,
        reason: "branch_assignment_failed",
        details: { branchId: resolution.branchId },
        now,
      });
      return { branchId: null, outcome: "branch_assignment_failed" };
    }
  }

  const branchIds = new Set(existing.map((row: any) => String(row.branchId)));
  if (branchIds.size === 1 && branchIds.has(resolution.branchId)) {
    return { branchId: resolution.branchId, outcome: "already-present" };
  }

  // Manual and constituent affiliations are owned by Engage. Never overwrite
  // them; surface the discrepancy for an administrator instead.
  await openReview(db, {
    memberId,
    reason: "branch_conflict",
    details: {
      resolvedBranchId: resolution.branchId,
      existingBranchIds: [...branchIds],
    },
    now,
  });
  return { branchId: null, outcome: "branch_conflict" };
}

export async function verifyMemberFromCrm(
  db: Db,
  env: Record<string, string | undefined>,
  memberId: string,
  options: {
    fetchImpl?: typeof fetch;
    now?: Date;
    sendNotice?: (
      db: Db,
      env: Record<string, string | undefined>,
      memberId: string,
      status: "verified" | "suspended",
    ) => Promise<string>;
  } = {},
): Promise<VerificationOutcome> {
  const now = options.now ?? new Date();
  const fetchImpl = options.fetchImpl ?? fetch;
  const sendNotice = options.sendNotice ?? sendVerificationNotice;
  const config = readUndergroundCrmConfig(env);

  const member = await findUserById(db, memberId);
  if (!member) return { kind: "skipped", memberId, reason: "account_missing" };
  if (member.disabled === true)
    return { kind: "skipped", memberId, reason: "disabled" };
  if (member.emailVerified !== true)
    return { kind: "skipped", memberId, reason: "email_unverified" };

  const membership = await db.collection("memberships").findOne({ memberId });
  if (membership?.status === "suspended") {
    const review = await openReview(db, {
      memberId,
      reason: "suspended_membership",
      now,
    });
    if (await findIdentityLink(db, memberId)) {
      await touchIdentityLink(db, memberId, {
        now,
        outcome: "suspended_membership",
        nextCheckAt: nextReconcileAt(env, now),
      });
    }
    return { kind: "review", memberId, reviewId: review.reviewId, reason: review.reason };
  }

  let resolution: PersonResolution | PersonResolutionFailure;
  try {
    resolution = await resolveCrmPerson(db, config, member, memberId, now, fetchImpl);
  } catch (error) {
    if (error instanceof CrmUnavailableError) {
      return {
        kind: "retry",
        memberId,
        reason: "crm_unavailable",
        nextAttemptAt: new Date(now.getTime() + 5 * 60_000),
      };
    }
    if (error instanceof CrmAuthorizationError) {
      await notifyAdministrators(db, {
        title: "CRM membership checks need configuration",
        body: "Underground CRM rejected the integration credential. No membership statuses were changed.",
        href: "/admin/members/",
        dedupeKey: `crm-config:${now.toISOString().slice(0, 10)}`,
        now,
      });
      return { kind: "blocked", memberId, reason: "crm_authorization" };
    }
    if (error instanceof CrmRequestError) {
      await notifyAdministrators(db, {
        title: "CRM membership checks need attention",
        body: "Underground CRM returned an unexpected response. No membership statuses were changed.",
        href: "/admin/members/",
        dedupeKey: `crm-response:${now.toISOString().slice(0, 10)}`,
        now,
      });
      return { kind: "blocked", memberId, reason: "crm_response" };
    }
    throw error;
  }

  if (resolution.kind !== "person") {
    if (resolution.kind === "review") {
      const review = await openReview(db, {
        memberId,
        reason: resolution.reason as VerificationReviewReason,
        now,
      });
      return {
        kind: "review",
        memberId,
        reviewId: review.reviewId,
        reason: review.reason,
      };
    }
    if (resolution.kind === "retry") {
      return {
        kind: "retry",
        memberId,
        reason: "crm_unavailable",
        nextAttemptAt: new Date(now.getTime() + 5 * 60_000),
      };
    }
    return { kind: "blocked", memberId, reason: "crm_response" };
  }

  const person = resolution.person;
  const membershipState = fusionMembershipState(
    person,
    config.fusionMembershipTypeIds,
  );

  if (membership?.status === "verified") {
    if (membershipState !== "active") {
      const review = await openReview(db, {
        memberId,
        reason: "membership_inactive",
        details: { crmPersonId: person.id, membershipState },
        now,
      });
      await touchIdentityLink(db, memberId, {
        now,
        outcome: "membership_inactive",
        crmUpdatedAt: person.updated_at,
      });
      return {
        kind: "review",
        memberId,
        reviewId: review.reviewId,
        reason: "membership_inactive",
      };
    }
    await resolveOpenVerificationReviews(db, memberId, {
      actorId: "system:underground-crm",
      note: "CRM membership is active again.",
      reasons: ["membership_inactive"],
      now,
    });
    const branch = await assignGeographicBranch(
      db,
      config,
      memberId,
      person,
      now,
    );
    await touchIdentityLink(db, memberId, {
      now,
      outcome: "already_verified",
      crmUpdatedAt: person.updated_at,
      nextCheckAt: nextReconcileAt(env, now),
    });
    return {
      kind: "already_verified",
      memberId,
      crmPersonId: person.id,
      branchId: branch.branchId,
      branchOutcome: branch.outcome,
    };
  }

  if (membershipState !== "active") {
    const reason: VerificationReviewReason =
      membershipState === "missing"
        ? "no_active_membership"
        : "inactive_membership";
    const review = await openReview(db, {
      memberId,
      reason,
      details: { crmPersonId: person.id, membershipState },
      now,
    });
    await touchIdentityLink(db, memberId, {
      now,
      outcome: reason,
      crmUpdatedAt: person.updated_at,
      nextCheckAt: nextReconcileAt(env, now),
    });
    return { kind: "review", memberId, reviewId: review.reviewId, reason };
  }

  const status = await markMembershipVerified(db, memberId, person, now);
  if (status === "conflict") {
    const review = await openReview(db, {
      memberId,
      reason: "suspended_membership",
      now,
    });
    return { kind: "review", memberId, reviewId: review.reviewId, reason: review.reason };
  }

  if (status === "verified") {
    await recordLifecycle(db, memberId, "verification_approved", now);
    try {
      await promotePendingVotePreferences(db, memberId);
    } catch (error) {
      logOperationalEvent("error", "crm_vote_promotion_failed", {
        code: error instanceof Error ? error.name : "unknown",
      });
    }
    try {
      await sendNotice(db, env, memberId, "verified");
    } catch (error) {
      logOperationalEvent("error", "crm_verification_notice_failed", {
        code: error instanceof Error ? error.name : "unknown",
      });
    }
    await resolveOpenVerificationReviews(db, memberId, {
      actorId: "system:underground-crm",
      note: "Automatic CRM verification succeeded.",
      reasons: [...REVIEWS_CLEARED_ON_SUCCESS],
      now,
    });
  }

  await recordVerificationEvent(db, {
    memberId,
    action: "membership-verified",
    outcome: status,
    crmPersonId: person.id,
    now,
  });

  const branch = await assignGeographicBranch(db, config, memberId, person, now);
  await touchIdentityLink(db, memberId, {
    now,
    outcome: "verified",
    crmUpdatedAt: person.updated_at,
    nextCheckAt: nextReconcileAt(env, now),
  });
  return {
    kind: status === "already" ? "already_verified" : "verified",
    memberId,
    crmPersonId: person.id,
    branchId: branch.branchId,
    branchOutcome: branch.outcome,
  };
}

function nextReconcileAt(
  env: Record<string, string | undefined>,
  now: Date,
): Date {
  const raw = Number(
    env.ENGAGE_CRM_RECONCILE_INTERVAL_MINUTES ??
      DEFAULT_RECONCILE_INTERVAL_MINUTES,
  );
  const minutes = Number.isFinite(raw) && raw >= 15 ? raw : DEFAULT_RECONCILE_INTERVAL_MINUTES;
  return new Date(now.getTime() + minutes * 60_000);
}

function verificationBatchSize(env: Record<string, string | undefined>): number {
  const raw = Number(env.ENGAGE_CRM_VERIFICATION_BATCH_SIZE ?? DEFAULT_BATCH_SIZE);
  return Number.isInteger(raw) && raw >= 1
    ? Math.min(raw, MAXIMUM_BATCH_SIZE)
    : DEFAULT_BATCH_SIZE;
}

async function processAttempt(
  db: Db,
  env: Record<string, string | undefined>,
  attempt: VerificationAttempt,
  options: {
    fetchImpl?: typeof fetch;
    now: Date;
    sendNotice?: (
      db: Db,
      env: Record<string, string | undefined>,
      memberId: string,
      status: "verified" | "suspended",
    ) => Promise<string>;
  },
): Promise<VerificationOutcome> {
  let outcome: VerificationOutcome;
  try {
    outcome = await verifyMemberFromCrm(db, env, attempt.memberId, {
      fetchImpl: options.fetchImpl,
      now: options.now,
      sendNotice: options.sendNotice,
    });
  } catch (error) {
    if (error instanceof CrmConfigurationError) {
      await notifyAdministrators(db, {
        title: "CRM membership checks need configuration",
        body: "Automatic CRM membership verification is not configured correctly. No membership statuses were changed.",
        href: "/admin/members/",
        dedupeKey: `crm-config:${options.now.toISOString().slice(0, 10)}`,
        now: options.now,
      });
      await blockAttempt(db, attempt.memberId, "configuration", options.now);
      return {
        kind: "blocked",
        memberId: attempt.memberId,
        reason: "configuration",
      };
    }
    throw error;
  }
  if (outcome.kind === "retry") {
    await retryAttempt(db, env, attempt.memberId, options.now);
  } else if (outcome.kind === "blocked") {
    await blockAttempt(db, attempt.memberId, outcome.reason, options.now);
  } else {
    await completeAttempt(db, attempt.memberId, outcome, options.now);
  }
  return outcome;
}

export async function processDueVerificationAttempts(
  db: Db,
  env: Record<string, string | undefined>,
  options: {
    fetchImpl?: typeof fetch;
    now?: Date;
    limit?: number;
    sendNotice?: (
      db: Db,
      env: Record<string, string | undefined>,
      memberId: string,
      status: "verified" | "suspended",
    ) => Promise<string>;
  } = {},
): Promise<VerificationCycleReport> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? verificationBatchSize(env);
  // Validate the contract before queueing or claiming work.
  readUndergroundCrmConfig(env);
  const report: VerificationCycleReport = {
    processed: 0,
    verified: 0,
    alreadyVerified: 0,
    reviews: 0,
    retried: 0,
    blocked: 0,
    skipped: 0,
    backfilled: await backfillVerificationAttempts(db, { now }),
    reconciled: 0,
  };
  await recoverStaleAttempts(db, now);
  const attempts = await claimDueAttempts(db, now, limit);
  for (const attempt of attempts) {
    const outcome = await processAttempt(db, env, attempt, {
      fetchImpl: options.fetchImpl,
      now,
      sendNotice: options.sendNotice,
    });
    report.processed += 1;
    if (outcome.kind === "verified") report.verified += 1;
    else if (outcome.kind === "already_verified") report.alreadyVerified += 1;
    else if (outcome.kind === "review") report.reviews += 1;
    else if (outcome.kind === "retry") report.retried += 1;
    else if (outcome.kind === "blocked") report.blocked += 1;
    else report.skipped += 1;
  }
  return report;
}

export async function reconcileLinkedMembers(
  db: Db,
  env: Record<string, string | undefined>,
  options: {
    fetchImpl?: typeof fetch;
    now?: Date;
    limit?: number;
    sendNotice?: (
      db: Db,
      env: Record<string, string | undefined>,
      memberId: string,
      status: "verified" | "suspended",
    ) => Promise<string>;
  } = {},
): Promise<{ checked: number; verified: number; reviews: number; retried: number }> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? verificationBatchSize(env);
  const links = await db
    .collection("crm_identity_links")
    .find({
      application: CRM_APPLICATION,
      status: "active",
      $or: [
        { nextCheckAt: null },
        { nextCheckAt: { $lte: now } },
        { nextCheckAt: { $exists: false } },
      ],
    } as any)
    .sort({ nextCheckAt: 1 })
    .limit(limit)
    .toArray();
  let verified = 0;
  let reviews = 0;
  let retried = 0;
  for (const link of links) {
    const outcome = await verifyMemberFromCrm(db, env, String(link.memberId), {
      fetchImpl: options.fetchImpl,
      now,
      sendNotice: options.sendNotice,
    });
    if (outcome.kind === "verified" || outcome.kind === "already_verified") {
      verified += 1;
    } else if (outcome.kind === "review") {
      reviews += 1;
    } else if (outcome.kind === "retry") {
      retried += 1;
      await touchIdentityLink(db, String(link.memberId), {
        now,
        outcome: "crm_unavailable",
        nextCheckAt: new Date(now.getTime() + 60 * 60_000),
      });
    } else if (outcome.kind === "blocked") {
      retried += 1;
      await touchIdentityLink(db, String(link.memberId), {
        now,
        outcome: "blocked",
        nextCheckAt: new Date(now.getTime() + 60 * 60_000),
      });
    } else if (outcome.kind === "skipped") {
      await touchIdentityLink(db, String(link.memberId), {
        now,
        outcome: "skipped",
        nextCheckAt: nextReconcileAt(env, now),
      });
    }
  }
  return { checked: links.length, verified, reviews, retried };
}

export async function runVerificationCycle(
  db: Db,
  env: Record<string, string | undefined>,
  options: {
    fetchImpl?: typeof fetch;
    now?: Date;
    limit?: number;
    sendNotice?: (
      db: Db,
      env: Record<string, string | undefined>,
      memberId: string,
      status: "verified" | "suspended",
    ) => Promise<string>;
  } = {},
): Promise<VerificationCycleReport & { reconciledChecked: number }> {
  const now = options.now ?? new Date();
  const attempts = await processDueVerificationAttempts(db, env, {
    ...options,
    now,
  });
  const reconcile = await reconcileLinkedMembers(db, env, {
    ...options,
    now,
  });
  return {
    ...attempts,
    reconciled: reconcile.checked,
    reconciledChecked: reconcile.checked,
    verified: attempts.verified + reconcile.verified,
    reviews: attempts.reviews + reconcile.reviews,
    retried: attempts.retried + reconcile.retried,
  };
}
