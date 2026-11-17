import type { APIRoute } from "astro";
import { getSessionUser } from "../../../../lib/auth.ts";
import { ballotActs } from "../../../../lib/ballot-authority.ts";
import {
  ballotOutcomeLabel,
  loadBallotTallyCryptoConfig,
  readBoundBallotTallies,
  resolveBallotClosure,
} from "../../../../lib/ballots.ts";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import {
  buildQuorumPreview,
  getQuorumElectoratePreview,
  quorumRuleLabel,
  quorumVerdictLabel,
  readBallotQuorumRecord,
} from "../../../../lib/quorum.ts";
import { hasPermissionAnywhere } from "../../../../lib/rbac.ts";
import { normalizeProposalDoc } from "../../../../lib/proposal-helpers.ts";
import { proposalBallotId } from "../../../../lib/vote-storage.ts";

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
    !hasPermissionAnywhere(user, "ballots.record_result")
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
  const authority = ballotActs(user, {
    governanceAuthorityBranchId: proposal.governanceAuthorityBranchId,
    jurisdictionBranchId: proposal.jurisdictionBranchId,
    originatingBranchId: proposal.originatingBranchId,
  });
  if (!authority.can("recordMatterResult")) {
    return Response.json(
      {
        error:
          authority.denialMessage("recordMatterResult") ??
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

  const tallies = await readBoundBallotTallies(db, {
    ballots: [
      {
        matterId: proposal.proposalId,
        revisionId: String(proposal.ballotRevisionId),
      },
    ],
    cryptoConfig: loadBallotTallyCryptoConfig(env),
  });
  const summary = tallies.get(proposal.proposalId) ?? null;
  const closure = resolveBallotClosure({ matter: proposal });
  const participation = summary?.tally?.total ?? 0;
  const quorumRecord = await readBallotQuorumRecord(
    db,
    proposalBallotId(proposal.proposalId),
  );
  const quorumPreview =
    !quorumRecord && !closure.closed
      ? buildQuorumPreview(
          await getQuorumElectoratePreview(db),
          participation,
        )
      : null;
  const quorum = quorumRecord
    ? {
        final: true,
        status: quorumRecord.status,
        ruleLabel: quorumRuleLabel(quorumRecord),
        verdictLabel: quorumVerdictLabel(quorumRecord.verdict),
        eligibleRegisteredMembers: quorumRecord.eligibleRegisteredMembers,
        activeEligibleMembers: quorumRecord.activeEligibleMembers,
        platformQuorumRequired: quorumRecord.platformQuorumRequired,
        platformQuorumMet: quorumRecord.platformQuorumMet,
        ballotQuorumRequired: quorumRecord.ballotQuorumRequired,
        ballotQuorumMet: quorumRecord.ballotQuorumMet,
        participation:
          quorumRecord.participatingMembers ?? quorumRecord.tally?.total ?? 0,
        quorumMet: quorumRecord.quorumMet,
      }
    : quorumPreview
      ? {
          final: false,
          status: "current",
          ruleLabel: quorumRuleLabel({
            ruleVersion: quorumPreview.ruleVersion,
          }),
          verdictLabel: null,
          eligibleRegisteredMembers:
            quorumPreview.eligibleRegisteredMembers,
          activeEligibleMembers: quorumPreview.activeEligibleMembers,
          platformQuorumRequired: quorumPreview.platformQuorumRequired,
          platformQuorumMet: quorumPreview.platformQuorumMet,
          ballotQuorumRequired: quorumPreview.ballotQuorumRequired,
          ballotQuorumMet: quorumPreview.ballotQuorumMet,
          participation: quorumPreview.participationCount,
          quorumMet: quorumPreview.quorumMet,
        }
      : null;

  return Response.json(
    {
      proposalId: proposal.proposalId,
      closed: closure.closed,
      summary,
      computedLabel: summary?.computedResult
        ? ballotOutcomeLabel(summary.computedResult)
        : null,
      quorum,
    },
    { status: 200, headers: { "cache-control": "private, no-store" } },
  );
};
