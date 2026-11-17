import type { Db } from "mongodb";
import { policyCanonicalPath } from "./policy-registry.ts";
import { canViewProposal, normalizeProposalDoc } from "./proposal-helpers.ts";
import { hasPermission } from "./rbac.ts";
import type {
  CommentRecord,
  ContributionFeedback,
  ContributionFeedbackEvidence,
  ContributionFeedbackEvidenceKind,
  ContributionFeedbackHistoryEntry,
  ContributionFeedbackStatus,
  ProposalRecord,
  SessionUser,
} from "./types.ts";

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
        "repealed",
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
          ? { href: policyCanonicalPath(pol) }
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
