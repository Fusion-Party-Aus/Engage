import type { Db } from "mongodb";
import {
  ballotDeadlineShortLabel,
  formatRelativeDeadline,
} from "./ballot-deadline.ts";
import { resolveBallotClosure } from "./ballots.ts";
import {
  NON_BLOCKING_AMENDMENT_STATUSES,
} from "./lifecycle-schedule.ts";
import { VERIFICATION_REVIEWS } from "./membership-verification.ts";
import { ballotActs, type BallotAct } from "./ballot-authority.ts";
import { hasPermission, hasPermissionAnywhere, type PermissionKey } from "./rbac.ts";
import { isPolicyRegistryRecordForResolution } from "./proposal-helpers.ts";
import type { SessionUser } from "./types.ts";
import { proposalBallotId } from "./vote-storage.ts";

export { viewerHasResponsibility } from "./responsibility-permissions.ts";

/**
 * Administrator responsibility queue.
 *
 * A read-only composition of the work an officer can act on *now*. Every item
 * names the permission that makes it actionable, and items the viewer cannot
 * act on are removed before the model is returned — a branch administrator
 * never receives another branch's items, and a moderator receives none.
 *
 * The queue contains no vote choice, tally of identifiable data, member
 * identifier, email address or raw collection/field name. Member verification
 * is a count and a generic label only.
 */

export type ResponsibilityGroupKey =
  | "ballot-outcome"
  | "ballot-closing"
  | "ballot-binding"
  | "advancement"
  | "amendments"
  | "member-verification"
  | "policy-publication";

export interface ResponsibilityQueueItem {
  /** Stable internal identity. Never rendered. */
  id: string;
  title: string;
  /** One line explaining why this needs the officer. */
  reason: string;
  actionLabel: string;
  href: string;
  /** The authority that makes the described action possible. */
  permission: PermissionKey;
}

export interface ResponsibilityQueueGroup {
  key: ResponsibilityGroupKey;
  title: string;
  summary: string;
  /** Affected units: member reviews may exceed the single summary item. */
  count: number;
  items: ResponsibilityQueueItem[];
  /** Short user-facing message when only this source failed. */
  error?: string;
}

export interface ResponsibilityQueue {
  /** Most urgent responsibility first. Empty groups are never returned. */
  groups: ResponsibilityQueueGroup[];
  total: number;
  /**
   * True when the viewer holds at least one permission a queue source depends
   * on. Distinguishes "you're up to date" from "this page is not for you".
   */
  hasResponsibility: boolean;
}

interface GroupMeta {
  title: string;
  summary: string;
  /**
   * Fixed severity order. A missing or overdue governance record outranks a
   * deadline that is still in the future. Ties are broken by key so the order
   * never depends on query timing.
   */
  order: number;
}

const GROUP_META: Record<ResponsibilityGroupKey, GroupMeta> = {
  "ballot-outcome": {
    title: "Ballot outcomes",
    summary: "Closed ballots without a recorded outcome.",
    order: 0,
  },
  "ballot-closing": {
    title: "Closing soon",
    summary: "Ballots closing in the next seven days.",
    order: 1,
  },
  "ballot-binding": {
    title: "Ballot wording",
    summary: "Matters in Decide without bound wording.",
    order: 2,
  },
  advancement: {
    title: "Advancement",
    summary: "Deliberation deadlines that have passed.",
    order: 3,
  },
  amendments: {
    title: "Amendments",
    summary: "Amendments that need a decision.",
    order: 4,
  },
  "member-verification": {
    title: "Member verification",
    summary: "Members waiting for a verification decision.",
    order: 5,
  },
  "policy-publication": {
    title: "Publication",
    summary: "Ratified policies not yet published.",
    order: 6,
  },
};

interface MatterContext {
  proposalId: string;
  slug: string;
  title: string;
  stage: string;
  deliberationEndsAt?: Date;
  ballotRevisionId?: string;
  ballotClosesAt?: Date;
  ballotClosedAt?: Date;
  originatingBranchId?: string;
  governanceAuthorityBranchId?: string;
  jurisdictionBranchId?: string;
}

