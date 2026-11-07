import type { Db } from "mongodb";
import baselineItems from "../data/policies.json" with { type: "json" };
import {
  ensureLegacyProposalRevision,
  legacyRevisionId,
  proposalWordingSnapshot,
  wordingContentHash,
  wordingSnapshotsMatch,
  type ProposalWordingSnapshot,
} from "./proposal-revision.ts";
import { PROPOSAL_VOTES, proposalBallotId } from "./vote-storage.ts";
import {
  BallotBindingError,
  bindBallotToRevision,
  verifyBallotBinding,
} from "./ballot-binding.ts";

export type EvidenceClassification =
  | "verified"
  | "supported"
  | "ambiguous"
  | "conflicting"
  | "no-existing-votes";

export interface BallotInventoryEntry {
  proposalId: string;
  title: string;
  stage: string;
  ballotScope: "open-ballot" | "archived-history";
  ballotId: string;
  voteCount: number;
  choices: { approve: number; abstain: number; reject: number };
  currentWording: ProposalWordingSnapshot;
  contentHash: string;
  candidateRevisionId: string;
  candidateRevisionExists: boolean;
  existingBallotRevisionId: string | null;
  evidence: {
    baselineMatch: boolean | null;
    baselineFieldDiffs: string[];
    proposalCreatedAt: string | null;
    proposalUpdatedAt: string | null;
    firstVoteAt: string | null;
    lastVoteAt: string | null;
    recordedRevisionIds: string[];
    candidateRevisionCreatedAt: string | null;
    candidateRevisionIsBackfill: boolean;
    note: string;
  };
  classification: EvidenceClassification;
  ambiguities: string[];
  proposedAction:
    | "bind-existing-revision"
    | "backfill-revision-then-bind"
    | "skip-no-existing-votes"
    | "hold";
  reviewStatus: "consistent" | "blocked" | "not-required";
  proposedDecision: "approve" | "hold" | "reject";
}

export interface BallotInventory {
  version: 1;
  ballotCount: number;
  totalVotes: number;
  classifications: Record<EvidenceClassification, number>;
  ballots: BallotInventoryEntry[];
}

export interface BulkBindingOptions {
  batchId: string;
  decisionEventId: string;
  reason: string;
  actorId: string;
}

export interface BulkBindingPlanEntry {
  proposalId: string;
  revisionId: string;
  contentHash: string;
  voteCount: number;
  revisionExists: boolean;
  action: "bind" | "backfill-revision-then-bind" | "already-bound" | "skip-no-existing-votes";
  blockers: string[];
}

export interface BulkBindingPlan {
  version: 1;
  batchId: string;
  decisionEventId: string;
  ballotCount: number;
  voteCount: number;
  entries: BulkBindingPlanEntry[];
  blockers: string[];
}

export interface BulkBindingResult {
  batchId: string;
  transaction: "committed" | "dry-run";
  ballots: Array<{
    proposalId: string;
    revisionId: string;
    eventId: string;
    idempotent: boolean;
    reviewedVoteCount: number;
    reboundVoteCount: number;
  }>;
  verification: { verified: number; failures: string[] };
}

const iso = (value: unknown): string | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const baselineById = new Map<string, Record<string, any>>(
  (baselineItems as Record<string, any>[]).map((item) => [
    String(item.proposalId || item.policyId),
    item,
  ]),
);

function baselineSnapshot(item: Record<string, any> | undefined) {
  if (!item) return null;
  return proposalWordingSnapshot({
    title: item.title,
    summary: item.summary || item.statement,
    outcomes: item.outcomes,
    details: item.details,
  });
}

function baselineDiffs(
  current: ProposalWordingSnapshot,
  baseline: ProposalWordingSnapshot | null,
) {
  if (!baseline) return ["No deployment baseline record found."];
  const diffs: string[] = [];
  for (const field of ["title", "summary", "outcomes", "details"] as const) {
    if (JSON.stringify(current[field]) !== JSON.stringify(baseline[field]))
      diffs.push(field);
  }
  return diffs;
}

/**
 * Build a deterministic inventory of every Decide-stage ballot that has not
 * yet been bound to an immutable wording revision.
 */
