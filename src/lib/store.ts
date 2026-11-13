import { recordLifecycle, recordParticipation, notePriorParticipation } from "./member-lifecycle.ts";
import { loadBallotCryptoConfig } from "./ballot-crypto.ts";
import { BALLOTS_COLLECTION, FORMAL_DECISIONS_COLLECTION } from "./ballots.ts";
import { runInTransaction } from "./db.ts";
import { recordGovernanceEvent } from "./governance-relationships.ts";
import {
  PROPOSAL_VOTES,
  buildEncryptedVoteFields,
  computeAllBlindIndexesForMember,
  decodeStoredVote,
  findMemberVotes,
  proposalBallotId,
} from "./vote-storage.ts";
import { ObjectId, type ClientSession, type Db } from "mongodb";
import { validPersonName } from "./auth.ts";
import { RBAC_ASSIGNMENTS, RBAC_ROLES } from "./roles-store.ts";
import {
  ALL_NATIONAL_PERMISSIONS,
  LEGACY_MODERATOR_PERMISSIONS,
  canGrantPermissionSet,
  hasPermission,
  normalisePlatformRoles,
  primaryPlatformRole,
} from "./rbac.ts";
import type {
  CommentRecord,
  CommentStance,
  ContributionFeedback,
  ContributionFeedbackEvidence,
  ContributionFeedbackEvidenceKind,
  ContributionFeedbackHistoryEntry,
  ContributionFeedbackStatus,
  MemberRecord,
  MembershipStatus,
  PendingVotePreferenceRecord,
  PolicyProvenance,
  ProposalKind,
  ProposalRecord,
  ProposalStage,
  ProposalSummaryView,
  ProvenanceLink,
  SessionUser,
  UserRole,
  VoteChoice,
  VoteRecord,
  VoteTally,
} from "./types.ts";
import { createHash, randomUUID } from "node:crypto";

import { ballotExpired } from "./ballot-deadline.ts";
import {
  geographicScopeForBranch,
  parseProposalScopeInput,
} from "./proposal-scope.ts";
import {
  matterHasCapability,
  normalizeMatterType,
  validateMatterTransition,
} from "./matters.ts";

export const PENDING_VOTE_PREFERENCES = "pending_vote_preferences";

export function isGovernanceResolution(proposal: {
  kind?: string;
  proposalId?: string;
  policyId?: string;
}): boolean {
  const id = String(proposal.proposalId ?? proposal.policyId ?? "");
  return normalizeKind(proposal.kind, id) === "resolution";
}

export function isPolicyProposal(proposal: {
  kind?: string;
  proposalId?: string;
  policyId?: string;
}): boolean {
  try {
    return matterHasCapability(proposal, "supportsPolicyPublication");
  } catch {
    return false;
  }
}

export function isPolicyRegistryRecordForResolution(
  policy: { policyId?: string; proposalId?: string; kind?: string },
  linkedProposal?: { kind?: string; proposalId?: string } | null,
): boolean {
  if (linkedProposal) {
    return isGovernanceResolution(linkedProposal);
  }
  return isGovernanceResolution({
    kind: policy.kind,
    proposalId: String(policy.proposalId ?? policy.policyId ?? ""),
  });
}

export function getDefaultProvenanceLabel(
  category: string,
  kind: ProposalKind = "policy",
): string {
  const isResolution = kind === "resolution";
  switch (category) {
    case "existing-repackaged":
      return isResolution
        ? "Preceding resolution · Equivalence unverified"
        : "Approved policy predecessor · Equivalence unverified";
    case "materially-revised":
      return isResolution
        ? "Preceding resolution · Materially revised"
        : "Approved policy predecessor · Materially revised";
    case "new-proposal":
      return isResolution
        ? "New resolution · No prior authority identified"
        : "New proposal · No prior policy identified";
    case "party-governance":
      return "Party Governance · Platform Review";
    case "draft-derived":
      return "Draft branch predecessor · Unapproved";
    case "unverified":
    default:
      return "Mapping unverified";
  }
}

export const VALID_STAGES: ProposalStage[] = [
  "propose",
  "deliberate",
  "decide",
  "implement",
  "archived",
];

export const VALID_KINDS: ProposalKind[] = ["policy", "resolution"];

export const VALID_STANCES: CommentStance[] = [
  "support",
  "concern",
  "amendment",
  "comment",
];

export function isValidStage(value: unknown): value is ProposalStage {
  if (typeof value !== "string") return false;
  const raw = value.trim().toLowerCase();
  return (
    VALID_STAGES.includes(raw as ProposalStage) ||
    ["draft", "open", "voting", "adopted"].includes(raw)
  );
}

export function normalizeStage(
  value: unknown,
  fallback: ProposalStage = "deliberate",
): ProposalStage {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "propose" || raw === "draft") return "propose";
  if (raw === "deliberate" || raw === "open") return "deliberate";
  if (raw === "decide" || raw === "voting") return "decide";
  if (raw === "implement" || raw === "adopted") return "implement";
  if (raw === "archived") return "archived";
  return fallback;
}

export function normalizeKind(value: unknown, proposalId = ""): ProposalKind {
  return normalizeMatterType(value, proposalId) as ProposalKind;
}

export function validateStageTransition(
  fromStage: ProposalStage,
  toStage: ProposalStage,
  kind: ProposalKind | string = "policy",
): void {
  const matterType = normalizeMatterType(kind);
  validateMatterTransition(matterType, fromStage, toStage);
}

export function isProposalLocked(
  stage: ProposalStage,
  voteCount: number,
): boolean {
  return stage === "decide" || voteCount > 0;
}

export function parseOutcomes(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((o) => String(o).trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw
      .split("\n")
      .map((line) => line.replace(/^[-*•\d.)\s]+/, "").trim())
      .filter(Boolean);
  }
  return [];
}