const MATTER_PROJECTION = {
  proposalId: 1,
  slug: 1,
  title: 1,
  stage: 1,
  deliberationEndsAt: 1,
  ballotRevisionId: 1,
  ballotClosesAt: 1,
  ballotClosedAt: 1,
  originatingBranchId: 1,
  governanceAuthorityBranchId: 1,
  jurisdictionBranchId: 1,
} as const;

const AMENDMENT_PROJECTION = {
  amendmentId: 1,
  proposalId: 1,
  status: 1,
  title: 1,
  "changes.title": 1,
  baseRevisionId: 1,
  currentRevisionId: 1,
  ballotRevisionId: 1,
  ballotAmendmentRevisionId: 1,
  ballotClosesAt: 1,
  "ballotDecision.result": 1,
} as const;

const ACTIONABLE_AMENDMENT_STATUSES = [
  "proposed",
  "stale",
  "conflict",
  "ready",
  "voting",
  "endorsed",
  "accepted",
] as const;

const AMENDMENT_STATUS_ORDER: Record<string, number> = {
  conflict: 0,
  stale: 1,
  proposed: 2,
  ready: 3,
  voting: 4,
  endorsed: 5,
  accepted: 6,
};

const SEVEN_DAYS_MS = 7 * 86_400_000;

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asDate(value: unknown): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : null;
}

function matterContext(doc: Record<string, any>): MatterContext {
  const ballotClosesAt = asDate(doc.ballotClosesAt);
  const ballotClosedAt = asDate(doc.ballotClosedAt);
  return {
    proposalId: asString(doc.proposalId),
    slug: asString(doc.slug) || asString(doc.proposalId),
    title: asString(doc.title) || "Untitled matter",
    stage: asString(doc.stage),
    ...(asDate(doc.deliberationEndsAt)
      ? { deliberationEndsAt: asDate(doc.deliberationEndsAt)! }
      : {}),
    ...(asString(doc.ballotRevisionId)
      ? { ballotRevisionId: asString(doc.ballotRevisionId) }
      : {}),
    ...(ballotClosesAt ? { ballotClosesAt } : {}),
    ...(ballotClosedAt ? { ballotClosedAt } : {}),
    ...(asString(doc.originatingBranchId)
      ? { originatingBranchId: asString(doc.originatingBranchId) }
      : {}),
    ...(asString(doc.governanceAuthorityBranchId)
      ? { governanceAuthorityBranchId: asString(doc.governanceAuthorityBranchId) }
      : {}),
    ...(asString(doc.jurisdictionBranchId)
      ? { jurisdictionBranchId: asString(doc.jurisdictionBranchId) }
      : {}),
  };
}

function dateLabel(value: Date): string {
  return ballotDeadlineShortLabel(value);
}

/**
 * The ballot authority gate shared with the bind, result and amendment-ballot
 * routes. A scattered branch grant therefore cannot act, or see an item,
 * outside its branch.
 */
function canActOnMatterBallot(
  viewer: SessionUser,
  matter: MatterContext,
  act: BallotAct,
): boolean {
  return ballotActs(viewer, {
    governanceAuthorityBranchId: matter.governanceAuthorityBranchId,
    jurisdictionBranchId: matter.jurisdictionBranchId,
    originatingBranchId: matter.originatingBranchId,
  }).can(act);
}

/** Mirrors the officer advancement gate in `saveProposal` (D5). */
function canAdvanceMatter(viewer: SessionUser, matter: MatterContext): boolean {
  const branchId = matter.governanceAuthorityBranchId;
  if (!hasPermission(viewer, "ballots.bind", branchId)) return false;
  if (viewer.isAdmin || hasPermission(viewer, "ballots.bind")) return true;
  if (!branchId || matter.jurisdictionBranchId !== branchId) return false;
  return Boolean(
    viewer.branchAdminIds?.includes(branchId) ||
      hasPermission(viewer, "ballots.bind", branchId),
  );
}

