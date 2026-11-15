import { randomUUID } from "node:crypto";
import { ObjectId, type Db } from "mongodb";
import { ballotExpired, ballotDeadlineDateLabel, closesWithinSevenDays } from "./ballot-deadline.ts";
import { getProposalEligibility } from "./branch-participation.ts";
import { LIFECYCLE_SYSTEM_ACTOR } from "./lifecycle-schedule.ts";
import {
  dispatchMemberNotification,
  getMemberNotificationPreferences,
  type NotificationTopic,
} from "./notifications.ts";
import { normalisePlatformRoles, primaryPlatformRole } from "./rbac.ts";
import { logOperationalEvent } from "./resilience.ts";
import { canViewProposal } from "./store.ts";
import type { PlatformEnv, ProposalRecord, SessionUser, UserRole } from "./types.ts";
import { proposalBallotId } from "./vote-storage.ts";
import type { PushSender } from "./web-push.ts";

/**
 * Durable notification outbox for governance lifecycle events (#33, RFC 0001 I9).
 *
 * A lifecycle transition commits first. Notification fan-out is written to
 * `notification_outbox` immediately afterwards, one row per member per event.
 * The scheduler never waits for a send and a notification failure can never
 * fail, block or alter a governance transition.
 *
 * This slice wires exactly two events:
 *
 * - `ballot_opened` — a matter advanced into Decide by the lifecycle scheduler.
 * - `ballot_closing_soon` — an open ballot inside the approved seven-day window.
 *
 * `governance_outcomes` and `contribution_responses` are deliberately not wired
 * here. The result route is being refactored elsewhere and the comment-outcome
 * event needs a product decision. See docs/architecture/notifications-and-jobs.md.
 *
 * Guarantees:
 *
 * - **At-least-once delivery.** A claimed row is retried with bounded backoff
 *   until it is sent or suppressed. In-app creation and push hand-off use the
 *   dispatch dedupe keys, so a retry after an ambiguous failure does not create a
 *   second inbox item or a second push.
 * - **At-least-once enqueue after a crash.** Enqueue is idempotent (one unique
 *   `dedupeKey`), and each scheduler run repairs any scheduler-opened ballot from
 *   the previous 24 hours that has no outbox row. A failed enqueue is logged as
 *   an operational event; it never fails the transition.
 * - **Audience equals the electorate.** The recipient list is produced by the
 *   same `getProposalEligibility` predicate that authorises a vote, plus the same
 *   `canViewProposal` visibility gate. Eligibility is checked again at drain time,
 *   so a member whose membership was revoked in between is suppressed.
 * - **No governance content beyond the link.** Payloads name the matter, link to
 *   the bound ballot page and state the deadline. They never contain a vote
 *   choice, tally, comment or identifiable ballot data.
 */

export const NOTIFICATION_OUTBOX_COLLECTION = "notification_outbox";

/** A claim older than this can be retried by another worker. */
export const OUTBOX_CLAIM_LEASE_MS = 5 * 60_000;

/** Bounded retries. After this many attempts the row is terminal `failed`. */
export const OUTBOX_MAX_ATTEMPTS = 5;

/**
 * Delivery and suppression evidence is retained for two years. Pending and
 * failed rows carry no `retainUntil`, so the TTL never deletes unresolved work.
 */
export const OUTBOX_RETENTION_DAYS = 730;

/** The approved engagement reminder window for `closing_deadlines`. */
export const CLOSING_SOON_WINDOW_DAYS = 7;

export type NotificationOutboxEvent = "ballot_opened" | "ballot_closing_soon";

export type NotificationOutboxStatus = "pending" | "sent" | "failed" | "suppressed";

export interface NotificationOutboxPayload {
  title: string;
  body: string;
  href: string;
  /** Confidential matters use a neutral lock-screen title and body. */
  isConfidential: boolean;
}

export interface NotificationOutboxChannels {
  inApp: "created" | "duplicate";
  push: "sent" | "suppressed" | "unavailable";
}

