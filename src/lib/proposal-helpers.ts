import {
  matterHasCapability,
  normalizeMatterType,
  validateMatterTransition,
} from "./matters.ts";
import { isPolicyChangeType } from "./policy-change.ts";
import { hasPermission } from "./rbac.ts";
import type {
  CommentStance,
  ProposalKind,
  ProposalRecord,
  ProposalStage,
  SessionUser,
} from "./types.ts";

export const PENDING_VOTE_PREFERENCES = "pending_vote_preferences";

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
    targetSection?: string;
    proposedWording?: string;
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
  if (
    updates.targetSection !== undefined &&
    updates.targetSection.trim() !== (existing.targetSection || "").trim()
  ) {
    changes.push("targetSection");
  }
  if (
    updates.proposedWording !== undefined &&
    updates.proposedWording.trim() !== (existing.proposedWording || "").trim()
  ) {
    changes.push("proposedWording");
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
    kind =
      typeof raw.kind === "string" && raw.kind.trim()
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
    ballotClosedAt: raw.ballotClosedAt ? new Date(raw.ballotClosedAt) : undefined,
    secondedBy: raw.secondedBy ? String(raw.secondedBy) : undefined,
    secondedAt: raw.secondedAt ? new Date(raw.secondedAt) : undefined,
    deliberationEndsAt: raw.deliberationEndsAt
      ? new Date(raw.deliberationEndsAt)
      : undefined,
    ...(raw.sourceSenseSubmissionId
      ? { sourceSenseSubmissionId: String(raw.sourceSenseSubmissionId) }
      : {}),
    ...(raw.sourceSensePrivacyReviewedAt
      ? { sourceSensePrivacyReviewedAt: new Date(raw.sourceSensePrivacyReviewedAt) }
      : {}),
    ...(raw.sourceSensePrivacyReviewedBy
      ? { sourceSensePrivacyReviewedBy: String(raw.sourceSensePrivacyReviewedBy) }
      : {}),
    ...(raw.sourceSensePrivacyBasis === "published-source" || raw.sourceSensePrivacyBasis === "independent-wording"
      ? { sourceSensePrivacyBasis: raw.sourceSensePrivacyBasis }
      : {}),
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
    ...(raw.targetPolicyId
      ? {
          targetPolicyId: String(raw.targetPolicyId),
          ...(raw.targetPolicyRevisionId
            ? { targetPolicyRevisionId: String(raw.targetPolicyRevisionId) }
            : {}),
          ...(isPolicyChangeType(raw.changeType)
            ? { changeType: raw.changeType }
            : {}),
        }
      : {}),
    ...(raw.targetSection ? { targetSection: String(raw.targetSection) } : {}),
    ...(raw.proposedWording
      ? { proposedWording: String(raw.proposedWording) }
      : {}),
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
