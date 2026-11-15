import { ObjectId, type Db } from "mongodb";
import {
  canReviewArchivedProposal,
  canViewProposal,
  normalizeProposalDoc,
} from "./store.ts";
import type {
  CommentRecord,
  CommentStance,
  ProposalRecord,
  ProposalStage,
  SessionUser,
} from "./types.ts";

/**
 * Public member profiles.
 *
 * A profile is a read model over records that already exist: the Better Auth
 * `user` document, `comments`, `proposals`, `amendments` and
 * `branch_memberships`. It is not a second contribution store and it never
 * copies ballot, vote or CRM data.
 *
 * Visibility is viewer-relative. A contribution appears only when the viewer
 * could already open its proposal, so a public profile cannot be used to
 * enumerate private or branch-only matters. Deleted comments and withdrawn
 * amendments are excluded from both the history and comment score.
 *
 * `memberId` is the Better Auth user `_id`. It is opaque, stable and contains
 * no email address, CRM identifier or membership status. Historic comments keep
 * working because they already store the same identifier.
 */

export const MEMBER_BIO_MAX_LENGTH = 500;
export const MEMBER_PROFILE_PAGE_SIZE = 15;
export const MEMBER_PROFILE_TABS = [
  "comments",
  "proposals",
  "amendments",
] as const;

export type MemberProfileTab = (typeof MEMBER_PROFILE_TABS)[number];

export interface MemberProfileStats {
  comments: number;
  proposals: number;
  amendments: number;
  /** Sum of net comment scores across visible, non-deleted comments. */
  commentScore: number;
}

export interface MemberProfileView {
  memberId: string;
  href: string;
  name: string;
  initials: string;
  bio: string;
  joinedAt: Date | null;
  affiliations: string[];
  stats: MemberProfileStats;
}

export interface MemberCommentContribution {
  kind: "comment";
  id: string;
  href: string;
  proposalId: string;
  proposalTitle: string;
  stance: CommentStance;
  body: string;
  score: number;
  isReply: boolean;
  createdAt: Date;
}

export interface MemberProposalContribution {
  kind: "proposal";
  id: string;
  href: string;
  title: string;
  summary: string;
  stage: ProposalStage;
  space: string;
  createdAt: Date;
}

export interface MemberAmendmentContribution {
  kind: "amendment";
  id: string;
  href: string;
  proposalId: string;
  proposalTitle: string;
  title: string;
  status: string;
  fieldCount: number;
  createdAt: Date;
}

export type MemberContribution =
  | MemberCommentContribution
  | MemberProposalContribution
  | MemberAmendmentContribution;

export interface MemberProfilePage {
  profile: MemberProfileView;
  tab: MemberProfileTab;
  items: MemberContribution[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    pageCount: number;
    hasPrevious: boolean;
    hasNext: boolean;
  };
}

export interface MemberProfileLink {
  href: string;
  /** Current display name when an account or contribution establishes one. */
  name: string;
}

export interface GetMemberProfileOptions {
  tab?: string | null;
  page?: number | null;
  viewer?: SessionUser | null;
  pageSize?: number;
}

function asText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date;
  }
  return null;
}

/** Comments before the proposal id was canonical could store `policyId`. */
function commentProposalId(row: Record<string, unknown>): string {
  return asText(row.proposalId || row.policyId);
}

export function profileProposalHref(slug: string): string {
  return `/proposals/${encodeURIComponent(slug)}/`;
}

export function memberProfileHref(memberId: string): string {
  return `/members/${encodeURIComponent(memberId)}/`;
}

export function memberInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "M";
  const first = Array.from(parts[0] ?? "")[0] ?? "M";
  const second = parts.length > 1 ? (Array.from(parts[1] ?? "")[0] ?? "") : "";
  return `${first}${second}`.toUpperCase();
}

export function commentDeepLink(slug: string, commentId: string): string {
  return `${profileProposalHref(slug)}#comment-${commentId}`;
}

export function amendmentDeepLink(slug: string, amendmentId: string): string {
  return `${profileProposalHref(slug)}#amendment-${amendmentId}`;
}

/** Canonicalise a 24-character ObjectId hex string; preserve legacy ids. */
function canonicalMemberId(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (/^[0-9a-fA-F]{24}$/.test(value)) {
    return new ObjectId(value).toHexString();
  }
  return value;
}

function memberIdFilter(memberId: string): Record<string, unknown> {
  const value = memberId.trim();
  if (!value) return { _id: "__missing_member__" };
  if (/^[0-9a-fA-F]{24}$/.test(value)) {
    return { _id: new ObjectId(value) };
  }
  return { _id: value };
}

