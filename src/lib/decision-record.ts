import type { Db } from "mongodb";
import {
  listMatterBallots,
  proposalBallotResultFilter,
  resolveBallotClosure,
  type BallotRecord,
} from "./ballots.ts";
import { normalizeMatterType, type MatterTypeId } from "./matters.ts";
import {
  canReviewArchivedProposal,
  canViewProposal,
  normalizeProposalDoc,
} from "./proposal-helpers.ts";
import type { SessionUser, VoteTally } from "./types.ts";

/**
 * Member-facing decision record for one matter.
 *
 * This is a read-only composition of immutable revisions, amendment outcomes,
 * the ballot result and the publication record. It deliberately contains no
 * individual vote, voter identifier, author identifier or actor identifier:
 * aggregate tallies come from the certified result, and every person reference
 * is dropped at this boundary. See decision register D20, D26 and D27.
 */

export interface DecisionRecordRevision {
  revisionId: string;
  contentHash: string;
  createdAt: Date;
  ordinal: number;
  title: string;
  summary: string;
  outcomes: string[];
  details: string;
  isBallotWording: boolean;
}

export interface DecisionRecordAmendment {
  amendmentId: string;
  ordinal: number;
  title: string;
  status: string;
  /** Endorsement result recorded by the amendment ballot, when one ran. */
  endorsementResult: string | null;
  /** Proposal revision produced by applying the amendment, when recorded. */
  appliedRevisionId: string | null;
  /** Amendment wording revision that was endorsed/approved. */
  approvedAmendmentRevisionId: string | null;
  reviewReason: string | null;
  /** True only when the amendment was applied and produced a proposal revision. */
  successfullyApplied: boolean;
  /** Approved but not yet applied: adoption cannot be derived while this is true. */
  approvedNotApplied: boolean;
}

export interface DecisionRecordBallot {
  ballotId: string;
  purpose: string;
  status: string;
  revisionId: string | null;
  boundToVotedWording: boolean;
  closesAt: Date | null;
  electorateScope: BallotRecord["electorate"]["scope"];
}

export interface DecisionRecordResult {
  result: string;
  /** Wording revision the result certifies. */
  revisionId: string | null;
  computedResult: string | null;
  ruleBasis: string | null;
  tally: VoteTally | null;
  recordedAt: Date | null;
  overrideReason: string | null;
  /** Recorded before tallies and computed outcomes were stored. */
  recordedBeforeComputation: boolean;
}

export type AdoptedWordingReviewReason =
  | "multiple-applied-amendments"
  | "approved-amendment-not-applied"
  | "applied-revision-missing"
  | "applied-revision-not-ballot-wording"
  | "result-names-other-revision"
  | "successful-result-without-bound-revision";

export type AdoptedWording =
  | {
      state: "derived";
      rule: "D15" | "D16";
      revision: DecisionRecordRevision;
      viaAmendmentId?: string;
      viaAmendmentRevisionId?: string;
    }
  | {
      state: "review-required";
      reason: AdoptedWordingReviewReason;
      amendmentIds: string[];
    }
  | { state: "not-adopted"; result: string }
  | { state: "pending"; reason: "no-result" | "no-voted-wording" };

export interface DecisionRecordPublicationEvent {
  transition: string;
  at: Date | null;
  reason: string | null;
}

export interface DecisionRecordPublication {
  state: "not-applicable" | "not-published" | "recorded";
  policyTitle: string | null;
  publicationStatus: string | null;
  ratifiedAt: Date | null;
  ratifiedRevisionId: string | null;
  ratifiedRevisionHash: string | null;
  publishedAt: Date | null;
  events: DecisionRecordPublicationEvent[];
}

export interface DecisionRecord {
  matter: {
    matterId: string;
    slug: string;
    title: string;
    stage: string;
    matterType: MatterTypeId;
  };
  votedWording: DecisionRecordRevision | null;
  revisionHistory: DecisionRecordRevision[];
  amendments: DecisionRecordAmendment[];
  adoptedWording: AdoptedWording;
  ballot: DecisionRecordBallot | null;
  result: DecisionRecordResult | null;
  publication: DecisionRecordPublication;
}

function asDate(value: unknown): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : null;
}

