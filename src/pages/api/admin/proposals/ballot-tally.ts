import type { APIRoute } from "astro";
import { canManageBranchBallot, getSessionUser } from "../../../../lib/auth.ts";
import { readBallotOutcome } from "../../../../lib/ballot-outcome.ts";
import type { BallotQuorumView } from "../../../../lib/ballot-outcome.ts";
import { loadBallotTallyCryptoConfig } from "../../../../lib/ballots.ts";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import { hasPermission } from "../../../../lib/rbac.ts";
import { normalizeProposalDoc } from "../../../../lib/proposal-helpers.ts";

export const prerender = false;

/**
 * On-demand bound ballot tally for a single proposal row on the admin
 * register. Only decrypts votes when an officer explicitly opens that row's
 * inline outcome-recording control.
 */
export const GET: APIRoute = async ({ request, url, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user) {
    return Response.json({ error: "Sign in required." }, { status: 401 });
  }
  if (
    !user.isAdmin &&
    !user.isBranchAdmin &&
    !hasPermission(user, "ballots.record_result")
  ) {
    return Response.json(
      { error: "Administrator access required." },
      { status: 403 },
    );
  }

  const proposalId = (url.searchParams.get("proposalId") ?? "").trim();
  if (!proposalId) {
    return Response.json(
      { error: "proposalId is required." },
      { status: 400 },
    );
  }

  const db = await getDatabase(env);
  const raw = await db
    .collection("proposals")
    .findOne({ $or: [{ proposalId }, { policyId: proposalId }] });
  if (!raw) {
    return Response.json({ error: "Proposal not found." }, { status: 404 });
  }

  const proposal = normalizeProposalDoc(raw as Record<string, any>);
  const branchScope =
    typeof proposal.governanceAuthorityBranchId === "string"
      ? proposal.governanceAuthorityBranchId
      : undefined;
  if (
    !hasPermission(user, "ballots.record_result", branchScope) ||
    !canManageBranchBallot(user, {
      governanceAuthorityBranchId: proposal.governanceAuthorityBranchId,
      jurisdictionBranchId: proposal.jurisdictionBranchId,
    })
  ) {
    return Response.json(
      {
        error:
          "You are not authorised to view or record an outcome for this ballot.",
      },
      { status: 403 },
    );
  }

  if (proposal.stage !== "decide" || !proposal.ballotRevisionId) {
    return Response.json(
      { error: "Proposal must have an active, revision-bound ballot." },
      { status: 409 },
    );
  }

  const outcome = await readBallotOutcome(db, {
    proposalId: proposal.proposalId,
    cryptoConfig: loadBallotTallyCryptoConfig(env),
  });
  if (!outcome) {
    return Response.json({ error: "Proposal not found." }, { status: 404 });
  }

  return Response.json(
    {
      proposalId: proposal.proposalId,
      closed: outcome.closure.closed,
      summary: outcome.tally,
      computedLabel: outcome.tally?.computedLabel ?? null,
      quorum: quorumResponse(outcome.quorum),
    },
    { status: 200, headers: { "cache-control": "private, no-store" } },
  );
};

function quorumResponse(quorum: BallotQuorumView | null) {
  if (!quorum) return null;
  if (quorum.status === "recorded") {
    const record = quorum.record;
    return {
      final: true,
      status: record.status,
      ruleLabel: quorum.ruleLabel,
      verdictLabel: quorum.verdictLabel,
      eligibleRegisteredMembers: record.eligibleRegisteredMembers,
      activeEligibleMembers: record.activeEligibleMembers,
      platformQuorumRequired: record.platformQuorumRequired,
      platformQuorumMet: record.platformQuorumMet,
      ballotQuorumRequired: record.ballotQuorumRequired,
      ballotQuorumMet: record.ballotQuorumMet,
      participation:
        record.participatingMembers ?? record.tally?.total ?? 0,
      quorumMet: record.quorumMet,
    };
  }
  if (quorum.status === "preview") {
    const preview = quorum.preview;
    return {
      final: false,
      status: "current",
      ruleLabel: quorum.ruleLabel,
      verdictLabel: null,
      eligibleRegisteredMembers: preview.eligibleRegisteredMembers,
      activeEligibleMembers: preview.activeEligibleMembers,
      platformQuorumRequired: preview.platformQuorumRequired,
      platformQuorumMet: preview.platformQuorumMet,
      ballotQuorumRequired: preview.ballotQuorumRequired,
      ballotQuorumMet: preview.ballotQuorumMet,
      participation: preview.participationCount,
      quorumMet: preview.quorumMet,
    };
  }
  return {
    final: true,
    status: "unavailable",
    ruleLabel: quorum.ruleLabel,
    verdictLabel: "Inconclusive",
    quorumMet: false,
    anomalies: [quorum.reason],
  };
}
