import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { canAdministerBranch } from "./auth.ts";
import type {
  BranchKind,
  BranchMembershipRecord,
  ProposalRecord,
  SessionUser,
} from "./types.ts";

/**
 * Branch participation is deliberately split into two facts:
 *
 *  - `branch_subscriptions` is an Engage-owned personal preference. A person may
 *    follow or stop following a branch at any time.
 *  - `branch_memberships` is an organisational fact. It records that a branch
 *    has verified the person's membership. Verified members can choose their geographic and constituent membership;
 *    administrators and external authorities can also maintain membership facts.
 *
 * Voting eligibility reads only the membership fact. Following a branch grants
 * discovery, never a ballot. Keeping these collections separate is what allows
 * Underground CRM to become the membership authority later without touching a
 * person's chosen branch subscriptions.
 */

export const BRANCH_SUBSCRIPTIONS = "branch_subscriptions";
export const BRANCH_SUBSCRIPTION_EVENTS = "branch_subscription_events";
export const BRANCH_MEMBERSHIPS = "branch_memberships";
export const BRANCH_MEMBERSHIP_EVENTS = "branch_membership_events";

export const LOCAL_MEMBERSHIP_SOURCE = "engage-local";
export const LEGACY_MEMBERSHIP_SOURCE = "engage-legacy";
export const EXTERNAL_MEMBERSHIP_SOURCE = "underground-crm";

export const FALLBACK_NATIONAL_ID = "__national__";
export const FALLBACK_NATIONAL_NAME = "Fusion National";

export type BranchMembershipSource =
  | typeof LOCAL_MEMBERSHIP_SOURCE
  | typeof LEGACY_MEMBERSHIP_SOURCE
  | typeof EXTERNAL_MEMBERSHIP_SOURCE
  | string;

export interface BranchSubscriptionRecord {
  memberId: string;
  branchId: string;
  status: "following" | "unfollowed";
  source: "member" | "migration";
  createdAt: Date;
  updatedAt: Date;
}

export interface BranchOption {
  branchId: string;
  name: string;
  kind: BranchKind;
  parentBranchId: string | null;
  parentName: string | null;
  /** Fusion National is part of every Engage account and cannot be removed. */
  included: boolean;
  locked: boolean;
  following: boolean;
  verified: boolean;
  branchRole?: "member" | "administrator";
  membershipSource?: BranchMembershipSource;
  /** Only shown to the authorised administrator interface. */
  recognised: boolean;
}

export interface MemberBranchProfile {
  national: BranchOption;
  connected: BranchOption[];
  following: BranchOption[];
  verified: BranchOption[];
  available: BranchOption[];
  all: BranchOption[];
  /** True when the person has chosen at least one state, territory or local branch. */
  hasSelection: boolean;
}

export interface BranchPeopleRow {
  memberId: string;
  name: string;
  email: string;
  branchId: string;
  following: boolean;
  verified: boolean;
  branchRole: "member" | "administrator";
  assignedAt?: string;
  verifiedAt?: string;
  source?: BranchMembershipSource;
}

export interface BranchParticipationCounts {
  followers: number;
  members: number;
  administrators: number;
}

export type EligibilityLevel =
  | "eligible"
  | "follower"
  | "not-connected"
  | "pending-verification"
  | "branch-unavailable"
  | "signed-out";

export interface ParticipationEligibility {
  eligible: boolean;
  level: EligibilityLevel;
  branchId?: string;
  branchName?: string;
  /** Short, human-readable status for a badge or status line. */
  label: string;
  /** A complete explanation suitable for a proposal or ballot page. */
  reason: string;
}

export class BranchParticipationError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = "branch-participation") {
    super(message);
    this.name = "BranchParticipationError";
    this.status = status;
    this.code = code;
  }
}

const KIND_ORDER: Record<string, number> = {
  national: 0,
  state: 1,
  territory: 2,
  constituent: 3,
};
const FOLLOWABLE_KINDS = new Set(["state", "territory", "constituent"]);

function cleanIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0 && item.length <= 120),
    ),
  ];
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: number }).code === 11000
  );
}

function branchKind(value: unknown): BranchKind {
  return ["national", "state", "territory", "constituent"].includes(
    String(value),
  )
    ? (String(value) as BranchKind)
    : "constituent";
}

function fallbackNational(): BranchOption {
  return {
    branchId: FALLBACK_NATIONAL_ID,
    name: FALLBACK_NATIONAL_NAME,
    kind: "national",
    parentBranchId: null,
    parentName: null,
    included: true,
    locked: true,
    following: true,
    verified: false,
    recognised: true,
  };
}

function optionFor(
  branch: Record<string, any>,
  parentName: string | null,
  subscription: { status?: string } | undefined,
  membership: Record<string, any> | undefined,
): BranchOption {
  const included = branch.kind === "national";
  return {
    branchId: String(branch.branchId),
    name: String(branch.name),
    kind: branchKind(branch.kind),
    parentBranchId:
      typeof branch.parentBranchId === "string" ? branch.parentBranchId : null,
    parentName,
    included,
    locked: included,
    following: included || subscription?.status === "following",
    verified: membership?.status === "active",
    ...(membership?.status === "active"
      ? {
          branchRole:
            membership.branchRole === "administrator"
              ? ("administrator" as const)
              : ("member" as const),
          membershipSource: String(
            membership.source ?? LEGACY_MEMBERSHIP_SOURCE,
          ),
        }
      : {}),
    recognised: branch.recognised === true,
  };
}