function revisionRecord(
  doc: Record<string, any>,
  ordinal: number,
  ballotRevisionId: string | undefined,
): DecisionRecordRevision {
  const snapshot = doc.snapshot ?? {};
  const revisionId = String(doc.revisionId ?? "");
  return {
    revisionId,
    contentHash: String(doc.contentHash ?? ""),
    createdAt: asDate(doc.createdAt) ?? new Date(0),
    ordinal,
    title: String(snapshot.title ?? ""),
    summary: String(snapshot.summary ?? ""),
    outcomes: Array.isArray(snapshot.outcomes)
      ? snapshot.outcomes.map(String)
      : [],
    details: String(snapshot.details ?? ""),
    isBallotWording: Boolean(ballotRevisionId && revisionId === ballotRevisionId),
  };
}

function asTally(value: unknown): VoteTally | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const approve = Number(source.approve);
  const abstain = Number(source.abstain);
  const reject = Number(source.reject);
  const total = Number(source.total);
  if (![approve, abstain, reject, total].every(Number.isFinite)) return null;
  return { approve, abstain, reject, total };
}

function amendmentRecord(
  doc: Record<string, any>,
  ordinal: number,
): DecisionRecordAmendment {
  const appliedRevisionId = doc.appliedRevisionId
    ? String(doc.appliedRevisionId)
    : null;
  const status = String(doc.status ?? "proposed");
  const approvedAmendmentRevisionId =
    doc.formalApproval?.amendmentRevisionId ?? doc.ballotAmendmentRevisionId;
  return {
    amendmentId: String(doc.amendmentId ?? ""),
    ordinal,
    title: String(
      doc.changes?.title ?? doc.title ?? "Proposed wording revision",
    ),
    status,
    endorsementResult: doc.ballotDecision?.result
      ? String(doc.ballotDecision.result)
      : null,
    appliedRevisionId,
    approvedAmendmentRevisionId: approvedAmendmentRevisionId
      ? String(approvedAmendmentRevisionId)
      : null,
    reviewReason: doc.resolution?.reason
      ? String(doc.resolution.reason)
      : null,
    successfullyApplied: status === "applied" && Boolean(appliedRevisionId),
    approvedNotApplied: status === "accepted" || status === "endorsed",
  };
}

/**
 * Derive the adopted wording from immutable evidence only.
 *
 * - D15: with zero successfully applied amendments, the bound (voted) revision
 *   is the adopted wording. An amendment that was rejected, not endorsed or
 *   withdrawn does not change that.
 * - D16: with exactly one successfully applied amendment, the revision that
 *   application produced is the adopted wording, provided it is the revision
 *   the ballot actually approved.
 * - D17–D18: two or more applied amendments require an authorised collision
 *   review. Nothing is derived.
 * - D19–D20: an approved-but-unapplied amendment, a missing applied revision,
 *   or a result naming different wording leaves the derivation to review rather
 *   than guessing.
 */
export function deriveAdoptedWording(input: {
  votedWording: DecisionRecordRevision | null;
  revisions: DecisionRecordRevision[];
  amendments: DecisionRecordAmendment[];
  result: DecisionRecordResult | null;
}): AdoptedWording {
  const { votedWording, revisions, amendments, result } = input;
  if (!result) return { state: "pending", reason: "no-result" };
  if (result.result !== "successful") {
    return { state: "not-adopted", result: result.result };
  }
  if (!votedWording) {
    return {
      state: "review-required",
      reason: "successful-result-without-bound-revision",
      amendmentIds: [],
    };
  }
  if (result.revisionId && result.revisionId !== votedWording.revisionId) {
    return {
      state: "review-required",
      reason: "result-names-other-revision",
      amendmentIds: [],
    };
  }

  const applied = amendments.filter((amendment) => amendment.successfullyApplied);
  const approvedNotApplied = amendments.filter(
    (amendment) => amendment.approvedNotApplied,
  );
  const missingAppliedRevision = amendments.filter(
    (amendment) => amendment.status === "applied" && !amendment.appliedRevisionId,
  );

  if (applied.length + missingAppliedRevision.length >= 2) {
    return {
      state: "review-required",
      reason: "multiple-applied-amendments",
      amendmentIds: [
        ...applied.map((amendment) => amendment.amendmentId),
        ...missingAppliedRevision.map((amendment) => amendment.amendmentId),
      ],
    };
  }
  if (missingAppliedRevision.length === 1) {
    return {
      state: "review-required",
      reason: "applied-revision-missing",
      amendmentIds: [missingAppliedRevision[0]!.amendmentId],
    };
  }
  if (approvedNotApplied.length > 0) {
    return {
      state: "review-required",
      reason: "approved-amendment-not-applied",
      amendmentIds: approvedNotApplied.map((amendment) => amendment.amendmentId),
    };
  }

  const appliedRevisionDoc =
    applied.length === 1
      ? revisions.find(
          (revision) =>
            revision.revisionId === applied[0]!.appliedRevisionId,
        )
      : undefined;
  if (applied.length === 1 && !appliedRevisionDoc) {
    return {
      state: "review-required",
      reason: "applied-revision-missing",
      amendmentIds: [applied[0]!.amendmentId],
    };
  }
  if (
    appliedRevisionDoc &&
    appliedRevisionDoc.revisionId !== votedWording.revisionId
  ) {
    return {
      state: "review-required",
      reason: "applied-revision-not-ballot-wording",
      amendmentIds: [applied[0]!.amendmentId],
    };
  }

  if (appliedRevisionDoc) {
    return {
      state: "derived",
      rule: "D16",
      revision: appliedRevisionDoc,
      ...(applied[0]!.amendmentId
        ? { viaAmendmentId: applied[0]!.amendmentId }
        : {}),
      ...(applied[0]!.approvedAmendmentRevisionId
        ? {
            viaAmendmentRevisionId:
              applied[0]!.approvedAmendmentRevisionId,
          }
        : {}),
    };
  }
  return { state: "derived", rule: "D15", revision: votedWording };
}

