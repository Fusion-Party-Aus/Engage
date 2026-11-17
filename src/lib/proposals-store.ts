import { createHash, randomUUID } from "node:crypto";
import type { Collection, Db } from "mongodb";
import { loadBallotCryptoConfigForRead } from "./ballot-crypto.ts";
import { BALLOTS_COLLECTION, FORMAL_DECISIONS_COLLECTION } from "./ballots.ts";
import { runInTransaction } from "./db.ts";
import { recordGovernanceEvent } from "./governance-relationships.ts";
import { defaultBallotClosesAtFrom, deliberationEndsAtFrom } from "./lifecycle-schedule.ts";
import { isPolicyChangeType, PolicyChangeError } from "./policy-change.ts";
import {
  PENDING_VOTE_PREFERENCES,
  VALID_STANCES,
  canReviewArchivedProposal,
  canViewProposal,
  getDefaultProvenanceLabel,
  getSubstantiveChanges,
  isPolicyRegistryRecordForResolution,
  isProposalLocked,
  isValidStage,
  normalizeKind,
  normalizeProposalDoc,
  normalizeStage,
  parseOutcomes,
  slugify,
  validateStageTransition,
} from "./proposal-helpers.ts";
import { geographicScopeForBranch, parseProposalScopeInput } from "./proposal-scope.ts";
import { hasPermission } from "./rbac.ts";
import { canReviewSense } from "./sense-box.ts";