export interface NotificationOutboxRecord {
  /** Equal to `dedupeKey`, so uniqueness holds on every storage engine. */
  _id: string;
  dedupeKey: string;
  memberId: string;
  topic: NotificationTopic;
  event: NotificationOutboxEvent;
  matterId: string;
  ballotId: string;
  revisionId?: string;
  payload: NotificationOutboxPayload;
  status: NotificationOutboxStatus;
  attempts: number;
  nextAttemptAt: Date;
  claimToken?: string;
  claimExpiresAt?: Date;
  lastClaimedAt?: Date;
  lastAttemptAt?: Date;
  lastError?: string;
  sentAt?: Date;
  suppressedAt?: Date;
  suppressionReason?: string;
  channels?: NotificationOutboxChannels;
  createdAt: Date;
  updatedAt: Date;
  retainUntil?: Date;
}

export interface EnqueueReport {
  event: NotificationOutboxEvent;
  matters: number;
  eligible: number;
  enqueued: number;
  duplicates: number;
  skipped: Array<{ matterId: string; reason: string }>;
  errors: Array<{ matterId?: string; message: string }>;
}

export interface NotificationOutboxDrainReport {
  mode: "dry-run" | "apply";
  now: string;
  /** Rows that were due when the run started. */
  due: number;
  claimed: number;
  sent: number;
  suppressed: number;
  failed: number;
  retried: number;
  exhausted: number;
  remaining: number;
  byEvent: Record<NotificationOutboxEvent, number>;
  errors: Array<{ event?: NotificationOutboxEvent; matterId?: string; message: string }>;
}

const EVENT_TOPICS: Record<NotificationOutboxEvent, NotificationTopic> = {
  ballot_opened: "new_ballots",
  ballot_closing_soon: "closing_deadlines",
};

/** One row per member, ballot and event. A reminder window is the deadline. */
export function ballotOpenedDedupeKey(memberId: string, matterId: string): string {
  return `governance:ballot_opened:${matterId}:${memberId}`;
}

export function closingSoonDedupeKey(
  memberId: string,
  matterId: string,
  ballotClosesAt: Date | string,
): string {
  const deadline = new Date(ballotClosesAt).toISOString();
  return `governance:ballot_closing_soon:${matterId}:${deadline}:${memberId}`;
}

function proposalHref(proposal: Pick<ProposalRecord, "slug">): string {
  return `/proposals/${encodeURIComponent(proposal.slug)}/#proposal-vote`;
}

function isConfidentialMatter(
  proposal: Pick<ProposalRecord, "publicationScope">,
): boolean {
  return proposal.publicationScope === "branch" || proposal.publicationScope === "private";
}

export function buildBallotOpenedPayload(
  proposal: Pick<ProposalRecord, "slug" | "title" | "ballotClosesAt" | "publicationScope">,
): NotificationOutboxPayload {
  const deadline = proposal.ballotClosesAt
    ? ` Voting closes ${ballotDeadlineDateLabel(proposal.ballotClosesAt)}.`
    : "";
  return {
    title: `Ballot open: ${proposal.title}`,
    body: `${deadline.trim()} Open the ballot to read the motion and vote.`.trim(),
    href: proposalHref(proposal),
    isConfidential: isConfidentialMatter(proposal),
  };
}

export function buildClosingSoonPayload(
  proposal: Pick<ProposalRecord, "slug" | "title" | "ballotClosesAt" | "publicationScope">,
): NotificationOutboxPayload {
  const deadline = proposal.ballotClosesAt
    ? ` Voting closes ${ballotDeadlineDateLabel(proposal.ballotClosesAt)}.`
    : " Voting is closing soon.";
  return {
    title: `Closing soon: ${proposal.title}`,
    body: `${deadline.trim()} Vote before the deadline.`.trim(),
    href: proposalHref(proposal),
    isConfidential: isConfidentialMatter(proposal),
  };
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  return null;
}