function publicationRecord(
  policy: Record<string, any> | null,
  events: Record<string, any>[],
  ratifiedRevisionHash: string | null,
): DecisionRecordPublication {
  if (!policy) {
    return {
      state: "not-published",
      policyTitle: null,
      publicationStatus: null,
      ratifiedAt: null,
      ratifiedRevisionId: null,
      ratifiedRevisionHash: null,
      publishedAt: null,
      events: [],
    };
  }
  return {
    state: "recorded",
    policyTitle: policy.title ? String(policy.title) : null,
    publicationStatus: policy.publicationStatus
      ? String(policy.publicationStatus)
      : null,
    ratifiedAt: asDate(policy.ratification?.ratifiedAt),
    ratifiedRevisionId: policy.ratification?.ratifiedRevisionId
      ? String(policy.ratification.ratifiedRevisionId)
      : null,
    ratifiedRevisionHash,
    publishedAt: asDate(policy.publishedAt),
    events: events
      .map((event) => ({
        transition: String(event.transition ?? event.status ?? "published"),
        at: asDate(
          event.publishedAt ?? event.createdAt ?? event.completedAt,
        ),
        reason: event.reason ? String(event.reason) : null,
      }))
      .sort(
        (left, right) =>
          (left.at?.getTime() ?? 0) - (right.at?.getTime() ?? 0),
      ),
  };
}

/**
 * Build the decision record for one matter.
 *
 * Returns null when the matter does not exist or the viewer may not see it,
 * including an archived matter the viewer cannot review. A null response must
 * be rendered as a plain 404 so a private draft is never disclosed.
 */
