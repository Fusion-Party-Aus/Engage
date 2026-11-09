import type { ProposalSummaryView } from "./types.ts";
export const MIN_DECISIVE_VOTES = 5;
export type ProposalRanking = "divisive" | "approved" | "active";
export function proposalMetrics(p: Pick<ProposalSummaryView, "votes" | "commentCount">) {
  const decisive = p.votes.approve + p.votes.reject;
  return {
    decisive,
    approval: decisive >= MIN_DECISIVE_VOTES ? p.votes.approve / decisive : null,
    division: decisive >= MIN_DECISIVE_VOTES && p.votes.approve > 0 && p.votes.reject > 0
      ? 4 * p.votes.approve * p.votes.reject / decisive ** 2 : null,
    activity: p.votes.total + p.commentCount,
  };
}
export function rankProposals(proposals: ProposalSummaryView[], ranking: ProposalRanking) {
  const score = (p: ProposalSummaryView) => {
    const m = proposalMetrics(p);
    return ranking === "divisive" ? m.division : ranking === "approved" ? m.approval : m.activity || null;
  };
  return proposals.filter(p => p.stage !== "archived" && score(p) !== null).sort((a,b) =>
    (score(b)! - score(a)!) || b.votes.total - a.votes.total || a.proposalId.localeCompare(b.proposalId));
}
