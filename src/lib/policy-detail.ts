import type { Db } from "mongodb";
import { proposalBallotResultFilter } from "./ballots.ts";
import { listPolicyChangeProposals } from "./policy-change.ts";
import {
  canViewProposal,
  isPolicyRegistryRecordForResolution,
} from "./store.ts";
import type { SessionUser } from "./types.ts";

export interface PolicyDetailContext {
  policy: Record<string, any>;
  branch: Record<string, any> | null;
  authority: Record<string, any> | null;
  sourceProposal: Record<string, any> | null;
  sourceResult: Record<string, any> | null;
  changeProposals: Array<Record<string, any>>;
  previousPolicy: Record<string, any> | null;
  successorPolicy: Record<string, any> | null;
  repealProposal: Record<string, any> | null;
}

/**
 * Load everything the policy page needs in one pass. A governance resolution
 * that leaked into the registry is treated as absent, never displayed.
 */
export async function loadPolicyDetail(
  db: Db,
  user: SessionUser | null,
  row: Record<string, any> | null,
): Promise<PolicyDetailContext | null> {
  if (!row) return null;
  const sourceProposal = row.proposalId
    ? await db
        .collection("proposals")
        .findOne({ proposalId: String(row.proposalId) })
    : null;
  if (
    isPolicyRegistryRecordForResolution(
      row as { policyId?: string; proposalId?: string; kind?: string },
      sourceProposal as { kind?: string; proposalId?: string } | null,
    )
  )
    return null;

  const [branch, authority, sourceResult, changeCandidates, previousPolicy] =
    await Promise.all([
      row.jurisdictionBranchId
        ? db
            .collection("branches")
            .findOne({ branchId: String(row.jurisdictionBranchId) })
        : Promise.resolve(null),
      row.governanceAuthorityBranchId
        ? db
            .collection("branches")
            .findOne({ branchId: String(row.governanceAuthorityBranchId) })
        : Promise.resolve(null),
      row.proposalId
        ? db
            .collection("ballot_results")
            .findOne(proposalBallotResultFilter(String(row.proposalId)))
        : Promise.resolve(null),
      listPolicyChangeProposals(db, String(row.policyId)),
      Array.isArray(row.supersedes) && row.supersedes[0]
        ? db
            .collection("policy_registry")
            .findOne({ policyId: String(row.supersedes[0]) })
        : Promise.resolve(null),
    ]);
  const [successorPolicy, repealProposal] = await Promise.all([
    row.supersededBy
      ? db
          .collection("policy_registry")
          .findOne({ policyId: String(row.supersededBy) })
      : Promise.resolve(null),
    row.repealedBy?.proposalId
      ? db
          .collection("proposals")
          .findOne({ proposalId: String(row.repealedBy.proposalId) })
      : Promise.resolve(null),
  ]);
  return {
    policy: row,
    branch,
    authority,
    sourceProposal,
    sourceResult,
    changeProposals: changeCandidates.filter((proposal) =>
      canViewProposal(proposal as any, user),
    ),
    previousPolicy,
    successorPolicy,
    repealProposal,
  };
}
