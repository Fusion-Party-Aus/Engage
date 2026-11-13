import type { APIRoute } from "astro";
import { getSessionUser } from "../../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import { getProposalDetail, isGovernanceResolution } from "../../../../lib/store.ts";
import { buildProposalPdfReport } from "../../../../lib/proposal-pdf.ts";

export const prerender = false;

export const GET: APIRoute = async ({ request, url, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user) {
    return Response.json({ error: "Sign in required." }, { status: 401 });
  }
  if (!user.isStaff && !user.isBranchAdmin) {
    return Response.json(
      { error: "Administrator access required." },
      { status: 403 },
    );
  }

  const identifier =
    (url.searchParams.get("proposalId") ?? url.searchParams.get("slug") ?? "").trim();
  if (!identifier) {
    return Response.json(
      { error: "Provide proposalId or slug." },
      { status: 400 },
    );
  }

  const db = await getDatabase(env);
  const detail = await getProposalDetail(db, identifier, user);
  if (!detail) {
    return Response.json({ error: "Proposal not found." }, { status: 404 });
  }

  const { proposal, comments } = detail;
  if (!user.isStaff && !user.isAdmin) {
    const allowed = Boolean(
      proposal.originatingBranchId &&
        (user.branchAdminIds ?? []).includes(proposal.originatingBranchId),
    );
    if (!allowed) {
      return Response.json(
        { error: "Proposal is outside your branch administration scope." },
        { status: 403 },
      );
    }
  }

  const [branches, ballotResult, rawPolicyRecord, ballotBindEvent] = await Promise.all([
    db.collection("branches").find({}).toArray(),
    db.collection("ballot_results").findOne({ proposalId: proposal.proposalId }),
    db.collection("policy_registry").findOne({ proposalId: proposal.proposalId }),
    db
      .collection("ballot_binding_events")
      .findOne({ proposalId: proposal.proposalId }, { sort: { createdAt: 1 } }),
  ]);
  const policyRecord = isGovernanceResolution(proposal) ? null : rawPolicyRecord;

  const branchNameFor = (branchId?: string) =>
    branchId
      ? String(
          branches.find((b: any) => String(b.branchId) === branchId)?.name ??
            branchId,
        )
      : "Party-wide";

  const pdfBytes = buildProposalPdfReport({
    proposal,
    comments,
    jurisdictionName: branchNameFor(proposal.jurisdictionBranchId),
    originatingBranchName: branchNameFor(proposal.originatingBranchId),
    authorityBranchName: branchNameFor(proposal.governanceAuthorityBranchId),
    ballotOpenedAt: ballotBindEvent?.createdAt
      ? new Date(String(ballotBindEvent.createdAt))
      : undefined,
    ballotResult: ballotResult
      ? {
          result: String(ballotResult.result),
          decisionEventId: ballotResult.decisionEventId
            ? String(ballotResult.decisionEventId)
            : undefined,
          recordedAt: ballotResult.recordedAt
            ? new Date(String(ballotResult.recordedAt))
            : undefined,
        }
      : null,
    policyRecord: policyRecord
      ? {
          policyId: String(policyRecord.policyId),
          status: policyRecord.status ? String(policyRecord.status) : undefined,
          publicationStatus: policyRecord.publicationStatus
            ? String(policyRecord.publicationStatus)
            : undefined,
          ratification: policyRecord.ratification
            ? {
                ratifiedAt: policyRecord.ratification.ratifiedAt
                  ? new Date(String(policyRecord.ratification.ratifiedAt))
                  : undefined,
                decisionEventId: policyRecord.ratification.decisionEventId
                  ? String(policyRecord.ratification.decisionEventId)
                  : undefined,
              }
            : undefined,
          publishedAt: policyRecord.publishedAt
            ? new Date(String(policyRecord.publishedAt))
            : undefined,
        }
      : null,
  });

  const safeFilename = `${proposal.proposalId.replace(/[^A-Za-z0-9_-]/g, "_")}-report.pdf`;
  return new Response(Buffer.from(pdfBytes), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${safeFilename}"`,
      "cache-control": "private, no-store",
    },
  });
};
