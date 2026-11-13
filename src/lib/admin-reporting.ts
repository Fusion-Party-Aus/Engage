import { ballotExpired } from "./ballot-deadline.ts";
import type { BranchRecord, ProposalSummaryView } from "./types.ts";

export interface BallotProgressRow {
  proposalId: string;
  slug: string;
  title: string;
  kind: string;
  branchName: string;
  bound: boolean;
  closesAt?: Date;
  expired: boolean;
  approve: number;
  abstain: number;
  reject: number;
  total: number;
}

export interface BranchSummaryRow {
  branchId: string;
  branchName: string;
  kind: string;
  verifiedMembers: number;
  propose: number;
  deliberate: number;
  decide: number;
  implement: number;
  archived: number;
  totalProposals: number;
  totalVotes: number;
}

export function buildBallotProgressRows(
  proposals: ProposalSummaryView[],
  branchNames: Map<string, string>,
): BallotProgressRow[] {
  return proposals
    .filter((proposal) => proposal.stage === "decide")
    .map((proposal) => {
      const branchId =
        proposal.jurisdictionBranchId || proposal.originatingBranchId || "";
      return {
        proposalId: proposal.proposalId,
        slug: proposal.slug,
        title: proposal.title,
        kind:
          proposal.kind === "resolution" || proposal.proposalId.startsWith("GOV-")
            ? "resolution"
            : "policy",
        branchName: branchId
          ? (branchNames.get(branchId) ?? branchId)
          : "Party-wide",
        bound: Boolean(proposal.ballotRevisionId),
        closesAt: proposal.ballotClosesAt,
        expired: ballotExpired(proposal),
        approve: proposal.votes.approve,
        abstain: proposal.votes.abstain,
        reject: proposal.votes.reject,
        total: proposal.votes.total,
      };
    })
    .sort((a, b) => {
      if (a.bound !== b.bound) return a.bound ? 1 : -1;
      if (a.closesAt && b.closesAt) {
        return new Date(a.closesAt).getTime() - new Date(b.closesAt).getTime();
      }
      if (a.closesAt) return -1;
      if (b.closesAt) return 1;
      return b.total - a.total;
    });
}

export function buildBranchSummaryRows(
  proposals: ProposalSummaryView[],
  branches: Array<Pick<BranchRecord, "branchId" | "name" | "kind">>,
  verifiedCountsByBranch: Map<string, number>,
  allowedBranchIds?: Set<string>,
): BranchSummaryRow[] {
  const rows = new Map<string, BranchSummaryRow>();
  for (const branch of branches) {
    if (allowedBranchIds && !allowedBranchIds.has(branch.branchId)) continue;
    rows.set(branch.branchId, {
      branchId: branch.branchId,
      branchName: branch.name,
      kind: branch.kind,
      verifiedMembers: verifiedCountsByBranch.get(branch.branchId) ?? 0,
      propose: 0,
      deliberate: 0,
      decide: 0,
      implement: 0,
      archived: 0,
      totalProposals: 0,
      totalVotes: 0,
    });
  }

  for (const proposal of proposals) {
    const branchId =
      proposal.originatingBranchId ||
      proposal.jurisdictionBranchId ||
      "national";
    if (allowedBranchIds && !allowedBranchIds.has(branchId)) continue;
    const existing = rows.get(branchId) ?? {
      branchId,
      branchName: branchId === "national" ? "National" : branchId,
      kind: "national",
      verifiedMembers: verifiedCountsByBranch.get(branchId) ?? 0,
      propose: 0,
      deliberate: 0,
      decide: 0,
      implement: 0,
      archived: 0,
      totalProposals: 0,
      totalVotes: 0,
    };
    if (proposal.stage === "propose") existing.propose += 1;
    else if (proposal.stage === "deliberate") existing.deliberate += 1;
    else if (proposal.stage === "decide") existing.decide += 1;
    else if (proposal.stage === "implement") existing.implement += 1;
    else if (proposal.stage === "archived") existing.archived += 1;
    existing.totalProposals += 1;
    existing.totalVotes += proposal.votes.total;
    rows.set(branchId, existing);
  }

  return [...rows.values()].sort(
    (a, b) =>
      b.totalProposals - a.totalProposals ||
      b.verifiedMembers - a.verifiedMembers ||
      a.branchName.localeCompare(b.branchName),
  );
}

function escapeCsvCell(value: unknown): string {
  const raw = value === null || value === undefined ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  if (/[",\n\r]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export function proposalsSummaryToCsv(
  proposals: ProposalSummaryView[],
  branchNames: Map<string, string>,
): string {
  const headers = [
    "proposalId",
    "title",
    "kind",
    "stage",
    "space",
    "branch",
    "ballotBound",
    "ballotClosesAt",
    "approveVotes",
    "abstainVotes",
    "rejectVotes",
    "totalVotes",
    "commentCount",
    "supersededByProposalId",
    "updatedAt",
  ];
  const lines = [headers.join(",")];
  for (const proposal of proposals) {
    const branchId =
      proposal.originatingBranchId || proposal.jurisdictionBranchId || "";
    const branchName = branchId
      ? (branchNames.get(branchId) ?? branchId)
      : "Party-wide";
    const kind =
      proposal.kind === "resolution" || proposal.proposalId.startsWith("GOV-")
        ? "resolution"
        : "policy";
    const row = [
      proposal.proposalId,
      proposal.title,
      kind,
      proposal.stage,
      proposal.space,
      branchName,
      proposal.ballotRevisionId ? "yes" : "no",
      proposal.ballotClosesAt
        ? new Date(proposal.ballotClosesAt).toISOString()
        : "",
      proposal.votes.approve,
      proposal.votes.abstain,
      proposal.votes.reject,
      proposal.votes.total,
      proposal.commentCount,
      proposal.supersededByProposalId ?? "",
      new Date(proposal.updatedAt).toISOString(),
    ];
    lines.push(row.map(escapeCsvCell).join(","));
  }
  return `${lines.join("\n")}\n`;
}
