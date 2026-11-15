import { policyCanonicalPath } from "./policy-registry.ts";

export function publicPolicy(row: Record<string, any>) {
  const canonicalPath = policyCanonicalPath(row);
  return {
    policyId: row.policyId,
    /** Public address of this record. */
    canonicalPath,
    branchSlug: row.branchSlug ?? null,
    policySlug: row.policySlug ?? null,
    title: row.title,
    summary: row.summary,
    pillar: row.pillar ?? null,
    category: row.category ?? null,
    commitments: Array.isArray(row.commitments) ? row.commitments : [],
    approvedWording: row.approvedWording ?? "",
    revisionId: row.revisionId,
    revisionIds: Array.isArray(row.revisionIds)
      ? row.revisionIds
      : [row.revisionId].filter(Boolean),
    status: row.status,
    publicationStatus: row.publicationStatus,
    /** "branch-import" records were adopted outside Engage. */
    recordOrigin: row.recordOrigin ?? null,
    changeType: row.changeType ?? null,
    supersedes: Array.isArray(row.supersedes) ? row.supersedes : [],
    provenance: row.provenance ?? null,
    jurisdiction: row.jurisdiction ?? null,
    jurisdictionBranchId: row.jurisdictionBranchId ?? null,
    governanceAuthorityBranchId: row.governanceAuthorityBranchId ?? null,
    ratification: row.ratification
      ? {
          authorityBranchId: row.ratification.authorityBranchId,
          decisionEventId: row.ratification.decisionEventId,
          ballotRevisionId: row.ratification.ballotRevisionId,
          ratifiedRevisionId: row.ratification.ratifiedRevisionId,
          adoptedAmendmentIds: Array.isArray(
            row.ratification.adoptedAmendmentIds,
          )
            ? row.ratification.adoptedAmendmentIds
            : [],
          ratifiedAt: row.ratification.ratifiedAt,
        }
      : null,
    effectiveAt: row.effectiveAt ?? null,
    publishedAt: row.publishedAt ?? null,
    supersededBy: row.supersededBy ?? null,
    supersededAt: row.supersededAt ?? null,
    supersededByChangeType: row.supersededByChangeType ?? null,
    repealedAt: row.repealedAt ?? null,
    repealedBy: row.repealedBy
      ? {
          proposalId: row.repealedBy.proposalId,
          revisionId: row.repealedBy.revisionId,
          decisionEventId: row.repealedBy.decisionEventId,
          authorityBranchId: row.repealedBy.authorityBranchId,
          recordedAt: row.repealedBy.recordedAt,
        }
      : null,
    withdrawnAt: row.withdrawnAt ?? null,
  };
}
