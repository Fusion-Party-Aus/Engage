import { canViewIdentifiableBallots } from "./auth.ts";
import { storedProposalScopeKey } from "./proposal-scope.ts";
import { publicPolicy } from "./public-policy.ts";
import type {
  CommentRecord,
  MemberRecord,
  ProposalSummaryView,
  SessionUser,
  VoteRecord,
} from "./types.ts";

export const PRIVATE_NO_STORE_HEADERS = {
  "cache-control": "private, no-store",
} as const;

export function privateJson(
  data: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "private, no-store");
  return Response.json(data, { ...init, headers });
}

export function parsePagination(
  url: URL,
  options: { defaultLimit?: number; maxLimit?: number } = {},
): { limit: number; offset: number } {
  const defaultLimit = options.defaultLimit ?? 50;
  const maxLimit = options.maxLimit ?? 100;
  const rawLimit = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(rawLimit)
    ? Math.min(maxLimit, Math.max(1, Math.trunc(rawLimit)))
    : defaultLimit;
  const rawOffset = Number(url.searchParams.get("offset") ?? "0");
  const offset = Number.isFinite(rawOffset)
    ? Math.max(0, Math.trunc(rawOffset))
    : 0;
  return { limit, offset };
}

/**
 * Minimal session identity returned by `/api/session`.
 * Excludes internal permission provenance, branch membership arrays, and activity.
 */
export interface SessionIdentityDto {
  memberId: string;
  name: string;
  role: SessionUser["role"];
  roles: NonNullable<SessionUser["roles"]>;
  status: SessionUser["status"];
  canParticipate: boolean;
  isStaff: boolean;
  isAdmin: boolean;
  isBranchAdmin: boolean;
}

export function toSessionIdentityDto(
  user: SessionUser | null | undefined,
): SessionIdentityDto | null {
  if (!user) return null;
  return {
    memberId: user.memberId,
    name: user.name,
    role: user.role,
    roles: user.roles ?? [user.role],
    status: user.status,
    canParticipate: Boolean(user.canParticipate),
    isStaff: Boolean(user.isStaff),
    isAdmin: Boolean(user.isAdmin),
    isBranchAdmin: Boolean(user.isBranchAdmin),
  };
}

/**
 * Public/member-visible proposal summary for collection endpoints.
 * Intentionally omits full `details`, `detailHtml`, `authorId`, and internal fields.
 */