/**
 * Trim, normalise line endings and cap a biography read from storage. This is
 * deliberately forgiving: an older record must not break a public page.
 */
export function normalizeMemberBio(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u202a-\u202e\u2066-\u2069]/g, "")
    .trim()
    .slice(0, MEMBER_BIO_MAX_LENGTH);
}

/**
 * Validate an owner-supplied biography. Control characters and overlong text
 * are rejected rather than silently truncated, so the saved value is exactly
 * what the member saw in the editor.
 */
export function validateMemberBioInput(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new Error("Biography must be text.");
  }
  const bio = value.replace(/\r\n?/g, "\n").trim();
  if (bio.length > MEMBER_BIO_MAX_LENGTH) {
    throw new Error(
      `Biography must be ${MEMBER_BIO_MAX_LENGTH} characters or fewer.`,
    );
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u202a-\u202e\u2066-\u2069]/.test(bio)) {
    throw new Error("Biography contains unsupported characters.");
  }
  return bio;
}

function resolveTab(value: string | null | undefined): MemberProfileTab {
  return MEMBER_PROFILE_TABS.includes(value as MemberProfileTab)
    ? (value as MemberProfileTab)
    : "comments";
}

function proposalVisibleTo(
  proposal: ProposalRecord,
  viewer: SessionUser | null,
): boolean {
  if (!canViewProposal(proposal, viewer)) return false;
  if (
    proposal.stage === "archived" &&
    !canReviewArchivedProposal(proposal, viewer)
  ) {
    return false;
  }
  return true;
}

function sortByNewest(
  left: { createdAt?: unknown; id: string },
  right: { createdAt?: unknown; id: string },
): number {
  const leftTime = asDate(left.createdAt)?.getTime() ?? 0;
  const rightTime = asDate(right.createdAt)?.getTime() ?? 0;
  return rightTime - leftTime || right.id.localeCompare(left.id);
}

interface ProfileIdentity {
  name: string;
  bio: string;
  joinedAt: Date | null;
  affiliations: string[];
}

async function loadAffiliations(db: Db, memberId: string): Promise<string[]> {
  const memberships = await db
    .collection<{ branchId: string }>("branch_memberships")
    .find({ memberId, status: "active" })
    .project({ branchId: 1 })
    .toArray();
  const branchIds = [
    ...new Set(
      memberships
        .map((membership) => asText(membership.branchId))
        .filter(Boolean),
    ),
  ];
  if (branchIds.length === 0) return [];

  const branches = await db
    .collection<{ branchId: string; name: string; kind?: string }>("branches")
    .find({ branchId: { $in: branchIds }, recognised: true })
    .project({ branchId: 1, name: 1, kind: 1 })
    .toArray();
  const order: Record<string, number> = { national: 0, state: 1, territory: 2 };
  return branches
    .filter((branch) => branch.kind !== "constituent")
    .sort(
      (left, right) =>
        (order[String(left.kind)] ?? 9) - (order[String(right.kind)] ?? 9) ||
        left.name.localeCompare(right.name),
    )
    .map((branch) =>
      branch.kind === "national" ? "National member" : branch.name,
    )
    .filter((name, index, all) => Boolean(name) && all.indexOf(name) === index);
}