export async function buildBallotInventory(
  db: Db,
  options: { includeBound?: boolean } = {},
): Promise<BallotInventory> {
  const proposals = await db
    .collection("proposals")
    .find({})
    .sort({ proposalId: 1 })
    .toArray();
  const ballots: BallotInventoryEntry[] = [];

  for (const proposal of proposals) {
    const ballotId = proposalBallotId(String(proposal.proposalId));
    const votes = await db
      .collection(PROPOSAL_VOTES)
      .find({ proposalId: proposal.proposalId, ballotId })
      .sort({ updatedAt: 1 })
      .toArray();
    if (!options.includeBound && proposal.ballotRevisionId) continue;
    // The migration covers every open ballot and any historical ballot that
    // still carries votes, so all existing vote records are revision-bound.
    if (proposal.stage !== "decide" && votes.length === 0) continue;
    const revisions = await db
      .collection("proposal_revisions")
      .find({ proposalId: proposal.proposalId })
      .sort({ createdAt: 1 })
      .toArray();
    const currentWording = proposalWordingSnapshot(proposal);
    const contentHash = wordingContentHash(currentWording);
    const matchingRevision = revisions
      .filter(
        (revision) =>
          revision.contentHash === contentHash &&
          wordingSnapshotsMatch(
            proposalWordingSnapshot(revision.snapshot ?? {}),
            currentWording,
          ),
      )
      .sort((left, right) => {
        const leftLegacy = String(left.revisionId).startsWith("legacy-") ? 1 : 0;
        const rightLegacy = String(right.revisionId).startsWith("legacy-")
          ? 1
          : 0;
        if (leftLegacy !== rightLegacy) return rightLegacy - leftLegacy;
        return (
          new Date(right.createdAt ?? 0).getTime() -
          new Date(left.createdAt ?? 0).getTime()
        );
      })[0];
    const candidateRevisionId =
      matchingRevision?.revisionId ??
      legacyRevisionId(String(proposal.proposalId));
    const firstVoteAt = votes[0]?.updatedAt;
    const lastVoteAt = votes[votes.length - 1]?.updatedAt;
    const recordedRevisionIds = [
      ...new Set(
        votes
          .map((vote) => vote.revisionId)
          .filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          ),
      ),
    ].sort();
    const baseline = baselineSnapshot(
      baselineById.get(String(proposal.proposalId)),
    );
    const baselineDiff = baselineDiffs(currentWording, baseline);
    const candidateCreatedAt = matchingRevision?.createdAt ?? null;
    const candidateIsBackfill =
      matchingRevision?.provenance === "legacy-backfill";
    const mixedBoundState =
      votes.some((vote) => Boolean(vote.revisionId)) &&
      votes.some((vote) => !vote.revisionId);
    const choices = { approve: 0, abstain: 0, reject: 0 };
    for (const vote of votes) {
      if (vote.choice === "approve") choices.approve++;
      else if (vote.choice === "abstain") choices.abstain++;
      else if (vote.choice === "reject") choices.reject++;
    }

    const ambiguities: string[] = [];
    if (votes.length === 0)
      ambiguities.push("No existing votes: no historical wording is at risk.");
    if (votes.length > 0 && !firstVoteAt)
      ambiguities.push("Existing votes have no usable timestamp.");
    if (!baseline)
      ambiguities.push("No deployment baseline wording record was found.");
    if (baselineDiff.length)
      ambiguities.push(
        `Current wording differs from the deployment baseline (${baselineDiff.join(", ")}).`,
      );
    if (mixedBoundState)
      ambiguities.push(
        "Existing votes mix bound and unbound records; a partial prior binding requires review.",
      );
    if (
      recordedRevisionIds.length > 1 ||
      (recordedRevisionIds.length === 1 &&
        recordedRevisionIds[0] !== candidateRevisionId)
    )
      ambiguities.push(
        "Existing votes name a different wording revision from the current proposal wording.",
      );
    if (
      proposal.ballotRevisionId &&
      proposal.ballotRevisionId !== candidateRevisionId
    )
      ambiguities.push(
        "The proposal is already bound to a different revision than the current wording.",
      );
    if (
      candidateCreatedAt &&
      firstVoteAt &&
      new Date(candidateCreatedAt).getTime() >
        new Date(firstVoteAt).getTime()
    )
      ambiguities.push(
        "The matching revision was created after voting began, so it is not historical evidence of the wording shown to voters.",
      );
    ambiguities.push(
      "No immutable revision snapshot was recorded at the moment voting began; the binding therefore relies on the confirmed absence of wording change rather than an original vote-time snapshot.",
    );

    let classification: EvidenceClassification;
    if (
      proposal.ballotRevisionId &&
      proposal.ballotRevisionId !== candidateRevisionId
    ) {
      classification = "conflicting";
    } else if (mixedBoundState) {
      classification = "ambiguous";
    } else if (
      recordedRevisionIds.length > 1 ||
      (recordedRevisionIds.length === 1 &&
        recordedRevisionIds[0] !== candidateRevisionId)
    ) {
      classification = "conflicting";
    } else if (votes.length === 0) {
      classification = "no-existing-votes";
    } else if (baselineDiff.length || !baseline || !firstVoteAt) {
      classification = "ambiguous";
    } else if (
      candidateCreatedAt &&
      new Date(candidateCreatedAt).getTime() >
        new Date(firstVoteAt).getTime()
    ) {
      classification = "ambiguous";
    } else if (matchingRevision && !candidateIsBackfill) {
      classification = "verified";
    } else {
      classification = "supported";
    }

    const proposedAction: BallotInventoryEntry["proposedAction"] =
      classification === "no-existing-votes"
        ? "skip-no-existing-votes"
        : classification === "conflicting" || classification === "ambiguous"
          ? "hold"
          : matchingRevision
            ? "bind-existing-revision"
            : "backfill-revision-then-bind";
    const reviewStatus: BallotInventoryEntry["reviewStatus"] =
      classification === "no-existing-votes"
        ? "not-required"
        : classification === "conflicting" || classification === "ambiguous"
          ? "blocked"
          : "consistent";
    const proposedDecision: BallotInventoryEntry["proposedDecision"] =
      classification === "conflicting" || classification === "ambiguous"
        ? classification === "conflicting"
          ? "reject"
          : "hold"
        : "approve";

    ballots.push({
      proposalId: String(proposal.proposalId),
      title: String(proposal.title ?? ""),
      stage: String(proposal.stage),
      ballotScope:
        proposal.stage === "decide" ? "open-ballot" : "archived-history",
      ballotId,
      voteCount: votes.length,
      choices,
      currentWording,
      contentHash,
      candidateRevisionId,
      candidateRevisionExists: Boolean(matchingRevision),
      existingBallotRevisionId: proposal.ballotRevisionId
        ? String(proposal.ballotRevisionId)
        : null,
      evidence: {
        baselineMatch: baseline ? baselineDiff.length === 0 : null,
        baselineFieldDiffs: baselineDiff,
        proposalCreatedAt: iso(proposal.createdAt),
        proposalUpdatedAt: iso(proposal.updatedAt),
        firstVoteAt: iso(firstVoteAt),
        lastVoteAt: iso(lastVoteAt),
        recordedRevisionIds,
        candidateRevisionCreatedAt: iso(candidateCreatedAt),
        candidateRevisionIsBackfill: candidateIsBackfill,
        note:
          "updatedAt is recorded but is not treated as proof of wording: routine startup writes may have changed it. Content comparison against the deployment baseline and vote timing are the primary evidence.",
      },
      classification,
      ambiguities,
      proposedAction,
      reviewStatus,
      proposedDecision,
    });
  }

  const classifications: Record<EvidenceClassification, number> = {
    verified: 0,
    supported: 0,
    ambiguous: 0,
    conflicting: 0,
    "no-existing-votes": 0,
  };
  for (const ballot of ballots) classifications[ballot.classification]++;

  return {
    version: 1,
    ballotCount: ballots.length,
    totalVotes: ballots.reduce((sum, ballot) => sum + ballot.voteCount, 0),
    classifications,
    ballots,
  };
}

