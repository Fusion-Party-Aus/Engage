import type { Db } from "mongodb";
import { listMatterBallots, type BallotRecord } from "./ballots.ts";
import { canViewProposal, getProposalDetail } from "./store.ts";
import { normalizeMatterType, type MatterTypeId } from "./matters.ts";
import { hasPermission } from "./rbac.ts";
import type { ProposalRevision, SessionUser, VoteTally } from "./types.ts";

export interface AuthorizedMatterBriefing {
  matterId: string;
  matterType: MatterTypeId;
  slug: string;
  title: string;
  stage: string;
  publicationScope: string;
  boundRevision: {
    revisionId: string;
    contentHash?: string;
    title: string;
    summary: string;
    outcomes: string[];
    details: string;
  } | null;
  ballots: Array<{
    ballotId: string;
    purpose: string;
    status: string;
    revisionId: string;
    closesAt: Date | null;
    electorate: BallotRecord["electorate"];
  }>;
  aggregateVotes: VoteTally;
  formalDecision: {
    decisionEventId: string;
    result: string;
    revisionId: string;
    recordedAt: Date;
  } | null;
  confidentiality: {
    identifiableBallotsIncluded: false;
    viewerHasIdentifiableAccess: boolean;
  };
}

/**
 * Permission-aware, confidentiality-safe read model for reporting, PDF export,
 * and future AI briefings. Never exposes identifiable voter records or
 * unauthorised private branch matters.
 */
export async function buildAuthorizedMatterBriefing(
  db: Db,
  matterIdOrSlug: string,
  viewer: SessionUser | null,
): Promise<AuthorizedMatterBriefing | null> {
  const detail = await getProposalDetail(db, matterIdOrSlug, viewer);
  if (!detail) return null;
  const { proposal } = detail;
  const votes = proposal.votes;

  if (!canViewProposal(proposal, viewer)) {
    return null;
  }

  const matterType = normalizeMatterType(proposal.kind, proposal.proposalId);
  const [ballots, boundRevisionDoc, decisionDoc] = await Promise.all([
    listMatterBallots(db, proposal.proposalId),
    proposal.ballotRevisionId
      ? db.collection<ProposalRevision>("proposal_revisions").findOne({
          proposalId: proposal.proposalId,
          revisionId: proposal.ballotRevisionId,
        })
      : Promise.resolve(null),
    db
      .collection("ballot_results")
      .findOne({ proposalId: proposal.proposalId }),
  ]);

  const branchScope =
    proposal.governanceAuthorityBranchId ?? proposal.originatingBranchId;
  const viewerHasIdentifiableAccess = hasPermission(
    viewer,
    "ballots.view_identifiable",
    branchScope,
  );

  return {
    matterId: proposal.proposalId,
    matterType,
    slug: proposal.slug,
    title: proposal.title,
    stage: proposal.stage,
    publicationScope: proposal.publicationScope ?? "national",
    boundRevision: boundRevisionDoc
      ? {
          revisionId: boundRevisionDoc.revisionId,
          contentHash: boundRevisionDoc.contentHash,
          title: boundRevisionDoc.snapshot.title,
          summary: boundRevisionDoc.snapshot.summary,
          outcomes: boundRevisionDoc.snapshot.outcomes,
          details: boundRevisionDoc.snapshot.details,
        }
      : null,
    ballots: ballots.map((b) => ({
      ballotId: b.ballotId,
      purpose: b.purpose,
      status: b.status,
      revisionId: b.revisionId,
      closesAt: b.closesAt ?? null,
      electorate: b.electorate,
    })),
    aggregateVotes: votes,
    formalDecision: decisionDoc
      ? {
          decisionEventId: String(decisionDoc.decisionEventId),
          result: String(decisionDoc.result),
          revisionId: String(decisionDoc.revisionId),
          recordedAt: new Date(decisionDoc.recordedAt),
        }
      : null,
    confidentiality: {
      identifiableBallotsIncluded: false,
      viewerHasIdentifiableAccess,
    },
  };
}