export function isOpenBallot(
  proposal: Pick<ProposalRecord, "stage" | "ballotClosedAt" | "ballotClosesAt" | "ballotRevisionId">,
  now: Date,
): boolean {
  return (
    proposal.stage === "decide" &&
    Boolean(proposal.ballotRevisionId) &&
    !proposal.ballotClosedAt &&
    !ballotExpired(proposal, now)
  );
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function idCandidates(memberIds: string[]): Array<string | ObjectId> {
  const values: Array<string | ObjectId> = [...memberIds];
  for (const memberId of memberIds) {
    if (ObjectId.isValid(memberId) && memberId.length === 24) {
      values.push(new ObjectId(memberId));
    }
  }
  return values;
}

interface ParticipationFacts {
  verified: boolean;
  disabled: boolean;
  hasAccount: boolean;
  branchMemberships: Array<{ branchId: string; branchRole?: string }>;
  followedBranchIds: string[];
  roles: UserRole[];
  name: string;
  email: string;
}

/**
 * Load everything a `SessionUser` needs for eligibility and visibility in a
 * bounded number of queries. Non-sensitive fields only; no vote data is read.
 */
async function loadParticipationFacts(
  db: Db,
  memberIds: string[],
): Promise<Map<string, ParticipationFacts>> {
  const facts = new Map<string, ParticipationFacts>();
  if (memberIds.length === 0) return facts;

  for (const ids of chunk(memberIds, 500)) {
    const [memberships, branchMemberships, subscriptions, roles, users] =
      await Promise.all([
        db
          .collection("memberships")
          .find({ memberId: { $in: ids } })
          .toArray(),
        db
          .collection("branch_memberships")
          .find({ memberId: { $in: ids }, status: "active" })
          .toArray(),
        db
          .collection("branch_subscriptions")
          .find({ memberId: { $in: ids }, status: "following" })
          .toArray(),
        db.collection("application_roles").find({ memberId: { $in: ids } }).toArray(),
        db
          .collection("user")
          .find({ _id: { $in: idCandidates(ids) } } as any)
          .toArray(),
      ]);

    const membershipStatus = new Map<string, string>();
    for (const row of memberships as Array<Record<string, any>>) {
      membershipStatus.set(String(row.memberId), String(row.status ?? ""));
    }
    const userById = new Map<string, Record<string, any>>();
    for (const row of users as Array<Record<string, any>>) {
      userById.set(String(row._id), row);
    }
    const rolesById = new Map<string, UserRole[]>();
    for (const row of roles as Array<Record<string, any>>) {
      const list = rolesById.get(String(row.memberId)) ?? [];
      const role = String(row.role ?? "");
      if (role) list.push(role as UserRole);
      rolesById.set(String(row.memberId), list);
    }
    const branchById = new Map<string, Array<{ branchId: string; branchRole?: string }>>();
    for (const row of branchMemberships as Array<Record<string, any>>) {
      const list = branchById.get(String(row.memberId)) ?? [];
      list.push({
        branchId: String(row.branchId),
        ...(row.branchRole === "administrator" ? { branchRole: "administrator" as const } : {}),
      });
      branchById.set(String(row.memberId), list);
    }
    const followedById = new Map<string, string[]>();
    for (const row of subscriptions as Array<Record<string, any>>) {
      const list = followedById.get(String(row.memberId)) ?? [];
      list.push(String(row.branchId));
      followedById.set(String(row.memberId), list);
    }

    for (const memberId of ids) {
      const account = userById.get(memberId);
      facts.set(memberId, {
        verified: membershipStatus.get(memberId) === "verified",
        disabled: account?.disabled === true,
        hasAccount: Boolean(account),
        branchMemberships: branchById.get(memberId) ?? [],
        followedBranchIds: followedById.get(memberId) ?? [],
        roles: rolesById.get(memberId) ?? ["member"],
        name: String(account?.name ?? ""),
        email: String(account?.email ?? ""),
      });
    }
  }

  return facts;
}

function sessionUserFromFacts(memberId: string, facts: ParticipationFacts): SessionUser | null {
  if (!facts.verified || facts.disabled || !facts.hasAccount) return null;
  const platformRoles = normalisePlatformRoles(
    facts.roles.filter((role) => role === "member" || role === "moderator" || role === "administrator"),
  );
  const role = primaryPlatformRole(platformRoles);
  const verifiedBranchIds = facts.branchMemberships.map((row) => row.branchId);
  const branchAdminIds = facts.branchMemberships
    .filter((row) => row.branchRole === "administrator")
    .map((row) => row.branchId);
  return {
    memberId,
    name: facts.name,
    email: facts.email,
    role,
    roles: platformRoles,
    status: "verified",
    canParticipate: true,
    isStaff: role === "administrator" || role === "moderator",
    isAdmin: role === "administrator",
    isBranchAdmin: branchAdminIds.length > 0,
    branchAdminIds,
    verifiedBranchIds,
    followedBranchIds: facts.followedBranchIds,
    activeBranchIds: [
      ...new Set([...verifiedBranchIds, ...facts.followedBranchIds]),
    ],
  };
}

async function loadSessionUser(db: Db, memberId: string): Promise<SessionUser | null> {
  const facts = await loadParticipationFacts(db, [memberId]);
  const row = facts.get(memberId);
  return row ? sessionUserFromFacts(memberId, row) : null;
}

/**
 * The electorate for a ballot, derived from the same predicate that authorises
 * a vote. Candidates are narrowed with the participation facts, then every
 * candidate is confirmed with `getProposalEligibility` and `canViewProposal`.
 * Nothing looser is acceptable: a member who could not vote must never be
 * notified.
 */
export async function listEligibleBallotMembers(
  db: Db,
  proposal: Pick<
    ProposalRecord,
    | "jurisdictionBranchId"
    | "governanceAuthorityBranchId"
    | "publicationScope"
    | "authorId"
    | "originatingBranchId"
  >,
): Promise<SessionUser[]> {
  const branchId = proposal.jurisdictionBranchId;
  let candidateIds: string[];

  if (!branchId) {
    // Party-wide ballot: every verified member can vote.
    const verified = await db
      .collection("memberships")
      .find({ status: "verified" })
      .project({ memberId: 1 })
      .toArray();
    candidateIds = verified.map((row) => String((row as Record<string, any>).memberId));
  } else {
    const branch = await db.collection("branches").findOne({ branchId });
    // `getProposalEligibility` refuses every member when the branch is not
    // recognised, so no one is eligible.
    if (!branch || branch.recognised !== true) return [];
    if (String(branch.kind) === "national") {
      const verified = await db
        .collection("memberships")
        .find({ status: "verified" })
        .project({ memberId: 1 })
        .toArray();
      candidateIds = verified.map((row) => String((row as Record<string, any>).memberId));
    } else {
      const members = await db
        .collection("branch_memberships")
        .find({ branchId, status: "active" })
        .project({ memberId: 1 })
        .toArray();
      candidateIds = members.map((row) => String((row as Record<string, any>).memberId));
    }
  }

  const uniqueIds = [...new Set(candidateIds.filter(Boolean))];
  if (uniqueIds.length === 0) return [];

  const facts = await loadParticipationFacts(db, uniqueIds);
  const eligible: SessionUser[] = [];
  for (const ids of chunk(uniqueIds, 25)) {
    const confirmed = await Promise.all(
      ids.map(async (memberId) => {
        const row = facts.get(memberId);
        if (!row) return null;
        const user = sessionUserFromFacts(memberId, row);
        if (!user) return null;
        const eligibility = await getProposalEligibility(db, proposal, user);
        if (!eligibility.eligible) return null;
        if (!canViewProposal(proposal as ProposalRecord, user)) return null;
        return user;
      }),
    );
    for (const user of confirmed) {
      if (user) eligible.push(user);
    }
  }
  return eligible;
}

async function insertOutboxRow(
  db: Db,
  row: NotificationOutboxRecord,
): Promise<"inserted" | "duplicate"> {
  try {
    await db.collection<NotificationOutboxRecord>(NOTIFICATION_OUTBOX_COLLECTION).insertOne(row);
    return "inserted";
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return "duplicate";
    throw error;
  }
}

function emptyEnqueueReport(event: NotificationOutboxEvent): EnqueueReport {
  return {
    event,
    matters: 0,
    eligible: 0,
    enqueued: 0,
    duplicates: 0,
    skipped: [],
    errors: [],
  };
}

/**
 * Enqueue one opened-ballot notification per eligible member.
 *
 * Idempotent: re-running produces `duplicates` and no second notification.
 * Never throws for a governance reason — a caller can log and continue.
 */
export async function enqueueBallotOpenedNotifications(
  db: Db,
  matterId: string,
  options: { now?: Date } = {},
): Promise<EnqueueReport> {
  const now = options.now ?? new Date();
  const report = emptyEnqueueReport("ballot_opened");
  const raw = await db.collection("proposals").findOne({ proposalId: matterId });
  if (!raw) {
    report.skipped.push({ matterId, reason: "matter_missing" });
    return report;
  }
  const proposal = raw as unknown as ProposalRecord;
  if (!isOpenBallot(proposal, now)) {
    report.skipped.push({ matterId, reason: "ballot_not_open" });
    return report;
  }

  report.matters = 1;
  const members = await listEligibleBallotMembers(db, proposal);
  report.eligible = members.length;
  const payload = buildBallotOpenedPayload(proposal);
  for (const member of members) {
    const dedupeKey = ballotOpenedDedupeKey(member.memberId, proposal.proposalId);
    const outcome = await insertOutboxRow(db, {
      _id: dedupeKey,
      dedupeKey,
      memberId: member.memberId,
      topic: EVENT_TOPICS.ballot_opened,
      event: "ballot_opened",
      matterId: proposal.proposalId,
      ballotId: proposalBallotId(proposal.proposalId),
      ...(proposal.ballotRevisionId ? { revisionId: proposal.ballotRevisionId } : {}),
      payload,
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    });
    if (outcome === "inserted") report.enqueued += 1;
    else report.duplicates += 1;
  }
  return report;
}

/** Enqueue a closing reminder for every open ballot inside the seven-day window. */
export async function enqueueClosingSoonNotifications(
  db: Db,
  options: { now?: Date; matterIds?: string[] } = {},
): Promise<EnqueueReport> {
  const now = options.now ?? new Date();
  const report = emptyEnqueueReport("ballot_closing_soon");
  const filter: Record<string, unknown> = {
    stage: "decide",
    ballotClosedAt: { $exists: false },
    ballotClosesAt: {
      $gt: now,
      $lte: new Date(now.getTime() + CLOSING_SOON_WINDOW_DAYS * 86_400_000),
    },
  };
  if (options.matterIds) {
    if (options.matterIds.length === 0) return report;
    filter.proposalId = { $in: [...new Set(options.matterIds)] };
  }
  const proposals = await db
    .collection("proposals")
    .find(filter)
    .toArray();

  for (const raw of proposals as unknown as ProposalRecord[]) {
    if (!isOpenBallot(raw, now) || !closesWithinSevenDays(raw, now)) continue;
    const closesAt = asDate(raw.ballotClosesAt);
    if (!closesAt) {
      report.skipped.push({ matterId: raw.proposalId, reason: "invalid_deadline" });
      continue;
    }
    report.matters += 1;
    try {
      const members = await listEligibleBallotMembers(db, raw);
      report.eligible += members.length;
      const payload = buildClosingSoonPayload(raw);
      for (const member of members) {
        const dedupeKey = closingSoonDedupeKey(member.memberId, raw.proposalId, closesAt);
        const outcome = await insertOutboxRow(db, {
          _id: dedupeKey,
          dedupeKey,
          memberId: member.memberId,
          topic: EVENT_TOPICS.ballot_closing_soon,
          event: "ballot_closing_soon",
          matterId: raw.proposalId,
          ballotId: proposalBallotId(raw.proposalId),
          ...(raw.ballotRevisionId ? { revisionId: raw.ballotRevisionId } : {}),
          payload,
          status: "pending",
          attempts: 0,
          nextAttemptAt: now,
          createdAt: now,
          updatedAt: now,
        });
        if (outcome === "inserted") report.enqueued += 1;
        else report.duplicates += 1;
      }
    } catch (error) {
      report.errors.push({
        matterId: raw.proposalId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return report;
}

/**
 * Repair an opened-ballot enqueue that was lost between the committed
 * transition and fan-out (for example a process crash). Only scheduler-opened
 * ballots from the last 24 hours are considered, and a matter that already has
 * any opened row is skipped without enumerating the electorate again.
 */
async function repairRecentOpenedNotifications(
  db: Db,
  now: Date,
  reports: EnqueueReport[],
): Promise<void> {
  const since = new Date(now.getTime() - 24 * 60 * 60_000);
  const events = await db
    .collection("governance_events")
    .find({
      eventType: "proposal.stage_transition",
      actorId: LIFECYCLE_SYSTEM_ACTOR,
      createdAt: { $gte: since },
      "metadata.toStage": "decide",
    })
    .project({ matterId: 1 })
    .toArray();
  const matterIds = [
    ...new Set(events.map((event) => String((event as Record<string, any>).matterId ?? ""))),
  ].filter(Boolean);

  for (const matterId of matterIds) {
    const existing = await db
      .collection(NOTIFICATION_OUTBOX_COLLECTION)
      .findOne({ matterId, event: "ballot_opened" });
    if (existing) continue;
    try {
      reports.push(await enqueueBallotOpenedNotifications(db, matterId, { now }));
    } catch (error) {
      reports.push({
        ...emptyEnqueueReport("ballot_opened"),
        errors: [
          {
            matterId,
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      });
    }
  }
}

/**
 * Fan-out entry point used by the governance scheduler after a committed run.
 * Returns reports for logging; the caller must not change the scheduler report
 * or throw because of a notification problem.
 */
export async function enqueueGovernanceNotifications(
  db: Db,
  options: {
    now?: Date;
    advanced?: Array<{ proposalId: string }>;
    repair?: boolean;
  } = {},
): Promise<EnqueueReport[]> {
  const now = options.now ?? new Date();
  const reports: EnqueueReport[] = [];

  for (const matter of options.advanced ?? []) {
    try {
      reports.push(await enqueueBallotOpenedNotifications(db, matter.proposalId, { now }));
    } catch (error) {
      reports.push({
        ...emptyEnqueueReport("ballot_opened"),
        errors: [
          {
            matterId: matter.proposalId,
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      });
    }
  }

  if (options.repair !== false) {
    try {
      await repairRecentOpenedNotifications(db, now, reports);
    } catch (error) {
      reports.push({
        ...emptyEnqueueReport("ballot_opened"),
        errors: [
          { message: error instanceof Error ? error.message : String(error) },
        ],
      });
    }
  }

  try {
    reports.push(await enqueueClosingSoonNotifications(db, { now }));
  } catch (error) {
    reports.push({
      ...emptyEnqueueReport("ballot_closing_soon"),
      errors: [
        { message: error instanceof Error ? error.message : String(error) },
      ],
    });
  }

  return reports;
}

function outboxRetentionCutoff(now: Date): Date {
  return new Date(now.getTime() + OUTBOX_RETENTION_DAYS * 86_400_000);
}

/** Exponential backoff: 1m, 2m, 4m, 8m; the fifth failure is terminal. */
export function outboxRetryDelayMs(attempts: number): number {
  return Math.min(
    6 * 60 * 60_000,
    60_000 * 2 ** Math.max(0, attempts - 1),
  );
}

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  return raw.replace(/\s+/g, " ").trim().slice(0, 300) || "Notification dispatch failed.";
}

export async function claimNextOutboxRow(
  db: Db,
  now: Date,
  leaseMs = OUTBOX_CLAIM_LEASE_MS,
): Promise<NotificationOutboxRecord | null> {
  const claimToken = randomUUID();
  const row = await db
    .collection<NotificationOutboxRecord>(NOTIFICATION_OUTBOX_COLLECTION)
    .findOneAndUpdate(
      {
        status: { $in: ["pending", "failed"] },
        attempts: { $lt: OUTBOX_MAX_ATTEMPTS },
        nextAttemptAt: { $lte: now },
        $or: [
          { claimExpiresAt: { $exists: false } },
          { claimExpiresAt: { $lte: now } },
        ],
      },
      {
        $set: {
          claimToken,
          claimExpiresAt: new Date(now.getTime() + leaseMs),
          lastClaimedAt: now,
          updatedAt: now,
        },
      },
      { sort: { nextAttemptAt: 1 }, returnDocument: "after" },
    );
  return (row as NotificationOutboxRecord | null) ?? null;
}

async function finishOutboxRow(
  db: Db,
  row: NotificationOutboxRecord,
  now: Date,
  update: Record<string, unknown>,
): Promise<void> {
  const write = await db.collection(NOTIFICATION_OUTBOX_COLLECTION).updateOne(
    { _id: row._id, claimToken: row.claimToken } as Record<string, unknown>,
    {
      $set: {
        ...update,
        updatedAt: now,
      },
      $unset: { claimToken: "", claimExpiresAt: "" },
    },
  );
  if (write.matchedCount !== 1) {
    logOperationalEvent("warn", "notification_outbox_claim_lost", {
      event: row.event,
      matterId: row.matterId,
    });
  }
}

type SuppressionReason =
  | "matter_missing"
  | "ballot_not_open"
  | "ballot_closed"
  | "no_longer_closing"
  | "recipient_ineligible"
  | "not_visible";

/**
 * Confirm, at drain time, that the row is still a valid governance notification
 * for a member who could still vote. Governance notices are not general
 * marketing, so the general-communications switch and email suppression do not
 * block the in-app inbox or an opted-in push.
 */
async function suppressionReasonFor(
  db: Db,
  row: NotificationOutboxRecord,
  now: Date,
): Promise<SuppressionReason | null> {
  const raw = await db.collection("proposals").findOne({ proposalId: row.matterId });
  if (!raw) return "matter_missing";
  const proposal = raw as unknown as ProposalRecord;
  if (proposal.stage !== "decide") return "ballot_not_open";
  if (proposal.ballotClosedAt) return "ballot_closed";
  if (ballotExpired(proposal, now)) return "ballot_closed";
  if (row.event === "ballot_closing_soon" && !closesWithinSevenDays(proposal, now)) {
    return "no_longer_closing";
  }

  const user = await loadSessionUser(db, row.memberId);
  if (!user) return "recipient_ineligible";
  const eligibility = await getProposalEligibility(db, proposal, user);
  if (!eligibility.eligible) return "recipient_ineligible";
  if (!canViewProposal(proposal, user)) return "not_visible";
  return null;
}

async function markSuppressed(
  db: Db,
  row: NotificationOutboxRecord,
  reason: string,
  now: Date,
): Promise<void> {
  await finishOutboxRow(db, row, now, {
    status: "suppressed",
    suppressionReason: reason,
    suppressedAt: now,
    retainUntil: outboxRetentionCutoff(now),
  });
}

async function processOutboxRow(
  db: Db,
  env: PlatformEnv,
  row: NotificationOutboxRecord,
  options: {
    now: Date;
    pushSender?: PushSender;
    dispatch?: typeof dispatchMemberNotification;
  },
): Promise<"sent" | "suppressed"> {
  const { now } = options;
  const suppression = await suppressionReasonFor(db, row, now);
  if (suppression) {
    await markSuppressed(db, row, suppression, now);
    return "suppressed";
  }

  const preferences = await getMemberNotificationPreferences(db, row.memberId);
  try {
    const dispatch = options.dispatch ?? dispatchMemberNotification;
    const result = await dispatch(db, env, {
      memberId: row.memberId,
      topic: row.topic,
      title: row.payload.title,
      body: row.payload.body,
      href: row.payload.href,
      dedupeKey: row.dedupeKey,
      isConfidential: row.payload.isConfidential,
      ...(options.pushSender ? { pushSender: options.pushSender } : {}),
      now,
    });
    const channels: NotificationOutboxChannels = {
      inApp: result.inAppCreated ? "created" : "duplicate",
      push: !preferences.push[row.topic]
        ? "suppressed"
        : result.push.sent > 0
          ? "sent"
          : "unavailable",
    };
    await finishOutboxRow(db, row, now, {
      status: "sent",
      attempts: row.attempts + 1,
      lastAttemptAt: now,
      sentAt: now,
      channels,
      retainUntil: outboxRetentionCutoff(now),
    });
    return "sent";
  } catch (error) {
    const attempts = row.attempts + 1;
    const terminal = attempts >= OUTBOX_MAX_ATTEMPTS;
    await finishOutboxRow(db, row, now, {
      status: "failed",
      attempts,
      lastAttemptAt: now,
      lastError: safeErrorMessage(error),
      nextAttemptAt: terminal
        ? now
        : new Date(now.getTime() + outboxRetryDelayMs(attempts)),
      ...(terminal ? { retainUntil: outboxRetentionCutoff(now) } : {}),
    });
    throw error;
  }
}

function dueFilter(now: Date): Record<string, unknown> {
  return {
    status: { $in: ["pending", "failed"] },
    attempts: { $lt: OUTBOX_MAX_ATTEMPTS },
    nextAttemptAt: { $lte: now },
    $or: [
      { claimExpiresAt: { $exists: false } },
      { claimExpiresAt: { $lte: now } },
    ],
  };
}

/**
 * Drain due rows. `dryRun` reports the backlog without claiming or sending.
 *
 * Two concurrent workers cannot claim the same row: the conditional
 * `findOneAndUpdate` sets a lease that the other worker's filter rejects. A
 * worker that crashes loses its lease and the row is retried after the lease
 * expires. Dispatch dedupe keys make an ambiguous retry safe.
 */
export async function drainNotificationOutbox(
  db: Db,
  env: PlatformEnv,
  options: {
    now?: Date;
    dryRun?: boolean;
    limit?: number;
    pushSender?: PushSender;
    /** Test or alternate-transport seam; defaults to the production dispatcher. */
    dispatch?: typeof dispatchMemberNotification;
  } = {},
): Promise<NotificationOutboxDrainReport> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;
  const limit = Math.max(1, Math.min(options.limit ?? 200, 1000));
  const byEvent: Record<NotificationOutboxEvent, number> = {
    ballot_opened: 0,
    ballot_closing_soon: 0,
  };
  const report: NotificationOutboxDrainReport = {
    mode: dryRun ? "dry-run" : "apply",
    now: now.toISOString(),
    due: await db.collection(NOTIFICATION_OUTBOX_COLLECTION).countDocuments(dueFilter(now)),
    claimed: 0,
    sent: 0,
    suppressed: 0,
    failed: 0,
    retried: 0,
    exhausted: 0,
    remaining: 0,
    byEvent,
    errors: [],
  };

  if (dryRun) {
    report.exhausted = await db
      .collection(NOTIFICATION_OUTBOX_COLLECTION)
      .countDocuments({ status: "failed", attempts: { $gte: OUTBOX_MAX_ATTEMPTS } });
    return report;
  }

  while (report.claimed < limit) {
    const row = await claimNextOutboxRow(db, now);
    if (!row) break;
    report.claimed += 1;
    byEvent[row.event] = (byEvent[row.event] ?? 0) + 1;
    try {
      const outcome = await processOutboxRow(db, env, row, {
        now,
        ...(options.pushSender ? { pushSender: options.pushSender } : {}),
        ...(options.dispatch ? { dispatch: options.dispatch } : {}),
      });
      if (outcome === "sent") report.sent += 1;
      else if (outcome === "suppressed") report.suppressed += 1;
    } catch (error) {
      if (row.attempts + 1 >= OUTBOX_MAX_ATTEMPTS) report.exhausted += 1;
      else report.retried += 1;
      report.failed += 1;
      report.errors.push({
        event: row.event,
        matterId: row.matterId,
        message: safeErrorMessage(error),
      });
    }
  }

  report.remaining = await db
    .collection(NOTIFICATION_OUTBOX_COLLECTION)
    .countDocuments(dueFilter(now));
  return report;
}

/** The topic catalogue entry for an outbox event, used by tests and docs. */
export function notificationTopicForEvent(event: NotificationOutboxEvent): NotificationTopic {
  return EVENT_TOPICS[event];
}