/**
 * Build the full bulk-binding plan. No writes occur. Any inconsistent ballot,
 * missing evidence or changed content becomes a blocker.
 */
export function buildBulkBindingPlan(
  inventory: BallotInventory,
  options: BulkBindingOptions,
): BulkBindingPlan {
  const entries: BulkBindingPlanEntry[] = [];
  const blockers: string[] = [];
  if (!options.batchId.trim()) blockers.push("A migration batch identifier is required.");
  if (!options.decisionEventId.trim())
    blockers.push("A decision event reference is required.");
  if (!options.actorId.trim()) blockers.push("An authorised operator identity is required.");
  if (!options.reason.trim()) blockers.push("A migration reason is required.");

  for (const ballot of inventory.ballots) {
    const entryBlockers: string[] = [];
    if (ballot.classification === "no-existing-votes") {
      entries.push({
        proposalId: ballot.proposalId,
        revisionId: ballot.candidateRevisionId,
        contentHash: ballot.contentHash,
        voteCount: 0,
        revisionExists: ballot.candidateRevisionExists,
        action: "skip-no-existing-votes",
        blockers: [],
      });
      continue;
    }
    if (ballot.classification === "conflicting")
      entryBlockers.push("Conflicting ballot records must be resolved manually.");
    if (
      ballot.existingBallotRevisionId &&
      ballot.existingBallotRevisionId !== ballot.candidateRevisionId
    )
      entryBlockers.push(
        "The ballot is already bound to a different immutable revision.",
      );
    if (ballot.classification === "ambiguous")
      entryBlockers.push(
        ...ballot.ambiguities.filter((note) => !note.includes("No immutable revision snapshot")),
      );
    if (ballot.evidence.baselineMatch !== true)
      entryBlockers.push(
        "Current wording is not confirmed against the deployment baseline.",
      );
    if (ballot.proposedDecision !== "approve")
      entryBlockers.push("Inventory outcome is not eligible for bulk binding.");
    entries.push({
      proposalId: ballot.proposalId,
      revisionId: ballot.candidateRevisionId,
      contentHash: ballot.contentHash,
      voteCount: ballot.voteCount,
      revisionExists: ballot.candidateRevisionExists,
      action:
        ballot.existingBallotRevisionId === ballot.candidateRevisionId
          ? "already-bound"
          : ballot.candidateRevisionExists
            ? "bind"
            : "backfill-revision-then-bind",
      blockers: [...new Set(entryBlockers)],
    });
    for (const blocker of entryBlockers)
      blockers.push(`${ballot.proposalId}: ${blocker}`);
  }

  return {
    version: 1,
    batchId: options.batchId,
    decisionEventId: options.decisionEventId,
    ballotCount: entries.filter(
      (entry) => entry.action !== "skip-no-existing-votes",
    ).length,
    voteCount: entries.reduce((sum, entry) => sum + entry.voteCount, 0),
    entries,
    blockers,
  };
}