async function loadParticipationRows(db: Db, memberId: string) {
  const [subscriptions, memberships] = await Promise.all([
    db
      .collection<BranchSubscriptionRecord>(BRANCH_SUBSCRIPTIONS)
      .find({ memberId, status: "following" })
      .toArray(),
    db
      .collection<BranchMembershipRecord>(BRANCH_MEMBERSHIPS)
      .find({ memberId, status: "active" })
      .toArray(),
  ]);
  return { subscriptions, memberships };
}

/**
 * The branch directory used by onboarding and My Engage. National is always
 * present even if an organisation has not yet created the national branch
 * record, so national governance scope is never silently lost.
 */
export async function listBranchOptions(
  db: Db,
  memberId?: string,
): Promise<BranchOption[]> {
  const [branches, participation] = await Promise.all([
    db
      .collection("branches")
      .find({ recognised: true })
      .sort({ name: 1 })
      .toArray(),
    memberId
      ? loadParticipationRows(db, memberId)
      : Promise.resolve({ subscriptions: [], memberships: [] }),
  ]);

  let nationalRow: any = branches.find((branch: any) => branch.kind === "national");
  if (!nationalRow) {
    nationalRow = await db
      .collection("branches")
      .findOne({ kind: "national" } as any);
  }

  const byId = new Map<string, Record<string, any>>();
  for (const branch of branches) byId.set(String(branch.branchId), branch);
  if (nationalRow) byId.set(String(nationalRow.branchId), nationalRow);

  const subscriptionByBranch = new Map(
    participation.subscriptions.map((row) => [row.branchId, row]),
  );
  const membershipByBranch = new Map(
    participation.memberships.map((row) => [row.branchId, row]),
  );

  const rows: BranchOption[] = [];
  if (nationalRow) {
    rows.push(
      optionFor(
        nationalRow,
        null,
        subscriptionByBranch.get(String(nationalRow.branchId)),
        membershipByBranch.get(String(nationalRow.branchId)),
      ),
    );
  } else {
    rows.push(fallbackNational());
  }

  for (const branch of branches) {
    if (branch.kind === "national") continue;
    const parentId =
      typeof branch.parentBranchId === "string" ? branch.parentBranchId : null;
    const parent = parentId
      ? byId.get(parentId)?.name ?? null
      : nationalRow?.name ?? FALLBACK_NATIONAL_NAME;
    rows.push(
      optionFor(
        branch,
        parent,
        subscriptionByBranch.get(String(branch.branchId)),
        membershipByBranch.get(String(branch.branchId)),
      ),
    );
  }

  return rows.sort(
    (left, right) =>
      (KIND_ORDER[left.kind] ?? 9) - (KIND_ORDER[right.kind] ?? 9) ||
      left.name.localeCompare(right.name),
  );
}

export async function getMemberBranchProfile(
  db: Db,
  memberId: string,
): Promise<MemberBranchProfile> {
  const all = await listBranchOptions(db, memberId);
  const national = all.find((branch) => branch.included) ?? fallbackNational();
  const available = all.filter((branch) => !branch.included);
  const following = all.filter((branch) => branch.following && !branch.included);
  const verified = all.filter((branch) => branch.verified && !branch.included);
  const connected = all.filter(
    (branch) => branch.included || branch.following || branch.verified,
  );
  return {
    national,
    connected,
    following,
    verified,
    available,
    all,
    hasSelection: following.length > 0 || verified.length > 0,
  };
}

async function recordSubscriptionEvent(
  db: Db,
  memberId: string,
  branchId: string,
  action: "followed" | "unfollowed",
  actorId = memberId,
) {
  await db.collection(BRANCH_SUBSCRIPTION_EVENTS).insertOne({
    eventId: randomUUID(),
    memberId,
    branchId,
    action,
    actorId,
    createdAt: new Date(),
  });
}

async function applyFollowingChanges(
  db: Db,
  memberId: string,
  followIds: string[],
  unfollowIds: string[],
) {
  const col = db.collection<BranchSubscriptionRecord>(BRANCH_SUBSCRIPTIONS);
  const now = new Date();

  for (const branchId of followIds) {
    const existing = await col.findOne({ memberId, branchId });
    if (existing?.status === "following") continue;
    const source: BranchSubscriptionRecord["source"] =
      existing?.source === "migration" ? "migration" : "member";
    const update = {
      status: "following" as const,
      source,
      updatedAt: now,
    };
    try {
      await col.updateOne(
        { memberId, branchId },
        {
          $set: update,
          $setOnInsert: {
            memberId,
            branchId,
            createdAt: now,
            ...(existing ? {} : { source: "member" }),
          },
        },
        { upsert: true },
      );
    } catch (error) {
      // A concurrent request may have created the same subscription between our
      // read and write. The unique index is the source of truth; retry the
      // update without upserting so duplicate requests stay idempotent.
      if (!isDuplicateKey(error)) throw error;
      await col.updateOne(
        { memberId, branchId },
        { $set: { ...update, source: "member" } },
      );
    }
    // The unique index is authoritative in production. The follow-up keeps the
    // operation safe on storage engines that cannot enforce it (for example the
    // in-memory development database).
    const rows = await col.find({ memberId, branchId }).toArray();
    if (rows.length > 1) {
      for (const extra of rows.slice(1)) {
        await col.deleteOne({ _id: (extra as any)._id } as any);
      }
    }
    await recordSubscriptionEvent(db, memberId, branchId, "followed");
  }

  for (const branchId of unfollowIds) {
    const existing = await col.findOne({ memberId, branchId });
    if (!existing || existing.status !== "following") continue;
    await col.updateOne(
      { memberId, branchId, status: "following" },
      { $set: { status: "unfollowed", updatedAt: now } },
    );
    await recordSubscriptionEvent(db, memberId, branchId, "unfollowed");
  }
}

