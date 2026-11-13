import type { APIRoute } from "astro";
import { getSessionUser } from "../../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import { listProposals } from "../../../../lib/store.ts";
import { proposalsSummaryToCsv } from "../../../../lib/admin-reporting.ts";

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

  const db = await getDatabase(env);
  const stage = (url.searchParams.get("stage") ?? "all").trim();
  const branchFilter = (url.searchParams.get("branch") ?? "all").trim();
  const search = (url.searchParams.get("q") ?? "").trim();
  const branchAdminIds = user.branchAdminIds ?? [];

  const [allProposals, branches] = await Promise.all([
    listProposals(db, { includeArchived: true, stage, search }),
    db.collection("branches").find({}).toArray(),
  ]);

  const scoped = allProposals.filter((proposal) => {
    const inAdminScope =
      user.isStaff ||
      [
        proposal.originatingBranchId,
        proposal.governanceAuthorityBranchId,
        proposal.jurisdictionBranchId,
      ].some((id) => Boolean(id && branchAdminIds.includes(id)));
    if (!inAdminScope) return false;
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
  const csv = proposalsSummaryToCsv(scoped, branchNames);

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