/**
 * Apply the bulk binding in one MongoDB transaction. The transaction contains
 * revision backfill (where required), ballot updates, vote attachment and
 * per-ballot audit events. Any failure rolls the whole batch back.
 */
export async function applyBulkBinding(
  db: Db,
  inventory: BallotInventory,
  options: BulkBindingOptions,
  settings: { apply: boolean },
): Promise<BulkBindingResult> {
  const plan = buildBulkBindingPlan(inventory, options);
  if (plan.blockers.length)
    throw new BallotBindingError(
      `Bulk binding refused:\n${plan.blockers.join("\n")}`,
      409,
    );
  if (!settings.apply)
    return {
      batchId: options.batchId,
      transaction: "dry-run",
      ballots: [],
      verification: { verified: 0, failures: [] },
    };

  const bindable = plan.entries.filter(
    (entry) =>
      entry.action === "bind" ||
      entry.action === "backfill-revision-then-bind" ||
      entry.action === "already-bound",
  );
  const results: BulkBindingResult["ballots"] = [];
  const client = db.client;
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      for (const entry of bindable) {
        const ballot = inventory.ballots.find(
          (candidate) => candidate.proposalId === entry.proposalId,
        )!;
        const proposal = await db
          .collection("proposals")
          .findOne(
            { proposalId: entry.proposalId, stage: ballot.stage },
            { session },
          );
        if (!proposal)
          throw new BallotBindingError(
            `${entry.proposalId}: the proposal is no longer in the inventoried ballot stage (${ballot.stage}).`,
          );
        const currentHash = wordingContentHash(proposalWordingSnapshot(proposal));
        if (currentHash !== ballot.contentHash)
          throw new BallotBindingError(
            `${entry.proposalId}: proposal wording changed after the inventory was generated.`,
          );
        const revision = await ensureLegacyProposalRevision(db, proposal, {
          session,
        });
        if (
          !revision ||
          revision.revisionId !== entry.revisionId ||
          revision.contentHash !== ballot.contentHash ||
          !wordingSnapshotsMatch(
            proposalWordingSnapshot(revision.snapshot ?? {}),
            ballot.currentWording,
          )
        )
          throw new BallotBindingError(
            `${entry.proposalId}: an immutable revision matching the inventoried wording could not be verified.`,
          );

        const applied = await bindBallotToRevision(db, {
          proposalId: entry.proposalId,
          revisionId: revision.revisionId,
          decisionEventId: options.decisionEventId,
          reason: options.reason,
          actorId: options.actorId,
          bindingBasis:
            ballot.ballotScope === "open-ballot"
              ? "retrospective-bulk-no-wording-change"
              : "retrospective-archived-ballot-no-wording-change",
          migrationBatchId: options.batchId,
          contentHash: ballot.contentHash,
          allowedStages: [ballot.stage],
          session,
        });
        results.push({
          proposalId: entry.proposalId,
          revisionId: applied.event.revisionId,
          eventId: applied.event.eventId,
          idempotent: applied.idempotent,
          reviewedVoteCount: applied.event.reviewedVoteCount,
          reboundVoteCount: applied.event.reboundVoteCount,
        });
      }
    });
  } finally {
    await session.endSession();
  }

  const verification = await verifyBallotInventory(db, inventory);
  return {
    batchId: options.batchId,
    transaction: "committed",
    ballots: results,
    verification,
  };
}