export function getSubstantiveChanges(
  existing: ProposalRecord,
  updates: {
    title?: string;
    summary?: string;
    outcomes?: string[];
    details?: string;
    attachmentUrl?: string;
    attachmentDescription?: string;
    kind?: string;
    branch?: string;
  },
): string[] {
  const changes: string[] = [];
  if (
    updates.title !== undefined &&
    updates.title.trim() !== existing.title.trim()
  ) {
    changes.push("title");
  }
  if (
    updates.summary !== undefined &&
    updates.summary.trim() !== existing.summary.trim()
  ) {
    changes.push("summary");
  }
  if (
    updates.details !== undefined &&
    updates.details.trim() !== (existing.details || "").trim()
  ) {
    changes.push("details");
  }
  if (
    updates.attachmentUrl !== undefined &&
    (updates.attachmentUrl.trim() || undefined) !==
      (existing.attachmentUrl?.trim() || undefined)
  ) {
    changes.push("attachmentUrl");
  }
  if (
    updates.attachmentDescription !== undefined &&
    (updates.attachmentDescription.trim() || undefined) !==
      (existing.attachmentDescription?.trim() || undefined)
  ) {
    changes.push("attachmentDescription");
  }
  if (
    updates.kind !== undefined &&
    normalizeKind(updates.kind, existing.proposalId) !==
      normalizeKind(existing.kind, existing.proposalId)
  ) {
    changes.push("kind");
  }
  if (updates.outcomes !== undefined) {
    const existingOutcomes = (existing.outcomes || [])
      .map((o) => o.trim())
      .filter(Boolean);
    const newOutcomes = updates.outcomes.map((o) => o.trim()).filter(Boolean);
    if (
      existingOutcomes.length !== newOutcomes.length ||
      existingOutcomes.some((val, idx) => val !== newOutcomes[idx])
    ) {
      changes.push("outcomes");
    }
  }
  return changes;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function normalizeProposalDoc(raw: any): ProposalRecord {
  const proposalId = String(raw.proposalId || raw.policyId || "");
  const space = String(raw.space || raw.category || "General");
  const summary = String(raw.summary || raw.statement || "");
  const stage = normalizeStage(raw.stage || raw.status || "deliberate");
  let kind: ProposalKind | string = "policy";
  try {
    kind = normalizeKind(raw.kind, proposalId);
  } catch {
    kind = typeof raw.kind === "string" && raw.kind.trim()
      ? raw.kind.trim().toLowerCase()
      : "policy";
  }
  return {
    proposalId,
    slug: String(raw.slug || slugify(raw.title || proposalId)),
    title: String(raw.title || ""),
    space,
    spaceSummary: String(raw.spaceSummary || raw.categorySummary || ""),
    summary,
    outcomes: Array.isArray(raw.outcomes) ? raw.outcomes : [],
    details: String(raw.details || ""),
    detailHtml: raw.detailHtml ? String(raw.detailHtml) : undefined,
    provenance: raw.provenance || undefined,
    attachmentUrl: raw.attachmentUrl ? String(raw.attachmentUrl) : undefined,
    attachmentDescription: raw.attachmentDescription
      ? String(raw.attachmentDescription).trim()
      : undefined,
    stage,
    kind,
    ...(typeof raw.scope === "string" && raw.scope.trim()
      ? { scope: raw.scope.trim() }
      : {}),
    originatingBranchId: raw.originatingBranchId
      ? String(raw.originatingBranchId)
      : undefined,
    governanceAuthorityBranchId: raw.governanceAuthorityBranchId
      ? String(raw.governanceAuthorityBranchId)
      : undefined,
    jurisdictionBranchId: raw.jurisdictionBranchId
      ? String(raw.jurisdictionBranchId)
      : undefined,
    publicationScope:
      raw.publicationScope === "private" ||
      raw.publicationScope === "branch" ||
      raw.publicationScope === "national"
        ? raw.publicationScope
        : undefined,
    ballotRevisionId: raw.ballotRevisionId
      ? String(raw.ballotRevisionId)
      : undefined,
    ballotClosesAt: raw.ballotClosesAt ? new Date(raw.ballotClosesAt) : undefined,
    implementationNote: raw.implementationNote
      ? String(raw.implementationNote)
      : undefined,
    supersededByProposalId: raw.supersededByProposalId
      ? String(raw.supersededByProposalId)
      : undefined,
    supersededByNote:
      raw.supersededByProposalId && raw.supersededByNote
        ? String(raw.supersededByNote)
        : undefined,
    authorId: raw.authorId ? String(raw.authorId) : undefined,
    authorName: raw.authorName ? String(raw.authorName) : undefined,
    createdAt: raw.createdAt ? new Date(raw.createdAt) : new Date(),
    updatedAt: raw.updatedAt ? new Date(raw.updatedAt) : new Date(),

    // Backwards compatibility aliases
    policyId: proposalId,
    category: space,
    categorySummary: String(raw.spaceSummary || raw.categorySummary || ""),
    statement: summary,
    status: stage,
    division: raw.division || space,
  };
}

export async function listProposals(
  db: Db,
  options: {
    includeArchived?: boolean;
    search?: string;
    space?: string;
    stage?: string;
    // Backwards compatibility filter options
    category?: string;
    status?: string;
    kind?: string;
    includeDrafts?: boolean;
    branch?: string;
    user?: SessionUser | null;
  } = {},
): Promise<ProposalSummaryView[]> {
  const rawProposals = await db
    .collection<ProposalRecord>("proposals")
    .find({})
    .sort({ proposalId: 1 })
    .toArray();

  const allProposals = rawProposals.map(normalizeProposalDoc);

  const cryptoConfig = loadBallotCryptoConfig(process.env);
  const [allComments, allVotes] = await Promise.all([
    db
      .collection<CommentRecord>("comments")
      .find({})
      .project({ proposalId: 1, policyId: 1 })
      .toArray(),
    db
      .collection<VoteRecord>(PROPOSAL_VOTES)
      .find({})
      .project({
        proposalId: 1,
        policyId: 1,
        ballotId: 1,
        revisionId: 1,
        amendmentRevisionId: 1,
        choice: 1,
        voterBlindIndex: 1,
        voteEnvelope: 1,
      })
      .toArray(),
  ]);

  const commentCounts = new Map<string, number>();
  for (const c of allComments) {
    const id = c.proposalId || (c as any).policyId;
    if (id) commentCounts.set(id, (commentCounts.get(id) ?? 0) + 1);
  }

  const voteMap = new Map<string, VoteTally>();
  for (const v of allVotes) {
    const id = v.proposalId || (v as any).policyId;
    if (!id) continue;
    if (v.ballotId !== proposalBallotId(id)) continue;
    const decoded = decodeStoredVote(v as Record<string, any>, cryptoConfig);
    const current = voteMap.get(id) ?? {
      approve: 0,
      abstain: 0,
      reject: 0,
      total: 0,
    };
    if (decoded.choice === "approve") current.approve += 1;
    else if (decoded.choice === "abstain") current.abstain += 1;
    else current.reject += 1;
    current.total += 1;
    voteMap.set(id, current);
  }

  const query = (options.search ?? "").trim().toLowerCase();
  const spaceFilter = (options.space ?? options.category ?? "").trim();
  const stageFilter =
    (options.stage && options.stage !== "all") ||
    (options.status && options.status !== "all")
      ? normalizeStage(options.stage ?? options.status)
      : "";
  const allowArchived =
    options.includeArchived ?? options.includeDrafts ?? false;

  return allProposals
    .filter((p) => {
      if (!allowArchived && p.stage === "archived") {
        return false;
      }
      if (
        options.user !== undefined &&
        p.stage === "archived" &&
        !canReviewArchivedProposal(p, options.user)
      ) {
        return false;
      }
      if (options.user !== undefined && !canViewProposal(p, options.user))
        return false;
      if (spaceFilter && spaceFilter !== "all" && p.space !== spaceFilter) {
        return false;
      }
      if (stageFilter && p.stage !== stageFilter) {
        return false;
      }
      if (
        options.branch &&
        options.branch !== "all" &&
        ![
          p.originatingBranchId,
          p.governanceAuthorityBranchId,
          p.jurisdictionBranchId,
        ].includes(options.branch)
      )
        return false;
      if (query) {
        const haystack =
          `${p.proposalId} ${p.title} ${p.space} ${p.summary} ${p.details}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    })
    .map((p) => ({
      ...p,
      commentCount: commentCounts.get(p.proposalId) ?? 0,
      votes: voteMap.get(p.proposalId) ?? {
        approve: 0,
        abstain: 0,
        reject: 0,
        total: 0,
      },
    }));
}

export function canViewProposal(
  proposal: ProposalRecord,
  user: SessionUser | null,
): boolean {
  if (user?.isStaff || user?.isAdmin) return true;
  const isAuthor = Boolean(user && proposal.authorId === user.memberId);
  if (proposal.publicationScope === "private")
    return (
      isAuthor ||
      Boolean(
        proposal.originatingBranchId &&
        user?.branchAdminIds?.includes(proposal.originatingBranchId),
      )
    );
  if (proposal.publicationScope === "branch") {
    if (isAuthor) return true;
    const branchId =
      proposal.jurisdictionBranchId ?? proposal.originatingBranchId;
    return Boolean(
      branchId &&
      (user?.activeBranchIds?.includes(branchId) ||
        user?.branchAdminIds?.includes(branchId)),
    );
  }
  return true;
}

export function canReviewArchivedProposal(
  proposal: ProposalRecord,
  user: SessionUser | null,
): boolean {
  return Boolean(
    user &&
    (user.isStaff ||
      user.isAdmin ||
      proposal.authorId === user.memberId ||
      (proposal.originatingBranchId &&
        user.branchAdminIds?.includes(proposal.originatingBranchId)) ||
      hasPermission(user, "proposals.view_archived", proposal.originatingBranchId)),
  );
}

export async function getProposalDetail(
  db: Db,
  idOrSlug: string,
  user: SessionUser | null,
): Promise<{
  proposal: ProposalSummaryView;
  comments: CommentRecord[];
  votesList: VoteRecord[];
  myVote: VoteChoice | null;
  myReason: string;
  myPendingVote?: VoteChoice | null;
  myPendingReason?: string;
} | null> {
  const key = idOrSlug.trim();
  if (!key) return null;

  const col = db.collection<ProposalRecord>("proposals");
  const rawProposal =
    (await col.findOne({ slug: key })) ??
    (await col.findOne({ proposalId: key })) ??
    (await col.findOne({ policyId: key } as any));
  if (!rawProposal) return null;

  const proposal = normalizeProposalDoc(rawProposal);

  if (!canViewProposal(proposal, user)) return null;

  const canReviewArchived = canReviewArchivedProposal(proposal, user);
  if (proposal.stage === "archived" && !canReviewArchived) {
    return null;
  }

  const [rawComments, votes, pendingPref] = await Promise.all([
    db
      .collection<CommentRecord>("comments")
      .find({
        $or: [
          { proposalId: proposal.proposalId },
          { policyId: proposal.proposalId } as any,
        ],
      })
      .sort({ createdAt: 1 })
      .toArray(),
    db
      .collection<VoteRecord>(PROPOSAL_VOTES)
      .find({
        $or: [
          { proposalId: proposal.proposalId },
          { policyId: proposal.proposalId } as any,
        ],
      })
      .sort({ updatedAt: -1 })
      .toArray(),
    user && !user.canParticipate && user.status === "pending"
      ? db
          .collection<PendingVotePreferenceRecord>(PENDING_VOTE_PREFERENCES)
          .findOne({
            ballotId: proposalBallotId(proposal.proposalId),
            memberId: user.memberId,
          })
      : Promise.resolve(null),
  ]);

  const comments = rawComments.map((c) => ({
    ...c,
    stance: VALID_STANCES.includes(c.stance) ? c.stance : "comment",
    upvotes: Array.isArray(c.upvotes) ? c.upvotes : [],
  }));
  const cryptoConfig = loadBallotCryptoConfig(process.env);
  const currentBallotId = proposalBallotId(proposal.proposalId);
  const myBlindIndexes =
    user && cryptoConfig
      ? new Set(
          computeAllBlindIndexesForMember(
            cryptoConfig,
            currentBallotId,
            user.memberId,
          ),
        )
      : null;

  const proposalVotes = votes
    .filter((vote) => vote.ballotId === currentBallotId)
    .map((vote) => decodeStoredVote(vote as Record<string, any>, cryptoConfig));

  const tally: VoteTally = { approve: 0, abstain: 0, reject: 0, total: 0 };
  let myVote: VoteChoice | null = null;
  let myReason = "";

  for (const v of proposalVotes) {
    if (v.choice === "approve") tally.approve += 1;
    else if (v.choice === "abstain") tally.abstain += 1;
    else tally.reject += 1;
    tally.total += 1;
    const isMine =
      Boolean(user && v.memberId && v.memberId === user.memberId) ||
      Boolean(
        myBlindIndexes &&
          v.voterBlindIndex &&
          myBlindIndexes.has(v.voterBlindIndex),
      );
    if (isMine) {
      myVote = v.choice;
      myReason = v.reason ?? "";
    }
  }

  const myPendingVote: VoteChoice | null =
    !myVote && pendingPref?.choice ? pendingPref.choice : null;
  const myPendingReason =
    !myVote && pendingPref?.reason ? pendingPref.reason : "";

  return {
    proposal: {
      ...proposal,
      commentCount: comments.length,
      votes: tally,
    },
    comments,
    votesList: proposalVotes as unknown as VoteRecord[],
    myVote,
    myReason,
    myPendingVote,
    myPendingReason,
  };
}

/**
 * Read immutable proposal revisions only when the requester may view the
 * proposal itself. Archived proposals follow the same reviewer rule as the
 * proposal detail page so revision history cannot be used to bypass it.
 */
export async function listProposalRevisions(
  db: Db,
  idOrSlug: string,
  user: SessionUser | null,
): Promise<{
  proposalId: string;
  revisions: Array<Record<string, unknown>>;
} | null> {
  const key = idOrSlug.trim();
  if (!key) return null;

  const col = db.collection<ProposalRecord>("proposals");
  const rawProposal =
    (await col.findOne({ slug: key })) ??
    (await col.findOne({ proposalId: key })) ??
    (await col.findOne({ policyId: key } as any));
  if (!rawProposal) return null;

  const proposal = normalizeProposalDoc(rawProposal);
  if (!canViewProposal(proposal, user)) return null;
  if (
    proposal.stage === "archived" &&
    !canReviewArchivedProposal(proposal, user)
  )
    return null;

  const revisions: any[] = await db
    .collection("proposal_revisions")
    .find({ proposalId: proposal.proposalId })
    .sort({ createdAt: 1 })
    .toArray();
  const data = revisions.map((revision, index) => {
    const previous = revisions[index - 1];
    const changes = previous
      ? Object.keys(revision.snapshot).flatMap((field) => {
          const before = previous.snapshot[field];
          const after = revision.snapshot[field];
          return JSON.stringify(before) === JSON.stringify(after)
            ? []
            : [{ field, before, after }];
        })
      : [{ field: "initial", before: null, after: revision.snapshot }];
    return {
      revisionId: String(revision.revisionId ?? ""),
      proposalId: String(revision.proposalId ?? ""),
      parentRevisionId: revision.parentRevisionId ?? null,
      createdAt: revision.createdAt,
      snapshot: revision.snapshot,
      contentHash: String(revision.contentHash ?? ""),
      ...(revision.provenance ? { provenance: revision.provenance } : {}),
      changes,
    };
  });
  return { proposalId: proposal.proposalId, revisions: data };
}

export async function saveProposal(
  db: Db,
  user: SessionUser,
  body: Record<string, unknown>,
): Promise<ProposalRecord> {
  const col = db.collection<ProposalRecord>("proposals");
  const existingId =
    typeof body.proposalId === "string"
      ? body.proposalId.trim()
      : typeof body.policyId === "string"
        ? body.policyId.trim()
        : "";
  const existing = existingId
    ? await col.findOne({ proposalId: existingId })
    : null;
  const branchFields = [
    "originatingBranchId",
    "governanceAuthorityBranchId",
    "jurisdictionBranchId",
    "publicationScope",
  ] as const;
  const branchAdminIds = user.branchAdminIds ?? [];
  // Validate the submitted geographic scope before any permissions run. The
  // canonical key is translated to an organisational branch identifier here,
  // so a display label can never select a branch.
  const submittedScope = await parseProposalScopeInput(db, body);
  const canManageExisting = Boolean(
    existing &&
    (user.isStaff ||
      (existing.originatingBranchId &&
        branchAdminIds.includes(existing.originatingBranchId)) ||
      hasPermission(user, "proposals.edit", existing.originatingBranchId)),
  );
  if (!user.isAdmin) {
    if (
      [
        "governanceAuthorityBranchId",
        "jurisdictionBranchId",
        "publicationScope",
      ].some((field) => body[field] !== undefined)
    )
      throw new Error(
        "Only a national administrator may set governance authority, jurisdiction, or publication scope.",
      );
    // Choosing a destination is participation, not administration. Any
    // verified member may submit into any recognised branch; this grants no
    // voting eligibility and no administrative authority in that branch.
    if (
      existing?.originatingBranchId &&
      submittedScope?.branchId &&
      submittedScope.branchId !== existing.originatingBranchId
    )
      throw new Error("Proposal scope cannot be changed after it is set.");
  }
  const isGovernanceOperator = Boolean(user.isStaff || canManageExisting);

  if (existing) {
    const isAuthorInPropose =
      existing.authorId === user.memberId && existing.stage === "propose";
    if (!canManageExisting && !isAuthorInPropose) {
      throw new Error(
        "Moderator or Administrator access is required to edit this proposal.",
      );
    }
  } else if (!user.canParticipate && !user.isStaff) {
    throw new Error(
      "Your membership must be verified before you can submit a proposal.",
    );
  }

  if (existing) {
    // Validate stage transition if changing stage
    if (body.stage !== undefined || body.status !== undefined) {
      const rawStageInput = body.stage !== undefined ? body.stage : body.status;
      if (!isValidStage(rawStageInput)) {
        throw new Error(
          `Invalid lifecycle stage: '${String(rawStageInput)}'. Must be propose, deliberate, decide, implement, or archived.`,
        );
      }
      const targetStage = normalizeStage(rawStageInput, existing.stage);
      validateStageTransition(existing.stage, targetStage, existing.kind);
      if (targetStage === "decide" && existing.stage !== "decide") {
        if (
          !hasPermission(
            user,
            "ballots.bind",
            existing.governanceAuthorityBranchId,
          )
        ) {
          throw new Error(
            "You are not authorised to open a ballot for this proposal.",
          );
        }
        if (!user.isAdmin && !hasPermission(user, "ballots.bind")) {
          const branchId = existing.governanceAuthorityBranchId;
          if (
            !branchId ||
            (!branchAdminIds.includes(branchId) &&
              !hasPermission(user, "ballots.bind", branchId)) ||
            existing.jurisdictionBranchId !== branchId
          ) {
            throw new Error(
              "A national administrator must explicitly assign this proposal's branch authority and jurisdiction before its local ballot can open.",
            );
          }
        }
      }
      if (existing.stage === "decide" && targetStage === "implement") {
        if (
          !existing.ballotRevisionId ||
          !(await db
            .collection("ballot_results")
            .findOne({
              proposalId: existing.proposalId,
              revisionId: existing.ballotRevisionId,
              result: "successful",
            }))
        ) {
          throw new Error(
            "Record a successful ballot result for the exact frozen revision before moving this proposal to Implement.",
          );
        }
      }
    }

    // Server-enforced ballot integrity lock
    const voteCount = await db
      .collection<VoteRecord>(PROPOSAL_VOTES)
      .countDocuments({
        $or: [
          { proposalId: existing.proposalId },
          { policyId: existing.proposalId } as any,
        ],
      });
    const locked = isProposalLocked(existing.stage, voteCount);

    if (locked) {
      if (
        branchFields.some(
          (field) =>
            body[field] !== undefined &&
            body[field] !== (existing[field] ?? ""),
        ) ||
        (submittedScope?.branchId &&
          submittedScope.branchId !== (existing.originatingBranchId ?? ""))
      ) {
        throw new Error(
          "Governance authority, jurisdiction and publication scope are locked once a ballot begins.",
        );
      }
      const candidateOutcomes =
        body.outcomes !== undefined ? parseOutcomes(body.outcomes) : undefined;
      const substantiveChanges = getSubstantiveChanges(existing, {
        title: typeof body.title === "string" ? body.title : undefined,
        summary:
          typeof body.summary === "string"
            ? body.summary
            : typeof body.statement === "string"
              ? body.statement
              : undefined,
        outcomes: candidateOutcomes,
        details: typeof body.details === "string" ? body.details : undefined,
        attachmentUrl:
          typeof body.attachmentUrl === "string"
            ? body.attachmentUrl
            : undefined,
        attachmentDescription:
          typeof body.attachmentDescription === "string"
            ? body.attachmentDescription
            : undefined,
        kind: typeof body.kind === "string" ? body.kind : undefined,
      });

      if (substantiveChanges.length > 0) {
        const reason =
          voteCount > 0
            ? `voting has already begun and ${voteCount} member vote(s) have been cast`
            : `the proposal is active in the Decide stage`;
        throw new Error(
          `Cannot modify substantive proposal content (${substantiveChanges.join(", ")}) because ${reason}. Substantive text is locked to protect ballot integrity. Create a revised proposal to submit modified motion text.`,
        );
      }
    }
  }

function parseBallotCloseDate(raw: unknown, existingClose?: Date, now = new Date()): Date {
  if (raw !== undefined) {
    if (raw === null || raw === "") {
      throw new Error("A future ballot closing date is required when opening a ballot.");
    }
    const parsed = new Date(String(raw));
    if (!Number.isFinite(parsed.getTime())) {
      throw new Error("Ballot closing date is invalid.");
    }
    if (parsed.getTime() <= now.getTime()) {
      throw new Error("Ballot closing date must be in the future.");
    }
    return parsed;
  }
  if (existingClose) {
    const parsed = new Date(existingClose);
    if (Number.isFinite(parsed.getTime()) && parsed.getTime() > now.getTime()) {
      return parsed;
    }
  }
  throw new Error("A future ballot closing date is required when opening a ballot.");
}

  // Quick stage / implementationNote / supersession update by staff
  if (
    existing &&
    isGovernanceOperator &&
    Object.keys(body).every((k) =>
      [
        "proposalId",
        "policyId",
        "stage",
        "status",
        "implementationNote",
        "supersededByProposalId",
        "supersededByNote",
        "ballotClosesAt",
      ].includes(k),
    ) &&
    (body.stage !== undefined ||
      body.status !== undefined ||
      body.implementationNote !== undefined ||
      body.supersededByProposalId !== undefined ||
      body.supersededByNote !== undefined ||
      body.ballotClosesAt !== undefined)
  ) {
    const stage =
      body.stage !== undefined || body.status !== undefined
        ? normalizeStage(body.stage ?? body.status, existing.stage)
        : existing.stage;
    const updatedAt = new Date();
    const openingBallot = stage === "decide" && existing.stage !== "decide";
    const closingBallot = existing.stage === "decide" && stage !== "decide";
    let ballotClosesAt = existing.ballotClosesAt;
    if (openingBallot || (stage === "decide" && body.ballotClosesAt !== undefined)) {
      ballotClosesAt = parseBallotCloseDate(
        body.ballotClosesAt,
        existing.ballotClosesAt,
        updatedAt,
      );
    }
    const implementationNote =
      typeof body.implementationNote === "string"
        ? body.implementationNote.trim().slice(0, 1000)
        : existing.implementationNote;
    if (
      body.supersededByProposalId !== undefined ||
      body.supersededByNote !== undefined
    ) {
      if (
        !hasPermission(
          user,
          "proposals.manage_supersession",
          existing.originatingBranchId,
        )
      ) {
        throw new Error(
          "You do not have permission to manage proposal supersession.",
        );
      }
    }
    let supersededByProposalId = existing.supersededByProposalId;
    if (body.supersededByProposalId !== undefined) {
      const candidate =
        typeof body.supersededByProposalId === "string"
          ? body.supersededByProposalId.trim()
          : "";
      if (!candidate) {
        supersededByProposalId = undefined;
      } else {
        if (candidate === existing.proposalId) {
          throw new Error("A proposal cannot supersede itself.");
        }
        const target = await col.findOne({ proposalId: candidate });
        if (!target) {
          throw new Error(
            `Successor proposal '${candidate}' was not found.`,
          );
        }
        const visited = new Set<string>([existing.proposalId]);
        let cursor: ProposalRecord | null = target;
        let hops = 0;
        while (cursor && hops < 50) {
          if (visited.has(cursor.proposalId)) {
            throw new Error("Supersession chain cannot contain a cycle.");
          }
          visited.add(cursor.proposalId);
          const nextId: string | undefined = cursor.supersededByProposalId?.trim();
          if (!nextId) break;
          if (visited.has(nextId)) {
            throw new Error("Supersession chain cannot contain a cycle.");
          }
          cursor = await col.findOne({ proposalId: nextId });
          hops += 1;
        }
        supersededByProposalId = target.proposalId;
      }
    }
    const supersededByNote =
      body.supersededByNote !== undefined
        ? typeof body.supersededByNote === "string" && body.supersededByNote.trim()
          ? body.supersededByNote.trim().slice(0, 500)
          : undefined
        : existing.supersededByNote;

    const currentBallotId = proposalBallotId(existing.proposalId);
    const ballotVoteCount = await db
      .collection<VoteRecord>(PROPOSAL_VOTES)
      .countDocuments({
        $or: [
          { proposalId: existing.proposalId },
          { ballotId: currentBallotId },
        ],
      });

    let ballotRevisionId = existing.ballotRevisionId;
    let ballotUnbound = false;
    let ballotReboundFrom: string | undefined;

    if (closingBallot && ballotVoteCount === 0 && ballotRevisionId) {
      // Returning a zero-vote ballot to deliberation/propose clears its binding so
      // any subsequent wording edits do not leave a stale revision attached.
      ballotRevisionId = undefined;
      ballotUnbound = true;
    } else if (stage === "decide") {
      const latest = await db
        .collection("proposal_revisions")
        .find({ proposalId: existing.proposalId })
        .sort({ createdAt: -1, _id: -1 })
        .limit(1)
        .toArray();
      const latestRevisionId = latest[0]?.revisionId;
      if (!latestRevisionId) {
        throw new Error(
          "A proposal revision is required before opening a ballot.",
        );
      }
      if (ballotRevisionId && ballotRevisionId !== latestRevisionId) {
        if (ballotVoteCount > 0) {
          throw new Error(
            "Cannot reopen a voted ballot when a newer wording revision exists.",
          );
        }
        ballotReboundFrom = ballotRevisionId;
        ballotRevisionId = latestRevisionId;
      } else if (!ballotRevisionId) {
        ballotRevisionId = latestRevisionId;
      }
    }

    const set: Record<string, unknown> = {
      stage,
      implementationNote,
      updatedAt,
    };
    const unset: Record<string, "" | 1> = {};
    if (supersededByProposalId) {
      set.supersededByProposalId = supersededByProposalId;
      if (supersededByNote) {
        set.supersededByNote = supersededByNote;
      } else if (body.supersededByNote !== undefined) {
        unset.supersededByNote = "";
      }
    } else {
      if (body.supersededByProposalId !== undefined) {
        unset.supersededByProposalId = "";
        unset.supersededByNote = "";
      } else if (body.supersededByNote !== undefined) {
        unset.supersededByNote = "";
      }
    }
    if (ballotRevisionId) {
      set.ballotRevisionId = ballotRevisionId;
      if (openingBallot || ballotReboundFrom || !existing.ballotRevisionId) {
        set.ballotRevisionBoundAt = updatedAt;
        set.ballotRevisionBoundBy = user.memberId;
      }
    } else if (ballotUnbound) {
      unset.ballotRevisionId = "";
      unset.ballotRevisionBoundAt = "";
      unset.ballotRevisionBoundBy = "";
    }
    if (ballotClosesAt) {
      set.ballotClosesAt = ballotClosesAt;
    }
    const updateDoc: Record<string, unknown> = { $set: set };
    if (Object.keys(unset).length) updateDoc.$unset = unset;

    await runInTransaction(db, async (session) => {
      const sessionOpts = session ? { session } : undefined;
      const write = await col.updateOne(
        { proposalId: existing.proposalId, updatedAt: existing.updatedAt },
        updateDoc,
        sessionOpts,
      );
      if (write.matchedCount !== 1)
        throw new Error(
          "Proposal changed while you were editing it. Reload the latest state and try again.",
        );
      if (existing.stage !== stage) {
        await recordGovernanceEvent(
          db,
          {
            eventType: "proposal.stage_transition",
            matterId: existing.proposalId,
            revisionId: ballotRevisionId,
            actorId: user.memberId,
            authorityBranchId: existing.governanceAuthorityBranchId,
            metadata: {
              fromStage: existing.stage,
              toStage: stage,
              ...(ballotClosesAt
                ? { ballotClosesAt: ballotClosesAt.toISOString() }
                : {}),
            },
            createdAt: updatedAt,
          },
          session,
        );
      }
      if (ballotUnbound) {
        await recordGovernanceEvent(
          db,
          {
            eventType: "ballot.unbound",
            matterId: existing.proposalId,
            ballotId: currentBallotId,
            revisionId: existing.ballotRevisionId,
            actorId: user.memberId,
            authorityBranchId: existing.governanceAuthorityBranchId,
            reason: "Returned from Decide with zero votes.",
            createdAt: updatedAt,
          },
          session,
        );
      } else if (ballotReboundFrom && ballotRevisionId) {
        await recordGovernanceEvent(
          db,
          {
            eventType: "ballot.rebound",
            matterId: existing.proposalId,
            ballotId: currentBallotId,
            revisionId: ballotRevisionId,
            actorId: user.memberId,
            authorityBranchId: existing.governanceAuthorityBranchId,
            metadata: { previousRevisionId: ballotReboundFrom },
            createdAt: updatedAt,
          },
          session,
        );
      }
    });

    return {
      ...existing,
      stage,
      implementationNote,
      supersededByProposalId,
      supersededByNote: supersededByProposalId ? supersededByNote : undefined,
      ballotRevisionId,
      ...(ballotClosesAt ? { ballotClosesAt } : {}),
      updatedAt,
    };
  }

  const title =
    typeof body.title === "string"
      ? body.title.trim()
      : (existing?.title ?? "");
  if (title.length < 4 || title.length > 200) {
    throw new Error("Title must be between 4 and 200 characters.");
  }

  const space =
    typeof body.space === "string" && body.space.trim()
      ? body.space.trim()
      : typeof body.category === "string" && body.category.trim()
        ? body.category.trim()
        : (existing?.space ?? "General");
  if (space.length < 2 || space.length > 100) {
    throw new Error("Space / topic must be between 2 and 100 characters.");
  }

  const rawSummary =
    typeof body.summary === "string"
      ? body.summary.trim()
      : typeof body.statement === "string"
        ? body.statement.trim()
        : (existing?.summary ?? "");
  if (rawSummary.length < 10 || rawSummary.length > 2000) {
    throw new Error(
      "Proposal summary must be between 10 and 2,000 characters.",
    );
  }

  let outcomes: string[] = existing?.outcomes ?? [];
  if (Array.isArray(body.outcomes)) {
    outcomes = body.outcomes.map((o) => String(o).trim()).filter(Boolean);
  } else if (typeof body.outcomes === "string") {
    outcomes = body.outcomes
      .split("\n")
      .map((line) => line.replace(/^[-*•\d.)\s]+/, "").trim())
      .filter(Boolean);
  }

  const details =
    typeof body.details === "string"
      ? body.details.trim()
      : (existing?.details ?? "");
  const attachmentUrl =
    typeof body.attachmentUrl === "string"
      ? body.attachmentUrl.trim()
      : (existing?.attachmentUrl ?? "");
  if (attachmentUrl && !/^(https?:\/\/|\/)/i.test(attachmentUrl)) {
    throw new Error(
      "Supporting link or image URL must start with https:// or /.",
    );
  }

  const attachmentDescription =
    typeof body.attachmentDescription === "string"
      ? body.attachmentDescription.trim()
      : (existing?.attachmentDescription ?? "");

  const kind = normalizeKind(
    body.kind ?? existing?.kind ?? "policy",
    existing?.proposalId ?? "",
  );

  const implementationNote =
    typeof body.implementationNote === "string"
      ? body.implementationNote.trim()
      : (existing?.implementationNote ?? "");

  // Non-staff member submissions always start in "propose" stage
  const stage: ProposalStage = isGovernanceOperator
    ? normalizeStage(body.stage ?? body.status, existing?.stage ?? "propose")
    : (existing?.stage ?? "propose");

  const now = new Date();

  let originatingBranchId =
    submittedScope?.branchId ??
    (typeof body.originatingBranchId === "string"
      ? body.originatingBranchId.trim()
      : existing?.originatingBranchId);
  const scopeWasSubmitted =
    typeof body.scope === "string" && Boolean(body.scope.trim());
  let geographicScope = scopeWasSubmitted
    ? submittedScope?.definition?.key
    : existing?.scope;
  let governanceAuthorityBranchId =
    typeof body.governanceAuthorityBranchId === "string"
      ? body.governanceAuthorityBranchId.trim()
      : existing?.governanceAuthorityBranchId;
  let jurisdictionBranchId =
    typeof body.jurisdictionBranchId === "string"
      ? body.jurisdictionBranchId.trim()
      : existing?.jurisdictionBranchId;
  let publicationScope =
    body.publicationScope === "national" ||
    body.publicationScope === "branch" ||
    body.publicationScope === "private"
      ? body.publicationScope
      : (existing?.publicationScope ??
        (originatingBranchId && branchAdminIds.includes(originatingBranchId)
          ? "branch"
          : undefined));

  // New proposals are usable immediately. A branch administrator's own branch
  // supplies the governance context; everything else starts under national
  // governance. This is derived from permissions, not from untrusted input, so
  // a follower cannot choose a stronger governance authority.
  if (!existing) {
    const [nationalBranchForDefault, originBranch] = await Promise.all([
      db
        .collection("branches")
        .findOne({ kind: "national", recognised: true } as any),
      originatingBranchId
        ? db.collection("branches").findOne({ branchId: originatingBranchId })
        : Promise.resolve(null),
    ]);
    if (
      originBranch &&
      String(originBranch.kind) !== "national" &&
      (user.isAdmin || branchAdminIds.includes(originatingBranchId!))
    ) {
      governanceAuthorityBranchId ||= originatingBranchId;
      jurisdictionBranchId ||= originatingBranchId;
      publicationScope ||= "branch";
      geographicScope ||= geographicScopeForBranch(originBranch)?.key;
    } else if (nationalBranchForDefault) {
      const nationalId = String(nationalBranchForDefault.branchId);
      const hadOrigin = Boolean(originatingBranchId);
      originatingBranchId ||= nationalId;
      governanceAuthorityBranchId ||= nationalId;
      jurisdictionBranchId ||= nationalId;
      publicationScope ||= "national";
      // A branch destination keeps its own geographic scope. Only a proposal
      // with no branch destination defaults to National.
      if (!hadOrigin)
        geographicScope ||= geographicScopeForBranch(nationalBranchForDefault)?.key;
    }
  }
  if (!scopeWasSubmitted && originatingBranchId) {
    // API clients may still submit an originating branch identifier. Derive the
    // canonical geographic scope from the branch record rather than trusting a
    // label, and keep legacy records untouched when it cannot be derived.
    const originBranch = await db
      .collection("branches")
      .findOne({ branchId: originatingBranchId });
    const derivedScope = originBranch
      ? geographicScopeForBranch(originBranch)?.key
      : undefined;
    geographicScope = derivedScope ?? existing?.scope;
  }
  if (user.isAdmin) {
    for (const branchId of [
      originatingBranchId,
      governanceAuthorityBranchId,
      jurisdictionBranchId,
    ].filter(Boolean)) {
      if (!(await db.collection("branches").findOne({ branchId })))
        throw new Error(`Branch '${branchId}' does not exist.`);
    }
    if (publicationScope === "branch" && !jurisdictionBranchId)
      throw new Error(
        "Branch publication requires an explicit jurisdiction branch.",
      );
    if (publicationScope === "national" && !governanceAuthorityBranchId)
      throw new Error(
        "National publication requires an explicit governance authority branch.",
      );
  } else if (originatingBranchId) {
    // Any verified member may submit into any recognised branch. Recognition is
    // the only destination rule; it does not grant branch membership, voting
    // eligibility, or administrative authority.
    if (
      !(await db
        .collection("branches")
        .findOne({ branchId: originatingBranchId, recognised: true }))
    )
      throw new Error("Choose a recognised proposal scope.");
  }

  let provenance: PolicyProvenance | undefined = existing?.provenance;
  if (user.isStaff && body.provenance !== undefined) {
    if (
      !body.provenance ||
      (typeof body.provenance === "object" &&
        !(body.provenance as any).category)
    ) {
      provenance = undefined;
    } else if (typeof body.provenance === "object") {
      const rawProv = body.provenance as Record<string, any>;
      const category = String(rawProv.category || "unverified").trim();
      const label =
        String(rawProv.label || "").trim() ||
        getDefaultProvenanceLabel(category, kind);
      const summary = String(rawProv.summary || "").trim();
      const uncertaintyNote = rawProv.uncertaintyNote
        ? String(rawProv.uncertaintyNote).trim()
        : undefined;

      let lineage: ProvenanceLink[] = [];
      if (Array.isArray(rawProv.lineage)) {
        lineage = rawProv.lineage
          .map((l: any) => ({
            label: String(l.label || "").trim(),
            url: l.url ? String(l.url).trim() : null,
            description: String(l.description || "").trim(),
          }))
          .filter((l: ProvenanceLink) => l.label);
      }

      let valuesAlignment: string[] = [];
      if (Array.isArray(rawProv.valuesAlignment)) {
        valuesAlignment = rawProv.valuesAlignment
          .map((v: any) => String(v).trim())
          .filter(Boolean);
      }

      provenance = {
        category,
        classification: category,
        label,
        summary,
        uncertaintyNote,
        lineage,
        valuesAlignment,
        flaggedNewInStaticExport: category === "new-proposal",
        lineageVerified: category !== "unverified",
      };
    }
  }

  if (existing) {
    const updated: ProposalRecord = {
      ...existing,
      title,
      space,
      summary: rawSummary,
      outcomes,
      details,
      attachmentUrl: attachmentUrl || undefined,
      attachmentDescription: attachmentDescription || undefined,
      kind,
      implementationNote: implementationNote || undefined,
      stage,
      originatingBranchId,
      governanceAuthorityBranchId,
      jurisdictionBranchId,
      publicationScope,
      scope: geographicScope,
      provenance,
      updatedAt: now,
    };
    const updateSet: Record<string, any> = {
      title: updated.title,
      space: updated.space,
      summary: updated.summary,
      outcomes: updated.outcomes,
      details: updated.details,
      attachmentUrl: updated.attachmentUrl,
      attachmentDescription: updated.attachmentDescription,
      kind: updated.kind,
      implementationNote: updated.implementationNote,
      stage: updated.stage,
      originatingBranchId: updated.originatingBranchId,
      governanceAuthorityBranchId: updated.governanceAuthorityBranchId,
      jurisdictionBranchId: updated.jurisdictionBranchId,
      publicationScope: updated.publicationScope,
      ...(geographicScope ? { scope: geographicScope } : {}),
      updatedAt: now,
    };
    const unsetFields: Record<string, 1> = {};
    if (scopeWasSubmitted && !geographicScope) unsetFields.scope = 1;
    if (user.isStaff && body.provenance === null) {
      unsetFields.provenance = 1;
    } else if (user.isStaff && body.provenance !== undefined) {
      updateSet.provenance = provenance;
    }

    const snapshot = {
      title: updated.title,
      summary: updated.summary,
      outcomes: updated.outcomes,
      details: updated.details,
    };
    const contentHash = createHash("sha256")
      .update(JSON.stringify(snapshot))
      .digest("hex");
    const latestRevisions = await db
      .collection("proposal_revisions")
      .find({ proposalId: existing.proposalId })
      .sort({ createdAt: -1 })
      .limit(1)
      .toArray();
    const previousRevision = latestRevisions[0];
    const appendRevision =
      !previousRevision || previousRevision.contentHash !== contentHash;
    const nextRevisionId = appendRevision
      ? randomUUID()
      : previousRevision.revisionId;
    const openingBallot = stage === "decide" && existing.stage !== "decide";
    const closingBallot = existing.stage === "decide" && stage !== "decide";
    let ballotClosesAt = existing.ballotClosesAt;
    if (openingBallot || (stage === "decide" && body.ballotClosesAt !== undefined)) {
      ballotClosesAt = parseBallotCloseDate(
        body.ballotClosesAt,
        existing.ballotClosesAt,
        now,
      );
      updated.ballotClosesAt = ballotClosesAt;
      updateSet.ballotClosesAt = ballotClosesAt;
    }

    let ballotUnbound = false;
    let ballotReboundFrom: string | undefined;
    if (stage === "decide") {
      if (updated.ballotRevisionId && updated.ballotRevisionId !== nextRevisionId) {
        ballotReboundFrom = updated.ballotRevisionId;
      }
      updated.ballotRevisionId = nextRevisionId;
      updateSet.ballotRevisionId = nextRevisionId;
      if (openingBallot || ballotReboundFrom || !existing.ballotRevisionId) {
        updateSet.ballotRevisionBoundAt = now;
        updateSet.ballotRevisionBoundBy = user.memberId;
      }
    } else if (existing.ballotRevisionId && (closingBallot || appendRevision)) {
      // Editable path only runs when zero votes exist; clear any prior binding so
      // a returned/edited proposal cannot carry stale wording back into Decide.
      delete updated.ballotRevisionId;
      unsetFields.ballotRevisionId = 1;
      unsetFields.ballotRevisionBoundAt = 1;
      unsetFields.ballotRevisionBoundBy = 1;
      ballotUnbound = true;
    }

    await runInTransaction(db, async (session) => {
      const sessionOpts = session ? { session } : undefined;
      const write = await col.updateOne(
        { proposalId: existing.proposalId, updatedAt: existing.updatedAt },
        {
          $set: updateSet,
          ...(Object.keys(unsetFields).length
            ? { $unset: unsetFields }
            : {}),
        },
        sessionOpts,
      );
      if (write.matchedCount !== 1)
        throw new Error(
          "Proposal changed while you were editing it. Reload the latest revision and try again.",
        );
      if (appendRevision)
        await db
          .collection("proposal_revisions")
          .insertOne(
            {
              revisionId: nextRevisionId,
              proposalId: updated.proposalId,
              parentRevisionId: previousRevision?.revisionId ?? null,
              authorId: user.memberId,
              createdAt: now,
              snapshot,
              contentHash,
              provenance: updated.provenance,
            },
            sessionOpts,
          );
      if (existing.stage !== stage) {
        await recordGovernanceEvent(
          db,
          {
            eventType: "proposal.stage_transition",
            matterId: updated.proposalId,
            revisionId: nextRevisionId,
            actorId: user.memberId,
            authorityBranchId: updated.governanceAuthorityBranchId,
            metadata: {
              fromStage: existing.stage,
              toStage: stage,
              ...(ballotClosesAt
                ? { ballotClosesAt: ballotClosesAt.toISOString() }
                : {}),
            },
            createdAt: now,
          },
          session,
        );
      }
      if (ballotUnbound) {
        await recordGovernanceEvent(
          db,
          {
            eventType: "ballot.unbound",
            matterId: updated.proposalId,
            ballotId: proposalBallotId(updated.proposalId),
            revisionId: existing.ballotRevisionId,
            actorId: user.memberId,
            authorityBranchId: updated.governanceAuthorityBranchId,
            reason: closingBallot
              ? "Returned from Decide with zero votes."
              : "Wording edited with zero votes.",
            createdAt: now,
          },
          session,
        );
      } else if (ballotReboundFrom) {
        await recordGovernanceEvent(
          db,
          {
            eventType: "ballot.rebound",
            matterId: updated.proposalId,
            ballotId: proposalBallotId(updated.proposalId),
            revisionId: nextRevisionId,
            actorId: user.memberId,
            authorityBranchId: updated.governanceAuthorityBranchId,
            metadata: { previousRevisionId: ballotReboundFrom },
            createdAt: now,
          },
          session,
        );
      }
    });
    return updated;
  }

  const ballotClosesAt =
    stage === "decide"
      ? parseBallotCloseDate(body.ballotClosesAt, undefined, now)
      : undefined;

  const count = await col.countDocuments();
  const proposalId =
    existingId ||
    `PROP-${String(count + 1).padStart(3, "0")}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
  const baseSlug = slugify(title) || proposalId.toLowerCase();
  const slugConflict = await col.findOne({ slug: baseSlug });
  const slug = slugConflict
    ? `${baseSlug}-${proposalId.toLowerCase()}`
    : baseSlug;

  const createdKind = normalizeKind(body.kind, proposalId);

  const revisionId = randomUUID();
  const created: ProposalRecord = {
    proposalId,
    slug,
    title,
    space,
    summary: rawSummary,
    outcomes,
    details,
    ...(attachmentUrl ? { attachmentUrl } : {}),
    ...(attachmentDescription ? { attachmentDescription } : {}),
    kind: createdKind,
    ...(implementationNote ? { implementationNote } : {}),
    stage,
    ...(stage === "decide"
      ? {
          ballotRevisionId: revisionId,
          ballotClosesAt,
        }
      : {}),
    originatingBranchId,
    governanceAuthorityBranchId,
    jurisdictionBranchId,
    publicationScope,
    ...(geographicScope ? { scope: geographicScope } : {}),
    provenance,
    authorId: user.memberId,
    authorName: user.name || "Verified Member",
    createdAt: now,
    updatedAt: now,
  };

  const snapshot = {
    title: created.title,
    summary: created.summary,
    outcomes: created.outcomes,
    details: created.details,
  };
  const revision = {
    revisionId,
    proposalId,
    parentRevisionId: null,
    authorId: user.memberId,
    createdAt: now,
    snapshot,
    contentHash: createHash("sha256")
      .update(JSON.stringify(snapshot))
      .digest("hex"),
    provenance: created.provenance,
  };
  await runInTransaction(db, async (session) => {
    const sessionOpts = session ? { session } : undefined;
    await col.insertOne(created, sessionOpts);
    await db
      .collection("proposal_revisions")
      .insertOne(revision, sessionOpts);
    if (stage === "decide") {
      await recordGovernanceEvent(
        db,
        {
          eventType: "proposal.stage_transition",
          matterId: proposalId,
          revisionId,
          actorId: user.memberId,
          authorityBranchId: created.governanceAuthorityBranchId,
          metadata: {
            fromStage: null,
            toStage: "decide",
            ...(ballotClosesAt
              ? { ballotClosesAt: ballotClosesAt.toISOString() }
              : {}),
          },
          createdAt: now,
        },
        session,
      );
    }
  });
  return created;
}

export class ProposalDeletionConflictError extends Error {
  status = 409;
  constructor(message: string) {
    super(message);
    this.name = "ProposalDeletionConflictError";
  }
}

export async function deleteProposal(
  db: Db,
  user: SessionUser,
  proposalId: string,
  reason?: string,
): Promise<void> {
  const id = proposalId.trim();
  if (!id) throw new Error("Proposal ID is required.");
  const col = db.collection<ProposalRecord>("proposals");
  const existing = await col.findOne({ proposalId: id });
  if (!existing) throw new Error("Proposal not found.");

  const isAuthorInPropose =
    existing.authorId === user.memberId && existing.stage === "propose";
  if (
    !user.isAdmin &&
    !hasPermission(user, "proposals.delete", existing.originatingBranchId) &&
    !isAuthorInPropose
  ) {
    throw new Error(
      "Administrator access is required to delete this proposal.",
    );
  }

  const [revisionCount, voteCount, ballotCount, resultCount, registryCount] =
    await Promise.all([
      db.collection("proposal_revisions").countDocuments({ proposalId: id }),
      db.collection(PROPOSAL_VOTES).countDocuments({
        $or: [{ proposalId: id }, { ballotId: proposalBallotId(id) }],
      }),
      db.collection(BALLOTS_COLLECTION).countDocuments({ matterId: id }),
      db.collection(FORMAL_DECISIONS_COLLECTION).countDocuments({
        $or: [{ matterId: id }, { proposalId: id }],
      }),
      db.collection("policy_registry").countDocuments({
        $or: [{ policyId: id }, { proposalId: id }, { matterId: id }],
      }),
    ]);

  if (
    revisionCount > 1 ||
    voteCount > 0 ||
    ballotCount > 0 ||
    resultCount > 0 ||
    registryCount > 0 ||
    Boolean(existing.ballotRevisionId) ||
    ["decide", "implement", "archived"].includes(existing.stage)
  ) {
    throw new ProposalDeletionConflictError(
      "Matters with governance history (revisions beyond initial draft, ballots, votes, results, or registry records) cannot be deleted. Archive the matter instead.",
    );
  }

  await runInTransaction(db, async (session) => {
    const sessionOpts = session ? { session } : undefined;
    await col.deleteOne({ proposalId: id }, sessionOpts);
    await db
      .collection("proposal_revisions")
      .deleteMany({ proposalId: id }, sessionOpts);
    await db.collection("comments").deleteMany({ proposalId: id }, sessionOpts);
    await recordGovernanceEvent(
      db,
      {
        eventType: "proposal.deleted",
        matterId: id,
        actorId: user.memberId,
        authorityBranchId: existing.governanceAuthorityBranchId,
        reason: reason?.trim() || "Draft deleted before governance history.",
        metadata: { stage: existing.stage, title: existing.title },
      },
      session,
    );
  });
}

export async function addComment(
  db: Db,
  user: SessionUser,
  body: Record<string, unknown>,
): Promise<CommentRecord> {
  if (!user.canParticipate) {
    throw new Error(
      "Your membership must be verified before you can contribute to deliberation.",
    );
  }

  const proposalId =
    typeof body.proposalId === "string"
      ? body.proposalId.trim()
      : typeof body.policyId === "string"
        ? body.policyId.trim()
        : "";
  const proposal = await db
    .collection<ProposalRecord>("proposals")
    .findOne({ proposalId });
  if (
    !proposal ||
    !canViewProposal(normalizeProposalDoc(proposal), user) ||
    proposal.stage === "archived"
  ) {
    throw new Error("This proposal is not open for deliberation.");
  }

  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (text.length < 5 || text.length > 5000) {
    throw new Error("Contribution must be between 5 and 5,000 characters.");
  }

  const rawStance = String(body.stance || body.kind || "comment");
  const stance: CommentStance = VALID_STANCES.includes(
    rawStance as CommentStance,
  )
    ? (rawStance as CommentStance)
    : "comment";

  const record: CommentRecord = {
    commentId: `cmt-${crypto.randomUUID()}`,
    proposalId: proposal.proposalId,
    memberId: user.memberId,
    authorName: user.name || "Verified Member",
    stance,
    body: text,
    upvotes: [],
    createdAt: new Date(),
  };

  await db.collection<CommentRecord>("comments").insertOne(record);
  return record;
}

export async function toggleUpvoteComment(
  db: Db,
  user: SessionUser,
  commentId: string,
): Promise<{
  upvotes: string[];
  count: number;
  endorsed: boolean;
  hasUpvoted: boolean;
}> {
  if (!user.canParticipate) {
    throw new Error(
      "Your membership must be verified to endorse deliberation points.",
    );
  }
  const id = commentId.trim();
  const col = db.collection<CommentRecord>("comments");
  const existing = await col.findOne({ commentId: id });
  if (!existing) throw new Error("Comment not found.");

  const proposal = await db
    .collection<ProposalRecord>("proposals")
    .findOne({ proposalId: existing.proposalId });
  if (!proposal || !canViewProposal(normalizeProposalDoc(proposal), user))
    throw new Error("Comment not found.");

  const current = Array.isArray(existing.upvotes) ? existing.upvotes : [];
  const hasEndorsed = current.includes(user.memberId);
  const updated = hasEndorsed
    ? current.filter((m) => m !== user.memberId)
    : [...current, user.memberId];
  const currentEvents = Array.isArray(existing.upvoteEvents)
    ? existing.upvoteEvents
    : [];
  const updatedEvents = hasEndorsed
    ? currentEvents.filter((event) => event.memberId !== user.memberId)
    : [...currentEvents, { memberId: user.memberId, at: new Date() }];

  await col.updateOne(
    { commentId: id },
    { $set: { upvotes: updated, upvoteEvents: updatedEvents } },
  );
  return {
    upvotes: updated,
    count: updated.length,
    endorsed: !hasEndorsed,
    hasUpvoted: !hasEndorsed,
  };
}

export async function deleteComment(
  db: Db,
  user: SessionUser,
  commentId: string,
): Promise<void> {
  const id = commentId.trim();
  if (!id) throw new Error("Comment ID is required.");
  const col = db.collection<CommentRecord>("comments");
  const existing = await col.findOne({ commentId: id });
  if (!existing) throw new Error("Comment not found.");
  const proposal = await db
    .collection<ProposalRecord>("proposals")
    .findOne({ proposalId: existing.proposalId });
  if (!proposal || !canViewProposal(normalizeProposalDoc(proposal), user))
    throw new Error("Comment not found.");
  if (
    existing.memberId !== user.memberId &&
    !user.isStaff &&
    !hasPermission(user, "comments.moderate", proposal.originatingBranchId)
  ) {
    throw new Error("You can only delete your own contributions.");
  }
  await col.deleteOne({ commentId: id });
}

const VALID_FEEDBACK_STATUSES: ContributionFeedbackStatus[] = [
  "incorporated",
  "considered",
  "deferred",
  "declined",
];

const VALID_EVIDENCE_KINDS: ContributionFeedbackEvidenceKind[] = [
  "amendment",
  "revision",
  "decision",
  "policy",
];

function parseEvidenceInput(
  body: Record<string, unknown>,
): { kind: ContributionFeedbackEvidenceKind; recordId: string } | null {
  if (typeof body.evidenceRef === "string") {
    const ref = body.evidenceRef.trim();
    if (!ref) return null;
    const colon = ref.indexOf(":");
    if (colon <= 0) {
      throw new Error("Choose a valid supporting evidence record.");
    }
    const kind = ref.slice(0, colon).trim().toLowerCase();
    const recordId = ref.slice(colon + 1).trim();
    if (
      !VALID_EVIDENCE_KINDS.includes(kind as ContributionFeedbackEvidenceKind) ||
      !recordId
    ) {
      throw new Error("Choose a valid supporting evidence record.");
    }
    return { kind: kind as ContributionFeedbackEvidenceKind, recordId };
  }
  if (body.evidence && typeof body.evidence === "object") {
    const raw = body.evidence as Record<string, unknown>;
    const kind =
      typeof raw.kind === "string" ? raw.kind.trim().toLowerCase() : "";
    const recordId =
      typeof raw.recordId === "string" ? raw.recordId.trim() : "";
    if (!kind && !recordId) return null;
    if (
      !VALID_EVIDENCE_KINDS.includes(kind as ContributionFeedbackEvidenceKind) ||
      !recordId
    ) {
      throw new Error("Choose a valid supporting evidence record.");
    }
    return { kind: kind as ContributionFeedbackEvidenceKind, recordId };
  }
  return null;
}

function formatEvidenceDate(value: unknown): string {
  if (!value) return "";
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

async function resolveAndValidateEvidence(
  db: Db,
  proposal: ProposalRecord,
  user: SessionUser,
  input: { kind: ContributionFeedbackEvidenceKind; recordId: string },
): Promise<ContributionFeedbackEvidence> {
  const { kind, recordId } = input;
  if (kind === "amendment") {
    const amendment: any = await db
      .collection("amendments")
      .findOne({ amendmentId: recordId, proposalId: proposal.proposalId });
    if (!amendment || amendment.status === "withdrawn") {
      throw new Error(
        "Referenced amendment was not found on this proposal.",
      );
    }
    const prefix =
      amendment.status === "applied"
        ? "Applied amendment"
        : `Amendment (${String(amendment.status ?? "proposed")})`;
    const title = String(amendment.title ?? recordId).trim().slice(0, 100);
    return { kind, recordId, label: `${prefix}: ${title}` };
  }
  if (kind === "revision") {
    const revision: any = await db
      .collection("proposal_revisions")
      .findOne({ revisionId: recordId, proposalId: proposal.proposalId });
    if (!revision) {
      throw new Error(
        "Referenced revision was not found on this proposal.",
      );
    }
    const dateLabel = formatEvidenceDate(revision.createdAt);
    const isBallot = proposal.ballotRevisionId === recordId;
    const label = isBallot
      ? `Ballot revision${dateLabel ? ` (${dateLabel})` : ""}`
      : `Proposal revision${dateLabel ? ` (${dateLabel})` : ""}`;
    return { kind, recordId, label };
  }
  if (kind === "decision") {
    const ballotResult: any = await db
      .collection("ballot_results")
      .findOne({ proposalId: proposal.proposalId });
    if (
      !ballotResult ||
      (recordId !== proposal.proposalId &&
        recordId !== String(ballotResult.decisionEventId ?? ""))
    ) {
      throw new Error(
        "Referenced ballot decision was not found on this proposal.",
      );
    }
    const outcome = String(ballotResult.result ?? "recorded");
    return {
      kind,
      recordId: String(ballotResult.decisionEventId ?? proposal.proposalId),
      label: `Ballot outcome: ${outcome}`,
    };
  }
  const policy: any = await db
    .collection("policy_registry")
    .findOne({ policyId: recordId });
  if (!policy) {
    throw new Error("Referenced policy record was not found.");
  }
  const pubStatus = String(policy.publicationStatus ?? "unpublished");
  const isPublishedState = ["published", "withdrawn", "superseded"].includes(
    pubStatus,
  );
  if (
    !isPublishedState &&
    (policy.proposalId !== proposal.proposalId ||
      (!user.isStaff && !user.isAdmin))
  ) {
    throw new Error("Referenced policy record is not accessible.");
  }
  const title = String(policy.title ?? recordId).trim().slice(0, 100);
  const label =
    pubStatus === "published"
      ? `Adopted policy: ${title}`
      : `Policy record (${pubStatus}): ${title}`;
  return { kind, recordId, label };
}

export interface ResolvedContributionEvidence {
  kind: ContributionFeedbackEvidenceKind;
  recordId: string;
  label: string;
  href?: string;
}

/**
 * Resolve contribution feedback evidence for display, re-checking viewer
 * permissions and current record existence so inaccessible or withdrawn
 * targets never leak titles, identifiers or broken links.
 */
export async function resolveContributionEvidenceMap(
  db: Db,
  proposal: ProposalRecord,
  comments: CommentRecord[],
  user: SessionUser | null,
): Promise<Map<string, ResolvedContributionEvidence>> {
  const result = new Map<string, ResolvedContributionEvidence>();
  const evidenceItems: ContributionFeedbackEvidence[] = [];
  for (const c of comments) {
    if (c.feedback?.evidence) evidenceItems.push(c.feedback.evidence);
    for (const h of c.feedbackHistory ?? []) {
      if (h.evidence) evidenceItems.push(h.evidence);
    }
  }
  if (evidenceItems.length === 0) return result;

  const amendmentIds = [
    ...new Set(
      evidenceItems
        .filter((e) => e.kind === "amendment")
        .map((e) => e.recordId),
    ),
  ];
  const revisionIds = [
    ...new Set(
      evidenceItems
        .filter((e) => e.kind === "revision")
        .map((e) => e.recordId),
    ),
  ];
  const policyIds = [
    ...new Set(
      evidenceItems
        .filter((e) => e.kind === "policy")
        .map((e) => e.recordId),
    ),
  ];
  const hasDecision = evidenceItems.some((e) => e.kind === "decision");

  const [amendments, revisions, policies, ballotResult] = await Promise.all([
    amendmentIds.length
      ? db
          .collection("amendments")
          .find({
            proposalId: proposal.proposalId,
            amendmentId: { $in: amendmentIds },
          })
          .toArray()
      : Promise.resolve([]),
    revisionIds.length
      ? db
          .collection("proposal_revisions")
          .find({
            proposalId: proposal.proposalId,
            revisionId: { $in: revisionIds },
          })
          .toArray()
      : Promise.resolve([]),
    policyIds.length
      ? db
          .collection("policy_registry")
          .find({ policyId: { $in: policyIds } })
          .toArray()
      : Promise.resolve([]),
    hasDecision
      ? db
          .collection("ballot_results")
          .findOne({ proposalId: proposal.proposalId })
      : Promise.resolve(null),
  ]);

  const amendmentById = new Map<string, any>(
    amendments.map((a: any) => [String(a.amendmentId), a]),
  );
  const revisionById = new Map<string, any>(
    revisions.map((r: any) => [String(r.revisionId), r]),
  );
  const policyById = new Map<string, any>(
    policies.map((p: any) => [String(p.policyId), p]),
  );

  for (const item of evidenceItems) {
    const key = `${item.kind}:${item.recordId}`;
    if (result.has(key)) continue;

    if (item.kind === "amendment") {
      const am = amendmentById.get(item.recordId);
      if (!am || am.status === "withdrawn") continue;
      const prefix =
        am.status === "applied"
          ? "Applied amendment"
          : `Amendment (${String(am.status ?? "proposed")})`;
      result.set(key, {
        kind: item.kind,
        recordId: item.recordId,
        label: `${prefix}: ${String(am.title ?? item.recordId)}`,
        href: `#amendment-${encodeURIComponent(item.recordId)}`,
      });
    } else if (item.kind === "revision") {
      const rev = revisionById.get(item.recordId);
      if (!rev) continue;
      const dateLabel = formatEvidenceDate(rev.createdAt);
      const isBallot = proposal.ballotRevisionId === item.recordId;
      result.set(key, {
        kind: item.kind,
        recordId: item.recordId,
        label: isBallot
          ? `Ballot revision${dateLabel ? ` (${dateLabel})` : ""}`
          : `Proposal revision${dateLabel ? ` (${dateLabel})` : ""}`,
        href: `#revision-${encodeURIComponent(item.recordId)}`,
      });
    } else if (item.kind === "decision") {
      if (!ballotResult) continue;
      if (
        item.recordId !== proposal.proposalId &&
        item.recordId !== String(ballotResult.decisionEventId ?? "")
      ) {
        continue;
      }
      result.set(key, {
        kind: item.kind,
        recordId: item.recordId,
        label: `Ballot outcome: ${String(ballotResult.result ?? "recorded")}`,
        href: "#proposal-vote",
      });
    } else if (item.kind === "policy") {
      const pol = policyById.get(item.recordId);
      if (!pol) continue;
      const pubStatus = String(pol.publicationStatus ?? "unpublished");
      const isPublicRecord = [
        "published",
        "withdrawn",
        "superseded",
      ].includes(pubStatus);
      if (!isPublicRecord && !user?.isStaff && !user?.isAdmin) continue;
      result.set(key, {
        kind: item.kind,
        recordId: item.recordId,
        label:
          pubStatus === "published"
            ? `Adopted policy: ${String(pol.title ?? item.recordId)}`
            : `Policy record (${pubStatus}): ${String(pol.title ?? item.recordId)}`,
        ...(isPublicRecord
          ? { href: `/policies/${encodeURIComponent(item.recordId)}/` }
          : {}),
      });
    }
  }

  return result;
}

export function canRespondToContribution(
  user: SessionUser | null,
  proposal: Pick<ProposalRecord, "authorId" | "originatingBranchId">,
): boolean {
  if (!user) return false;
  if (
    user.isStaff ||
    user.isAdmin ||
    hasPermission(user, "contributions.respond", proposal.originatingBranchId)
  ) {
    return true;
  }
  if (
    user.isBranchAdmin &&
    proposal.originatingBranchId &&
    (user.branchAdminIds ?? []).includes(proposal.originatingBranchId)
  ) {
    return true;
  }
  return Boolean(
    user.canParticipate &&
      proposal.authorId &&
      proposal.authorId === user.memberId,
  );
}

export async function setCommentFeedback(
  db: Db,
  user: SessionUser,
  body: Record<string, unknown>,
): Promise<{
  feedback: ContributionFeedback | null;
  feedbackHistory: ContributionFeedbackHistoryEntry[];
}> {
  const commentId =
    typeof body.commentId === "string" ? body.commentId.trim() : "";
  if (!commentId) throw new Error("Comment ID is required.");

  const rawStatus =
    typeof body.status === "string" ? body.status.trim().toLowerCase() : "";
  if (
    rawStatus !== "clear" &&
    !VALID_FEEDBACK_STATUSES.includes(rawStatus as ContributionFeedbackStatus)
  ) {
    throw new Error(
      "Choose a valid feedback outcome: incorporated, considered, deferred, declined, or clear.",
    );
  }

  const col = db.collection<CommentRecord>("comments");
  const existing = await col.findOne({ commentId });
  if (!existing) throw new Error("Contribution not found.");

  const rawProposal = await db
    .collection<ProposalRecord>("proposals")
    .findOne({ proposalId: existing.proposalId });
  if (!rawProposal) throw new Error("Proposal not found.");
  const proposal = normalizeProposalDoc(rawProposal);
  if (!canViewProposal(proposal, user)) throw new Error("Proposal not found.");

  if (!canRespondToContribution(user, proposal)) {
    throw new Error(
      "Only administrators, branch moderators for this proposal, or the proposal author can record contribution outcomes.",
    );
  }

  const note =
    typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
  const updatedAt = new Date();
  const updatedByName = user.name || "Author";
  const priorHistory = Array.isArray(existing.feedbackHistory)
    ? existing.feedbackHistory
    : [];

  if (rawStatus === "clear") {
    const entry: ContributionFeedbackHistoryEntry = {
      action: "cleared",
      ...(note ? { note } : {}),
      updatedBy: user.memberId,
      updatedByName,
      updatedAt,
    };
    const feedbackHistory = [...priorHistory, entry];
    await col.updateOne(
      { commentId },
      { $unset: { feedback: "" }, $set: { feedbackHistory } },
    );
    return { feedback: null, feedbackHistory };
  }

  const evidenceInput = parseEvidenceInput(body);
  const evidence = evidenceInput
    ? await resolveAndValidateEvidence(db, proposal, user, evidenceInput)
    : undefined;

  const feedback: ContributionFeedback = {
    status: rawStatus as ContributionFeedbackStatus,
    ...(note ? { note } : {}),
    ...(evidence ? { evidence } : {}),
    updatedBy: user.memberId,
    updatedByName,
    updatedAt,
  };
  const entry: ContributionFeedbackHistoryEntry = {
    action: feedback.status,
    ...(note ? { note } : {}),
    ...(evidence ? { evidence } : {}),
    updatedBy: user.memberId,
    updatedByName,
    updatedAt,
  };
  const feedbackHistory = [...priorHistory, entry];

  await col.updateOne(
    { commentId },
    { $set: { feedback, feedbackHistory } },
  );
  return { feedback, feedbackHistory };
}

async function upsertStoredVote(
  db: Db,
  cryptoConfig: ReturnType<typeof loadBallotCryptoConfig>,
  input: {
    ballotId: string;
    proposalId: string;
    revisionId: string;
    amendmentId?: string;
    amendmentRevisionId?: string;
    memberId: string;
    authorName: string;
    choice: VoteChoice;
    reason: string;
  },
  session?: ClientSession,
): Promise<VoteTally> {
  const sessionOpts = session ? { session } : undefined;
  const votesCol = db.collection<VoteRecord>(PROPOSAL_VOTES);
  const now = new Date();
  if (cryptoConfig?.mode === "encrypt") {
    const encryptedFields = buildEncryptedVoteFields(cryptoConfig, {
      ...input,
      updatedAt: now,
    });
    const allBlindIndexes = computeAllBlindIndexesForMember(
      cryptoConfig,
      input.ballotId,
      input.memberId,
    );
    const existing = (await votesCol.findOne(
      {
        ballotId: input.ballotId,
        $or: [
          { memberId: input.memberId },
          { voterBlindIndex: { $in: allBlindIndexes } },
        ],
      } as any,
      sessionOpts,
    )) as (VoteRecord & { _id?: ObjectId }) | null;
    if (existing?._id) {
      await votesCol.updateOne(
        { _id: existing._id } as any,
        {
          $set: encryptedFields as any,
          $unset: { memberId: "", authorName: "", choice: "", reason: "" },
        },
        sessionOpts,
      );
    } else {
      await votesCol.updateOne(
        {
          ballotId: input.ballotId,
          voterBlindIndex: encryptedFields.voterBlindIndex,
        } as any,
        { $set: encryptedFields as any },
        { upsert: true, ...(sessionOpts ?? {}) },
      );
    }
  } else {
    await votesCol.updateOne(
      { ballotId: input.ballotId, memberId: input.memberId },
      {
        $set: {
          ballotId: input.ballotId,
          proposalId: input.proposalId,
          ...(input.amendmentId ? { amendmentId: input.amendmentId } : {}),
          revisionId: input.revisionId,
          ...(input.amendmentRevisionId
            ? { amendmentRevisionId: input.amendmentRevisionId }
            : {}),
          memberId: input.memberId,
          authorName: input.authorName,
          choice: input.choice,
          reason: input.reason,
          updatedAt: now,
        },
      },
      { upsert: true, ...(sessionOpts ?? {}) },
    );
  }

  const allVotes = await votesCol
    .find({ ballotId: input.ballotId }, sessionOpts)
    .toArray();
  const votes: VoteTally = { approve: 0, abstain: 0, reject: 0, total: 0 };
  for (const v of allVotes) {
    const decoded = decodeStoredVote(v as Record<string, any>, cryptoConfig);
    if (decoded.choice === "approve") votes.approve += 1;
    else if (decoded.choice === "abstain") votes.abstain += 1;
    else votes.reject += 1;
    votes.total += 1;
  }
  return votes;
}

export async function castVote(
  db: Db,
  user: SessionUser,
  body: Record<string, unknown>,
  env?: Partial<import("./types.ts").PlatformEnv>,
): Promise<{ choice: VoteChoice; votes: VoteTally; amendmentId?: string }> {
  const cryptoConfig = loadBallotCryptoConfig(env ?? process.env);
  if (!user.canParticipate) {
    throw new Error(
      "Your membership must be verified before you can participate in decisions.",
    );
  }

  const proposalId =
    typeof body.proposalId === "string"
      ? body.proposalId.trim()
      : typeof body.policyId === "string"
        ? body.policyId.trim()
        : "";
  const proposal = await db
    .collection<ProposalRecord>("proposals")
    .findOne({ proposalId });
  if (!proposal || !canViewProposal(normalizeProposalDoc(proposal), user))
    throw new Error("Proposal not found.");
  // Eligibility is decided in one place so proposal lists, proposal details and
  // ballot submission cannot drift apart. Following a branch never qualifies.
  const { getProposalEligibility } = await import("./branch-participation.ts");
  const eligibility = await getProposalEligibility(
    db,
    normalizeProposalDoc(proposal),
    user,
  );
  if (!eligibility.eligible) throw new Error(eligibility.reason);
  if (ballotExpired(proposal)) throw new Error("This ballot has closed.");
  const amendmentId =
    typeof body.amendmentId === "string" ? body.amendmentId.trim() : "";
  if (amendmentId) {
    if (proposal.stage !== "decide" || !proposal.ballotRevisionId)
      throw new Error(
        "The proposal must have an open, revision-bound ballot before an amendment ballot can be used.",
      );
    const amendment = await db
      .collection("amendments")
      .findOne({
        amendmentId,
        proposalId,
        status: "voting",
        baseRevisionId: proposal.ballotRevisionId,
        ballotRevisionId: proposal.ballotRevisionId,
      });
    if (
      !amendment?.ballotAmendmentRevisionId ||
      amendment.ballotAmendmentRevisionId !== amendment.currentRevisionId ||
      !(await db
        .collection("amendment_revisions")
        .findOne({
          amendmentId,
          revisionId: amendment.ballotAmendmentRevisionId,
        }))
    )
      throw new Error(
        "This amendment ballot is not bound to the current immutable wording revision.",
      );
    if (ballotExpired({ballotClosesAt:amendment.ballotClosesAt})) throw new Error("This amendment ballot has closed.");
    const rawChoice =
      typeof body.choice === "string" ? body.choice.trim().toLowerCase() : "";
    if (!["approve", "abstain", "reject", "do-not-approve"].includes(rawChoice))
      throw new Error("Choose Approve, Abstain, or Reject.");
    const choice: VoteChoice =
      rawChoice === "approve"
        ? "approve"
        : rawChoice === "abstain"
          ? "abstain"
          : "reject";
    const ballotId = `amendment:${amendmentId}`;
    const reason =
      typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
    const votes = await runInTransaction(db, async (session) => {
      await notePriorParticipation(db, user.memberId, session);
      const tally = await upsertStoredVote(
        db,
        cryptoConfig,
        {
          ballotId,
          proposalId,
          amendmentId,
          revisionId: amendment.ballotRevisionId,
          amendmentRevisionId: amendment.ballotAmendmentRevisionId,
          memberId: user.memberId,
          authorName: user.name || "Verified Member",
          choice,
          reason,
        },
        session,
      );
      await recordParticipation(db, user.memberId, new Date(), session);
      return tally;
    });
    return { choice, votes, amendmentId };
  }
  if (proposal.stage !== "decide") {
    throw new Error("This proposal is not currently in the Decide stage.");
  }
  if (ballotExpired(proposal)) throw new Error("This ballot has closed.");

  let ballotRevisionId = proposal.ballotRevisionId;
  let lazyBindRevision = false;
  if (ballotRevisionId) {
    const currentBallotId = proposalBallotId(proposalId);
    const existingVotes = await db
      .collection<VoteRecord>(PROPOSAL_VOTES)
      .find({ proposalId, ballotId: currentBallotId })
      .toArray();
    if (existingVotes.some((vote) => vote.revisionId !== ballotRevisionId)) {
      throw new Error(
        "This ballot contains votes that are not bound to its frozen wording. An administrator must review and resolve the binding before voting can continue.",
      );
    }
  }
  if (!ballotRevisionId) {
    const currentBallotId = proposalBallotId(proposalId);
    const priorVotes = await db
      .collection<VoteRecord>(PROPOSAL_VOTES)
      .find({ proposalId, ballotId: currentBallotId })
      .toArray();
    if (priorVotes.length) {
      const ids = [
        ...new Set(
          priorVotes
            .map((vote) => vote.revisionId)
            .filter(
              (id): id is string => typeof id === "string" && id.length > 0,
            ),
        ),
      ];
      if (
        ids.length !== 1 ||
        priorVotes.some((vote) => vote.revisionId !== ids[0])
      ) {
        throw new Error(
          "This existing ballot has votes without one consistent revision reference. An administrator must review and bind the wording before voting can continue.",
        );
      }
      ballotRevisionId = ids[0];
      if (
        !(await db
          .collection("proposal_revisions")
          .findOne({ proposalId, revisionId: ballotRevisionId }))
      )
        throw new Error(
          "The existing ballot revision is missing. An administrator must review the ballot before voting can continue.",
        );
    } else {
      const latest = await db
        .collection("proposal_revisions")
        .find({ proposalId })
        .sort({ createdAt: -1 })
        .limit(1)
        .toArray();
      ballotRevisionId = latest[0]?.revisionId;
    }
    if (!ballotRevisionId)
      throw new Error(
        "A proposal revision is required before voting can begin.",
      );
    lazyBindRevision = true;
  }

  const rawChoice =
    typeof body.choice === "string" ? body.choice.trim().toLowerCase() : "";
  if (!["approve", "abstain", "reject", "do-not-approve"].includes(rawChoice)) {
    throw new Error("Choose Approve, Abstain, or Reject.");
  }
  const choice: VoteChoice =
    rawChoice === "approve"
      ? "approve"
      : rawChoice === "abstain"
        ? "abstain"
        : "reject";
  const reason =
    typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";

  if (!ballotRevisionId) {
    throw new Error("A proposal revision is required before voting can begin.");
  }
  const initialBallotRevisionId = ballotRevisionId;
  const votes = await runInTransaction(db, async (session) => {
    const sessionOpts = session ? { session } : undefined;
    let resolvedRevisionId = initialBallotRevisionId;
    if (lazyBindRevision) {
      const bound = await db
        .collection("proposals")
        .updateOne(
          { proposalId, stage: "decide", ballotRevisionId: { $exists: false } },
          { $set: { ballotRevisionId: resolvedRevisionId } },
          sessionOpts,
        );
      if (!bound.matchedCount) {
        const current = await db
          .collection<ProposalRecord>("proposals")
          .findOne({ proposalId, stage: "decide" }, sessionOpts);
        if (!current?.ballotRevisionId)
          throw new Error(
            "The ballot changed while its revision was being bound. Reload and try again.",
          );
        resolvedRevisionId = current.ballotRevisionId;
      }
    }

    await notePriorParticipation(db, user.memberId, session);
    const tally = await upsertStoredVote(
      db,
      cryptoConfig,
      {
        ballotId: proposalBallotId(proposal.proposalId),
        proposalId: proposal.proposalId,
        revisionId: resolvedRevisionId,
        memberId: user.memberId,
        authorName: user.name || "Verified Member",
        choice,
        reason,
      },
      session,
    );

    // Clear any pending preference for this ballot now that a formal vote is recorded
    await db
      .collection<PendingVotePreferenceRecord>(PENDING_VOTE_PREFERENCES)
      .deleteOne(
        {
          ballotId: proposalBallotId(proposal.proposalId),
          memberId: user.memberId,
        },
        sessionOpts,
      );

    await recordParticipation(db, user.memberId, new Date(), session);
    return tally;
  });
  return { choice, votes };
}

export async function savePendingVotePreference(
  db: Db,
  user: SessionUser,
  body: Record<string, unknown>,
): Promise<{
  choice: VoteChoice;
  pendingVerification: true;
  revisionId: string;
}> {
  if (user.status === "suspended") {
    throw new Error(
      "Your account is suspended and cannot save ballot preferences.",
    );
  }
  const proposalId =
    typeof body.proposalId === "string"
      ? body.proposalId.trim()
      : typeof body.policyId === "string"
        ? body.policyId.trim()
        : "";
  const proposal = await db
    .collection<ProposalRecord>("proposals")
    .findOne({ proposalId });
  if (!proposal || !canViewProposal(normalizeProposalDoc(proposal), user)) {
    throw new Error("Proposal not found.");
  }
  if (proposal.stage !== "decide") {
    throw new Error("This proposal is not currently in the Decide stage.");
  }
  if (ballotExpired(proposal)) throw new Error("This ballot has closed.");

  let ballotRevisionId = proposal.ballotRevisionId;
  if (!ballotRevisionId) {
    const latest = await db
      .collection("proposal_revisions")
      .find({ proposalId })
      .sort({ createdAt: -1 })
      .limit(1)
      .toArray();
    ballotRevisionId = latest[0]?.revisionId;
  }
  if (!ballotRevisionId) {
    throw new Error(
      "A proposal revision is required before a ballot preference can be saved.",
    );
  }

  const rawChoice =
    typeof body.choice === "string" ? body.choice.trim().toLowerCase() : "";
  if (!["approve", "abstain", "reject", "do-not-approve"].includes(rawChoice)) {
    throw new Error("Choose Approve, Abstain, or Reject.");
  }
  const choice: VoteChoice =
    rawChoice === "approve"
      ? "approve"
      : rawChoice === "abstain"
        ? "abstain"
        : "reject";
  const reason =
    typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";

  await db
    .collection<PendingVotePreferenceRecord>(PENDING_VOTE_PREFERENCES)
    .updateOne(
      {
        ballotId: proposalBallotId(proposal.proposalId),
        memberId: user.memberId,
      },
      {
        $set: {
          ballotId: proposalBallotId(proposal.proposalId),
          proposalId: proposal.proposalId,
          revisionId: ballotRevisionId,
          memberId: user.memberId,
          authorName: user.name || "Pending Member",
          choice,
          ...(reason ? { reason } : { reason: "" }),
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );

  return {
    choice,
    pendingVerification: true,
    revisionId: ballotRevisionId,
  };
}

export async function promotePendingVotePreferences(
  db: Db,
  memberId: string,
): Promise<number> {
  const pendingCol = db.collection<PendingVotePreferenceRecord>(
    PENDING_VOTE_PREFERENCES,
  );
  const pendingItems = await pendingCol.find({ memberId }).toArray();
  if (pendingItems.length === 0) return 0;

  const userDoc = ObjectId.isValid(memberId)
    ? await db.collection("user").findOne({ _id: new ObjectId(memberId) })
    : null;
  if (userDoc?.disabled === true) return 0;

  const membershipDoc = await db
    .collection<{ memberId: string; status: MembershipStatus }>("memberships")
    .findOne({ memberId, status: "verified" });
  if (!membershipDoc) return 0;

  const authorName =
    typeof userDoc?.name === "string" && userDoc.name.trim()
      ? userDoc.name.trim()
      : "Verified Member";

  let promoted = 0;
  const votesCol = db.collection<VoteRecord>(PROPOSAL_VOTES);

  for (const item of pendingItems) {
    const rawProposal = await db
      .collection<ProposalRecord>("proposals")
      .findOne({ proposalId: item.proposalId });
    if (!rawProposal) continue;
    const proposal = normalizeProposalDoc(rawProposal);
    if (proposal.stage !== "decide" || ballotExpired(proposal)) continue;

    // Enforce identical branch electorate eligibility as castVote. National
    // governance is included for every verified Engage account.
    if (proposal.jurisdictionBranchId) {
      const [branch, branchMembership] = await Promise.all([
        db.collection("branches").findOne({
          branchId: proposal.jurisdictionBranchId,
          recognised: true,
        }),
        db.collection("branch_memberships").findOne({
          branchId: proposal.jurisdictionBranchId,
          memberId,
          status: "active",
        }),
      ]);
      if (!branch) continue;
      if (String((branch as any).kind) !== "national" && !branchMembership)
        continue;
    }

    const ballotRevisionId = proposal.ballotRevisionId;
    if (!ballotRevisionId || item.revisionId !== ballotRevisionId) {
      continue;
    }

    const existingFormalVote = await votesCol.findOne({
      ballotId: proposalBallotId(proposal.proposalId),
      memberId,
    });
    if (!existingFormalVote) {
      await votesCol.updateOne(
        {
          ballotId: proposalBallotId(proposal.proposalId),
          memberId,
        },
        {
          $set: {
            ballotId: proposalBallotId(proposal.proposalId),
            proposalId: proposal.proposalId,
            revisionId: ballotRevisionId,
            memberId,
            authorName,
            choice: item.choice,
            reason: item.reason ?? "",
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      );
      promoted += 1;
    }

    await pendingCol.deleteOne({
      ballotId: proposalBallotId(proposal.proposalId),
      memberId,
    });
  }

  return promoted;
}

export async function listUserActivity(
  db: Db,
  memberId: string,
): Promise<{
  proposals: ProposalRecord[];
  comments: Array<
    CommentRecord & { proposalTitle: string; proposalSlug: string }
  >;
  votes: Array<
    VoteRecord & {
      proposalTitle: string;
      proposalSlug: string;
      proposalStage: ProposalStage;
    }
  >;
}> {
  const cryptoConfig = loadBallotCryptoConfig(process.env);
  const [proposals, comments] = await Promise.all([
    db.collection<ProposalRecord>("proposals").find({}).toArray(),
    db
      .collection<CommentRecord>("comments")
      .find({ memberId })
      .sort({ createdAt: -1 })
      .toArray(),
  ]);
  const votes = await findMemberVotes(
    db,
    memberId,
    proposals.map((p) => proposalBallotId(p.proposalId)),
    cryptoConfig,
  );

  const proposalMap = new Map(proposals.map((p) => [p.proposalId, p]));

  return {
    proposals: proposals.filter((p) => p.authorId === memberId),
    comments: comments.map((c) => {
      const p = proposalMap.get(c.proposalId);
      return {
        ...c,
        proposalTitle: p?.title ?? c.proposalId,
        proposalSlug: p?.slug ?? c.proposalId,
      };
    }),
    votes: votes.map((v) => {
      const p = proposalMap.get(v.proposalId);
      return {
        ...v,
        memberId: v.memberId ?? memberId,
        authorName: v.authorName ?? "",
        proposalTitle: p?.title ?? v.proposalId,
        proposalSlug: p?.slug ?? v.proposalId,
        proposalStage: p?.stage ?? "deliberate",
      };
    }),
  };
}

export async function listOutstandingDecisions(
  db: Db,
  memberId: string,
  user?: SessionUser | null,
  availableProposals?: ProposalSummaryView[],
): Promise<ProposalSummaryView[]> {
  if (user && !user.canParticipate) return [];
  const cryptoConfig = loadBallotCryptoConfig(process.env);
  const decisions = availableProposals
    ? availableProposals.filter((proposal) => proposal.stage === "decide")
    : await listProposals(db, { stage: "decide", user });
  const votes = await findMemberVotes(
    db,
    memberId,
    decisions.map((d) => proposalBallotId(d.proposalId)),
    cryptoConfig,
  );
  const branchIds = [...new Set(
    decisions
      .map((decision) => decision.jurisdictionBranchId)
      .filter((branchId): branchId is string => Boolean(branchId)),
  )];
  const [memberships, branches] = branchIds.length
    ? await Promise.all([
        db.collection<{ branchId: string }>("branch_memberships")
          .find({ memberId, status: "active", branchId: { $in: branchIds } })
          .toArray(),
        db.collection<{ branchId: string; kind?: string }>("branches")
          .find({ recognised: true, branchId: { $in: branchIds } })
          .toArray(),
      ])
    : [[], []];
  const activeMemberships = new Set(memberships.map(({ branchId }) => branchId));
  const recognisedBranches = new Map(
    branches.map(({ branchId, kind }) => [branchId, kind]),
  );
  return decisions.filter((decision) => {
    if (!decision.ballotRevisionId || votes.some(v=>v.ballotId === proposalBallotId(decision.proposalId) && v.revisionId === decision.ballotRevisionId) || ballotExpired(decision)) return false;
    const branchId = decision.jurisdictionBranchId;
    if (!branchId) return true;
    if (!recognisedBranches.has(branchId)) return false;
    const kind = recognisedBranches.get(branchId);
    // National governance is included for every verified Engage account.
    return kind === "national" || activeMemberships.has(branchId);
  });
}

export async function listMembers(
  db: Db,
  search = "",
): Promise<MemberRecord[]> {
  const [
    users,
    roles,
    memberships,
    branchMemberships,
    assignments,
    roleDefinitions,
    branches,
  ] = await Promise.all([
    db.collection("user").find({}).sort({ createdAt: -1 }).toArray(),
    db
      .collection<{ memberId: string; role: UserRole }>("application_roles")
      .find({})
      .toArray(),
    db
      .collection<{
        memberId: string;
        status: MembershipStatus;
      }>("memberships")
      .find({})
      .toArray(),
    db
      .collection<{
        memberId: string;
        branchId: string;
        branchRole?: string;
        status: string;
      }>("branch_memberships")
      .find({ status: "active", branchRole: "administrator" })
      .toArray(),
    db
      .collection<{
        memberId: string;
        roleId: string;
        branchId?: string | null;
        status: string;
      }>(RBAC_ASSIGNMENTS)
      .find({ status: "active" })
      .toArray(),
    db
      .collection<{ roleId: string; name: string }>(RBAC_ROLES)
      .find({})
      .toArray(),
    db
      .collection<{ branchId: string; name: string }>("branches")
      .find({})
      .toArray(),
  ]);

  const rolesMap = new Map<string, UserRole[]>();
  for (const r of roles) {
    const list = rolesMap.get(r.memberId) ?? [];
    if (!list.includes(r.role)) list.push(r.role);
    rolesMap.set(r.memberId, list);
  }
  const statusMap = new Map<string, MembershipStatus>(
    memberships.map((m) => [m.memberId, m.status]),
  );
  const branchNameById = new Map(
    branches.map((branch) => [branch.branchId, branch.name]),
  );
  const roleNameById = new Map(
    roleDefinitions.map((role) => [role.roleId, role.name]),
  );
  const branchAdministratorOf = new Map<string, string[]>();
  for (const membership of branchMemberships) {
    const list = branchAdministratorOf.get(membership.memberId) ?? [];
    list.push(
      branchNameById.get(membership.branchId) ?? membership.branchId,
    );
    branchAdministratorOf.set(membership.memberId, list);
  }
  const delegatedRoles = new Map<string, string[]>();
  for (const assignment of assignments) {
    const name =
      roleNameById.get(assignment.roleId) ?? assignment.roleId;
    const branch = assignment.branchId
      ? branchNameById.get(assignment.branchId) ?? assignment.branchId
      : null;
    const label = branch ? `${name} — ${branch}` : name;
    const list = delegatedRoles.get(assignment.memberId) ?? [];
    list.push(label);
    delegatedRoles.set(assignment.memberId, list);
  }
  const q = search.trim().toLowerCase();

  return users
    .map((u) => {
      const memberId = String(u._id);
      const platformRoles = normalisePlatformRoles(
        rolesMap.get(memberId) ?? [],
      );
      return {
        memberId,
        name: String(u.name ?? ""),
        email: String(u.email ?? ""),
        role: primaryPlatformRole(platformRoles),
        roles: platformRoles,
        status: statusMap.get(memberId) ?? "pending",
        disabled: Boolean(u.disabled),
        emailVerified: Boolean(u.emailVerified),
        createdAt: u.createdAt instanceof Date ? u.createdAt : undefined,
        ...(branchAdministratorOf.has(memberId)
          ? { branchAdministratorOf: branchAdministratorOf.get(memberId) }
          : {}),
        ...(delegatedRoles.has(memberId)
          ? { delegatedRoles: delegatedRoles.get(memberId) }
          : {}),
      };
    })
    .filter(
      (m) =>
        !q ||
        `${m.name} ${m.email} ${m.role} ${(m.roles ?? []).join(" ")} ${m.status} ${(m.delegatedRoles ?? []).join(" ")} ${(m.branchAdministratorOf ?? []).join(" ")}`
          .toLowerCase()
          .includes(q),
    );
}

export async function saveMember(
  db: Db,
  actor: SessionUser,
  body: Record<string, unknown>,
  create = false,
): Promise<{ memberId: string }> {
  const changingMembership =
    create ||
    body.name !== undefined ||
    body.status !== undefined ||
    body.disabled !== undefined;
  const rolesProvided = body.roles !== undefined;
  const roleProvided = body.role !== undefined;
  const changingRole = rolesProvided || roleProvided;
  if (changingMembership && !hasPermission(actor, "members.verify")) {
    throw new Error("Member verification permission required.");
  }
  if (changingRole && !hasPermission(actor, "roles.manage")) {
    throw new Error(
      "Role management permission is required to change a platform role.",
    );
  }
  if (!changingMembership && !changingRole) {
    throw new Error("Choose a membership or role change.");
  }

  const name = body.name === undefined ? undefined : validPersonName(body.name);
  if (name === null || (create && !name)) {
    throw new Error("Enter a full name (2–100 characters).");
  }

  let requestedRoles: UserRole[] | undefined;
  if (rolesProvided) {
    if (!Array.isArray(body.roles)) {
      throw new Error("Choose a valid set of platform roles.");
    }
    requestedRoles = normalisePlatformRoles(body.roles);
    if (roleProvided) {
      const single = normalisePlatformRoles([String(body.role)]);
      if (single.join(",") !== requestedRoles.join(",")) {
        throw new Error("Choose one set of platform roles.");
      }
    }
  } else if (roleProvided) {
    requestedRoles = normalisePlatformRoles([String(body.role)]);
  }

  // Anti-escalation: a delegated role manager cannot promote anyone into a
  // system role whose permissions they do not personally hold.
  const actorIsNationalAdministrator = canGrantPermissionSet(
    actor,
    ALL_NATIONAL_PERMISSIONS,
  );
  if (
    requestedRoles?.includes("administrator") &&
    !actorIsNationalAdministrator
  ) {
    throw new Error(
      "You cannot grant National Administrator because you do not hold all national permissions.",
    );
  }
  if (
    requestedRoles?.includes("moderator") &&
    !canGrantPermissionSet(actor, LEGACY_MODERATOR_PERMISSIONS)
  ) {
    throw new Error(
      "You cannot grant Moderator because you do not hold all moderator permissions.",
    );
  }

  const status = body.status !== undefined ? String(body.status) : undefined;
  if (
    status !== undefined &&
    !["pending", "verified", "suspended"].includes(status)
  ) {
    throw new Error("Choose a valid membership status.");
  }

  const disabled =
    body.disabled !== undefined ? Boolean(body.disabled) : undefined;
  const users = db.collection("user");
  const now = new Date();
  let memberId: string;

  if (create) {
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("Enter a valid email address.");
    }
    if (await users.findOne({ email })) {
      throw new Error("An account with that email already exists.");
    }
    const saved = await users.insertOne({
      name,
      email,
      emailVerified: false,
      disabled: disabled === true,
      createdAt: now,
      updatedAt: now,
    });
    memberId = saved.insertedId.toString();
    await recordLifecycle(db, memberId, "registration_completed", now);
    await recordLifecycle(db, memberId, "verification_requested", now);
  } else {
    if (
      typeof body.memberId !== "string" ||
      !/^[a-f0-9]{24}$/.test(body.memberId)
    ) {
      throw new Error("Choose a valid member account.");
    }
    memberId = body.memberId;
    if (!(await users.findOne({ _id: new ObjectId(memberId) }))) {
      throw new Error("Account not found.");
    }
    const targetRoles = await db
      .collection<{ role: UserRole }>("application_roles")
      .find({ memberId })
      .toArray();
    const targetIsAdministrator = targetRoles.some(
      (row) => row.role === "administrator",
    );
    if (
      targetIsAdministrator &&
      !actorIsNationalAdministrator
    ) {
      throw new Error(
        "Only a national administrator can change a national administrator account.",
      );
    }
    if (
      memberId === actor.memberId &&
      (disabled === true ||
        (actorIsNationalAdministrator &&
          requestedRoles !== undefined &&
          !requestedRoles.includes("administrator")) ||
        (status !== undefined && status !== "verified"))
    ) {
      throw new Error("You cannot remove your own administrator access.");
    }
    await users.updateOne(
      { _id: new ObjectId(memberId) },
      {
        $set: {
          ...(name ? { name } : {}),
          ...(disabled !== undefined ? { disabled } : {}),
          updatedAt: now,
        },
      },
    );
  }

  if (requestedRoles !== undefined) {
    const roleCollection = db.collection("application_roles");
    const desired = requestedRoles.filter((item) => item !== "member");
    const desiredSet = new Set<string>(desired);
    const existingRoles = await roleCollection.find({ memberId }).toArray();
    for (const row of existingRoles) {
      if (!desiredSet.has(String(row.role))) {
        await roleCollection.deleteOne({ _id: row._id });
      }
    }
    for (const role of desired) {
      await roleCollection.updateOne(
        { memberId, role },
        {
          $setOnInsert: {
            memberId,
            role,
            grantedAt: now,
            grantedBy: actor.memberId,
          },
        },
        { upsert: true },
      );
    }
  }

  if (status !== undefined) {
    const previous = await db.collection("memberships").findOne({memberId});
    await db.collection("memberships").updateOne(
      { memberId },
      {
        $set: {
          memberId,
          status,
          ...(status === "verified" && previous?.status !== "verified"
            ? {
                verifiedAt: now,
                verifiedBy: actor.memberId,
                verificationSource: "manual-admin",
              }
            : {}),
          updatedAt: now,
          updatedBy: actor.memberId,
        },
      },
      { upsert: true },
    );
    if (status === "verified" && previous?.status !== "verified") await recordLifecycle(db, memberId, "verification_approved", now);
    if (status === "verified" && disabled !== true) {
      await promotePendingVotePreferences(db, memberId);
    }
  }

  if (status === "pending") {
    try {
      const { enqueueVerificationAttempt } = await import(
        "./membership-verification.ts"
      );
      await enqueueVerificationAttempt(db, memberId, {
        source: "admin-pending",
        force: true,
      });
    } catch (error) {
      const { logOperationalEvent } = await import("./resilience.ts");
      logOperationalEvent("error", "verification_queue_failed", {
        code: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  if (disabled === true) {
    await db
      .collection("session")
      .deleteMany({ userId: { $in: [memberId, new ObjectId(memberId)] } });
  }

  return { memberId };
}

// Keep aliases for any callers
export const listPolicies = listProposals;
export const getPolicyDetail = getProposalDetail;
export const savePolicy = saveProposal;
export const deletePolicy = deleteProposal;