/** Mirrors the `amendments/resolve` route authority. */
function canResolveAmendment(
  viewer: SessionUser,
  matter: MatterContext,
): boolean {
  return canActOnMatterBallot(viewer, matter, "resolveAmendment");
}

/** Mirrors the amendment ballot open, close and acceptance routes. */
function canManageAmendmentBallot(
  viewer: SessionUser,
  matter: MatterContext,
  act: BallotAct,
): boolean {
  return canActOnMatterBallot(viewer, matter, act);
}

/** Mirrors the `amendments/apply` route authority. */
function canApplyAmendment(
  viewer: SessionUser,
  matter: MatterContext,
): boolean {
  return canActOnMatterBallot(viewer, matter, "applyAmendment");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function makeGroup(
  key: ResponsibilityGroupKey,
  items: ResponsibilityQueueItem[],
  count = items.length,
): ResponsibilityQueueGroup | null {
  if (!items.length && count === 0) return null;
  const meta = GROUP_META[key];
  return {
    key,
    title: meta.title,
    summary: meta.summary,
    count,
    items,
  };
}

function failedGroup(
  key: ResponsibilityGroupKey,
  message: string,
): ResponsibilityQueueGroup {
  const meta = GROUP_META[key];
  return {
    key,
    title: meta.title,
    summary: meta.summary,
    count: 0,
    items: [],
    error: message,
  };
}

/**
 * Closing state for a matter from the ballot record first, then the matter.
 * The matter is the fallback for legacy ballots with no stored row.
 */
interface MatterBallotState {
  ballotId: string;
  closesAt: Date | null;
  closed: boolean;
  status: string;
}

function resolveMatterBallotState(
  matter: MatterContext,
  stored: Record<string, any> | undefined,
  now: Date,
): MatterBallotState {
  const closure = resolveBallotClosure({
    ballot: stored as { status?: string; closesAt?: Date } | undefined,
    matter: {
      ballotClosedAt: matter.ballotClosedAt,
      ballotClosesAt: matter.ballotClosesAt,
    },
    now,
  });
  const closesAt =
    closure.closesAt ??
    asDate(stored?.closesAt) ??
    matter.ballotClosesAt ??
    matter.ballotClosedAt;
  return {
    ballotId: asString(stored?.ballotId) || proposalBallotId(matter.proposalId),
    closesAt: closesAt ?? null,
    closed: closure.closed,
    status: asString(stored?.status),
  };
}

async function loadBallotGroups(
  db: Db,
  viewer: SessionUser,
  now: Date,
): Promise<ResponsibilityQueueGroup[]> {
  const matters = (
    await db
      .collection("proposals")
      .find({ stage: "decide" }, { projection: MATTER_PROJECTION })
      .toArray()
  ).map(matterContext);

  if (!matters.length) return [];

  const matterIds = matters.map((matter) => matter.proposalId);
  const primaryBallotIds = matterIds.map((id) => proposalBallotId(id));
  const [storedBallots, recordedResults] = await Promise.all([
    db
      .collection("ballots")
      .find(
        { matterId: { $in: matterIds } },
        {
          projection: {
            ballotId: 1,
            matterId: 1,
            purpose: 1,
            status: 1,
            closesAt: 1,
          },
        },
      )
      .toArray(),
    db
      .collection("ballot_results")
      .find(
        {
          $or: [
            { ballotId: { $in: primaryBallotIds } },
            { proposalId: { $in: matterIds }, ballotId: { $exists: false } },
          ],
        },
        { projection: { ballotId: 1, proposalId: 1 } },
      )
      .toArray(),
  ]);

  const storedByMatter = new Map<string, Record<string, any>>();
  for (const row of storedBallots as Record<string, any>[]) {
    const matterId = asString(row.matterId);
    const ballotId = asString(row.ballotId);
    if (!matterId) continue;
    // Amendment ballots share the matter ID; they are never the adoption
    // ballot this queue reports on.
    if (
      asString(row.purpose) === "amendment" ||
      ballotId.startsWith("amendment:")
    )
      continue;
    // Prefer the matter's primary ballot when a matter has more than one row.
    if (
      !storedByMatter.has(matterId) ||
      ballotId === proposalBallotId(matterId)
    ) {
      storedByMatter.set(matterId, row);
    }
  }

  const recordedBallotIds = new Set(
    (recordedResults as Record<string, any>[])
      .map((row) => asString(row.ballotId))
      .filter(Boolean),
  );
  const legacyResultProposalIds = new Set(
    (recordedResults as Record<string, any>[])
      .filter((row) => !asString(row.ballotId))
      .map((row) => asString(row.proposalId))
      .filter(Boolean),
  );

  const outcomeItems: Array<{ item: ResponsibilityQueueItem; sortAt: number }> =
    [];
  const closingItems: Array<{ item: ResponsibilityQueueItem; sortAt: number }> =
    [];
  const bindingItems: ResponsibilityQueueItem[] = [];

  for (const matter of matters) {
    const state = resolveMatterBallotState(
      matter,
      storedByMatter.get(matter.proposalId),
      now,
    );

    if (!matter.ballotRevisionId) {
      if (!canActOnMatterBallot(viewer, matter, "bindMatterBallot")) continue;
      bindingItems.push({
        id: `ballot-binding:${matter.proposalId}`,
        title: matter.title,
        reason: "In Decide with no wording bound to a ballot.",
        actionLabel: "Bind wording",
        href: `/admin/proposals/${matter.slug}/#bind-ballot`,
        permission: "ballots.bind",
      });
      continue;
    }

    const hasResult =
      recordedBallotIds.has(state.ballotId) ||
      legacyResultProposalIds.has(matter.proposalId);

    if (
      state.closed &&
      !hasResult &&
      state.status !== "certified" &&
      state.status !== "cancelled" &&
      canActOnMatterBallot(viewer, matter, "recordMatterResult")
    ) {
      const closedAt = state.closesAt ?? matter.ballotClosedAt;
      outcomeItems.push({
        sortAt: (closedAt ?? now).getTime(),
        item: {
          id: `ballot-outcome:${state.ballotId}`,
          title: matter.title,
          reason: closedAt
            ? `Closed ${dateLabel(closedAt)} with no outcome recorded.`
            : "Closed with no outcome recorded.",
          actionLabel: "Record outcome",
          href: `/admin/proposals/${matter.slug}/#record-outcome`,
          permission: "ballots.record_result",
        },
      });
      continue;
    }

    if (
      !state.closed &&
      state.status !== "cancelled" &&
      state.status !== "certified" &&
      state.closesAt &&
      state.closesAt.getTime() > now.getTime() &&
      state.closesAt.getTime() <= now.getTime() + SEVEN_DAYS_MS &&
      canActOnMatterBallot(viewer, matter, "recordMatterResult")
    ) {
      closingItems.push({
        sortAt: state.closesAt.getTime(),
        item: {
          id: `ballot-closing:${state.ballotId}`,
          title: matter.title,
          reason: `Closes ${formatRelativeDeadline(state.closesAt, now)}.`,
          actionLabel: "View ballot",
          href: `/admin/proposals/${matter.slug}/#record-decision`,
          permission: "ballots.record_result",
        },
      });
    }
  }

  const byTimeThenTitle = (
    left: { item: ResponsibilityQueueItem; sortAt: number },
    right: { item: ResponsibilityQueueItem; sortAt: number },
  ) =>
    left.sortAt - right.sortAt ||
    compareText(left.item.title, right.item.title) ||
    compareText(left.item.id, right.item.id);

  return [
    makeGroup(
      "ballot-outcome",
      outcomeItems.sort(byTimeThenTitle).map((entry) => entry.item),
    ),
    makeGroup(
      "ballot-closing",
      closingItems.sort(byTimeThenTitle).map((entry) => entry.item),
    ),
    makeGroup(
      "ballot-binding",
      bindingItems.sort(
        (left, right) =>
          compareText(left.title, right.title) ||
          compareText(left.id, right.id),
      ),
    ),
  ].filter((group): group is ResponsibilityQueueGroup => group !== null);
}

async function loadAdvancementGroup(
  db: Db,
  viewer: SessionUser,
  now: Date,
): Promise<ResponsibilityQueueGroup[]> {
  const overdue = (
    await db
      .collection("proposals")
      .find(
        { stage: "deliberate", deliberationEndsAt: { $lte: now } },
        { projection: MATTER_PROJECTION },
      )
      .toArray()
  ).map(matterContext);

  if (!overdue.length) return [];

  const proposalIds = overdue.map((matter) => matter.proposalId);
  const blockingRows = await db
    .collection("amendments")
    .find(
      {
        proposalId: { $in: proposalIds },
        status: { $nin: [...NON_BLOCKING_AMENDMENT_STATUSES] },
      },
      { projection: { proposalId: 1 } },
    )
    .toArray();
  const blockedProposalIds = new Set(
    (blockingRows as Record<string, any>[])
      .map((row) => asString(row.proposalId))
      .filter(Boolean),
  );

  const items: Array<{ item: ResponsibilityQueueItem; sortAt: number }> = [];
  for (const matter of overdue) {
    const deadline = matter.deliberationEndsAt;
    if (!deadline) continue;
    const blocked = blockedProposalIds.has(matter.proposalId);
    if (blocked) {
      // The scheduler refuses advancement while an amendment is unresolved.
      // The actionable responsibility is the amendment, not a forced advance.
      if (!canResolveAmendment(viewer, matter)) continue;
      items.push({
        sortAt: deadline.getTime(),
        item: {
          id: `advancement:${matter.proposalId}:amendment`,
          title: matter.title,
          reason: `Deliberation ended ${dateLabel(deadline)}; an amendment is unresolved.`,
          actionLabel: "Review amendment",
          href: `/admin/proposals/${matter.slug}/#record-amendments`,
          permission: "amendments.resolve",
        },
      });
      continue;
    }
    if (!canAdvanceMatter(viewer, matter)) continue;
    items.push({
      sortAt: deadline.getTime(),
      item: {
        id: `advancement:${matter.proposalId}`,
        title: matter.title,
        reason: `Deliberation ended ${dateLabel(deadline)}.`,
        actionLabel: "Advance proposal",
        href: `/admin/proposals/${matter.slug}/`,
        permission: "ballots.bind",
      },
    });
  }

  const group = makeGroup(
    "advancement",
    items
      .sort(
        (left, right) =>
          left.sortAt - right.sortAt ||
          compareText(left.item.title, right.item.title) ||
          compareText(left.item.id, right.item.id),
      )
      .map((entry) => entry.item),
  );
  return group ? [group] : [];
}

async function loadAmendmentGroup(
  db: Db,
  viewer: SessionUser,
  now: Date,
): Promise<ResponsibilityQueueGroup[]> {
  const amendments = (
    await db
      .collection("amendments")
      .find(
        { status: { $in: [...ACTIONABLE_AMENDMENT_STATUSES] } },
        { projection: AMENDMENT_PROJECTION },
      )
      .toArray()
  ).map((doc) => doc as Record<string, any>);

  if (!amendments.length) return [];

  const proposalIds = [
    ...new Set(
      amendments.map((row) => asString(row.proposalId)).filter(Boolean),
    ),
  ];
  const matters = (
    await db
      .collection("proposals")
      .find(
        { proposalId: { $in: proposalIds } },
        { projection: MATTER_PROJECTION },
      )
      .toArray()
  ).map(matterContext);
  const matterById = new Map(
    matters.map((matter) => [matter.proposalId, matter]),
  );

  // An endorsement ballot and a formal approval both depend on the immutable
  // amendment revision still existing. Verify the exact pairs once.
  const revisionPairs = amendments
    .filter(
      (row) =>
        ["ready", "endorsed"].includes(asString(row.status)) &&
        asString(row.amendmentId) &&
        asString(row.currentRevisionId),
    )
    .map((row) => ({
      amendmentId: asString(row.amendmentId),
      revisionId: asString(row.currentRevisionId),
    }));
  const existingRevisionPairs = new Set<string>();
  if (revisionPairs.length) {
    const rows = await db
      .collection("amendment_revisions")
      .find(
        { amendmentId: { $in: revisionPairs.map((pair) => pair.amendmentId) } },
        { projection: { amendmentId: 1, revisionId: 1 } },
      )
      .toArray();
    for (const row of rows as Record<string, any>[]) {
      existingRevisionPairs.add(
        `${asString(row.amendmentId)}|${asString(row.revisionId)}`,
      );
    }
  }

  // Applying an accepted amendment is only possible against the current
  // proposal revision. Read the latest revision for accepted items only.
  const acceptedProposalIds = [
    ...new Set(
      amendments
        .filter((row) => asString(row.status) === "accepted")
        .map((row) => asString(row.proposalId))
        .filter(Boolean),
    ),
  ];
  const latestRevisionByProposal = new Map<string, string>();
  if (acceptedProposalIds.length) {
    const rows = await db
      .collection("proposal_revisions")
      .find(
        { proposalId: { $in: acceptedProposalIds } },
        { projection: { proposalId: 1, revisionId: 1, createdAt: 1 } },
      )
      .sort({ createdAt: -1, _id: -1 })
      .toArray();
    for (const row of rows as Record<string, any>[]) {
      const proposalId = asString(row.proposalId);
      if (!proposalId || latestRevisionByProposal.has(proposalId)) continue;
      latestRevisionByProposal.set(proposalId, asString(row.revisionId));
    }
  }

  const items: Array<{ item: ResponsibilityQueueItem; statusOrder: number }> =
    [];
  for (const row of amendments) {
    const matter = matterById.get(asString(row.proposalId));
    if (!matter || matter.stage === "archived") continue;
    const status = asString(row.status);
    const amendmentId = asString(row.amendmentId);
    const title =
      asString(row.changes?.title) ||
      asString(row.title) ||
      "Proposed wording change";
    const href = `/admin/proposals/${matter.slug}/#record-amendments`;

    const push = (
      actionLabel: string,
      reason: string,
      permission: PermissionKey,
    ) => {
      items.push({
        statusOrder: AMENDMENT_STATUS_ORDER[status] ?? 99,
        item: {
          id: `amendment:${amendmentId}:${status}`,
          title,
          reason,
          actionLabel,
          href,
          permission,
        },
      });
    };

    if (["proposed", "stale", "conflict"].includes(status)) {
      if (!canResolveAmendment(viewer, matter)) continue;
      push(
        "Review amendment",
        status === "conflict"
          ? "Overlapping wording needs an officer decision."
          : "Awaiting review.",
        "amendments.resolve",
      );
      continue;
    }

    if (status === "ready") {
      if (
        !canManageAmendmentBallot(viewer, matter, "openAmendmentBallot") ||
        matter.stage !== "decide" ||
        !matter.ballotRevisionId ||
        matter.ballotRevisionId !== asString(row.baseRevisionId) ||
        !existingRevisionPairs.has(`${amendmentId}|${asString(row.currentRevisionId)}`)
      )
        continue;
      push(
        "Open ballot",
        "Ready for an endorsement ballot.",
        "amendments.manage_ballot",
      );
      continue;
    }

    if (status === "voting") {
      const closesAt = asDate(row.ballotClosesAt);
      if (
        !closesAt ||
        closesAt.getTime() > now.getTime() ||
        !canManageAmendmentBallot(viewer, matter, "closeAmendmentBallot") ||
        matter.stage !== "decide" ||
        !matter.ballotRevisionId ||
        matter.ballotRevisionId !== asString(row.ballotRevisionId)
      )
        continue;
      push(
        "Close ballot",
        `Endorsement ballot closed ${dateLabel(closesAt)}.`,
        "amendments.manage_ballot",
      );
      continue;
    }

    if (status === "endorsed") {
      if (
        asString(row.ballotDecision?.result) !== "endorsed" ||
        !canManageAmendmentBallot(viewer, matter, "acceptAmendment") ||
        !matter.ballotRevisionId ||
        matter.ballotRevisionId !== asString(row.ballotRevisionId) ||
        asString(row.ballotAmendmentRevisionId) !==
          asString(row.currentRevisionId) ||
        !existingRevisionPairs.has(`${amendmentId}|${asString(row.currentRevisionId)}`)
      )
        continue;
      push(
        "Record approval",
        "Endorsed; formal approval is not recorded.",
        "amendments.manage_ballot",
      );
      continue;
    }

    if (status === "accepted") {
      if (
        !canApplyAmendment(viewer, matter) ||
        !["propose", "deliberate"].includes(matter.stage) ||
        latestRevisionByProposal.get(matter.proposalId) !==
          asString(row.baseRevisionId)
      )
        continue;
      push(
        "Apply amendment",
        "Accepted; not applied to the proposal.",
        "amendments.apply",
      );
    }
  }

  const group = makeGroup(
    "amendments",
    items
      .sort(
        (left, right) =>
          left.statusOrder - right.statusOrder ||
          compareText(left.item.title, right.item.title) ||
          compareText(left.item.id, right.item.id),
      )
      .map((entry) => entry.item),
  );
  return group ? [group] : [];
}

async function loadVerificationGroup(
  db: Db,
): Promise<ResponsibilityQueueGroup[]> {
  const [pendingMemberships, openReviews] = await Promise.all([
    db
      .collection("memberships")
      .find({ status: "pending" }, { projection: { memberId: 1 } })
      .toArray(),
    db
      .collection(VERIFICATION_REVIEWS)
      .find({ status: "open" }, { projection: { memberId: 1 } })
      .toArray(),
  ]);
  const memberIds = new Set<string>();
  for (const row of [...pendingMemberships, ...openReviews] as Record<
    string,
    any
  >[]) {
    const memberId = asString(row.memberId);
    if (memberId) memberIds.add(memberId);
  }
  if (!memberIds.size) return [];
  const count = memberIds.size;
  const items: ResponsibilityQueueItem[] = [
    {
      id: "member-verification",
      title: `${count} member${count === 1 ? "" : "s"} to verify`,
      reason: "Waiting for a verification decision.",
      actionLabel: "Review members",
      href: "/admin/members/",
      permission: "members.verify",
    },
  ];
  const group = makeGroup("member-verification", items, count);
  return group ? [group] : [];
}

async function loadPublicationGroup(
  db: Db,
): Promise<ResponsibilityQueueGroup[]> {
  const policies = (
    await db
      .collection("policy_registry")
      .find(
        { status: "adopted", publicationStatus: "unpublished" },
        {
          projection: {
            policyId: 1,
            proposalId: 1,
            title: 1,
            kind: 1,
            jurisdictionBranchId: 1,
            ratifiedAt: 1,
          },
        },
      )
      .toArray()
  ).map((row) => row as Record<string, any>);

  if (!policies.length) return [];

  const proposalIds = [
    ...new Set(
      policies.map((policy) => asString(policy.proposalId)).filter(Boolean),
    ),
  ];
  const linkedProposals = proposalIds.length
    ? await db
        .collection("proposals")
        .find(
          { proposalId: { $in: proposalIds } },
          { projection: { proposalId: 1, kind: 1 } },
        )
        .toArray()
    : [];
  const proposalById = new Map(
    (linkedProposals as Record<string, any>[]).map((row) => [
      asString(row.proposalId),
      row,
    ]),
  );

  const items: Array<{ item: ResponsibilityQueueItem; sortAt: number }> = [];
  for (const policy of policies) {
    const linked = proposalById.get(asString(policy.proposalId));
    if (
      isPolicyRegistryRecordForResolution(
        policy as { policyId?: string; proposalId?: string; kind?: string },
        linked as { kind?: string; proposalId?: string } | null,
      )
    )
      continue;
    const policyId = asString(policy.policyId) || asString(policy.proposalId);
    if (!policyId) continue;
    const ratifiedAt = asDate(policy.ratifiedAt);
    items.push({
      sortAt: ratifiedAt?.getTime() ?? 0,
      item: {
        id: `policy-publication:${policyId}`,
        title: asString(policy.title) || "Adopted policy",
        reason: ratifiedAt
          ? `Ratified ${dateLabel(ratifiedAt)}, not published.`
          : "Ratified, not published.",
        actionLabel: "Publish policy",
        href: `/admin/policies/#policy-${encodeURIComponent(policyId)}`,
        permission: "policies.publish",
      },
    });
  }

  const group = makeGroup(
    "policy-publication",
    items
      .sort(
        (left, right) =>
          left.sortAt - right.sortAt ||
          compareText(left.item.title, right.item.title) ||
          compareText(left.item.id, right.item.id),
      )
      .map((entry) => entry.item),
  );
  return group ? [group] : [];
}

async function guardSource(
  key: ResponsibilityGroupKey,
  message: string,
  load: () => Promise<ResponsibilityQueueGroup[]>,
): Promise<ResponsibilityQueueGroup[]> {
  try {
    return await load();
  } catch {
    // A single failed source degrades to a short message for its own group.
    // The error object is never returned, logged or rendered.
    return [failedGroup(key, message)];
  }
}

/** Fixed ordering; equal priorities fall back to the key. */
function compareGroups(
  left: ResponsibilityQueueGroup,
  right: ResponsibilityQueueGroup,
): number {
  return (
    GROUP_META[left.key].order - GROUP_META[right.key].order ||
    compareText(left.key, right.key)
  );
}

/**
 * Build the administrator responsibility queue for one viewer.
 *
 * Sources are independent: a failure in one group cannot fail the page or
 * hide another group's items.
 */
export async function buildResponsibilityQueue(
  db: Db,
  viewer: SessionUser,
  options: { now?: Date } = {},
): Promise<ResponsibilityQueue> {
  const now = options.now ?? new Date();

  const canBallot =
    hasPermissionAnywhere(viewer, "ballots.bind") ||
    hasPermissionAnywhere(viewer, "ballots.record_result");
  const canAdvanceOrResolve =
    hasPermissionAnywhere(viewer, "ballots.bind") ||
    hasPermissionAnywhere(viewer, "amendments.resolve");
  const canAmend =
    hasPermissionAnywhere(viewer, "amendments.resolve") ||
    hasPermissionAnywhere(viewer, "amendments.manage_ballot") ||
    hasPermissionAnywhere(viewer, "amendments.apply");
  const canVerify = hasPermission(viewer, "members.verify");
  const canPublish = hasPermission(viewer, "policies.publish");

  const hasResponsibility =
    canBallot || canAdvanceOrResolve || canAmend || canVerify || canPublish;

  if (!hasResponsibility) {
    return { groups: [], total: 0, hasResponsibility: false };
  }

  const settled = await Promise.all([
    canBallot
      ? guardSource(
          "ballot-outcome",
          "Couldn't load ballot responsibilities just now.",
          () => loadBallotGroups(db, viewer, now),
        )
      : Promise.resolve([]),
    canAdvanceOrResolve
      ? guardSource(
          "advancement",
          "Couldn't load advancement responsibilities just now.",
          () => loadAdvancementGroup(db, viewer, now),
        )
      : Promise.resolve([]),
    canAmend
      ? guardSource(
          "amendments",
          "Couldn't load amendment responsibilities just now.",
          () => loadAmendmentGroup(db, viewer, now),
        )
      : Promise.resolve([]),
    canVerify
      ? guardSource(
          "member-verification",
          "Couldn't load member verification just now.",
          () => loadVerificationGroup(db),
        )
      : Promise.resolve([]),
    canPublish
      ? guardSource(
          "policy-publication",
          "Couldn't load publication responsibilities just now.",
          () => loadPublicationGroup(db),
        )
      : Promise.resolve([]),
  ]);

  const groups = settled.flat().sort(compareGroups);
  return {
    groups,
    total: groups.reduce(
      (count, group) => count + (group.error ? 0 : group.count),
      0,
    ),
    hasResponsibility: true,
  };
}