export async function verifyBallotInventory(
  db: Db,
  inventory: BallotInventory,
): Promise<{ verified: number; failures: string[] }> {
  const failures: string[] = [];
  let verified = 0;
  for (const ballot of inventory.ballots) {
    if (ballot.classification === "no-existing-votes") continue;
    try {
      await verifyBallotBinding(
        db,
        ballot.proposalId,
        ballot.candidateRevisionId,
        undefined,
        [ballot.stage],
      );
      const voteCount = await db.collection(PROPOSAL_VOTES).countDocuments({
        proposalId: ballot.proposalId,
        ballotId: ballot.ballotId,
      });
      if (voteCount !== ballot.voteCount)
        failures.push(
          `${ballot.proposalId}: vote count changed from ${ballot.voteCount} to ${voteCount}.`,
        );
      else verified++;
    } catch (error) {
      failures.push(
        `${ballot.proposalId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { verified, failures };
}

export function renderInventoryMarkdown(inventory: BallotInventory): string {
  const lines = [
    "# Engage ballot-binding migration inventory",
    "",
    `- Ballots: ${inventory.ballotCount} (${inventory.ballots.filter((ballot) => ballot.ballotScope === "open-ballot").length} open Decide ballots, ${inventory.ballots.filter((ballot) => ballot.ballotScope === "archived-history").length} archived historical ballots)`,
    `- Existing votes: ${inventory.totalVotes}`,
    `- Verified historical wording: ${inventory.classifications.verified}`,
    `- Confirmed-unchanged wording: ${inventory.classifications.supported}`,
    `- Ambiguous: ${inventory.classifications.ambiguous}`,
    `- Conflicting: ${inventory.classifications.conflicting}`,
    "",
    "The binding is retrospective: no immutable revision was captured when voting began. The inventory therefore records the current wording hash, compares it with the deployment baseline, and requires the bulk plan to fail closed on any difference.",
    "",
    "| Ballot | Title | Votes | Classification | Candidate revision | Review status | Proposed action |",
    "| --- | --- | ---: | --- | --- | --- | --- |",
  ];
  for (const ballot of inventory.ballots) {
    lines.push(
      `| ${ballot.proposalId} | ${ballot.title.replaceAll("|", "\\|")} | ${ballot.voteCount} | ${ballot.classification} | \`${ballot.candidateRevisionId}\` | ${ballot.reviewStatus} | ${ballot.proposedAction} |`,
    );
  }
  lines.push("", "## Evidence notes", "");
  for (const ballot of inventory.ballots) {
    lines.push(
      `### ${ballot.proposalId} — ${ballot.title}`,
      "",
      `- Content hash: \`${ballot.contentHash}\``,
      `- Votes: ${ballot.voteCount} (${ballot.choices.approve} approve, ${ballot.choices.abstain} abstain, ${ballot.choices.reject} reject)`,
      `- Voting window: ${ballot.evidence.firstVoteAt ?? "not recorded"} to ${ballot.evidence.lastVoteAt ?? "not recorded"}`,
      `- Baseline match: ${ballot.evidence.baselineMatch === null ? "no baseline record" : ballot.evidence.baselineMatch ? "yes" : "no"}`,
      `- Candidate revision exists: ${ballot.candidateRevisionExists ? "yes" : "no (migration will create the deterministic immutable revision)"}`,
      "",
      "Evidence notes:",
      ...ballot.ambiguities.map((note) => `- ${note}`),
      "",
    );
  }
  return lines.join("\n");
}
