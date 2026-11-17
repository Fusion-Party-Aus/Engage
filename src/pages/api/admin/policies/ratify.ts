import type { APIRoute } from "astro";
import { createHash, randomUUID } from "node:crypto";
import { getSessionUser } from "../../../../lib/auth.ts";
import { privateJson, toRatifiedPolicyDto } from "../../../../lib/api-contracts.ts";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import { requireApiPermission } from "../../../../lib/rbac.ts";
import { isGovernanceResolution } from "../../../../lib/proposal-helpers.ts";
import {
  applyRatifiedPolicyChange,
  isPolicyChangeType,
} from "../../../../lib/policy-change.ts";
import {
  branchPublicSlug,
  policySlugFromTitle,
  uniquePolicySlug,
} from "../../../../lib/policy-registry.ts";

export const prerender = false;
export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  const denied = requireApiPermission(user, "policies.ratify", {
    message: "Administrator access required.",
  });
  if (denied || !user) return denied ?? Response.json({ error: "Sign in required." }, { status: 401 });
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const proposalId = String(body.proposalId ?? "");
    const revisionId = String(body.revisionId ?? "");
    const decisionEventId = String(body.decisionEventId ?? "");
    const authorityBranchId = String(body.authorityBranchId ?? "");
    if (!proposalId || !revisionId || !decisionEventId || !authorityBranchId)
      return Response.json(
        {
          error:
            "proposalId, revisionId, decisionEventId and authorityBranchId are required.",
        },
        { status: 400 },
      );
    const db = await getDatabase(env);
    const proposal = await db.collection("proposals").findOne({ proposalId });
    const revision = await db
      .collection("proposal_revisions")
      .findOne({ proposalId, revisionId });
    if (!proposal || !revision)
      return Response.json(
        { error: "Proposal revision not found." },
        { status: 404 },
      );
    // A change proposal must name a complete, current relationship to an
    // adopted policy. Half-declared lineage is refused rather than guessed.
    const declaredChangeType = isPolicyChangeType(proposal.changeType)
      ? proposal.changeType
      : null;
    const declaredTargetPolicyId =
      typeof proposal.targetPolicyId === "string"
        ? proposal.targetPolicyId
        : "";
    if (Boolean(proposal.changeType) !== Boolean(proposal.targetPolicyId))
      return Response.json(
        {
          error:
            "This proposal declares an incomplete policy change. Both the target policy and the change type are required.",
        },
        { status: 409 },
      );
    if (proposal.targetPolicyId && !declaredChangeType)
      return Response.json(
        { error: "The declared change type is not recognised." },
        { status: 409 },
      );
    let policyChangeTarget: Record<string, any> | null = null;
    if (declaredChangeType && declaredTargetPolicyId) {
      policyChangeTarget = await db
        .collection("policy_registry")
        .findOne({ policyId: declaredTargetPolicyId });
      if (!policyChangeTarget)
        return Response.json(
          { error: "The policy this proposal changes was not found." },
          { status: 409 },
        );
      if (
        String(policyChangeTarget.revisionId ?? "") !==
        String(proposal.targetPolicyRevisionId ?? "")
      )
        return Response.json(
          {
            error:
              "The policy wording changed after this proposal was created. Start a new change proposal against the current wording.",
          },
          { status: 409 },
        );
      if (
        declaredChangeType !== "repeal" &&
        policyChangeTarget.publicationStatus !== "published"
      )
        return Response.json(
          {
            error:
              "This proposal can only amend or replace a policy that is still published.",
          },
          { status: 409 },
        );
    }
    if (isGovernanceResolution(proposal as { kind?: string; proposalId?: string }))
      return Response.json(
        {
          error:
            "Governance resolutions cannot be ratified into the Policy Registry. Record the resolution outcome or implementation notes on the proposal instead.",
        },
        { status: 409 },
      );
    if (proposal.stage !== "implement")
      return Response.json(
        {
          error:
            "Only a proposal moved to Implement can be ratified. Review the ballot result and record the lifecycle transition first.",
        },
        { status: 409 },
      );
    const ballotResult = await db
      .collection("ballot_results")
      .findOne({ proposalId, revisionId, result: "successful" });
    if (!ballotResult)
      return Response.json(
        {
          error:
            "A successful result for this exact ballot revision must be recorded before ratification.",
        },
        { status: 409 },
      );
    if (ballotResult.decisionEventId !== decisionEventId)
      return Response.json(
        {
          error:
            "Ratification must cite the decision event recorded with the successful ballot result.",
        },
        { status: 409 },
      );
    const authorityBranch = await db
      .collection("branches")
      .findOne({ branchId: authorityBranchId, recognised: true });
    if (!authorityBranch)
      return Response.json(
        { error: "Ratifying authority must be a recognised branch." },
        { status: 400 },
      );
    if (
      typeof proposal.governanceAuthorityBranchId === "string" &&
      proposal.governanceAuthorityBranchId &&
      authorityBranchId !== proposal.governanceAuthorityBranchId
    )
      return Response.json(
        {
          error:
            "Ratification authority must match the proposal's governance authority branch.",
        },
        { status: 409 },
      );
    if (
      typeof ballotResult.authorityBranchId === "string" &&
      ballotResult.authorityBranchId &&
      authorityBranchId !== ballotResult.authorityBranchId
    )
      return Response.json(
        {
          error:
            "Ratification authority must match the recorded ballot decision authority.",
        },
        { status: 409 },
      );
    const jurisdictionBranchId =
      typeof body.jurisdictionBranchId === "string" && body.jurisdictionBranchId
        ? body.jurisdictionBranchId
        : typeof policyChangeTarget?.jurisdictionBranchId === "string"
          ? policyChangeTarget.jurisdictionBranchId
          : null;
    if (
      jurisdictionBranchId &&
      !(await db
        .collection("branches")
        .findOne({ branchId: jurisdictionBranchId, recognised: true }))
    )
      return Response.json(
        { error: "Policy jurisdiction must be a recognised branch." },
        { status: 400 },
      );
    const key = request.headers.get("idempotency-key");
    if (!key || key.length > 200)
      return Response.json(
        { error: "Idempotency-Key is required for ratification." },
        { status: 400 },
      );
    const priorPolicy = await db
      .collection("policy_registry")
      .findOne({ policyId: proposalId });
    if (priorPolicy) {
      if (
        priorPolicy.idempotencyKey === key &&
        priorPolicy.ratification?.decisionEventId === decisionEventId
      )
        return privateJson({ policy: toRatifiedPolicyDto(priorPolicy) }, { status: 200 });
      return Response.json(
        { error: "A different revision is already ratified for this policy." },
        { status: 409 },
      );
    }
    if (declaredChangeType === "repeal" && policyChangeTarget) {
      if (
        Array.isArray(body.adoptedAmendmentIds) &&
        body.adoptedAmendmentIds.length
      )
        return Response.json(
          {
            error:
              "A repeal decision cannot adopt amendments to wording that is being removed.",
          },
          { status: 409 },
        );
      if (
        policyChangeTarget.publicationStatus === "repealed" &&
        String(policyChangeTarget.repealedBy?.proposalId ?? "") ===
          proposalId &&
        String(policyChangeTarget.repealedBy?.decisionEventId ?? "") ===
          decisionEventId
      )
        return privateJson(
          { policy: toRatifiedPolicyDto(policyChangeTarget), repealed: true },
          { status: 200 },
        );
      const repealed = await applyRatifiedPolicyChange(db, {
        proposalId,
        revisionId,
        ratifiedRevisionId: revisionId,
        changeType: "repeal",
        targetPolicyId: declaredTargetPolicyId,
        targetPolicyRevisionId: String(proposal.targetPolicyRevisionId ?? ""),
        decisionEventId,
        authorityBranchId,
        actorId: user.memberId,
        ratifiedAt: new Date(),
      });
      return privateJson(
        { policy: toRatifiedPolicyDto(repealed), repealed: true },
        { status: 201 },
      );
    }
    const amendmentIds = Array.isArray(body.adoptedAmendmentIds)
      ? [...new Set(body.adoptedAmendmentIds.map(String))]
      : [];
    const acceptedAmendments = amendmentIds.length
      ? await db
          .collection("amendments")
          .find({
            amendmentId: { $in: amendmentIds },
            proposalId,
            status: "accepted",
            baseRevisionId: revisionId,
            "formalApproval.baseRevisionId": revisionId,
          })
          .toArray()
      : [];
    if (acceptedAmendments.length !== amendmentIds.length)
      return Response.json(
        {
          error:
            "Every adopted amendment must be formally accepted against the exact ballot revision.",
        },
        { status: 409 },
      );
    const snapshot = { ...revision.snapshot } as {
      title: string;
      summary: string;
      outcomes: string[];
      details: string;
    };
    const adoptedRevisionIds: string[] = [];
    for (const amendment of acceptedAmendments) {
      const amendmentRevisionId = amendment.formalApproval?.amendmentRevisionId;
      if (
        !amendmentRevisionId ||
        amendmentRevisionId !== amendment.ballotAmendmentRevisionId ||
        amendmentRevisionId !== amendment.currentRevisionId
      )
        return Response.json(
          {
            error:
              "Formal approval must point to the exact amendment wording revision endorsed by its ballot.",
          },
          { status: 409 },
        );
      const amendmentRevision = await db
        .collection("amendment_revisions")
        .findOne({
          amendmentId: amendment.amendmentId,
          revisionId: amendmentRevisionId,
        });
      if (!amendmentRevision)
        return Response.json(
          { error: "Approved amendment wording revision not found." },
          { status: 409 },
        );
      adoptedRevisionIds.push(amendmentRevisionId);
      const changes = amendmentRevision.snapshot as Record<string, unknown>;
      if (typeof changes.title === "string") snapshot.title = changes.title;
      if (typeof changes.summary === "string")
        snapshot.summary = changes.summary;
      if (typeof changes.details === "string")
        snapshot.details = changes.details;
      if (Array.isArray(changes.outcomes))
        snapshot.outcomes = changes.outcomes.map(String);
    }
    const ratifiedRevisionId = acceptedAmendments.length
      ? randomUUID()
      : revisionId;
    if (acceptedAmendments.length)
      await db
        .collection("proposal_revisions")
        .insertOne({
          revisionId: ratifiedRevisionId,
          proposalId,
          parentRevisionId: revisionId,
          revisionType: "ratified-policy",
          adoptedAmendmentIds: amendmentIds,
          adoptedAmendmentRevisionIds: adoptedRevisionIds,
          authorId: user.memberId,
          createdAt: new Date(),
          snapshot,
          contentHash: createHash("sha256")
            .update(JSON.stringify(snapshot))
            .digest("hex"),
          provenance: revision.provenance,
        });
    const ratification = {
      authorityBranchId,
      decisionEventId,
      ballotRevisionId: revisionId,
      ratifiedRevisionId,
      adoptedAmendmentIds: amendmentIds,
      adoptedAmendmentRevisionIds: adoptedRevisionIds,
      ratifiedBy: user.memberId,
      ratifiedAt: new Date(),
    };
    const branchSlug =
      branchPublicSlug(authorityBranch) ??
      authorityBranchId.replace(/^branch-/, "").toLowerCase();
    const policySlug = await uniquePolicySlug(
      db,
      branchSlug,
      policySlugFromTitle(snapshot.title),
      proposalId,
    );
    const registry = {
      policyId: proposalId,
      proposalId,
      branchSlug,
      policySlug,
      title: snapshot.title,
      summary: snapshot.summary,
      category: proposal.space,
      commitments: snapshot.outcomes,
      approvedWording: snapshot.details,
      revisionId: ratifiedRevisionId,
      revisionIds: [...new Set([revisionId, ratifiedRevisionId])],
      status: "adopted",
      publicationStatus: "unpublished",
      recordOrigin: "engage-ratification",
      provenance: revision.provenance ?? null,
      ...(declaredChangeType && policyChangeTarget
        ? {
            changeType: declaredChangeType,
            supersedes: [declaredTargetPolicyId],
            supersedesRevisionId: proposal.targetPolicyRevisionId ?? null,
          }
        : {}),
      jurisdiction:
        typeof body.jurisdiction === "string" && body.jurisdiction
          ? body.jurisdiction
          : (policyChangeTarget?.jurisdiction ?? null),
      jurisdictionBranchId,
      governanceAuthorityBranchId: authorityBranchId,
      ratification,
      effectiveAt:
        typeof body.effectiveAt === "string"
          ? new Date(body.effectiveAt)
          : null,
      idempotencyKey: key,
    };
    await db
      .collection("policy_registry")
      .updateOne(
        { policyId: proposalId },
        { $setOnInsert: registry },
        { upsert: true },
      );
    const existing = await db
      .collection("policy_registry")
      .findOne({ policyId: proposalId });
    if (
      existing?.revisionId !== ratifiedRevisionId ||
      existing?.ratification?.decisionEventId !== decisionEventId
    )
      return Response.json(
        { error: "A different revision is already ratified for this policy." },
        { status: 409 },
      );
    // An amended or replaced policy supersedes its predecessor only when the
    // successor is published. Until then the current published wording remains
    // the operative policy, so the registry never shows a gap.
    return privateJson({ policy: toRatifiedPolicyDto(existing) }, { status: 201 });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Ratification failed.",
      },
      { status: 400 },
    );
  }
};
