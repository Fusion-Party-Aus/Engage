import type { Db } from "mongodb";
import { recordGovernanceEvent } from "./governance-relationships.ts";
import type { PolicyChangeType } from "./types.ts";

/**
 * Post-ratification policy lifecycle.
 *
 * A proposal may declare that it amends, replaces or repeals an already
 * published policy. Nothing changes about the adopted policy until the change
 * proposal is ratified: the policy page continues to show the current wording
 * and lists the proposed change separately.
 *
 * Ratification then records exactly one lineage transition:
 * - amend / replace: the change becomes a new published policy record and the
 *   target is marked superseded, pointing at its successor;
 * - repeal: the target is marked repealed with the deciding proposal recorded.
 */

export const POLICY_CHANGE_TYPES: PolicyChangeType[] = [
  "amend",
  "replace",
  "repeal",
];

export class PolicyChangeError extends Error {
  status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = "PolicyChangeError";
    this.status = status;
  }
}

export function isPolicyChangeType(value: unknown): value is PolicyChangeType {
  return (
    typeof value === "string" &&
    (POLICY_CHANGE_TYPES as string[]).includes(value)
  );
}

export function policyChangeLabel(changeType: PolicyChangeType): string {
  switch (changeType) {
    case "amend":
      return "Amend policy";
    case "replace":
      return "Replace policy";
    case "repeal":
      return "Repeal policy";
  }
}

export interface RatifiedPolicyChange {
  proposalId: string;
  revisionId: string;
  ratifiedRevisionId: string;
  changeType: PolicyChangeType;
  targetPolicyId: string;
  targetPolicyRevisionId: string;
  decisionEventId: string;
  authorityBranchId: string;
  actorId: string;
  ratifiedAt: Date;
}

/**
 * Apply the lineage transition for a ratified change. The new policy record is
 * written by the caller first; this only changes the target, and only from
 * `published`, so a retry cannot double-apply or rewrite history.
 */
export async function applyRatifiedPolicyChange(
  db: Db,
  change: RatifiedPolicyChange,
): Promise<Record<string, any>> {
  const col = db.collection("policy_registry");
  const target = await col.findOne({ policyId: change.targetPolicyId });
  if (!target)
    throw new PolicyChangeError("The policy being changed no longer exists.");
  if (target.revisionId !== change.targetPolicyRevisionId)
    throw new PolicyChangeError(
      "The policy wording changed after this proposal was created. Start a new change proposal against the current wording.",
    );

  if (change.changeType === "repeal") {
    if (target.publicationStatus === "repealed") {
      if (
        String(target.repealedBy?.proposalId ?? "") === change.proposalId &&
        String(target.repealedBy?.decisionEventId ?? "") ===
          change.decisionEventId
      )
        return target;
      throw new PolicyChangeError("The policy is already repealed.");
    }
    if (target.publicationStatus !== "published")
      throw new PolicyChangeError(
        "Only a published policy can be repealed by this proposal.",
      );
    await col.updateOne(
      {
        policyId: change.targetPolicyId,
        revisionId: change.targetPolicyRevisionId,
        publicationStatus: "published",
      },
      {
        $set: {
          publicationStatus: "repealed",
          repealedAt: change.ratifiedAt,
          repealedBy: {
            proposalId: change.proposalId,
            revisionId: change.ratifiedRevisionId,
            ballotRevisionId: change.revisionId,
            decisionEventId: change.decisionEventId,
            authorityBranchId: change.authorityBranchId,
            changeType: change.changeType,
            recordedBy: change.actorId,
            recordedAt: change.ratifiedAt,
          },
        },
      },
    );
    await recordChangeEvent(db, change, "policy.repealed");
    return (await col.findOne({ policyId: change.targetPolicyId })) ?? target;
  }

  if (
    target.publicationStatus === "superseded" &&
    String(target.supersededBy ?? "") === change.proposalId
  )
    return target;
  if (target.publicationStatus !== "published")
    throw new PolicyChangeError(
      "Only a published policy can be amended or replaced by this proposal.",
    );
  await col.updateOne(
    {
      policyId: change.targetPolicyId,
      revisionId: change.targetPolicyRevisionId,
      publicationStatus: "published",
    },
    {
      $set: {
        publicationStatus: "superseded",
        supersededAt: change.ratifiedAt,
        supersededBy: change.proposalId,
        supersessionReason: `${change.changeType === "replace" ? "Replacement" : "Amendment"} ratified by decision ${change.decisionEventId}.`,
        supersededByChangeType: change.changeType,
      },
    },
  );
  await recordChangeEvent(db, change, "policy.superseded");
  return (await col.findOne({ policyId: change.targetPolicyId })) ?? target;
}

async function recordChangeEvent(
  db: Db,
  change: RatifiedPolicyChange,
  eventType: "policy.superseded" | "policy.repealed",
): Promise<void> {
  await recordGovernanceEvent(db, {
    eventType,
    matterId: change.targetPolicyId,
    actorId: change.actorId,
    reason: `${policyChangeLabel(change.changeType)} ratified by decision ${change.decisionEventId}.`,
    metadata: {
      changeType: change.changeType,
      proposalId: change.proposalId,
      revisionId: change.ratifiedRevisionId,
      decisionEventId: change.decisionEventId,
      authorityBranchId: change.authorityBranchId,
    },
  });
}

/** Proposals that declare a change to this policy, newest first. */
export async function listPolicyChangeProposals(
  db: Db,
  policyId: string,
): Promise<Array<Record<string, any>>> {
  return db
    .collection("proposals")
    .find({ targetPolicyId: policyId })
    .sort({ createdAt: -1 })
    .toArray();
}