/**
 * Replace a person's non-national branch following selection. This is used by
 * onboarding and by the "Save my branches" experience. Fusion National is
 * implicit, so it is ignored if submitted and can never be removed.
 */
export async function saveBranchFollowing(
  db: Db,
  memberId: string,
  branchIds: unknown,
): Promise<MemberBranchProfile> {
  const requested = cleanIds(branchIds);
  if (requested.length > 100) {
    throw new BranchParticipationError(
      "Choose no more than 100 branches.",
      400,
      "too-many-branches",
    );
  }

  const branches = requested.length
    ? await db
        .collection("branches")
        .find({ branchId: { $in: requested } })
        .toArray()
    : [];
  const branchById = new Map(
    branches.map((branch: any) => [String(branch.branchId), branch]),
  );
  const unavailable = requested.filter((id) => {
    const branch = branchById.get(id);
    return !branch || branch.recognised !== true;
  });
  if (unavailable.length) {
    throw new BranchParticipationError(
      "One or more branches are no longer available. Refresh the page and try again.",
      409,
      "branch-unavailable",
    );
  }

  const nationalIds = new Set(
    branches
      .filter((branch: any) => branch.kind === "national")
      .map((branch: any) => String(branch.branchId)),
  );
  const requestedSet = new Set(
    requested.filter((id) => !nationalIds.has(id)),
  );

  const current = await db
    .collection<BranchSubscriptionRecord>(BRANCH_SUBSCRIPTIONS)
    .find({ memberId, status: "following" })
    .toArray();
  const currentFollowing = current
    .map((row) => row.branchId)
    .filter((id) => !nationalIds.has(id));

  await applyFollowingChanges(
    db,
    memberId,
    [...requestedSet].filter((id) => !currentFollowing.includes(id)),
    currentFollowing.filter((id) => !requestedSet.has(id)),
  );

  return getMemberBranchProfile(db, memberId);
}

/** Follow or unfollow one branch immediately. */
export async function setBranchFollowing(
  db: Db,
  memberId: string,
  branchId: string,
  following: boolean,
): Promise<MemberBranchProfile> {
  const branch = await db.collection("branches").findOne({ branchId });
  if (!branch) {
    throw new BranchParticipationError(
      "That branch is no longer available.",
      404,
      "branch-not-found",
    );
  }
  if (branch.kind === "national") {
    if (!following) {
      throw new BranchParticipationError(
        "Fusion National is included for every Engage account and cannot be removed.",
        400,
        "national-required",
      );
    }
    return getMemberBranchProfile(db, memberId);
  }
  if (branch.recognised !== true) {
    throw new BranchParticipationError(
      "That branch is not currently open for participation.",
      409,
      "branch-unavailable",
    );
  }
  if (!FOLLOWABLE_KINDS.has(String(branch.kind))) {
    throw new BranchParticipationError(
      "That branch cannot be followed.",
      400,
      "branch-kind",
    );
  }
  await applyFollowingChanges(
    db,
    memberId,
    following ? [branchId] : [],
    following ? [] : [branchId],
  );
  return getMemberBranchProfile(db, memberId);
}

/**
 * Existing members who have never chosen a branch still receive national
 * governance scope. This records a National subscription — never a verified
 * membership fact — so it cannot be mistaken for party membership or a national
 * ballot right. It is idempotent and is safe to call on each visit.
 */