function normalisedSourceText(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * A private Sense Box priority may be used as an internal lead, but its text
 * must not be reproduced in a public proposal. This catches the obvious copy
 * paths without pretending to be a semantic plagiarism detector.
 */
function reproducesPrivateSource(
  source: Record<string, any>,
  proposal: { title: string; summary: string; details: string },
): boolean {
  const title = normalisedSourceText(source.title);
  if (proposal.title.trim().toLowerCase() === title) return true;
  const text = normalisedSourceText(`${proposal.title}\n${proposal.summary}\n${proposal.details}`);
  if (title.length >= 20 && text.includes(title)) return true;
  const detail = normalisedSourceText(source.detail);
  if (detail.length >= 60 && text.includes(detail)) return true;
  const fragments = String(source.detail ?? "")
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .map(normalisedSourceText)
    .filter((fragment) => fragment.length >= 40);
  return fragments.some((fragment) => text.includes(fragment));
}
import type {
  CommentRecord,
  PendingVotePreferenceRecord,
  PolicyChangeType,
  PolicyProvenance,
  ProposalKind,
  ProposalRecord,
  ProposalStage,
  ProposalSummaryView,
  ProvenanceLink,
  SessionUser,
  VoteChoice,
  VoteRecord,
  VoteTally,
} from "./types.ts";
import {
  PROPOSAL_VOTES,
  computeAllBlindIndexesForMember,
  decodeStoredVote,
  proposalBallotId,
} from "./vote-storage.ts";

export async function listProposals(
  db: Db,
  options: {
    includeArchived?: boolean;
    search?: string;
    space?: string;
    stage?: string;
    // Backwards compatibility filter options
    category?: string;
    status?: string;
    kind?: string;
    includeDrafts?: boolean;
    branch?: string;
    user?: SessionUser | null;
    /**
     * List pages do not render the long rationale. Set false only when the
     * caller also does not search on `details`; the summary view then omits it.
     */
    includeDetails?: boolean;
    /**
     * Render a page even when a stored vote cannot be read (for example with a
     * missing decryption key). Callers that opt in must show the unavailable
     * state; `unreadableVoteCount` is set on affected rows. Defaults to false so
     * every other read keeps failing loudly.
     */
    tolerateUnreadableVotes?: boolean;
    /**
     * Public list reads set this to false and overlay the display-only
     * `ballot_tallies` projection instead. The read then never touches
     * `proposal_votes` and never decrypts a ballot. Defaults to true so every
     * other caller keeps the authoritative live tally.
     */
    includeVoteTallies?: boolean;
  } = {},
): Promise<ProposalSummaryView[]> {
  const rawProposals = await db
    .collection<ProposalRecord>("proposals")
    .find(
      {},
      {
        // `detailHtml` is rendered only on the single-proposal view.
        projection: {
          detailHtml: 0,
          ...(options.includeDetails === false ? { details: 0 } : {}),
        },
      },
    )
    .sort({ proposalId: 1 })
    .toArray();

  const allProposals = rawProposals.map(normalizeProposalDoc);

  // Read-only path: a broken key ring must not fail a list that renders no
  // encrypted votes. Encrypted votes still fail loudly at decode time.
  const cryptoConfig = loadBallotCryptoConfigForRead(process.env);
  const includeVoteTallies = options.includeVoteTallies !== false;
  const [allComments, allVotes] = await Promise.all([
    db
      .collection<CommentRecord>("comments")
      .find({})
      .project({ proposalId: 1, policyId: 1 })
      .toArray(),
    includeVoteTallies
      ? db
          .collection<VoteRecord>(PROPOSAL_VOTES)
          .find({})
          .project({
            proposalId: 1,
            policyId: 1,
            ballotId: 1,
            revisionId: 1,
            amendmentRevisionId: 1,
            choice: 1,
            voterBlindIndex: 1,
            voteEnvelope: 1,
          })
          .toArray()
      : Promise.resolve([] as Array<Record<string, any>>),
  ]);

  const commentCounts = new Map<string, number>();
  for (const c of allComments) {
    const id = c.proposalId || (c as any).policyId;
    if (id) commentCounts.set(id, (commentCounts.get(id) ?? 0) + 1);
  }

  const voteMap = new Map<string, VoteTally>();
  const unreadableVoteCounts = new Map<string, number>();
  for (const v of allVotes) {
    const id = v.proposalId || (v as any).policyId;
    if (!id) continue;
    if (v.ballotId !== proposalBallotId(id)) continue;
    let decoded: ReturnType<typeof decodeStoredVote>;
    try {
      decoded = decodeStoredVote(v as Record<string, any>, cryptoConfig);
    } catch (error) {
      // Pages that opt in can render an explicit unavailable state. Anything
      // else keeps failing loudly so a tally is never quietly under-reported.
      if (!options.tolerateUnreadableVotes) throw error;
      unreadableVoteCounts.set(id, (unreadableVoteCounts.get(id) ?? 0) + 1);
      continue;
    }
    const current = voteMap.get(id) ?? {
      approve: 0,
      abstain: 0,
      reject: 0,
      total: 0,
    };
    if (decoded.choice === "approve") current.approve += 1;
    else if (decoded.choice === "abstain") current.abstain += 1;
    else current.reject += 1;
    current.total += 1;
    voteMap.set(id, current);
  }

  const query = (options.search ?? "").trim().toLowerCase();
  const spaceFilter = (options.space ?? options.category ?? "").trim();
  const stageFilter =
    (options.stage && options.stage !== "all") ||
    (options.status && options.status !== "all")
      ? normalizeStage(options.stage ?? options.status)
      : "";
  const allowArchived =
    options.includeArchived ?? options.includeDrafts ?? false;

  return allProposals
    .filter((p) => {
      if (!allowArchived && p.stage === "archived") {
        return false;
      }
      if (
        options.user !== undefined &&
        p.stage === "archived" &&
        !canReviewArchivedProposal(p, options.user)
      ) {
        return false;
      }
      if (options.user !== undefined && !canViewProposal(p, options.user)) {
        return false;
      }
      if (spaceFilter && spaceFilter !== "all" && p.space !== spaceFilter) {
        return false;
      }
      if (stageFilter && p.stage !== stageFilter) {
        return false;
      }
      if (
        options.branch &&
        options.branch !== "all" &&
        ![
          p.originatingBranchId,
          p.governanceAuthorityBranchId,
          p.jurisdictionBranchId,
        ].includes(options.branch)
      ) {
        return false;
      }
      if (query) {
        const haystack =
          `${p.proposalId} ${p.title} ${p.space} ${p.summary} ${p.details}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    })
    .map((p) => ({
      ...p,
      commentCount: commentCounts.get(p.proposalId) ?? 0,
      votes: voteMap.get(p.proposalId) ?? {
        approve: 0,
        abstain: 0,
        reject: 0,
        total: 0,
      },
      ...(unreadableVoteCounts.get(p.proposalId)
        ? { unreadableVoteCount: unreadableVoteCounts.get(p.proposalId) }
        : {}),
    }));
}

export async function getProposalDetail(
  db: Db,
  idOrSlug: string,
  user: SessionUser | null,
  options: { tolerateUnreadableVotes?: boolean } = {},
): Promise<{
  proposal: ProposalSummaryView;
  comments: CommentRecord[];
  votesList: VoteRecord[];
  unreadableVoteCount: number;
  myVote: VoteChoice | null;
  myReason: string;
  myPendingVote?: VoteChoice | null;
  myPendingReason?: string;
} | null> {
  const key = idOrSlug.trim();
  if (!key) return null;

  const col = db.collection<ProposalRecord>("proposals");
  const rawProposal =
    (await col.findOne({ slug: key })) ??
    (await col.findOne({ proposalId: key })) ??
    (await col.findOne({ policyId: key } as any));
  if (!rawProposal) return null;

  const proposal = normalizeProposalDoc(rawProposal);

  if (!canViewProposal(proposal, user)) return null;

  const canReviewArchived = canReviewArchivedProposal(proposal, user);
  if (proposal.stage === "archived" && !canReviewArchived) {
    return null;
  }

  const [rawComments, votes, pendingPref] = await Promise.all([
    db
      .collection<CommentRecord>("comments")
      .find({
        $or: [
          { proposalId: proposal.proposalId },
          { policyId: proposal.proposalId } as any,
        ],
      })
      .sort({ createdAt: 1 })
      .toArray(),
    db
      .collection<VoteRecord>(PROPOSAL_VOTES)
      .find({
        $or: [
          { proposalId: proposal.proposalId },
          { policyId: proposal.proposalId } as any,
        ],
      })
      .sort({ updatedAt: -1 })
      .toArray(),
    user && !user.canParticipate && user.status === "pending"
      ? db
          .collection<PendingVotePreferenceRecord>(PENDING_VOTE_PREFERENCES)
          .findOne({
            ballotId: proposalBallotId(proposal.proposalId),
            memberId: user.memberId,
          })
      : Promise.resolve(null),
  ]);

  const comments = rawComments.map((c) => ({
    ...c,
    stance: VALID_STANCES.includes(c.stance) ? c.stance : "comment",
    upvotes: Array.isArray(c.upvotes) ? c.upvotes : [],
    downvotes: Array.isArray(c.downvotes) ? c.downvotes : [],
    parentCommentId:
      typeof c.parentCommentId === "string" && c.parentCommentId
        ? c.parentCommentId
        : null,
    depth: Number.isFinite(c.depth) ? Number(c.depth) : 0,
    // Deleted contributions keep their place in the thread, never their text.
    ...(c.deletedAt ? { body: "" } : {}),
  }));
  // Read-only path: tolerate a broken key ring so the page can render an
  // operational message instead of failing before it is read.
  const cryptoConfig = loadBallotCryptoConfigForRead(process.env);
  const currentBallotId = proposalBallotId(proposal.proposalId);
  const myBlindIndexes =
    user && cryptoConfig
      ? new Set(
          computeAllBlindIndexesForMember(
            cryptoConfig,
            currentBallotId,
            user.memberId,
          ),
        )
      : null;

  const proposalVotes: ReturnType<typeof decodeStoredVote>[] = [];
  let unreadableVoteCount = 0;
  for (const vote of votes) {
    if (vote.ballotId !== currentBallotId) continue;
    try {
      proposalVotes.push(
        decodeStoredVote(vote as Record<string, any>, cryptoConfig),
      );
    } catch (error) {
      // Same contract as listProposals: opt-in pages render an unavailable
      // state, everyone else keeps failing loudly.
      if (!options.tolerateUnreadableVotes) throw error;
      unreadableVoteCount += 1;
    }
  }

  const tally: VoteTally = { approve: 0, abstain: 0, reject: 0, total: 0 };
  let myVote: VoteChoice | null = null;
  let myReason = "";

  for (const v of proposalVotes) {
    if (v.choice === "approve") tally.approve += 1;
    else if (v.choice === "abstain") tally.abstain += 1;
    else tally.reject += 1;
    tally.total += 1;
    const isMine =
      Boolean(user && v.memberId && v.memberId === user.memberId) ||
      Boolean(
        myBlindIndexes &&
          v.voterBlindIndex &&
          myBlindIndexes.has(v.voterBlindIndex),
      );
    if (isMine) {
      myVote = v.choice;
      myReason = v.reason ?? "";
    }
  }

  const myPendingVote: VoteChoice | null =
    !myVote && pendingPref?.choice ? pendingPref.choice : null;
  const myPendingReason =
    !myVote && pendingPref?.reason ? pendingPref.reason : "";

  return {
    proposal: {
      ...proposal,
      commentCount: comments.length,
      votes: tally,
      ...(unreadableVoteCount ? { unreadableVoteCount } : {}),
    },
    comments,
    votesList: proposalVotes as unknown as VoteRecord[],
    unreadableVoteCount,
    myVote,
    myReason,
    myPendingVote,
    myPendingReason,
  };
}

/**
 * Read immutable proposal revisions only when the requester may view the
 * proposal itself. Archived proposals follow the same reviewer rule as the
 * proposal detail page so revision history cannot be used to bypass it.
 */
export async function listProposalRevisions(
  db: Db,
  idOrSlug: string,
  user: SessionUser | null,
): Promise<{
  proposalId: string;
  revisions: Array<Record<string, unknown>>;
} | null> {
  const key = idOrSlug.trim();
  if (!key) return null;

  const col = db.collection<ProposalRecord>("proposals");
  const rawProposal =
    (await col.findOne({ slug: key })) ??
    (await col.findOne({ proposalId: key })) ??
    (await col.findOne({ policyId: key } as any));
  if (!rawProposal) return null;

  const proposal = normalizeProposalDoc(rawProposal);
  if (!canViewProposal(proposal, user)) return null;
  if (
    proposal.stage === "archived" &&
    !canReviewArchivedProposal(proposal, user)
  ) {
    return null;
  }

  const revisions: any[] = await db
    .collection("proposal_revisions")
    .find({ proposalId: proposal.proposalId })
    .sort({ createdAt: 1 })
    .toArray();
  const data = revisions.map((revision, index) => {
    const previous = revisions[index - 1];
    const changes = previous
      ? Object.keys(revision.snapshot).flatMap((field) => {
          const before = previous.snapshot[field];
          const after = revision.snapshot[field];
          return JSON.stringify(before) === JSON.stringify(after)
            ? []
            : [{ field, before, after }];
        })
      : [{ field: "initial", before: null, after: revision.snapshot }];
    return {
      revisionId: String(revision.revisionId ?? ""),
      proposalId: String(revision.proposalId ?? ""),
      parentRevisionId: revision.parentRevisionId ?? null,
      createdAt: revision.createdAt,
      snapshot: revision.snapshot,
      contentHash: String(revision.contentHash ?? ""),
      ...(revision.provenance ? { provenance: revision.provenance } : {}),
      changes,
    };
  });
  return { proposalId: proposal.proposalId, revisions: data };
}

export interface ResolvedPolicyChangeTarget {
  targetPolicyId: string;
  targetPolicyRevisionId: string;
  changeType: PolicyChangeType;
  target: Record<string, any>;
}

/**
 * Resolve a declared amend/replace/repeal against a published policy.
 *
 * A proposal may only change a policy that is published *now*, against the
 * exact revision it declares. If the policy is superseded or repealed later,
 * the change proposal fails rather than silently retargeting current wording.
 */
export async function resolvePolicyChangeTarget(
  db: Db,
  input: { targetPolicyId?: unknown; changeType?: unknown },
): Promise<ResolvedPolicyChangeTarget> {
  const targetPolicyId = String(input.targetPolicyId ?? "").trim();
  if (!targetPolicyId) {
    throw new PolicyChangeError(
      "Choose the policy this proposal would change.",
      400,
    );
  }
  if (!isPolicyChangeType(input.changeType)) {
    throw new PolicyChangeError(
      "Choose whether the proposal amends, replaces or repeals the policy.",
      400,
    );
  }
  const target = await db.collection("policy_registry").findOne({
    policyId: targetPolicyId,
    publicationStatus: "published",
  });
  if (!target) {
    throw new PolicyChangeError(
      "Only a currently published policy can be changed.",
      404,
    );
  }
  const linkedProposal = target.proposalId
    ? await db
        .collection("proposals")
        .findOne({ proposalId: String(target.proposalId) })
    : null;
  if (
    isPolicyRegistryRecordForResolution(
      target as { policyId?: string; proposalId?: string; kind?: string },
      linkedProposal as { kind?: string; proposalId?: string } | null,
    )
  ) {
    throw new PolicyChangeError(
      "Governance resolutions are not changed through the policy registry.",
      409,
    );
  }
  if (!target.revisionId) {
    throw new PolicyChangeError(
      "The policy has no authoritative revision to change.",
      409,
    );
  }
  return {
    targetPolicyId,
    targetPolicyRevisionId: String(target.revisionId),
    changeType: input.changeType,
    target,
  };
}

function parseBallotCloseDate(
  raw: unknown,
  existingClose?: Date,
  now = new Date(),
): Date {
  if (raw !== undefined) {
    if (raw === null || raw === "") {
      throw new Error(
        "A future ballot closing date is required when opening a ballot.",
      );
    }
    const parsed = new Date(String(raw));
    if (!Number.isFinite(parsed.getTime())) {
      throw new Error("Ballot closing date is invalid.");
    }
    if (parsed.getTime() <= now.getTime()) {
      throw new Error("Ballot closing date must be in the future.");
    }
    return parsed;
  }
  if (existingClose) {
    const parsed = new Date(existingClose);
    if (Number.isFinite(parsed.getTime()) && parsed.getTime() > now.getTime()) {
      return parsed;
    }
  }
  // D6: an officer who opens a ballot without a date receives the approved
  // 30-day ordinary ballot period. An explicit date always wins over this
  // default, so authorised overrides keep working unchanged.
  return defaultBallotClosesAtFrom(now);
}

function computeSnapshotHash(snapshot: {
  title: string;
  summary: string;
  outcomes: string[];
  details: string;
}): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

async function assertStageTransitionAllowed(
  db: Db,
  user: SessionUser,
  existing: ProposalRecord,
  body: Record<string, unknown>,
): Promise<void> {
  if (body.stage === undefined && body.status === undefined) return;
  const rawStageInput = body.stage !== undefined ? body.stage : body.status;
  if (!isValidStage(rawStageInput)) {
    throw new Error(
      `Invalid lifecycle stage: '${String(rawStageInput)}'. Must be propose, deliberate, decide, implement, or archived.`,
    );
  }
  const targetStage = normalizeStage(rawStageInput, existing.stage);
  validateStageTransition(existing.stage, targetStage, existing.kind);
  // D3: a proposal requires a seconder before it enters Deliberate. The
  // member-driven seconding act performs this transition itself; this gate
  // covers officer and API paths so no route can skip it.
  if (
    targetStage === "deliberate" &&
    existing.stage === "propose" &&
    !existing.secondedAt
  ) {
    throw new Error(
      "A proposal needs a seconder before it can enter Deliberate.",
    );
  }
  const branchAdminIds = user.branchAdminIds ?? [];
  if (targetStage === "decide" && existing.stage !== "decide") {
    if (
      !hasPermission(
        user,
        "ballots.bind",
        existing.governanceAuthorityBranchId,
      )
    ) {
      throw new Error(
        "You are not authorised to open a ballot for this proposal.",
      );
    }
    if (!user.isAdmin && !hasPermission(user, "ballots.bind")) {
      const branchId = existing.governanceAuthorityBranchId;
      if (
        !branchId ||
        (!branchAdminIds.includes(branchId) &&
          !hasPermission(user, "ballots.bind", branchId)) ||
        existing.jurisdictionBranchId !== branchId
      ) {
        throw new Error(
          "A national administrator must explicitly assign this proposal's branch authority and jurisdiction before its local ballot can open.",
        );
      }
    }
  }
  if (existing.stage === "decide" && targetStage === "implement") {
    if (
      !existing.ballotRevisionId ||
      !(await db.collection("ballot_results").findOne({
        proposalId: existing.proposalId,
        revisionId: existing.ballotRevisionId,
        result: "successful",
      }))
    ) {
      throw new Error(
        "Record a successful ballot result for the exact frozen revision before moving this proposal to Implement.",
      );
    }
  }
}

async function assertProposalUnlocked(
  db: Db,
  existing: ProposalRecord,
  body: Record<string, unknown>,
  submittedScope: Awaited<ReturnType<typeof parseProposalScopeInput>>,
): Promise<void> {
  const voteCount = await db
    .collection<VoteRecord>(PROPOSAL_VOTES)
    .countDocuments({
      $or: [
        { proposalId: existing.proposalId },
        { policyId: existing.proposalId } as any,
      ],
    });
  if (!isProposalLocked(existing.stage, voteCount)) return;

  const branchFields = [
    "originatingBranchId",
    "governanceAuthorityBranchId",
    "jurisdictionBranchId",
    "publicationScope",
  ] as const;
  if (
    branchFields.some(
      (field) =>
        body[field] !== undefined && body[field] !== (existing[field] ?? ""),
    ) ||
    (submittedScope?.branchId &&
      submittedScope.branchId !== (existing.originatingBranchId ?? ""))
  ) {
    throw new Error(
      "Governance authority, jurisdiction and publication scope are locked once a ballot begins.",
    );
  }
  const candidateOutcomes =
    body.outcomes !== undefined ? parseOutcomes(body.outcomes) : undefined;
  const substantiveChanges = getSubstantiveChanges(existing, {
    title: typeof body.title === "string" ? body.title : undefined,
    summary:
      typeof body.summary === "string"
        ? body.summary
        : typeof body.statement === "string"
          ? body.statement
          : undefined,
    outcomes: candidateOutcomes,
    details: typeof body.details === "string" ? body.details : undefined,
    attachmentUrl:
      typeof body.attachmentUrl === "string" ? body.attachmentUrl : undefined,
    attachmentDescription:
      typeof body.attachmentDescription === "string"
        ? body.attachmentDescription
        : undefined,
    kind: typeof body.kind === "string" ? body.kind : undefined,
    targetSection:
      typeof body.targetSection === "string" ? body.targetSection : undefined,
    proposedWording:
      typeof body.proposedWording === "string"
        ? body.proposedWording
        : undefined,
  });

  if (substantiveChanges.length > 0) {
    const reason =
      voteCount > 0
        ? `voting has already begun and ${voteCount} member vote(s) have been cast`
        : `the proposal is active in the Decide stage`;
    throw new Error(
      `Cannot modify substantive proposal content (${substantiveChanges.join(", ")}) because ${reason}. Substantive text is locked to protect ballot integrity. Create a revised proposal to submit modified motion text.`,
    );
  }
}

const QUICK_UPDATE_KEYS = new Set([
  "proposalId",
  "policyId",
  "stage",
  "status",
  "implementationNote",
  "supersededByProposalId",
  "supersededByNote",
  "ballotClosesAt",
]);

function isQuickGovernanceUpdate(body: Record<string, unknown>): boolean {
  return (
    Object.keys(body).every((k) => QUICK_UPDATE_KEYS.has(k)) &&
    (body.stage !== undefined ||
      body.status !== undefined ||
      body.implementationNote !== undefined ||
      body.supersededByProposalId !== undefined ||
      body.supersededByNote !== undefined ||
      body.ballotClosesAt !== undefined)
  );
}

async function resolveSupersessionTarget(
  col: Collection<ProposalRecord>,
  existing: ProposalRecord,
  rawCandidate: unknown,
): Promise<string | undefined> {
  const candidate =
    typeof rawCandidate === "string" ? rawCandidate.trim() : "";
  if (!candidate) return undefined;
  if (candidate === existing.proposalId) {
    throw new Error("A proposal cannot supersede itself.");
  }
  const target = await col.findOne({ proposalId: candidate });
  if (!target) {
    throw new Error(`Successor proposal '${candidate}' was not found.`);
  }
  const visited = new Set<string>([existing.proposalId]);
  let cursor: ProposalRecord | null = target;
  let hops = 0;
  while (cursor && hops < 50) {
    if (visited.has(cursor.proposalId)) {
      throw new Error("Supersession chain cannot contain a cycle.");
    }
    visited.add(cursor.proposalId);
    const nextId: string | undefined = cursor.supersededByProposalId?.trim();
    if (!nextId) break;
    if (visited.has(nextId)) {
      throw new Error("Supersession chain cannot contain a cycle.");
    }
    cursor = await col.findOne({ proposalId: nextId });
    hops += 1;
  }
  return target.proposalId;
}

async function applyQuickGovernanceUpdate(
  db: Db,
  col: Collection<ProposalRecord>,
  user: SessionUser,
  existing: ProposalRecord,
  body: Record<string, unknown>,
): Promise<ProposalRecord> {
  const stage =
    body.stage !== undefined || body.status !== undefined
      ? normalizeStage(body.stage ?? body.status, existing.stage)
      : existing.stage;
  const updatedAt = new Date();
  const openingBallot = stage === "decide" && existing.stage !== "decide";
  const closingBallot = existing.stage === "decide" && stage !== "decide";
  let ballotClosesAt = existing.ballotClosesAt;
  if (openingBallot || (stage === "decide" && body.ballotClosesAt !== undefined)) {
    ballotClosesAt = parseBallotCloseDate(
      body.ballotClosesAt,
      existing.ballotClosesAt,
      updatedAt,
    );
  }
  const implementationNote =
    typeof body.implementationNote === "string"
      ? body.implementationNote.trim().slice(0, 1000)
      : existing.implementationNote;
  if (
    body.supersededByProposalId !== undefined ||
    body.supersededByNote !== undefined
  ) {
    if (
      !hasPermission(
        user,
        "proposals.manage_supersession",
        existing.originatingBranchId,
      )
    ) {
      throw new Error(
        "You do not have permission to manage proposal supersession.",
      );
    }
  }
  const supersededByProposalId =
    body.supersededByProposalId !== undefined
      ? await resolveSupersessionTarget(col, existing, body.supersededByProposalId)
      : existing.supersededByProposalId;
  const supersededByNote =
    body.supersededByNote !== undefined
      ? typeof body.supersededByNote === "string" && body.supersededByNote.trim()
        ? body.supersededByNote.trim().slice(0, 500)
        : undefined
      : existing.supersededByNote;

  const currentBallotId = proposalBallotId(existing.proposalId);
  const ballotVoteCount = await db
    .collection<VoteRecord>(PROPOSAL_VOTES)
    .countDocuments({
      $or: [
        { proposalId: existing.proposalId },
        { ballotId: currentBallotId },
      ],
    });

  let ballotRevisionId = existing.ballotRevisionId;
  let ballotUnbound = false;
  let ballotReboundFrom: string | undefined;

  if (closingBallot && ballotVoteCount === 0 && ballotRevisionId) {
    // Returning a zero-vote ballot to deliberation/propose clears its binding so
    // any subsequent wording edits do not leave a stale revision attached.
    ballotRevisionId = undefined;
    ballotUnbound = true;
  } else if (stage === "decide") {
    const latest = await db
      .collection("proposal_revisions")
      .find({ proposalId: existing.proposalId })
      .sort({ createdAt: -1, _id: -1 })
      .limit(1)
      .toArray();
    const latestRevisionId = latest[0]?.revisionId;
    if (!latestRevisionId) {
      throw new Error(
        "A proposal revision is required before opening a ballot.",
      );
    }
    if (ballotRevisionId && ballotRevisionId !== latestRevisionId) {
      if (ballotVoteCount > 0) {
        throw new Error(
          "Cannot reopen a voted ballot when a newer wording revision exists.",
        );
      }
      ballotReboundFrom = ballotRevisionId;
      ballotRevisionId = latestRevisionId;
    } else if (!ballotRevisionId) {
      ballotRevisionId = latestRevisionId;
    }
  }

  const set: Record<string, unknown> = {
    stage,
    implementationNote,
    updatedAt,
  };
  const unset: Record<string, "" | 1> = {};
  if (supersededByProposalId) {
    set.supersededByProposalId = supersededByProposalId;
    if (supersededByNote) {
      set.supersededByNote = supersededByNote;
    } else if (body.supersededByNote !== undefined) {
      unset.supersededByNote = "";
    }
  } else {
    if (body.supersededByProposalId !== undefined) {
      unset.supersededByProposalId = "";
      unset.supersededByNote = "";
    } else if (body.supersededByNote !== undefined) {
      unset.supersededByNote = "";
    }
  }
  if (ballotRevisionId) {
    set.ballotRevisionId = ballotRevisionId;
    if (openingBallot || ballotReboundFrom || !existing.ballotRevisionId) {
      set.ballotRevisionBoundAt = updatedAt;
      set.ballotRevisionBoundBy = user.memberId;
    }
  } else if (ballotUnbound) {
    unset.ballotRevisionId = "";
    unset.ballotRevisionBoundAt = "";
    unset.ballotRevisionBoundBy = "";
  }
  if (ballotClosesAt) {
    set.ballotClosesAt = ballotClosesAt;
  }
  if (
    closingBallot ||
    (stage === "decide" && body.ballotClosesAt !== undefined)
  ) {
    // The closure marker belongs to one ballot deadline. Leaving Decide or
    // configuring a new deadline starts a new ballot instance, so the marker
    // must clear or the scheduler would never close the new ballot. The
    // historical `ballot.closed` event remains.
    unset.ballotClosedAt = "";
  }
  const updateDoc: Record<string, unknown> = { $set: set };
  if (Object.keys(unset).length) updateDoc.$unset = unset;

  await runInTransaction(db, async (session) => {
    const sessionOpts = session ? { session } : undefined;
    const write = await col.updateOne(
      { proposalId: existing.proposalId, updatedAt: existing.updatedAt },
      updateDoc,
      sessionOpts,
    );
    if (write.matchedCount !== 1) {
      throw new Error(
        "Proposal changed while you were editing it. Reload the latest state and try again.",
      );
    }
    if (existing.stage !== stage) {
      await recordGovernanceEvent(
        db,
        {
          eventType: "proposal.stage_transition",
          matterId: existing.proposalId,
          revisionId: ballotRevisionId,
          actorId: user.memberId,
          authorityBranchId: existing.governanceAuthorityBranchId,
          metadata: {
            fromStage: existing.stage,
            toStage: stage,
            ...(ballotClosesAt
              ? { ballotClosesAt: ballotClosesAt.toISOString() }
              : {}),
          },
          createdAt: updatedAt,
        },
        session,
      );
    }
    if (ballotUnbound) {
      await recordGovernanceEvent(
        db,
        {
          eventType: "ballot.unbound",
          matterId: existing.proposalId,
          ballotId: currentBallotId,
          revisionId: existing.ballotRevisionId,
          actorId: user.memberId,
          authorityBranchId: existing.governanceAuthorityBranchId,
          reason: "Returned from Decide with zero votes.",
          createdAt: updatedAt,
        },
        session,
      );
    } else if (ballotReboundFrom && ballotRevisionId) {
      await recordGovernanceEvent(
        db,
        {
          eventType: "ballot.rebound",
          matterId: existing.proposalId,
          ballotId: currentBallotId,
          revisionId: ballotRevisionId,
          actorId: user.memberId,
          authorityBranchId: existing.governanceAuthorityBranchId,
          metadata: { previousRevisionId: ballotReboundFrom },
          createdAt: updatedAt,
        },
        session,
      );
    }
  });

  return {
    ...existing,
    stage,
    implementationNote,
    supersededByProposalId,
    supersededByNote: supersededByProposalId ? supersededByNote : undefined,
    ballotRevisionId,
    ...(ballotClosesAt ? { ballotClosesAt } : {}),
    updatedAt,
  };
}

function parseProvenanceInput(
  rawInput: unknown,
  kind: ProposalKind,
): PolicyProvenance | undefined {
  if (!rawInput || (typeof rawInput === "object" && !(rawInput as any).category)) {
    return undefined;
  }
  if (typeof rawInput !== "object") return undefined;

  const rawProv = rawInput as Record<string, any>;
  const category = String(rawProv.category || "unverified").trim();
  const label =
    String(rawProv.label || "").trim() ||
    getDefaultProvenanceLabel(category, kind);
  const summary = String(rawProv.summary || "").trim();
  const uncertaintyNote = rawProv.uncertaintyNote
    ? String(rawProv.uncertaintyNote).trim()
    : undefined;

  let lineage: ProvenanceLink[] = [];
  if (Array.isArray(rawProv.lineage)) {
    lineage = rawProv.lineage
      .map((l: any) => ({
        label: String(l.label || "").trim(),
        url: l.url ? String(l.url).trim() : null,
        description: String(l.description || "").trim(),
      }))
      .filter((l: ProvenanceLink) => l.label);
  }

  let valuesAlignment: string[] = [];
  if (Array.isArray(rawProv.valuesAlignment)) {
    valuesAlignment = rawProv.valuesAlignment
      .map((v: any) => String(v).trim())
      .filter(Boolean);
  }

  return {
    category,
    classification: category,
    label,
    summary,
    uncertaintyNote,
    lineage,
    valuesAlignment,
    flaggedNewInStaticExport: category === "new-proposal",
    lineageVerified: category !== "unverified",
  };
}

async function resolveBranchGovernanceContext(
  db: Db,
  user: SessionUser,
  existing: ProposalRecord | null,
  body: Record<string, unknown>,
  submittedScope: Awaited<ReturnType<typeof parseProposalScopeInput>>,
  policyChange: ResolvedPolicyChangeTarget | null,
): Promise<{
  originatingBranchId: string | undefined;
  governanceAuthorityBranchId: string | undefined;
  jurisdictionBranchId: string | undefined;
  publicationScope: ProposalRecord["publicationScope"];
  geographicScope: string | undefined;
  scopeWasSubmitted: boolean;
}> {
  const branchAdminIds = user.branchAdminIds ?? [];
  let originatingBranchId =
    submittedScope?.branchId ??
    (typeof body.originatingBranchId === "string"
      ? body.originatingBranchId.trim()
      : existing?.originatingBranchId);
  const scopeWasSubmitted =
    typeof body.scope === "string" && Boolean(body.scope.trim());
  let geographicScope = scopeWasSubmitted
    ? submittedScope?.definition?.key
    : existing?.scope;
  let governanceAuthorityBranchId =
    typeof body.governanceAuthorityBranchId === "string"
      ? body.governanceAuthorityBranchId.trim()
      : existing?.governanceAuthorityBranchId;
  let jurisdictionBranchId =
    typeof body.jurisdictionBranchId === "string"
      ? body.jurisdictionBranchId.trim()
      : existing?.jurisdictionBranchId;
  let publicationScope =
    body.publicationScope === "national" ||
    body.publicationScope === "branch" ||
    body.publicationScope === "private"
      ? body.publicationScope
      : (existing?.publicationScope ??
        (originatingBranchId && branchAdminIds.includes(originatingBranchId)
          ? "branch"
          : undefined));

  // New proposals are usable immediately. A branch administrator's own branch
  // supplies the governance context; everything else starts under national
  // governance. This is derived from permissions, not from untrusted input, so
  // a follower cannot choose a stronger governance authority.
  if (!existing) {
    if (policyChange) {
      // A change inherits the governance context of the policy it changes.
      // This is derived from the published record, never from client input, so
      // a member cannot use an amendment to gain a different authority.
      const targetBranchId =
        policyChange.target.jurisdictionBranchId ??
        policyChange.target.governanceAuthorityBranchId ??
        null;
      originatingBranchId = targetBranchId ?? originatingBranchId;
      governanceAuthorityBranchId =
        targetBranchId ?? governanceAuthorityBranchId;
      jurisdictionBranchId =
        policyChange.target.jurisdictionBranchId ??
        targetBranchId ??
        jurisdictionBranchId;
      // A change concerns a policy that is already public, so its deliberation
      // is public too. Voting eligibility stays with the branch and is not
      // affected by visibility.
      publicationScope = policyChange.target.publicationScope ?? "national";
    }
    const [nationalBranchForDefault, originBranch] = await Promise.all([
      db
        .collection("branches")
        .findOne({ kind: "national", recognised: true } as any),
      originatingBranchId
        ? db.collection("branches").findOne({ branchId: originatingBranchId })
        : Promise.resolve(null),
    ]);
    if (
      originBranch &&
      String(originBranch.kind) !== "national" &&
      (user.isAdmin || branchAdminIds.includes(originatingBranchId!))
    ) {
      governanceAuthorityBranchId ||= originatingBranchId;
      jurisdictionBranchId ||= originatingBranchId;
      publicationScope ||= "branch";
      geographicScope ||= geographicScopeForBranch(originBranch)?.key;
    } else if (nationalBranchForDefault) {
      const nationalId = String(nationalBranchForDefault.branchId);
      const hadOrigin = Boolean(originatingBranchId);
      originatingBranchId ||= nationalId;
      governanceAuthorityBranchId ||= nationalId;
      jurisdictionBranchId ||= nationalId;
      publicationScope ||= "national";
      // A branch destination keeps its own geographic scope. Only a proposal
      // with no branch destination defaults to National.
      if (!hadOrigin) {
        geographicScope ||=
          geographicScopeForBranch(nationalBranchForDefault)?.key;
      }
    }
  }
  if (!scopeWasSubmitted && originatingBranchId) {
    // API clients may still submit an originating branch identifier. Derive the
    // canonical geographic scope from the branch record rather than trusting a
    // label, and keep legacy records untouched when it cannot be derived.
    const originBranch = await db
      .collection("branches")
      .findOne({ branchId: originatingBranchId });
    const derivedScope = originBranch
      ? geographicScopeForBranch(originBranch)?.key
      : undefined;
    geographicScope = derivedScope ?? existing?.scope;
  }

  if (user.isAdmin) {
    for (const branchId of [
      originatingBranchId,
      governanceAuthorityBranchId,
      jurisdictionBranchId,
    ].filter(Boolean)) {
      if (!(await db.collection("branches").findOne({ branchId }))) {
        throw new Error(`Branch '${branchId}' does not exist.`);
      }
    }
    if (publicationScope === "branch" && !jurisdictionBranchId) {
      throw new Error(
        "Branch publication requires an explicit jurisdiction branch.",
      );
    }
    if (publicationScope === "national" && !governanceAuthorityBranchId) {
      throw new Error(
        "National publication requires an explicit governance authority branch.",
      );
    }
  } else if (originatingBranchId) {
    // Any verified member may submit into any recognised branch. Recognition is
    // the only destination rule; it does not grant branch membership, voting
    // eligibility, or administrative authority.
    if (
      !(await db
        .collection("branches")
        .findOne({ branchId: originatingBranchId, recognised: true }))
    ) {
      throw new Error("Choose a recognised proposal scope.");
    }
  }

  return {
    originatingBranchId,
    governanceAuthorityBranchId,
    jurisdictionBranchId,
    publicationScope,
    geographicScope,
    scopeWasSubmitted,
  };
}

export async function saveProposal(
  db: Db,
  user: SessionUser,
  body: Record<string, unknown>,
  options: { allowAmendmentApply?: boolean } = {},
): Promise<ProposalRecord> {
  const col = db.collection<ProposalRecord>("proposals");
  const existingId =
    typeof body.proposalId === "string"
      ? body.proposalId.trim()
      : typeof body.policyId === "string"
        ? body.policyId.trim()
        : "";
  const existing = existingId
    ? await col.findOne({ proposalId: existingId })
    : null;
  // A declared policy change is fixed at creation. Rewriting what a live
  // proposal targets would let a draft claim authority over different policy.
  const declaresChange =
    body.targetPolicyId !== undefined || body.changeType !== undefined;
  if (existing && declaresChange) {
    const sameTarget =
      String(body.targetPolicyId ?? existing.targetPolicyId ?? "") ===
      String(existing.targetPolicyId ?? "");
    const sameType =
      String(body.changeType ?? existing.changeType ?? "") ===
      String(existing.changeType ?? "");
    if (!sameTarget || !sameType) {
      throw new Error(
        "The policy a proposal changes is fixed when it is created.",
      );
    }
  }
  const policyChange =
    !existing && declaresChange
      ? await resolvePolicyChangeTarget(db, body)
      : null;
  const branchAdminIds = user.branchAdminIds ?? [];
  // Validate the submitted geographic scope before any permissions run. The
  // canonical key is translated to an organisational branch identifier here,
  // so a display label can never select a branch.
  const submittedScope = await parseProposalScopeInput(db, body);
  const canManageExisting = Boolean(
    existing &&
      (user.isStaff ||
        (existing.originatingBranchId &&
          branchAdminIds.includes(existing.originatingBranchId)) ||
        hasPermission(user, "proposals.edit", existing.originatingBranchId) ||
        (options.allowAmendmentApply &&
          hasPermission(
            user,
            "amendments.apply",
            existing.originatingBranchId,
          ))),
  );
  if (!user.isAdmin) {
    if (
      [
        "governanceAuthorityBranchId",
        "jurisdictionBranchId",
        "publicationScope",
      ].some((field) => body[field] !== undefined)
    ) {
      throw new Error(
        "Only a national administrator may set governance authority, jurisdiction, or publication scope.",
      );
    }
    // Choosing a destination is participation, not administration. Any
    // verified member may submit into any recognised branch; this grants no
    // voting eligibility and no administrative authority in that branch.
    if (
      existing?.originatingBranchId &&
      submittedScope?.branchId &&
      submittedScope.branchId !== existing.originatingBranchId
    ) {
      throw new Error("Proposal scope cannot be changed after it is set.");
    }
  }
  const isGovernanceOperator = Boolean(user.isStaff || canManageExisting);

  if (existing) {
    const isAuthorInPropose =
      existing.authorId === user.memberId && existing.stage === "propose";
    if (!canManageExisting && !isAuthorInPropose) {
      throw new Error(
        "Moderator or Administrator access is required to edit this proposal.",
      );
    }
    await assertStageTransitionAllowed(db, user, existing, body);
    await assertProposalUnlocked(db, existing, body, submittedScope);

    if (isGovernanceOperator && isQuickGovernanceUpdate(body)) {
      return applyQuickGovernanceUpdate(db, col, user, existing, body);
    }
  } else if (!user.canParticipate && !user.isStaff) {
    throw new Error(
      "Your membership must be verified before you can submit a proposal.",
    );
  }

  const title =
    typeof body.title === "string"
      ? body.title.trim()
      : (existing?.title ?? "");
  if (title.length < 4 || title.length > 200) {
    throw new Error("Title must be between 4 and 200 characters.");
  }

  // A change inherits the published policy's topic. The policy already carries
  // its subject, so the member is never asked to choose it again.
  const inheritedPolicySpace =
    policyChange && typeof policyChange.target.category === "string"
      ? policyChange.target.category.trim()
      : "";
  const space =
    inheritedPolicySpace ||
    (typeof body.space === "string" && body.space.trim()
      ? body.space.trim()
      : typeof body.category === "string" && body.category.trim()
        ? body.category.trim()
        : (existing?.space ?? "General"));
  if (space.length < 2 || space.length > 100) {
    throw new Error("Space / topic must be between 2 and 100 characters.");
  }

  const rawSummary =
    typeof body.summary === "string"
      ? body.summary.trim()
      : typeof body.statement === "string"
        ? body.statement.trim()
        : (existing?.summary ?? "");
  if (rawSummary.length < 10 || rawSummary.length > 2000) {
    throw new Error(
      "Proposal summary must be between 10 and 2,000 characters.",
    );
  }

  const outcomes =
    body.outcomes !== undefined
      ? parseOutcomes(body.outcomes)
      : (existing?.outcomes ?? []);

  const details =
    typeof body.details === "string"
      ? body.details.trim()
      : (existing?.details ?? "");
  const attachmentUrl =
    typeof body.attachmentUrl === "string"
      ? body.attachmentUrl.trim()
      : (existing?.attachmentUrl ?? "");
  if (attachmentUrl && !/^(https?:\/\/|\/)/i.test(attachmentUrl)) {
    throw new Error(
      "Supporting link or image URL must start with https:// or /.",
    );
  }

  const attachmentDescription =
    typeof body.attachmentDescription === "string"
      ? body.attachmentDescription.trim()
      : (existing?.attachmentDescription ?? "");

  // Action-specific content. A repeal carries a rationale, not new commitments;
  // a replacement carries wording; an amendment may name the part it changes.
  const effectiveChangeType = policyChange?.changeType ?? existing?.changeType;
  const targetSection =
    effectiveChangeType === "amend"
      ? typeof body.targetSection === "string"
        ? body.targetSection.trim()
        : (existing?.targetSection ?? "")
      : "";
  if (targetSection.length > 300) {
    throw new Error(
      "The part of the policy to change must be 300 characters or fewer.",
    );
  }
  const proposedWording =
    effectiveChangeType === "replace"
      ? typeof body.proposedWording === "string"
        ? body.proposedWording.trim()
        : (existing?.proposedWording ?? "")
      : "";
  if (proposedWording.length > 5000) {
    throw new Error("Proposed wording must be 5,000 characters or fewer.");
  }

  const kind = normalizeKind(
    body.kind ?? existing?.kind ?? "policy",
    existing?.proposalId ?? "",
  );

  const implementationNote =
    typeof body.implementationNote === "string"
      ? body.implementationNote.trim()
      : (existing?.implementationNote ?? "");

  // Non-staff member submissions always start in "propose" stage
  const stage: ProposalStage = isGovernanceOperator
    ? normalizeStage(body.stage ?? body.status, existing?.stage ?? "propose")
    : (existing?.stage ?? "propose");

  const now = new Date();
  const {
    originatingBranchId,
    governanceAuthorityBranchId,
    jurisdictionBranchId,
    publicationScope,
    geographicScope,
    scopeWasSubmitted,
  } = await resolveBranchGovernanceContext(
    db,
    user,
    existing,
    body,
    submittedScope,
    policyChange,
  );

  const provenance =
    user.isStaff && body.provenance !== undefined
      ? parseProvenanceInput(body.provenance, kind)
      : existing?.provenance;

  if (existing) {
    const updated: ProposalRecord = {
      ...existing,
      title,
      space,
      summary: rawSummary,
      outcomes,
      details,
      targetSection: targetSection || undefined,
      proposedWording: proposedWording || undefined,
      attachmentUrl: attachmentUrl || undefined,
      attachmentDescription: attachmentDescription || undefined,
      kind,
      implementationNote: implementationNote || undefined,
      stage,
      originatingBranchId,
      governanceAuthorityBranchId,
      jurisdictionBranchId,
      publicationScope,
      scope: geographicScope,
      provenance,
      updatedAt: now,
    };
    const updateSet: Record<string, any> = {
      title: updated.title,
      space: updated.space,
      summary: updated.summary,
      outcomes: updated.outcomes,
      details: updated.details,
      ...(targetSection ? { targetSection } : {}),
      ...(proposedWording ? { proposedWording } : {}),
      attachmentUrl: updated.attachmentUrl,
      attachmentDescription: updated.attachmentDescription,
      kind: updated.kind,
      implementationNote: updated.implementationNote,
      stage: updated.stage,
      originatingBranchId: updated.originatingBranchId,
      governanceAuthorityBranchId: updated.governanceAuthorityBranchId,
      jurisdictionBranchId: updated.jurisdictionBranchId,
      publicationScope: updated.publicationScope,
      ...(geographicScope ? { scope: geographicScope } : {}),
      updatedAt: now,
    };
    const unsetFields: Record<string, 1> = {};
    if (scopeWasSubmitted && !geographicScope) unsetFields.scope = 1;
    if (!targetSection) unsetFields.targetSection = 1;
    if (!proposedWording) unsetFields.proposedWording = 1;
    if (user.isStaff && body.provenance === null) {
      unsetFields.provenance = 1;
    } else if (user.isStaff && body.provenance !== undefined) {
      updateSet.provenance = provenance;
    }

    const snapshot = {
      title: updated.title,
      summary: updated.summary,
      outcomes: updated.outcomes,
      details: updated.details,
      ...(updated.targetSection ? { targetSection: updated.targetSection } : {}),
      ...(updated.proposedWording
        ? { proposedWording: updated.proposedWording }
        : {}),
    };
    const contentHash = computeSnapshotHash(snapshot);
    const latestRevisions = await db
      .collection("proposal_revisions")
      .find({ proposalId: existing.proposalId })
      .sort({ createdAt: -1 })
      .limit(1)
      .toArray();
    const previousRevision = latestRevisions[0];
    const appendRevision =
      !previousRevision || previousRevision.contentHash !== contentHash;
    const nextRevisionId = appendRevision
      ? randomUUID()
      : previousRevision.revisionId;
    const openingBallot = stage === "decide" && existing.stage !== "decide";
    const closingBallot = existing.stage === "decide" && stage !== "decide";
    let ballotClosesAt = existing.ballotClosesAt;
    if (openingBallot || (stage === "decide" && body.ballotClosesAt !== undefined)) {
      ballotClosesAt = parseBallotCloseDate(
        body.ballotClosesAt,
        existing.ballotClosesAt,
        now,
      );
      updated.ballotClosesAt = ballotClosesAt;
      updateSet.ballotClosesAt = ballotClosesAt;
    }

    let ballotUnbound = false;
    let ballotReboundFrom: string | undefined;
    if (
      closingBallot ||
      (stage === "decide" && body.ballotClosesAt !== undefined)
    ) {
      // A new ballot instance (or leaving Decide) invalidates the previous
      // closure marker; the historical `ballot.closed` event remains.
      unsetFields.ballotClosedAt = 1;
    }
    if (stage === "decide") {
      if (updated.ballotRevisionId && updated.ballotRevisionId !== nextRevisionId) {
        ballotReboundFrom = updated.ballotRevisionId;
      }
      updated.ballotRevisionId = nextRevisionId;
      updateSet.ballotRevisionId = nextRevisionId;
      if (openingBallot || ballotReboundFrom || !existing.ballotRevisionId) {
        updateSet.ballotRevisionBoundAt = now;
        updateSet.ballotRevisionBoundBy = user.memberId;
      }
    } else if (existing.ballotRevisionId && (closingBallot || appendRevision)) {
      const currentBallotId = proposalBallotId(existing.proposalId);
      const ballotVoteCount = await db
        .collection<VoteRecord>(PROPOSAL_VOTES)
        .countDocuments({
          $or: [
            { proposalId: existing.proposalId },
            { ballotId: currentBallotId },
          ],
        });
      if (ballotVoteCount === 0) {
        // Clear any prior binding only when zero votes exist so a returned or
        // edited proposal cannot carry stale wording back into Decide.
        delete updated.ballotRevisionId;
        unsetFields.ballotRevisionId = 1;
        unsetFields.ballotRevisionBoundAt = 1;
        unsetFields.ballotRevisionBoundBy = 1;
        ballotUnbound = true;
      }
    }

    await runInTransaction(db, async (session) => {
      const sessionOpts = session ? { session } : undefined;
      const write = await col.updateOne(
        { proposalId: existing.proposalId, updatedAt: existing.updatedAt },
        {
          $set: updateSet,
          ...(Object.keys(unsetFields).length
            ? { $unset: unsetFields }
            : {}),
        },
        sessionOpts,
      );
      if (write.matchedCount !== 1) {
        throw new Error(
          "Proposal changed while you were editing it. Reload the latest revision and try again.",
        );
      }
      if (appendRevision) {
        await db
          .collection("proposal_revisions")
          .insertOne(
            {
              revisionId: nextRevisionId,
              proposalId: updated.proposalId,
              parentRevisionId: previousRevision?.revisionId ?? null,
              authorId: user.memberId,
              createdAt: now,
              snapshot,
              contentHash,
              provenance: updated.provenance,
            },
            sessionOpts,
          );
      }
      if (existing.stage !== stage) {
        await recordGovernanceEvent(
          db,
          {
            eventType: "proposal.stage_transition",
            matterId: updated.proposalId,
            revisionId: nextRevisionId,
            actorId: user.memberId,
            authorityBranchId: updated.governanceAuthorityBranchId,
            metadata: {
              fromStage: existing.stage,
              toStage: stage,
              ...(ballotClosesAt
                ? { ballotClosesAt: ballotClosesAt.toISOString() }
                : {}),
            },
            createdAt: now,
          },
          session,
        );
      }
      if (ballotUnbound) {
        await recordGovernanceEvent(
          db,
          {
            eventType: "ballot.unbound",
            matterId: updated.proposalId,
            ballotId: proposalBallotId(updated.proposalId),
            revisionId: existing.ballotRevisionId,
            actorId: user.memberId,
            authorityBranchId: updated.governanceAuthorityBranchId,
            reason: closingBallot
              ? "Returned from Decide with zero votes."
              : "Wording edited with zero votes.",
            createdAt: now,
          },
          session,
        );
      } else if (ballotReboundFrom) {
        await recordGovernanceEvent(
          db,
          {
            eventType: "ballot.rebound",
            matterId: updated.proposalId,
            ballotId: proposalBallotId(updated.proposalId),
            revisionId: nextRevisionId,
            actorId: user.memberId,
            authorityBranchId: updated.governanceAuthorityBranchId,
            metadata: { previousRevisionId: ballotReboundFrom },
            createdAt: now,
          },
          session,
        );
      }
    });
    return updated;
  }

  const ballotClosesAt =
    stage === "decide"
      ? parseBallotCloseDate(body.ballotClosesAt, undefined, now)
      : undefined;

  const count = await col.countDocuments();
  const proposalId =
    existingId ||
    `PROP-${String(count + 1).padStart(3, "0")}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;

  // A proposal may be drafted from a Sense Box priority by a reviewer. The
  // source is provenance only: it never publishes the submission, changes a
  // ballot, or grants the proposal any authority.
  const requestedSenseSource =
    typeof body.sourceSenseSubmissionId === "string"
      ? body.sourceSenseSubmissionId.trim()
      : "";
  if (existing && requestedSenseSource)
    throw new Error("A proposal's Sense Box source is fixed when it is created.");
  let senseSource: Record<string, any> | null = null;
  let senseSourcePublished = false;
  if (!existing && requestedSenseSource) {
    senseSource = await db.collection("sense_submissions").findOne({ submissionId: requestedSenseSource });
    if (!senseSource) throw new Error("That Sense Box priority was not found.");
    if (!canReviewSense(user, String(senseSource.branchId)))
      throw new Error("You are not authorised to develop that Sense Box priority.");
    if (senseSource.linkedProposalId)
      throw new Error("That Sense Box priority is already linked to a proposal.");
    const sourceIsPublished = senseSource.visibility === "published" && Boolean(senseSource.publishedAt);
    if (!sourceIsPublished) {
      if (body.privateSourceAcknowledgement !== true)
        throw new Error(
          "This Sense Box priority has not been published. Confirm that the proposal is independently written before submitting.",
        );
      if (reproducesPrivateSource(senseSource, { title, summary: rawSummary, details }))
        throw new Error(
          "This proposal reproduces text from a priority that has not been published. Write the proposal independently, or publish the priority first.",
        );
    }
    senseSourcePublished = sourceIsPublished;
  }

  const baseSlug = slugify(title) || proposalId.toLowerCase();
  const slugConflict = await col.findOne({ slug: baseSlug });
  const slug = slugConflict
    ? `${baseSlug}-${proposalId.toLowerCase()}`
    : baseSlug;

  const createdKind = normalizeKind(body.kind, proposalId);

  const revisionId = randomUUID();
  const created: ProposalRecord = {
    proposalId,
    slug,
    title,
    space,
    summary: rawSummary,
    outcomes,
    details,
    ...(targetSection ? { targetSection } : {}),
    ...(proposedWording ? { proposedWording } : {}),
    ...(attachmentUrl ? { attachmentUrl } : {}),
    ...(attachmentDescription ? { attachmentDescription } : {}),
    kind: createdKind,
    ...(implementationNote ? { implementationNote } : {}),
    stage,
    ...(stage === "decide"
      ? {
          ballotRevisionId: revisionId,
          ballotClosesAt,
        }
      : {}),
    originatingBranchId,
    governanceAuthorityBranchId,
    jurisdictionBranchId,
    publicationScope,
    ...(geographicScope ? { scope: geographicScope } : {}),
    ...(policyChange
      ? {
          targetPolicyId: policyChange.targetPolicyId,
          targetPolicyRevisionId: policyChange.targetPolicyRevisionId,
          changeType: policyChange.changeType,
        }
      : {}),
    ...(requestedSenseSource ? { sourceSenseSubmissionId: requestedSenseSource } : {}),
    ...(senseSource
      ? {
          sourceSensePrivacyBasis: senseSourcePublished ? "published-source" : "independent-wording",
          ...(!senseSourcePublished
            ? {
                sourceSensePrivacyReviewedAt: now,
                sourceSensePrivacyReviewedBy: user.memberId,
              }
            : {}),
        }
      : {}),
    provenance,
    authorId: user.memberId,
    authorName: user.name || "Verified Member",
    createdAt: now,
    updatedAt: now,
  };

  const snapshot = {
    title: created.title,
    summary: created.summary,
    outcomes: created.outcomes,
    details: created.details,
    ...(created.targetSection ? { targetSection: created.targetSection } : {}),
    ...(created.proposedWording
      ? { proposedWording: created.proposedWording }
      : {}),
  };
  const revision = {
    revisionId,
    proposalId,
    parentRevisionId: null,
    authorId: user.memberId,
    createdAt: now,
    snapshot,
    contentHash: computeSnapshotHash(snapshot),
    provenance: created.provenance,
  };
  await runInTransaction(db, async (session) => {
    const sessionOpts = session ? { session } : undefined;
    if (senseSource) {
      // Claim the source before creating anything. A concurrent request that
      // already claimed it must not produce a second proposal.
      const claim = await db.collection("sense_submissions").updateOne(
        { submissionId: requestedSenseSource, linkedProposalId: { $exists: false } },
        {
          $set: {
            linkedProposalId: proposalId,
            linkedProposalAt: now,
            linkedProposalBy: user.memberId,
            ...(senseSource.status !== "archived" ? { status: "developing" } : {}),
          },
        },
        sessionOpts,
      );
      if (claim.modifiedCount !== 1)
        throw new Error("That Sense Box priority is already linked to a proposal.");
    }
    await col.insertOne(created, sessionOpts);
    await db
      .collection("proposal_revisions")
      .insertOne(revision, sessionOpts);
    if (stage === "decide") {
      await recordGovernanceEvent(
        db,
        {
          eventType: "proposal.stage_transition",
          matterId: proposalId,
          revisionId,
          actorId: user.memberId,
          authorityBranchId: created.governanceAuthorityBranchId,
          metadata: {
            fromStage: null,
            toStage: "decide",
            ...(ballotClosesAt
              ? { ballotClosesAt: ballotClosesAt.toISOString() }
              : {}),
          },
          createdAt: now,
        },
        session,
      );
    }
  });
  return created;
}

export class ProposalSecondingError extends Error {
  status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = "ProposalSecondingError";
    this.status = status;
  }
}

/**
 * Record the independent seconder a proposal needs before it enters Deliberate
 * (D3) and start the 30-day deliberation clock (D4).
 *
 * Implemented assumptions, visible for review:
 * - one seconder per proposal, and the seconder may not be the author — the
 *   minimal reading of D3;
 * - seconding is a participation act, so the seconder must be a verified member
 *   who can view the matter. It is not a formal ballot and uses no ballot
 *   permission;
 * - seconding performs the Propose → Deliberate transition and records both
 *   `proposal.seconded` and `proposal.stage_transition` events atomically.
 */
export async function secondProposal(
  db: Db,
  user: SessionUser,
  proposalId: string,
): Promise<ProposalRecord> {
  const id = proposalId.trim();
  if (!id) throw new ProposalSecondingError("Proposal ID is required.", 400);
  if (!user.canParticipate) {
    throw new ProposalSecondingError(
      "Your membership must be verified before you can second a proposal.",
      403,
    );
  }

  const col = db.collection<ProposalRecord>("proposals");
  const raw = await col.findOne({ proposalId: id });
  if (!raw) throw new ProposalSecondingError("Proposal not found.", 404);

  const proposal = normalizeProposalDoc(raw);
  if (!canViewProposal(proposal, user)) {
    throw new ProposalSecondingError("Proposal not found.", 404);
  }
  if (proposal.authorId && proposal.authorId === user.memberId) {
    throw new ProposalSecondingError(
      "You cannot second your own proposal.",
    );
  }
  if (proposal.secondedBy) {
    throw new ProposalSecondingError(
      "This proposal already has a seconder.",
    );
  }
  if (proposal.stage !== "propose") {
    throw new ProposalSecondingError(
      "Only a proposal in Propose can be seconded.",
    );
  }

  const now = new Date();
  const deliberationEndsAt = deliberationEndsAtFrom(now);
  await runInTransaction(db, async (session) => {
    const sessionOpts = session ? { session } : undefined;
    const write = await col.updateOne(
      {
        proposalId: id,
        stage: "propose",
        secondedBy: { $exists: false },
      },
      {
        $set: {
          stage: "deliberate",
          secondedBy: user.memberId,
          secondedAt: now,
          deliberationEndsAt,
          updatedAt: now,
        },
      },
      sessionOpts,
    );
    if (write.matchedCount !== 1) {
      throw new ProposalSecondingError(
        "This proposal can no longer be seconded. Reload the latest state and try again.",
      );
    }
    await recordGovernanceEvent(
      db,
      {
        eventType: "proposal.seconded",
        matterId: id,
        actorId: user.memberId,
        authorityBranchId: proposal.governanceAuthorityBranchId,
        metadata: {
          secondedAt: now.toISOString(),
          deliberationEndsAt: deliberationEndsAt.toISOString(),
          ...(proposal.authorId ? { authorId: proposal.authorId } : {}),
        },
        createdAt: now,
      },
      session,
    );
    // Seconding is the member-driven act that satisfies D3, so it performs the
    // Propose -> Deliberate transition and is audited like any other transition.
    await recordGovernanceEvent(
      db,
      {
        eventType: "proposal.stage_transition",
        matterId: id,
        actorId: user.memberId,
        authorityBranchId: proposal.governanceAuthorityBranchId,
        metadata: {
          fromStage: "propose",
          toStage: "deliberate",
          trigger: "seconded",
        },
        createdAt: now,
      },
      session,
    );
  });

  return {
    ...proposal,
    stage: "deliberate",
    secondedBy: user.memberId,
    secondedAt: now,
    deliberationEndsAt,
    updatedAt: now,
  };
}

export class ProposalDeletionConflictError extends Error {
  status = 409;
  constructor(message: string) {
    super(message);
    this.name = "ProposalDeletionConflictError";
  }
}

export async function deleteProposal(
  db: Db,
  user: SessionUser,
  proposalId: string,
  reason?: string,
): Promise<void> {
  const id = proposalId.trim();
  if (!id) throw new Error("Proposal ID is required.");
  const col = db.collection<ProposalRecord>("proposals");
  const existing = await col.findOne({ proposalId: id });
  if (!existing) throw new Error("Proposal not found.");

  const isAuthorInPropose =
    existing.authorId === user.memberId && existing.stage === "propose";
  if (
    !user.isAdmin &&
    !hasPermission(user, "proposals.delete", existing.originatingBranchId) &&
    !isAuthorInPropose
  ) {
    throw new Error(
      "Administrator access is required to delete this proposal.",
    );
  }

  await runInTransaction(db, async (session) => {
    const sessionOpts = session ? { session } : undefined;
    const [revisionCount, voteCount, ballotCount, resultCount, registryCount] =
      await Promise.all([
        db
          .collection("proposal_revisions")
          .countDocuments({ proposalId: id }, sessionOpts),
        db
          .collection(PROPOSAL_VOTES)
          .countDocuments(
            {
              $or: [{ proposalId: id }, { ballotId: proposalBallotId(id) }],
            },
            sessionOpts,
          ),
        db
          .collection(BALLOTS_COLLECTION)
          .countDocuments({ matterId: id }, sessionOpts),
        db
          .collection(FORMAL_DECISIONS_COLLECTION)
          .countDocuments(
            {
              $or: [{ matterId: id }, { proposalId: id }],
            },
            sessionOpts,
          ),
        db
          .collection("policy_registry")
          .countDocuments(
            {
              $or: [{ policyId: id }, { proposalId: id }, { matterId: id }],
            },
            sessionOpts,
          ),
      ]);

    if (
      revisionCount > 1 ||
      voteCount > 0 ||
      ballotCount > 0 ||
      resultCount > 0 ||
      registryCount > 0 ||
      Boolean(existing.ballotRevisionId) ||
      ["decide", "implement", "archived"].includes(existing.stage)
    ) {
      throw new ProposalDeletionConflictError(
        "Matters with governance history (revisions beyond initial draft, ballots, votes, results, or registry records) cannot be deleted. Archive the matter instead.",
      );
    }

    const deleted = await col.deleteOne(
      { proposalId: id, updatedAt: existing.updatedAt },
      sessionOpts,
    );
    if (deleted.deletedCount !== 1) {
      throw new ProposalDeletionConflictError(
        "Proposal changed while deleting. Reload the latest state and try again.",
      );
    }
    await db
      .collection("proposal_revisions")
      .deleteMany({ proposalId: id }, sessionOpts);
    await db.collection("comments").deleteMany({ proposalId: id }, sessionOpts);
    await recordGovernanceEvent(
      db,
      {
        eventType: "proposal.deleted",
        matterId: id,
        actorId: user.memberId,
        authorityBranchId: existing.governanceAuthorityBranchId,
        reason: reason?.trim() || "Draft deleted before governance history.",
        metadata: { stage: existing.stage, title: existing.title },
      },
      session,
    );
  });
}