export function toProposalListItemDto(p: ProposalSummaryView) {
  return {
    proposalId: p.proposalId,
    slug: p.slug,
    title: p.title,
    space: p.space,
    spaceSummary: p.spaceSummary ?? "",
    summary: p.summary,
    outcomes: Array.isArray(p.outcomes) ? p.outcomes : [],
    stage: p.stage,
    kind: p.kind ?? "policy",
    scope: storedProposalScopeKey(p),
    ...(p.originatingBranchId
      ? { originatingBranchId: p.originatingBranchId }
      : {}),
    ...(p.governanceAuthorityBranchId
      ? { governanceAuthorityBranchId: p.governanceAuthorityBranchId }
      : {}),
    ...(p.jurisdictionBranchId
      ? { jurisdictionBranchId: p.jurisdictionBranchId }
      : {}),
    ...(p.publicationScope ? { publicationScope: p.publicationScope } : {}),
    ...(p.ballotRevisionId ? { ballotRevisionId: p.ballotRevisionId } : {}),
    ...(p.ballotClosesAt ? { ballotClosesAt: p.ballotClosesAt } : {}),
    ...(p.ballotClosedAt ? { ballotClosedAt: p.ballotClosedAt } : {}),
    // The seconder's member ID stays server-side; members only see that the
    // proposal has been seconded and when deliberation ends.
    seconded: Boolean(p.secondedBy),
    ...(p.secondedAt ? { secondedAt: p.secondedAt } : {}),
    ...(p.deliberationEndsAt
      ? { deliberationEndsAt: p.deliberationEndsAt }
      : {}),
    commentCount: p.commentCount,
    votes: p.votes,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/**
 * Proposal detail representation for `/api/proposals/[proposalId]`.
 * Excludes `authorId` and any raw MongoDB document fields.
 */
export function toProposalDetailDto(p: ProposalSummaryView) {
  return {
    ...toProposalListItemDto(p),
    details: p.details,
    ...(p.detailHtml ? { detailHtml: p.detailHtml } : {}),
    ...(p.provenance ? { provenance: p.provenance } : {}),
    ...(p.attachmentUrl ? { attachmentUrl: p.attachmentUrl } : {}),
    ...(p.attachmentDescription
      ? { attachmentDescription: p.attachmentDescription }
      : {}),
    ...(p.implementationNote
      ? { implementationNote: p.implementationNote }
      : {}),
    ...(p.supersededByProposalId
      ? { supersededByProposalId: p.supersededByProposalId }
      : {}),
    ...(p.supersededByNote ? { supersededByNote: p.supersededByNote } : {}),
    ...(p.authorName ? { authorName: p.authorName } : {}),
  };
}

/**
 * Deliberation comment DTO.
 * Never exposes MongoDB `_id`, `memberId`, `upvoteEvents`, or the `upvotes` memberId list.
 */
export function toCommentDto(
  c: CommentRecord,
  viewer?: SessionUser | null,
) {
  const upvotes = Array.isArray(c.upvotes) ? c.upvotes : [];
  return {
    commentId: c.commentId,
    proposalId: c.proposalId,
    authorName: c.authorName,
    stance: c.stance,
    body: c.body,
    upvoteCount: upvotes.length,
    upvotedByMe: Boolean(viewer && upvotes.includes(viewer.memberId)),
    isMine: Boolean(viewer && c.memberId === viewer.memberId),
    createdAt: c.createdAt,
    ...(c.feedback
      ? {
          feedback: {
            status: c.feedback.status,
            ...(c.feedback.note ? { note: c.feedback.note } : {}),
            updatedByName: c.feedback.updatedByName,
            updatedAt: c.feedback.updatedAt,
            ...(c.feedback.evidence ? { evidence: c.feedback.evidence } : {}),
          },
        }
      : {}),
  };
}

/**
 * Ballot vote DTO for `/api/proposals/[proposalId]`.
 * Only national administrators (`canViewIdentifiableBallots`) receive `memberId` and `authorName`.
 * Never exposes MongoDB `_id`.
 */
export function toBallotVoteDto(
  vote: VoteRecord,
  viewer: SessionUser | null | undefined,
) {
  const base = {
    ballotId: vote.ballotId,
    proposalId: vote.proposalId,
    ...(vote.revisionId ? { revisionId: vote.revisionId } : {}),
    choice: vote.choice,
    ...(vote.reason ? { reason: vote.reason } : {}),
    updatedAt: vote.updatedAt,
  };
  if (canViewIdentifiableBallots(viewer)) {
    return {
      ...base,
      memberId: vote.memberId,
      authorName: vote.authorName,
    };
  }
  return base;
}

/**
 * Amendment DTO.
 * Excludes MongoDB `_id` and internal actor IDs (`authorId`, `ballotOpenedBy`, `appliedBy`, etc.).
 */
export function toAmendmentDto(a: Record<string, any>) {
  return {
    amendmentId: String(a.amendmentId ?? ""),
    proposalId: String(a.proposalId ?? ""),
    baseRevisionId: String(a.baseRevisionId ?? ""),
    currentRevisionId: String(a.currentRevisionId ?? ""),
    changes: a.changes ?? {},
    fields: Array.isArray(a.fields) ? a.fields : [],
    status: String(a.status ?? "proposed"),
    conflicts: Array.isArray(a.conflicts) ? a.conflicts : [],
    createdAt: a.createdAt,
    ...(a.ballotRevisionId ? { ballotRevisionId: a.ballotRevisionId } : {}),
    ...(a.ballotAmendmentRevisionId
      ? { ballotAmendmentRevisionId: a.ballotAmendmentRevisionId }
      : {}),
    ...(a.ballotClosesAt ? { ballotClosesAt: a.ballotClosesAt } : {}),
    ...(a.ballotDecision
      ? {
          ballotDecision: {
            result: a.ballotDecision.result,
            decisionEventId: a.ballotDecision.decisionEventId,
            tally: a.ballotDecision.tally,
            decidedAt: a.ballotDecision.decidedAt,
            revisionId: a.ballotDecision.revisionId,
          },
        }
      : {}),
    ...(a.formalApproval
      ? {
          formalApproval: {
            decisionEventId: a.formalApproval.decisionEventId,
            approvedAt: a.formalApproval.approvedAt,
            baseRevisionId: a.formalApproval.baseRevisionId,
            amendmentRevisionId: a.formalApproval.amendmentRevisionId,
          },
        }
      : {}),
    ...(a.resolution
      ? {
          resolution: {
            outcome: a.resolution.outcome,
            reason: a.resolution.reason,
            resolvedAt: a.resolution.resolvedAt,
          },
        }
      : {}),
    ...(a.appliedRevisionId ? { appliedRevisionId: a.appliedRevisionId } : {}),
    ...(a.appliedAt ? { appliedAt: a.appliedAt } : {}),
    ...(a.rebasedFromRevisionId
      ? { rebasedFromRevisionId: a.rebasedFromRevisionId }
      : {}),
  };
}

/**
 * Explicit allowlist DTO for immutable proposal revisions.
 * Never exposes MongoDB `_id` or `authorId`.
 */
export function toPublicRevisionDto(r: Record<string, any>) {
  return {
    revisionId: String(r.revisionId ?? ""),
    proposalId: String(r.proposalId ?? ""),
    parentRevisionId: r.parentRevisionId ?? null,
    createdAt: r.createdAt,
    snapshot: r.snapshot,
    contentHash: String(r.contentHash ?? ""),
    ...(r.provenance ? { provenance: r.provenance } : {}),
    ...(Array.isArray(r.changes) ? { changes: r.changes } : {}),
  };
}

/**
 * Explicit allowlist DTO for branch records in admin APIs.
 * Excludes MongoDB `_id` and internal `updatedBy`.
 */
export function toBranchDto(b: Record<string, any>) {
  return {
    branchId: String(b.branchId ?? ""),
    name: String(b.name ?? ""),
    kind: String(b.kind ?? ""),
    ...(b.parentBranchId ? { parentBranchId: String(b.parentBranchId) } : {}),
    recognised: Boolean(b.recognised),
    ...(b.createdAt ? { createdAt: b.createdAt } : {}),
  };
}

/**
 * Explicit allowlist DTO for branch referrals.
 * Excludes MongoDB `_id` and `referredBy`.
 */
export function toBranchReferralDto(r: Record<string, any>) {
  return {
    referralId: String(r.referralId ?? ""),
    proposalId: String(r.proposalId ?? ""),
    sourceBranchId: r.sourceBranchId ?? null,
    targetBranchId: String(r.targetBranchId ?? ""),
    reason: String(r.reason ?? ""),
    status: String(r.status ?? "referred"),
    referredAt: r.referredAt,
  };
}

/**
 * Explicit allowlist DTO for policy publication events.
 * Excludes MongoDB `_id`, `idempotencyKey`, `publishedBy`, and `actorId`.
 */
export function toPublicationEventDto(e: Record<string, any>) {
  return {
    eventId: String(e.eventId ?? ""),
    policyId: String(e.policyId ?? ""),
    revisionId: String(e.revisionId ?? ""),
    ...(e.successorPolicyId
      ? { successorPolicyId: String(e.successorPolicyId) }
      : {}),
    ...(e.successorRevisionId
      ? { successorRevisionId: String(e.successorRevisionId) }
      : {}),
    ...(e.jurisdiction !== undefined ? { jurisdiction: e.jurisdiction } : {}),
    ...(e.jurisdictionBranchId !== undefined
      ? { jurisdictionBranchId: e.jurisdictionBranchId }
      : {}),
    status: String(e.status ?? ""),
    ...(e.transition ? { transition: String(e.transition) } : {}),
    ...(e.provenance ? { provenance: e.provenance } : {}),
    ...(e.reason ? { reason: String(e.reason) } : {}),
    ...(e.publishedAt ? { publishedAt: e.publishedAt } : {}),
    ...(e.createdAt ? { createdAt: e.createdAt } : {}),
    ...(e.completedAt ? { completedAt: e.completedAt } : {}),
  };
}

export function toRatifiedPolicyDto(p: Record<string, any>) {
  return publicPolicy(p);
}

/**
 * Explicit allowlist DTO for member in-app notifications.
 * Excludes MongoDB `_id` and `memberId`.
 */
export function toNotificationDto(n: Record<string, any>) {
  return {
    notificationId: String(n.notificationId ?? ""),
    topic: n.topic,
    title: String(n.title ?? ""),
    body: String(n.body ?? ""),
    href: String(n.href ?? ""),
    readAt: n.readAt ?? null,
    createdAt: n.createdAt,
  };
}

/**
 * Explicit allowlist DTO for admin member directory entries.
 */
export function toMemberAccountDto(m: MemberRecord) {
  return {
    memberId: m.memberId,
    name: m.name,
    email: m.email,
    role: m.role,
    roles: m.roles ?? [m.role],
    status: m.status,
    disabled: Boolean(m.disabled),
    emailVerified: Boolean(m.emailVerified),
    ...(m.branchAdministratorOf?.length
      ? { branchAdministratorOf: m.branchAdministratorOf }
      : {}),
    ...(m.delegatedRoles?.length ? { delegatedRoles: m.delegatedRoles } : {}),
    ...(m.createdAt ? { createdAt: m.createdAt } : {}),
  };
}