async function loadProfileIdentity(
  db: Db,
  memberId: string,
  viewer: SessionUser | null,
): Promise<ProfileIdentity | null> {
  const account = await db
    .collection("user")
    .findOne(memberIdFilter(memberId));
  if (account) {
    if (account.disabled === true) return null;
    return {
      name: asText(account.name) || "Member",
      bio: normalizeMemberBio(account.bio),
      joinedAt: asDate(account.createdAt),
      affiliations: await loadAffiliations(db, memberId),
    };
  }

  // A historic contribution can outlive its account document. Derive a display
  // name only from a contribution the viewer can already open; never invent one
  // and never reveal a name that exists only behind a private proposal. This
  // also keeps the development session's synthetic accounts usable.
  const [comments, proposals, amendment] = await Promise.all([
    db
      .collection<CommentRecord>("comments")
      .find({ memberId })
      .sort({ createdAt: -1 })
      .project({ proposalId: 1, policyId: 1, authorName: 1 })
      .toArray(),
    db
      .collection<ProposalRecord>("proposals")
      .find({ authorId: memberId })
      .sort({ createdAt: -1 })
      .project({ detailHtml: 0, details: 0 })
      .toArray(),
    db.collection("amendments").findOne({ authorId: memberId }),
  ]);

  const proposalIds = [
    ...new Set(
      [
        ...comments.map((row) =>
          commentProposalId(row as Record<string, unknown>),
        ),
        amendment ? asText(amendment.proposalId) : "",
      ].filter(Boolean),
    ),
  ];
  const proposalRows = proposalIds.length
    ? await db
        .collection<ProposalRecord>("proposals")
        .find({ proposalId: { $in: proposalIds } })
        .project({ detailHtml: 0, details: 0 })
        .toArray()
    : [];
  const visibleProposals = new Set<string>();
  for (const row of proposalRows) {
    const proposal = normalizeProposalDoc(row);
    if (proposalVisibleTo(proposal, viewer)) {
      visibleProposals.add(proposal.proposalId);
    }
  }

  const storedCommentName = comments
    .filter((row) =>
      visibleProposals.has(commentProposalId(row as Record<string, unknown>)),
    )
    .map((row) => asText(row.authorName))
    .find(Boolean);
  const storedProposalName = proposals
    .map((row) => normalizeProposalDoc(row))
    .filter((proposal) => proposalVisibleTo(proposal, viewer))
    .map((proposal) => asText(proposal.authorName))
    .find(Boolean);
  const amendmentVisible = Boolean(
    amendment && visibleProposals.has(asText(amendment.proposalId)),
  );
  const name =
    storedCommentName || storedProposalName || (amendmentVisible ? "Member" : "");
  if (!name) return null;
  return { name, bio: "", joinedAt: null, affiliations: [] };
}

async function commentScoreTotal(
  db: Db,
  filter: Record<string, unknown>,
): Promise<number> {
  const collection = db.collection<CommentRecord>("comments");
  // Real MongoDB sums in the database. The development/test database accepts
  // aggregate but does not implement `$group`, so fall through to the explicit
  // sum when the grouped value is absent.
  if (typeof (collection as unknown as { aggregate?: unknown }).aggregate === "function") {
    const rows = await collection
      .aggregate([
        { $match: filter },
        {
          $project: {
            score: {
              $subtract: [
                { $size: { $ifNull: ["$upvotes", []] } },
                { $size: { $ifNull: ["$downvotes", []] } },
              ],
            },
          },
        },
        { $group: { _id: null, commentScore: { $sum: "$score" } } },
      ])
      .toArray();
    if (rows.length === 0) return 0;
    if (typeof rows[0]?.commentScore === "number") return rows[0].commentScore;
  }
  const rows = await collection
    .find(filter)
    .project({ upvotes: 1, downvotes: 1 })
    .toArray();
  return rows.reduce(
    (total, row) =>
      total +
      (Array.isArray(row.upvotes) ? row.upvotes.length : 0) -
      (Array.isArray(row.downvotes) ? row.downvotes.length : 0),
    0,
  );
}

export async function getMemberBioSettings(
  db: Db,
  memberId: string,
): Promise<string> {
  const account = await db
    .collection("user")
    .findOne(memberIdFilter(memberId), { projection: { bio: 1 } });
  return normalizeMemberBio(account?.bio);
}

export async function saveMemberBio(
  db: Db,
  user: SessionUser,
  rawBio: unknown,
): Promise<string> {
  const bio = validateMemberBioInput(rawBio);
  const result = await db.collection("user").updateOne(
    memberIdFilter(user.memberId),
    { $set: { bio, bioUpdatedAt: new Date() } },
  );
  if (!result.matchedCount) {
    throw new Error("Account record not found.");
  }
  return bio;
}

/**
 * Resolve author identifiers to profile links.
 *
 * Callers pass identifiers taken from records that already exist
 * (`comments.memberId`, `proposals.authorId`, `amendments.authorId`), so a
 * missing account document can still be linked: the read model falls back to
 * the author name stored on the contribution. Disabled accounts are suppressed
 * and render as plain text.
 */
export async function resolveMemberProfileLinks(
  db: Db,
  memberIds: Iterable<string | null | undefined>,
): Promise<Map<string, MemberProfileLink>> {
  const requested = [
    ...new Set(
      [...memberIds]
        .map((value) => canonicalMemberId(String(value ?? "")))
        .filter(Boolean),
    ),
  ];
  const links = new Map<string, MemberProfileLink>();
  if (requested.length === 0) return links;

  const candidates: any[] = [];
  for (const id of requested) {
    candidates.push(id);
    if (/^[0-9a-f]{24}$/.test(id)) {
      candidates.push(new ObjectId(id));
    }
  }

  const users = await db
    .collection("user")
    .find({ _id: { $in: candidates } })
    .project({ _id: 1, name: 1, disabled: 1 })
    .toArray();
  const names = new Map<string, string>();
  const suppressed = new Set<string>();
  for (const account of users) {
    const id = canonicalMemberId(String(account._id));
    if (account.disabled === true) {
      suppressed.add(id);
      continue;
    }
    const name = asText(account.name);
    if (name) names.set(id, name);
  }

  for (const id of requested) {
    if (suppressed.has(id)) continue;
    links.set(id, {
      href: memberProfileHref(id),
      name: names.get(id) ?? "",
    });
  }
  return links;
}