export async function buildDecisionRecord(
  db: Db,
  idOrSlug: string,
  viewer: SessionUser | null,
): Promise<DecisionRecord | null> {
  const key = idOrSlug.trim();
  if (!key) return null;

  const collection = db.collection("proposals");
  const [bySlug, byId, byPolicyId] = await Promise.all([
    collection.findOne({ slug: key }),
    collection.findOne({ proposalId: key }),
    collection.findOne({ policyId: key } as any),
  ]);
  const rawProposal = bySlug ?? byId ?? byPolicyId;
  if (!rawProposal) return null;

  const proposal = normalizeProposalDoc(rawProposal);
  if (!canViewProposal(proposal, viewer)) return null;
  if (
    proposal.stage === "archived" &&
    !canReviewArchivedProposal(proposal, viewer)
  ) {
    return null;
  }

  const matterId = proposal.proposalId;
  const matterType = normalizeMatterType(proposal.kind, matterId);

  const [revisionDocs, amendmentDocs, ballots, rawResult, policy] =
    await Promise.all([
      db
        .collection("proposal_revisions")
        .find({ proposalId: matterId })
        .sort({ createdAt: 1, _id: 1 })
        .project({
          revisionId: 1,
          proposalId: 1,
          parentRevisionId: 1,
          createdAt: 1,
          snapshot: 1,
          contentHash: 1,
        })
        .toArray(),
      db
        .collection("amendments")
        .find({ proposalId: matterId })
        .sort({ createdAt: 1, _id: 1 })
        .project({
          amendmentId: 1,
          status: 1,
          changes: 1,
          title: 1,
          appliedRevisionId: 1,
          appliedAt: 1,
          ballotAmendmentRevisionId: 1,
          ballotDecision: 1,
          formalApproval: 1,
          resolution: 1,
          createdAt: 1,
        })
        .toArray(),
      listMatterBallots(db, matterId),
      db
        .collection("ballot_results")
        .findOne(proposalBallotResultFilter(matterId)),
      matterType === "resolution"
        ? Promise.resolve(null)
        : db.collection("policy_registry").findOne({
            $or: [{ proposalId: matterId }, { policyId: matterId }],
          }),
    ]);

  const revisionHistory = revisionDocs.map((doc, index) =>
    revisionRecord(doc, index + 1, proposal.ballotRevisionId),
  );
  const votedWording =
    revisionHistory.find((revision) => revision.isBallotWording) ?? null;

  const amendments = amendmentDocs.map((doc, index) =>
    amendmentRecord(doc, index + 1),
  );

  const result: DecisionRecordResult | null = rawResult
    ? {
        result: String(rawResult.result ?? "inconclusive"),
        revisionId: rawResult.revisionId ? String(rawResult.revisionId) : null,
        computedResult: rawResult.computedResult
          ? String(rawResult.computedResult)
          : null,
        ruleBasis: rawResult.ruleBasis ? String(rawResult.ruleBasis) : null,
        tally: asTally(rawResult.tally),
        recordedAt: asDate(rawResult.recordedAt),
        overrideReason: rawResult.override?.reason
          ? String(rawResult.override.reason)
          : null,
        recordedBeforeComputation:
          !rawResult.tally &&
          !rawResult.computedResult &&
          !rawResult.ruleBasis,
      }
    : null;

  const adoptedWording = deriveAdoptedWording({
    votedWording,
    revisions: revisionHistory,
    amendments,
    result,
  });

  const matterBallot =
    ballots.find((ballot) => ballot.purpose === "matter_adoption") ?? null;
  const ballotClosure = matterBallot
    ? resolveBallotClosure({ ballot: matterBallot, matter: proposal })
    : null;
  const ballot: DecisionRecordBallot | null = matterBallot
    ? {
        ballotId: matterBallot.ballotId,
        purpose: matterBallot.purpose,
        status:
          matterBallot.status === "open" && ballotClosure?.closed
            ? "closed"
            : matterBallot.status,
        revisionId: matterBallot.revisionId || null,
        boundToVotedWording: Boolean(
          votedWording &&
            matterBallot.revisionId === votedWording.revisionId,
        ),
        closesAt: matterBallot.closesAt ?? null,
        electorateScope: matterBallot.electorate.scope,
      }
    : null;

  const policyId = policy?.policyId ? String(policy.policyId) : null;
  const publicationEvents =
    matterType !== "resolution" && (policyId || matterId)
      ? await db
          .collection("publication_events")
          .find({
            policyId: { $in: [...new Set([policyId, matterId].filter(Boolean))] },
          })
          .sort({ createdAt: 1, _id: 1 })
          .project({
            transition: 1,
            status: 1,
            publishedAt: 1,
            createdAt: 1,
            completedAt: 1,
            reason: 1,
          })
          .toArray()
      : [];
  const ratifiedRevisionId = policy?.ratification?.ratifiedRevisionId
    ? String(policy.ratification.ratifiedRevisionId)
    : null;
  const ratifiedRevision = ratifiedRevisionId
    ? revisionHistory.find(
        (revision) => revision.revisionId === ratifiedRevisionId,
      )
    : undefined;
  const publication =
    matterType === "resolution"
      ? {
          state: "not-applicable" as const,
          policyTitle: null,
          publicationStatus: null,
          ratifiedAt: null,
          ratifiedRevisionId: null,
          ratifiedRevisionHash: null,
          publishedAt: null,
          events: [],
        }
      : publicationRecord(
          policy,
          publicationEvents,
          ratifiedRevision?.contentHash ?? null,
        );

  return {
    matter: {
      matterId,
      slug: proposal.slug,
      title: proposal.title,
      stage: proposal.stage,
      matterType,
    },
    votedWording,
    revisionHistory,
    amendments,
    adoptedWording,
    ballot,
    result,
    publication,
  };
}
