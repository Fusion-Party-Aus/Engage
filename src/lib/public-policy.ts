export function publicPolicy(row: Record<string, any>) {
  return {
    policyId: row.policyId,
    title: row.title,
    summary: row.summary,
    category: row.category ?? null,
    commitments: Array.isArray(row.commitments) ? row.commitments : [],
    approvedWording: row.approvedWording ?? "",
    revisionId: row.revisionId,
    revisionIds: Array.isArray(row.revisionIds)
      ? row.revisionIds
      : [row.revisionId].filter(Boolean),
    status: row.status,
    publicationStatus: row.publicationStatus,
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
    withdrawnAt: row.withdrawnAt ?? null,
  };
}