async function loadProfileContributions(
  db: Db,
  memberId: string,
  viewer: SessionUser | null,
) {
  const [commentProposalRows, authoredRows, amendmentRows] = await Promise.all([
    db
      .collection<CommentRecord>("comments")
      .find({ memberId })
      .project({ proposalId: 1, policyId: 1 })
      .toArray(),
    db
      .collection<ProposalRecord>("proposals")
      .find({ authorId: memberId })
      .project({ detailHtml: 0, details: 0 })
      .toArray(),
    db
      .collection("amendments")
      .find({ authorId: memberId, status: { $ne: "withdrawn" } })
      .toArray(),
  ]);

  const referencedProposalIds = new Set<string>();
  for (const row of commentProposalRows) {
    const proposalId = commentProposalId(row as Record<string, unknown>);
    if (proposalId) referencedProposalIds.add(proposalId);
  }
  for (const row of amendmentRows) {
    const proposalId = asText(row.proposalId);
    if (proposalId) referencedProposalIds.add(proposalId);
  }

  const proposalRows = referencedProposalIds.size
    ? await db
        .collection<ProposalRecord>("proposals")
        .find({ proposalId: { $in: [...referencedProposalIds] } })
        .project({ detailHtml: 0, details: 0 })
        .toArray()
    : [];

  const visibleProposals = new Map<string, ProposalRecord>();
  for (const row of proposalRows) {
    const proposal = normalizeProposalDoc(row);
    if (proposalVisibleTo(proposal, viewer)) {
      visibleProposals.set(proposal.proposalId, proposal);
    }
  }

  const visibleAuthored: ProposalRecord[] = [];
  for (const row of authoredRows) {
    const proposal = normalizeProposalDoc(row);
    if (proposalVisibleTo(proposal, viewer)) {
      visibleAuthored.push(proposal);
    }
  }
  visibleAuthored.sort((left, right) =>
    sortByNewest(
      { createdAt: left.createdAt, id: left.proposalId },
      { createdAt: right.createdAt, id: right.proposalId },
    ),
  );

  const visibleAmendments = amendmentRows
    .filter((row) => visibleProposals.has(asText(row.proposalId)))
    .sort((left, right) =>
      sortByNewest(
        { createdAt: left.createdAt, id: String(left.amendmentId) },
        { createdAt: right.createdAt, id: String(right.amendmentId) },
      ),
    );

  return {
    visibleProposals,
    visibleAuthored,
    visibleAmendments,
  };
}

/**
 * Build the public profile and one paginated tab.
 *
 * Returns null when the identifier has no account and no historic contribution
 * to establish an author, or when the account is disabled.
 */
