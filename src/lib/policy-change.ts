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

/**
 * Member-facing guidance for each way of changing a published policy.
 *
 * The action is the organising principle of the proposal form, so the label,
 * the question the member answers and the effect of adoption live together.
 * Repeal deliberately asks for a rationale and offers no new commitments.
 */
export interface PolicyChangeGuidance {
  /** Short action name used on the choice and in the default title. */
  label: string;
  /** One line explaining what the action does. */
  description: string;
  /** The primary question the member answers. */
  summaryLabel: string;
  summaryPlaceholder: string;
  summaryHint: string;
  /** When an adopted change takes effect. */
  effect: string;
}

export const POLICY_CHANGE_GUIDANCE: Record<
  PolicyChangeType,
  PolicyChangeGuidance
> = {
  amend: {
    label: "Amend",
    description: "Change part of the existing policy",
    summaryLabel: "What should change?",
    summaryPlaceholder: "Describe what should change and why it matters.",
    summaryHint: "Other members will refine the wording during discussion.",
    effect:
      "If adopted, the amendment takes effect when the updated policy is published. This policy stays in place until then.",
  },
  replace: {
    label: "Replace",
    description: "Propose a different policy in its place",
    summaryLabel: "What should the new policy do?",
    summaryPlaceholder: "Outline the policy that should replace this one, and why.",
    summaryHint: "Other members will refine the wording during discussion.",
    effect:
      "If adopted, the replacement takes effect when the new policy is published. This policy stays in place until then.",
  },
  repeal: {
    label: "Repeal",
    description: "Remove this policy",
    summaryLabel: "Why should this policy be repealed?",
    summaryPlaceholder:
      "Explain what this policy gets wrong and why removing it is better than amending it.",
    summaryHint:
      "Other members will be able to discuss your proposal before it goes to a vote.",
    effect:
      "If adopted, the repeal takes effect when the result is ratified. This policy stays in place until then.",
  },
};

/** The editable starting title for a change proposal. */
export function defaultPolicyChangeTitle(
  changeType: PolicyChangeType,
  policyTitle: string,
): string {
  return `${POLICY_CHANGE_GUIDANCE[changeType].label}: ${policyTitle}`;
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
