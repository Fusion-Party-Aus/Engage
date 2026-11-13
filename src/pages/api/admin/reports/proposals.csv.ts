import type { APIRoute } from "astro";
import { getSessionUser } from "../../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import { branchesWithPermission } from "../../../../lib/rbac.ts";
import { listProposals } from "../../../../lib/store.ts";
import {
  canIncludeProposalInAdminReport,
  proposalsSummaryToCsv,
} from "../../../../lib/admin-reporting.ts";

export const prerender = false;

export const GET: APIRoute = async ({ request, url, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user) {
    return Response.json({ error: "Sign in required." }, { status: 401 });
  }
  const exportScope = branchesWithPermission(user, "reports.export");
  if (!exportScope.national && exportScope.branchIds.length === 0) {
    return Response.json(
      { error: "Administrator access required." },
      { status: 403 },
    );
  }

  const db = await getDatabase(env);
  const stage = (url.searchParams.get("stage") ?? "all").trim();
  const branchFilter = (url.searchParams.get("branch") ?? "all").trim();
  const search = (url.searchParams.get("q") ?? "").trim();

  const [allProposals, branches, ballotResults] = await Promise.all([
    listProposals(db, { includeArchived: true, stage, search, user }),
    db.collection("branches").find({}).toArray(),
    db.collection("ballot_results").find({}).project({ proposalId: 1 }).toArray(),
  ]);

  const scoped = allProposals.filter((proposal) => {
    if (!canIncludeProposalInAdminReport(user, proposal)) return false;
    if (!branchFilter || branchFilter === "all") return true;
    return [
      proposal.originatingBranchId,
      proposal.governanceAuthorityBranchId,
      proposal.jurisdictionBranchId,
    ].includes(branchFilter);
  });

  const branchNames = new Map(
    branches.map((branch: any) => [String(branch.branchId), String(branch.name)]),
  );
  const recordedResultIds = new Set(
    ballotResults.map((row: any) => String(row.proposalId)),
  );
  const csv = proposalsSummaryToCsv(scoped, branchNames, recordedResultIds);

  return new Response(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition":
        'attachment; filename="engage-proposals-summary.csv"',
      "cache-control": "private, no-store",
    },
  });
};