export async function getMemberProfilePage(
  db: Db,
  rawMemberId: string,
  options: GetMemberProfileOptions = {},
): Promise<MemberProfilePage | null> {
  const memberId = canonicalMemberId(String(rawMemberId ?? ""));
  if (!memberId) return null;

  const identity = await loadProfileIdentity(db, memberId, options.viewer ?? null);
  if (!identity) return null;

  const viewer = options.viewer ?? null;
  const tab = resolveTab(options.tab);
  const pageSize =
    Number.isFinite(options.pageSize) && Number(options.pageSize) > 0
      ? Math.min(50, Math.max(1, Math.trunc(Number(options.pageSize))))
      : MEMBER_PROFILE_PAGE_SIZE;

  const { visibleProposals, visibleAuthored, visibleAmendments } =
    await loadProfileContributions(db, memberId, viewer);

  const visibleCommentProposalIds = [...visibleProposals.keys()];
  const commentFilter: Record<string, unknown> | null =
    visibleCommentProposalIds.length > 0
      ? {
          memberId,
          deletedAt: { $exists: false },
          $or: [
            { proposalId: { $in: visibleCommentProposalIds } },
            { policyId: { $in: visibleCommentProposalIds } },
          ],
        }
      : null;

  const [commentTotal, commentScore] = commentFilter
    ? await Promise.all([
        db.collection<CommentRecord>("comments").countDocuments(commentFilter),
        commentScoreTotal(db, commentFilter),
      ])
    : [0, 0];

  const stats: MemberProfileStats = {
    comments: commentTotal,
    proposals: visibleAuthored.length,
    amendments: visibleAmendments.length,
    commentScore,
  };

  const activeTotal =
    tab === "comments"
      ? commentTotal
      : tab === "proposals"
        ? visibleAuthored.length
        : visibleAmendments.length;
  const pageCount = Math.max(1, Math.ceil(activeTotal / pageSize));
  const requestedPage = Number.isFinite(options.page)
    ? Math.trunc(Number(options.page))
    : 1;
  const page = Math.min(Math.max(1, requestedPage), pageCount);
  const offset = (page - 1) * pageSize;

  let items: MemberContribution[] = [];
  if (tab === "comments" && commentFilter) {
    const rows = await db
      .collection<CommentRecord>("comments")
      .find(commentFilter)
      .project({
        commentId: 1,
        proposalId: 1,
        policyId: 1,
        parentCommentId: 1,
        stance: 1,
        body: 1,
        upvotes: 1,
        downvotes: 1,
        createdAt: 1,
      })
      .sort({ createdAt: -1, commentId: -1 })
      .skip(offset)
      .limit(pageSize)
      .toArray();
    items = rows.flatMap((row) => {
      const proposal = visibleProposals.get(
        commentProposalId(row as Record<string, unknown>),
      );
      if (!proposal) return [];
      const commentId = asText(row.commentId);
      if (!commentId) return [];
      return [
        {
          kind: "comment" as const,
          id: commentId,
          href: commentDeepLink(proposal.slug, commentId),
          proposalId: proposal.proposalId,
          proposalTitle: proposal.title,
          stance: row.stance,
          body: asText(row.body),
          score:
            (Array.isArray(row.upvotes) ? row.upvotes.length : 0) -
            (Array.isArray(row.downvotes) ? row.downvotes.length : 0),
          isReply: Boolean(row.parentCommentId),
          createdAt: asDate(row.createdAt) ?? new Date(0),
        },
      ];
    });
  } else if (tab === "proposals") {
    items = visibleAuthored
      .slice(offset, offset + pageSize)
      .map((proposal) => ({
        kind: "proposal" as const,
        id: proposal.proposalId,
        href: profileProposalHref(proposal.slug),
        title: proposal.title,
        summary: proposal.summary,
        stage: proposal.stage,
        space: proposal.space,
        createdAt: proposal.createdAt,
      }));
  } else if (tab === "amendments") {
    const pageAmendments = visibleAmendments.slice(offset, offset + pageSize);
    const revisionIds = [
      ...new Set(
        pageAmendments
          .map((row) => asText(row.currentRevisionId))
          .filter(Boolean),
      ),
    ];
    const revisions = revisionIds.length
      ? await db
          .collection("amendment_revisions")
          .find({ revisionId: { $in: revisionIds } })
          .project({ revisionId: 1, snapshot: 1 })
          .toArray()
      : [];
    const revisionsById = new Map(
      revisions.map((row) => [asText(row.revisionId), row]),
    );
    items = pageAmendments.flatMap((row) => {
      const proposal = visibleProposals.get(asText(row.proposalId));
      const amendmentId = asText(row.amendmentId);
      if (!proposal || !amendmentId) return [];
      const revision = revisionsById.get(asText(row.currentRevisionId));
      const snapshot =
        revision?.snapshot && typeof revision.snapshot === "object"
          ? (revision.snapshot as Record<string, unknown>)
          : row.changes && typeof row.changes === "object"
            ? (row.changes as Record<string, unknown>)
            : {};
      return [
        {
          kind: "amendment" as const,
          id: amendmentId,
          href: amendmentDeepLink(proposal.slug, amendmentId),
          proposalId: proposal.proposalId,
          proposalTitle: proposal.title,
          title: asText(snapshot.title) || "Wording amendment",
          status: asText(row.status) || "proposed",
          fieldCount: Array.isArray(row.fields)
            ? row.fields.length
            : Object.keys(snapshot).length,
          createdAt: asDate(row.createdAt) ?? new Date(0),
        },
      ];
    });
  }

  return {
    profile: {
      memberId,
      href: memberProfileHref(memberId),
      name: identity.name,
      initials: memberInitials(identity.name),
      bio: identity.bio,
      joinedAt: identity.joinedAt,
      affiliations: identity.affiliations,
      stats,
    },
    tab,
    items,
    pagination: {
      page,
      pageSize,
      total: activeTotal,
      pageCount,
      hasPrevious: page > 1,
      hasNext: page < pageCount,
    },
  };
}