export async function ensureNationalBranchAssignment(
  db: Db,
  memberId: string,
): Promise<boolean> {
  const [subscription, membership] = await Promise.all([
    db.collection(BRANCH_SUBSCRIPTIONS).findOne({ memberId }),
    db.collection(BRANCH_MEMBERSHIPS).findOne({ memberId }),
  ]);
  if (subscription || membership) return false;

  const national = await db
    .collection("branches")
    .findOne({ kind: "national" } as any);
  if (!national) return false;

  const now = new Date();
  try {
    const result = await db.collection(BRANCH_SUBSCRIPTIONS).updateOne(
      { memberId, branchId: String(national.branchId) },
      {
        $setOnInsert: {
          memberId,
          branchId: String(national.branchId),
          status: "following",
          source: "migration",
          autoAssignedNational: true,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
    return Boolean(result.upsertedId);
  } catch (error) {
    if (isDuplicateKey(error)) return false;
    throw error;
  }
}

export async function isVerifiedBranchMember(
  db: Db,
  memberId: string,
  branchId: string,
): Promise<boolean> {
  return Boolean(
    await db
      .collection(BRANCH_MEMBERSHIPS)
      .findOne({ memberId, branchId, status: "active" }),
  );
}

export async function isFollowingBranch(
  db: Db,
  memberId: string,
  branchId: string,
): Promise<boolean> {
  const branch = await db.collection("branches").findOne({ branchId });
  if (branch?.kind === "national") return true;
  return Boolean(
    await db
      .collection(BRANCH_SUBSCRIPTIONS)
      .findOne({ memberId, branchId, status: "following" }),
  );
}

/**
 * A single eligibility decision used by proposal lists, proposal details,
 * digest emails and ballot submission. Followers discover branch activity but
 * never gain the ballot; only an active verified membership qualifies.
 */
export async function getProposalEligibility(
  db: Db,
  proposal: Pick<
    ProposalRecord,
    "jurisdictionBranchId" | "governanceAuthorityBranchId"
  >,
  user: SessionUser | null,
): Promise<ParticipationEligibility> {
  const branchId = proposal.jurisdictionBranchId;
  if (!branchId) {
    if (!user) {
      return {
        eligible: false,
        level: "signed-out",
        label: "Sign in to check eligibility",
        reason: "Sign in to check whether you are eligible to vote.",
      };
    }
    if (!user.canParticipate) {
      return {
        eligible: false,
        level: "pending-verification",
        label: "Membership verification pending",
        reason:
          "Your Engage membership must be verified before you can vote in party-wide ballots.",
      };
    }
    return {
      eligible: true,
      level: "eligible",
      label: "Eligible · Verified member",
      reason: "This ballot is open to verified Engage members.",
    };
  }

  const branch = await db.collection("branches").findOne({ branchId });
  const branchName = branch ? String(branch.name) : "this branch";
  if (!branch || branch.recognised !== true) {
    return {
      eligible: false,
      level: "branch-unavailable",
      branchId,
      branchName,
      label: "Branch ballot unavailable",
      reason:
        "This branch is not currently able to run governance activities. You can still read public proposals.",
    };
  }
  if (!user) {
    return {
      eligible: false,
      level: "signed-out",
      branchId,
      branchName,
      label: "Sign in to check eligibility",
      reason: `Voting is limited to verified ${branchName} members. Sign in to check your status.`,
    };
  }
  if (!user.canParticipate) {
    return {
      eligible: false,
      level: "pending-verification",
      branchId,
      branchName,
      label: "Membership verification pending",
      reason: `Voting is limited to verified ${branchName} members. Your Engage membership is still awaiting verification.`,
    };
  }

  // National governance is included for every verified Engage account. It does
  // not certify party membership by itself; the normal verification gate above
  // still applies. This keeps national ballots open to members who do not hold a
  // separate state or local branch membership.
  if (String(branch.kind) === "national") {
    return {
      eligible: true,
      level: "eligible",
      branchId,
      branchName,
      label: `Eligible · ${branchName}`,
      reason: `This ballot is part of national governance, which is included for every verified Engage account.`,
    };
  }

  const membership = await db
    .collection(BRANCH_MEMBERSHIPS)
    .findOne({ memberId: user.memberId, branchId, status: "active" });
  if (membership) {
    return {
      eligible: true,
      level: "eligible",
      branchId,
      branchName,
      label: `Eligible · ${branchName}`,
      reason: `You are a verified ${branchName} member and can vote in this ballot.`,
    };
  }

  const following = await db
    .collection(BRANCH_SUBSCRIPTIONS)
    .findOne({ memberId: user.memberId, branchId, status: "following" });
  if (following) {
    return {
      eligible: false,
      level: "follower",
      branchId,
      branchName,
      label: `Follower · ${branchName}`,
      reason: `Voting is limited to verified ${branchName} members. You follow this branch, so you can read and follow its proposals, but following does not grant formal voting rights.`,
    };
  }

  return {
    eligible: false,
    level: "not-connected",
    branchId,
    branchName,
    label: `Not eligible · ${branchName}`,
    reason: `Voting is limited to verified ${branchName} members. You can follow the branch to see its updates; a branch administrator can verify your membership when appropriate.`,
  };
}

export async function countBranchParticipation(
  db: Db,
  branchIds: string[],
): Promise<Map<string, BranchParticipationCounts>> {
  const counts = new Map<string, BranchParticipationCounts>();
  await Promise.all(
    branchIds.map(async (branchId) => {
      const [followers, members, administrators] = await Promise.all([
        db
          .collection(BRANCH_SUBSCRIPTIONS)
          .countDocuments({ branchId, status: "following" }),
        db
          .collection(BRANCH_MEMBERSHIPS)
          .countDocuments({ branchId, status: "active" }),
        db.collection(BRANCH_MEMBERSHIPS).countDocuments({
          branchId,
          status: "active",
          branchRole: "administrator",
        }),
      ]);
      counts.set(branchId, { followers, members, administrators });
    }),
  );
  return counts;
}

/**
 * Combined follower and verified-member rows for the administration People
 * view. One person appears once per branch with both facts visible.
 */
export async function listBranchPeople(
  db: Db,
  branchIds: string[],
  search = "",
): Promise<BranchPeopleRow[]> {
  if (!branchIds.length) return [];
  const [subscriptions, memberships] = await Promise.all([
    db
      .collection<BranchSubscriptionRecord>(BRANCH_SUBSCRIPTIONS)
      .find({ branchId: { $in: branchIds }, status: "following" })
      .toArray(),
    db
      .collection<BranchMembershipRecord>(BRANCH_MEMBERSHIPS)
      .find({ branchId: { $in: branchIds }, status: "active" })
      .toArray(),
  ]);

  const memberIds = new Set<string>();
  const membershipByKey = new Map<string, Record<string, any>>();
  for (const row of memberships) {
    memberIds.add(row.memberId);
    membershipByKey.set(`${row.branchId}:${row.memberId}`, row);
  }
  for (const row of subscriptions) memberIds.add(row.memberId);

  const query = search.trim().toLowerCase();
  const { listMembers } = await import("./store.ts");
  const members = await listMembers(db, query);
  const memberById = new Map(members.map((member) => [member.memberId, member]));

  const rows: BranchPeopleRow[] = [];
  const seen = new Set<string>();
  const addRow = (branchId: string, memberId: string) => {
    const key = `${branchId}:${memberId}`;
    if (seen.has(key)) return;
    const member = memberById.get(memberId);
    if (!member) return;
    if (query) {
      const haystack = `${member.name} ${member.email}`.toLowerCase();
      if (!haystack.includes(query)) return;
    }
    const membership = membershipByKey.get(key);
    const following = subscriptions.some(
      (row) => row.branchId === branchId && row.memberId === memberId,
    );
    const verified = Boolean(membership);
    if (!following && !verified) return;
    seen.add(key);
    rows.push({
      memberId,
      name: member.name || "Name not provided",
      email: member.email,
      branchId,
      following,
      verified,
      branchRole:
        membership?.branchRole === "administrator" ? "administrator" : "member",
      assignedAt:
        membership?.assignedAt instanceof Date
          ? membership.assignedAt.toISOString()
          : membership?.verifiedAt instanceof Date
            ? membership.verifiedAt.toISOString()
            : undefined,
      verifiedAt:
        membership?.verifiedAt instanceof Date
          ? membership.verifiedAt.toISOString()
          : undefined,
      source: membership?.source
        ? String(membership.source)
        : membership
          ? LEGACY_MEMBERSHIP_SOURCE
          : undefined,
    });
  };

  for (const branchId of branchIds) {
    for (const memberId of memberIds) addRow(branchId, memberId);
  }

  return rows.sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.branchId.localeCompare(right.branchId),
  );
}

function assertLocalMembershipMutation(
  existing: Record<string, any> | null | undefined,
) {
  if (existing?.source === EXTERNAL_MEMBERSHIP_SOURCE) {
    throw new BranchParticipationError(
      "This membership is managed by the party's membership system. An authorised national administrator must resolve any discrepancy there.",
      409,
      "external-membership-source",
    );
  }
}

async function recordMembershipEvent(
  db: Db,
  input: {
    branchId: string;
    memberId: string;
    action: string;
    actorId: string;
    before: Record<string, any> | null;
    after: Record<string, any>;
    reason?: string;
    source?: string;
  },
) {
  await db.collection(BRANCH_MEMBERSHIP_EVENTS).insertOne({
    eventId: randomUUID(),
    branchId: input.branchId,
    memberId: input.memberId,
    action: input.action,
    actorId: input.actorId,
    before: input.before,
    after: input.after,
    ...(input.reason ? { reason: input.reason } : {}),
    source: input.source ?? LOCAL_MEMBERSHIP_SOURCE,
    createdAt: new Date(),
  });
}

/**
 * Verify a follower as a branch member, or change their governance role.
 * Permissions are checked here as well as at the HTTP boundary.
 */
export async function verifyBranchMember(
  db: Db,
  actor: SessionUser,
  input: {
    branchId: string;
    memberId: string;
    branchRole?: "member" | "administrator";
    reason?: string;
  },
): Promise<Record<string, any>> {
  const branchId = String(input.branchId ?? "").trim();
  const memberId = String(input.memberId ?? "").trim();
  if (!branchId || !memberId) {
    throw new BranchParticipationError(
      "Choose a branch and a person.",
      400,
      "missing-fields",
    );
  }
  if (!canAdministerBranch(actor, branchId)) {
    throw new BranchParticipationError(
      "You are not authorised to manage membership for this branch.",
      403,
      "branch-authority",
    );
  }
  const branchRole =
    input.branchRole === "administrator" ? "administrator" : "member";
  if (branchRole === "administrator" && !actor.isAdmin) {
    throw new BranchParticipationError(
      "Only a national administrator can delegate branch administrator access.",
      403,
      "national-authority",
    );
  }

  const branch = await db.collection("branches").findOne({ branchId });
  if (!branch) {
    throw new BranchParticipationError(
      "That branch is no longer available.",
      404,
      "branch-not-found",
    );
  }
  if (branchRole === "administrator" && branch.recognised !== true) {
    throw new BranchParticipationError(
      "Branch administrator access can only be delegated for a recognised branch.",
      409,
      "branch-unavailable",
    );
  }

  const platformMembership = await db
    .collection("memberships")
    .findOne({ memberId, status: "verified" });
  if (!platformMembership) {
    throw new BranchParticipationError(
      "This person's Engage membership must be verified first.",
      409,
      "platform-verification-required",
    );
  }

  const existing = await db
    .collection<Record<string, any>>(BRANCH_MEMBERSHIPS)
    .findOne({ branchId, memberId });
  assertLocalMembershipMutation(existing);
  if (
    existing?.status === "active" &&
    (existing.branchRole ?? "member") === branchRole
  ) {
    return existing;
  }
  if (!actor.isAdmin && existing?.branchRole === "administrator") {
    throw new BranchParticipationError(
      "Only a national administrator can change a branch administrator assignment.",
      403,
      "national-authority",
    );
  }

  const now = new Date();
  const record = {
    branchId,
    memberId,
    status: "active" as const,
    branchRole,
    source: existing?.source ?? LOCAL_MEMBERSHIP_SOURCE,
    assignedBy: actor.memberId,
    assignedAt: existing?.assignedAt ?? now,
    verifiedBy: actor.memberId,
    verifiedAt: existing?.verifiedAt ?? now,
    updatedAt: now,
    version: Number(existing?.version ?? 0) + 1,
    verification: {
      method: "branch-administrator",
      verifiedAt: existing?.verifiedAt ?? now,
      verifiedBy: actor.memberId,
      ...(input.reason ? { note: input.reason.slice(0, 500) } : {}),
    },
  };

  let updated;
  if (existing) {
    const filter: Record<string, any> = { branchId, memberId };
    if (existing.status !== undefined) filter.status = existing.status;
    if (existing.version !== undefined) filter.version = existing.version;
    updated = await db
      .collection(BRANCH_MEMBERSHIPS)
      .updateOne(filter, { $set: record });
    if (!updated.matchedCount) {
      throw new BranchParticipationError(
        "This membership changed while you were editing it. Reload and try again.",
        409,
        "concurrent-update",
      );
    }
  } else {
    try {
      updated = await db
        .collection(BRANCH_MEMBERSHIPS)
        .updateOne({ branchId, memberId }, { $set: record }, { upsert: true });
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      throw new BranchParticipationError(
        "This membership was just created by someone else. Reload and try again.",
        409,
        "concurrent-update",
      );
    }
  }

  await recordMembershipEvent(db, {
    branchId,
    memberId,
    action:
      existing?.status === "active"
        ? "role-changed"
        : existing
          ? "re-verified"
          : "assigned",
    actorId: actor.memberId,
    before: existing ?? null,
    after: record,
    reason: input.reason,
  });

  const { promotePendingVotePreferences } = await import("./store.ts");
  await promotePendingVotePreferences(db, memberId);
  return record;
}

/** Revoke verified membership. The person keeps their branch subscription. */
export async function revokeBranchMember(
  db: Db,
  actor: SessionUser,
  input: { branchId: string; memberId: string; reason: string },
): Promise<void> {
  const branchId = String(input.branchId ?? "").trim();
  const memberId = String(input.memberId ?? "").trim();
  const reason = String(input.reason ?? "").trim();
  if (!branchId || !memberId) {
    throw new BranchParticipationError(
      "Choose a branch and a person.",
      400,
      "missing-fields",
    );
  }
  if (!canAdministerBranch(actor, branchId)) {
    throw new BranchParticipationError(
      "You are not authorised to manage membership for this branch.",
      403,
      "branch-authority",
    );
  }
  if (reason.length < 3 || reason.length > 500) {
    throw new BranchParticipationError(
      "Give a short reason for removing this membership (3–500 characters).",
      400,
      "reason-required",
    );
  }

  const existing = await db
    .collection<Record<string, any>>(BRANCH_MEMBERSHIPS)
    .findOne({ branchId, memberId, status: "active" });
  if (!existing) {
    throw new BranchParticipationError(
      "Active branch membership not found.",
      404,
      "not-found",
    );
  }
  assertLocalMembershipMutation(existing);
  if (existing.branchRole === "administrator" && !actor.isAdmin) {
    throw new BranchParticipationError(
      "Only a national administrator can revoke delegated branch administrator access.",
      403,
      "national-authority",
    );
  }

  const revokedAt = new Date();
  const filter: Record<string, any> = {
    branchId,
    memberId,
    status: "active",
  };
  if (existing.version !== undefined) filter.version = existing.version;
  const result = await db.collection(BRANCH_MEMBERSHIPS).updateOne(filter, {
    $set: {
      status: "revoked",
      revokedBy: actor.memberId,
      revokedAt,
      revocationReason: reason,
      updatedAt: revokedAt,
      version: Number(existing.version ?? 0) + 1,
    },
  });
  if (!result.modifiedCount) {
    throw new BranchParticipationError(
      "This membership changed while you were editing it. Reload and try again.",
      409,
      "concurrent-update",
    );
  }

  await recordMembershipEvent(db, {
    branchId,
    memberId,
    action: "revoked",
    actorId: actor.memberId,
    before: existing,
    after: {
      ...existing,
      status: "revoked",
      revokedBy: actor.memberId,
      revokedAt,
      revocationReason: reason,
    },
    reason,
  });
}

/**
 * Integration boundary for Underground CRM. The external authority supplies
 * verified organisational membership facts. It may change membership status,
 * but it must never touch `branch_subscriptions` or historical votes.
 */
export async function applyExternalMembership(
  db: Db,
  fact: {
    memberId: string;
    branchId: string;
    status: "active" | "revoked";
    branchRole?: "member" | "administrator";
    externalId?: string;
    verifiedAt?: Date | string;
    reason?: string;
  },
): Promise<Record<string, any>> {
  const memberId = String(fact.memberId ?? "").trim();
  const branchId = String(fact.branchId ?? "").trim();
  if (!memberId || !branchId) {
    throw new BranchParticipationError(
      "External membership records need a person and a branch.",
      400,
      "missing-fields",
    );
  }
  if (!["active", "revoked"].includes(fact.status)) {
    throw new BranchParticipationError(
      "External membership status must be active or revoked.",
      400,
      "invalid-status",
    );
  }
  const branch = await db.collection("branches").findOne({ branchId });
  if (!branch) {
    throw new BranchParticipationError(
      "External membership refers to an unknown branch.",
      404,
      "branch-not-found",
    );
  }

  const existing = await db
    .collection<Record<string, any>>(BRANCH_MEMBERSHIPS)
    .findOne({ branchId, memberId });
  if (
    existing?.source === EXTERNAL_MEMBERSHIP_SOURCE &&
    existing.status === fact.status &&
    (existing.branchRole ?? "member") ===
      (fact.branchRole ?? existing.branchRole ?? "member") &&
    (!fact.externalId ||
      existing.externalMemberId === fact.externalId)
  ) {
    return existing;
  }

  const now = new Date();
  const verifiedAt = fact.verifiedAt ? new Date(fact.verifiedAt) : now;
  const record = {
    branchId,
    memberId,
    status: fact.status,
    branchRole: fact.branchRole ?? existing?.branchRole ?? "member",
    source: EXTERNAL_MEMBERSHIP_SOURCE,
    externalMemberId: fact.externalId,
    assignedAt: existing?.assignedAt ?? verifiedAt,
    verifiedAt: fact.status === "active" ? verifiedAt : existing?.verifiedAt,
    updatedAt: now,
    version: Number(existing?.version ?? 0) + 1,
    verification: {
      method: "external-authority",
      verifiedAt,
      authority: EXTERNAL_MEMBERSHIP_SOURCE,
      ...(fact.reason ? { note: fact.reason.slice(0, 500) } : {}),
    },
    ...(fact.status === "revoked"
      ? {
          revokedAt: now,
          revokedBy: EXTERNAL_MEMBERSHIP_SOURCE,
          revocationReason: fact.reason ?? "Membership ended at the external authority.",
        }
      : {}),
  };

  if (existing) {
    const filter: Record<string, any> = { branchId, memberId };
    if (existing.status !== undefined) filter.status = existing.status;
    if (existing.version !== undefined) filter.version = existing.version;
    const result = await db
      .collection(BRANCH_MEMBERSHIPS)
      .updateOne(filter, { $set: record });
    if (!result.matchedCount) {
      throw new BranchParticipationError(
        "This membership changed during synchronisation. Re-run the sync.",
        409,
        "concurrent-update",
      );
    }
  } else {
    await db
      .collection(BRANCH_MEMBERSHIPS)
      .updateOne({ branchId, memberId }, { $set: record }, { upsert: true });
  }

  await recordMembershipEvent(db, {
    branchId,
    memberId,
    action: fact.status === "active" ? "external-sync" : "external-revoked",
    actorId: `system:${EXTERNAL_MEMBERSHIP_SOURCE}`,
    before: existing ?? null,
    after: record,
    reason: fact.reason,
    source: EXTERNAL_MEMBERSHIP_SOURCE,
  });

  if (fact.status === "active") {
    const { promotePendingVotePreferences } = await import("./store.ts");
    await promotePendingVotePreferences(db, memberId);
  }
  return record;
}

export async function ensureBranchParticipationIndexes(db: Db): Promise<void> {
  await Promise.all([
    db
      .collection(BRANCH_SUBSCRIPTIONS)
      .createIndex({ memberId: 1, branchId: 1 }, { unique: true })
      .catch(() => {}),
    db
      .collection(BRANCH_SUBSCRIPTIONS)
      .createIndex({ branchId: 1, status: 1 })
      .catch(() => {}),
    db
      .collection(BRANCH_SUBSCRIPTIONS)
      .createIndex({ memberId: 1, status: 1 })
      .catch(() => {}),
    db
      .collection(BRANCH_SUBSCRIPTION_EVENTS)
      .createIndex({ eventId: 1 }, { unique: true })
      .catch(() => {}),
    db
      .collection(BRANCH_SUBSCRIPTION_EVENTS)
      .createIndex({ memberId: 1, createdAt: -1 })
      .catch(() => {}),
    db
      .collection(BRANCH_MEMBERSHIPS)
      .createIndex({ branchId: 1, status: 1 })
      .catch(() => {}),
    db
      .collection(BRANCH_MEMBERSHIPS)
      .createIndex({ source: 1, branchId: 1 })
      .catch(() => {}),
  ]);
}

/**
 * Restartable migration. It preserves every existing verification decision:
 * source metadata is added without changing status or role, and existing
 * verified members also receive a following preference so they keep the branch
 * discovery they had before the split. Re-running is safe and does not create
 * duplicate subscriptions.
 */
export async function migrateBranchParticipation(
  db: Db,
  options: { apply?: boolean } = {},
): Promise<{
  applied: boolean;
  annotatedMemberships: number;
  createdSubscriptions: number;
  preservedMemberships: number;
  assignedProposals: number;
}> {
  const apply = options.apply !== false;
  await ensureBranchParticipationIndexes(db);

  const legacy = await db
    .collection<Record<string, any>>(BRANCH_MEMBERSHIPS)
    .find({
      $or: [{ source: { $exists: false } }, { source: null }],
    } as any)
    .toArray();
  const active = await db
    .collection<Record<string, any>>(BRANCH_MEMBERSHIPS)
    .find({ status: "active" })
    .toArray();
  const branches = await db
    .collection("branches")
    .find({})
    .toArray();
  const branchById = new Map(
    branches.map((branch: any) => [String(branch.branchId), branch]),
  );

  let annotated = 0;
  for (const row of legacy) {
    annotated += 1;
    if (!apply) continue;
    const verifiedAt =
      row.verification?.verifiedAt instanceof Date
        ? row.verification.verifiedAt
        : row.assignedAt instanceof Date
          ? row.assignedAt
          : new Date();
    await db.collection(BRANCH_MEMBERSHIPS).updateOne(
      {
        branchId: row.branchId,
        memberId: row.memberId,
        $or: [
          { source: { $exists: false } },
          { source: null },
        ] as any,
      },
      {
        $set: {
          source: LEGACY_MEMBERSHIP_SOURCE,
          version: Number(row.version ?? 0),
          verifiedAt: row.verifiedAt instanceof Date ? row.verifiedAt : verifiedAt,
          verification: row.verification ?? {
            method: "legacy-record",
            verifiedAt,
            note: "Existing verified membership retained during the participation split.",
          },
          migratedAt: new Date(),
        },
      },
    );
  }

  let createdSubscriptions = 0;
  for (const row of legacy) {
    if (row.status !== "active") continue;
    const branch = branchById.get(String(row.branchId));
    if (!branch || branch.kind === "national") continue;
    const existing = await db
      .collection(BRANCH_SUBSCRIPTIONS)
      .findOne({ memberId: row.memberId, branchId: row.branchId });
    if (existing) continue;
    createdSubscriptions += 1;
    if (!apply) continue;
    try {
      await db.collection(BRANCH_SUBSCRIPTIONS).updateOne(
        { memberId: row.memberId, branchId: row.branchId },
        {
          $setOnInsert: {
            memberId: row.memberId,
            branchId: row.branchId,
            status: "following",
            source: "migration",
            migratedFrom: "branch-membership",
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      );
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      createdSubscriptions -= 1;
    }
  }

  // Existing open proposals without a branch context belong to national
  // governance. Branch-owned proposals keep their existing authority and
  // jurisdiction untouched. Completed decisions and their ballot snapshots are
  // never rewritten.
  const nationalBranch = branches.find((branch: any) => branch.kind === "national");
  let assignedProposals = 0;
  if (nationalBranch) {
    const nationalId = String(nationalBranch.branchId);
    const openProposals = await db
      .collection<Record<string, any>>("proposals")
      .find({ stage: { $in: ["propose", "deliberate", "decide"] } } as any)
      .toArray();
    for (const proposal of openProposals) {
      const hasBranchContext = Boolean(
        proposal.governanceAuthorityBranchId || proposal.jurisdictionBranchId,
      );
      if (hasBranchContext) continue;
      const origin = proposal.originatingBranchId;
      if (origin && String(origin) !== nationalId) continue;
      assignedProposals += 1;
      if (!apply) continue;
      const now = new Date();
      await db.collection("proposals").updateOne(
        { proposalId: proposal.proposalId },
        {
          $set: {
            originatingBranchId: origin ?? nationalId,
            governanceAuthorityBranchId: nationalId,
            jurisdictionBranchId: nationalId,
            publicationScope: proposal.publicationScope ?? "national",
            branchScopeMigratedAt: now,
          },
        },
      );
    }
    if (apply && assignedProposals > 0) {
      await db.collection("data_migrations").updateOne(
        { migrationId: "branch-participation-national-scope" },
        {
          $set: {
            migrationId: "branch-participation-national-scope",
            assignedProposals,
            completedAt: new Date(),
          },
        },
        { upsert: true },
      );
    }
  }

  return {
    applied: apply,
    annotatedMemberships: annotated,
    createdSubscriptions,
    preservedMemberships: active.length,
    assignedProposals,
  };
}

/** Member-initiated membership; a per-person database lock serialises switches.
 * A process crash leaves a fail-closed lock for an operator to clear after
 * confirming no change is running. Never expire a lock during a live switch. */
export async function chooseBranchMembership(db: Db, user: SessionUser, input: {branchId: string; join: boolean; resident?: boolean}) {
  if (user.status !== 'verified') throw new BranchParticipationError('Verify your Fusion membership before joining a branch.',403,'verification-required');
  const branch = await db.collection('branches').findOne({branchId:input.branchId,recognised:true});
  if (!branch || !['state','territory','constituent'].includes(branch.kind)) throw new BranchParticipationError('Choose an available branch.',400,'branch-unavailable');
  const geographic = ['state','territory'].includes(branch.kind);
  if (input.join && geographic && input.resident !== true) throw new BranchParticipationError('Confirm that you live in this state or territory.',400,'residence-required');
  const locks = db.collection('branch_membership_locks');
  const { ObjectId } = await import('mongodb');
  const { createHash } = await import('node:crypto');
  const _id = new ObjectId(createHash('sha256').update(user.memberId).digest('hex').slice(0,24));
  try { await locks.insertOne({_id,createdAt:new Date()}); }
  catch (error) { if ((error as {code?:number}).code !== 11000) throw error; throw new BranchParticipationError('A membership change is already in progress. Try again shortly.',409,'membership-busy'); }
  try {
    const branches = await db.collection('branches').find({kind:{$in:geographic?['state','territory']:['constituent']}}).project({branchId:1}).toArray();
    const memberships = await db.collection(BRANCH_MEMBERSHIPS).find({memberId:user.memberId,status:'active',branchId:{$in:branches.map(b=>b.branchId)}}).toArray();
    const now=new Date();
    for (const membership of memberships) {
      if (input.join && membership.branchId===input.branchId) continue;
      if (!input.join && membership.branchId!==input.branchId) continue;
      const after={status:'revoked',revokedAt:now,revokedBy:user.memberId,revocationReason:'Member changed their branch membership.'};
      await recordMembershipEvent(db,{branchId:String(membership.branchId),memberId:user.memberId,actorId:user.memberId,action:'self-left',before:membership,after});
      await db.collection(BRANCH_MEMBERSHIPS).updateOne({memberId:user.memberId,branchId:membership.branchId},{$set:after});
    }
    if(input.join) {
      const existing=await db.collection(BRANCH_MEMBERSHIPS).findOne({memberId:user.memberId,branchId:input.branchId});
      if(existing?.status!=='active') {
        const after={memberId:user.memberId,branchId:input.branchId,status:'active',branchRole:'member',source:LOCAL_MEMBERSHIP_SOURCE,verifiedAt:now,verifiedBy:user.memberId,updatedAt:now,verification:{method:geographic?'member-declared-residence':'member-choice',verifiedAt:now}};
        await recordMembershipEvent(db,{branchId:input.branchId,memberId:user.memberId,actorId:user.memberId,action:'self-joined',before:existing,after});
        await db.collection(BRANCH_MEMBERSHIPS).updateOne({memberId:user.memberId,branchId:input.branchId},{$set:after},{upsert:true});
      }
    }
    return await getMemberBranchProfile(db,user.memberId);
  } finally { await locks.deleteOne({_id}); }
}

export async function ensureNationalMembership(db: Db, memberId: string) {
  const national=await db.collection('branches').findOne({kind:'national',recognised:true});
  if(!national)return;
  await db.collection(BRANCH_MEMBERSHIPS).updateOne({memberId,branchId:national.branchId},{$setOnInsert:{memberId,branchId:national.branchId,status:'active',branchRole:'member',source:LOCAL_MEMBERSHIP_SOURCE,verifiedAt:new Date(),verification:{method:'verified-fusion-member'}}},{upsert:true});
}
