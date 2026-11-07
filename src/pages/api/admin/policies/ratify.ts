import type { APIRoute } from "astro";
import { createHash, randomUUID } from "node:crypto";
import { getSessionUser } from "../../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";

export const prerender = false;
export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user?.isAdmin)
    return Response.json(
      { error: "Administrator access required." },
      { status: user ? 403 : 401 },
    );
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
    if (
      !(await db
        .collection("branches")
        .findOne({ branchId: authorityBranchId, recognised: true }))
    )
      return Response.json(
        { error: "Ratifying authority must be a recognised branch." },
        { status: 400 },
      );
    const jurisdictionBranchId =
      typeof body.jurisdictionBranchId === "string"
        ? body.jurisdictionBranchId
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
        return Response.json({ policy: priorPolicy }, { status: 200 });
      return Response.json(
        { error: "A different revision is already ratified for this policy." },
        { status: 409 },
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
    const registry = {
      policyId: proposalId,
      proposalId,
      title: snapshot.title,
      summary: snapshot.summary,
      category: proposal.space,
      commitments: snapshot.outcomes,
      approvedWording: snapshot.details,
      revisionId: ratifiedRevisionId,
      revisionIds: [...new Set([revisionId, ratifiedRevisionId])],
      status: "adopted",
      publicationStatus: "unpublished",
      provenance: revision.provenance ?? null,
      jurisdiction:
        typeof body.jurisdiction === "string" ? body.jurisdiction : null,
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
    return Response.json({ policy: existing }, { status: 201 });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Ratification failed.",
      },
      { status: 400 },
    );
  }
};
