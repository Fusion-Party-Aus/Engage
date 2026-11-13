import type { APIRoute } from "astro";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import { publicPolicy } from "../../../../lib/public-policy.ts";
import { publicJson } from "../../../../lib/public-api.ts";
import { isPolicyRegistryRecordForResolution } from "../../../../lib/store.ts";
export const prerender = false;
export const GET: APIRoute = async ({ locals, url, request }) => {
  const env = runtimeEnv(locals);
  const db = await getDatabase(env);
  const filter: Record<string, unknown> = { publicationStatus: "published" };
  const branch = url.searchParams.get("branch");
  const jurisdiction = url.searchParams.get("jurisdiction");
  if (branch) filter.jurisdictionBranchId = branch;
  if (jurisdiction) filter.jurisdiction = jurisdiction;
  const limit = Math.min(
    100,
    Math.max(1, Number(url.searchParams.get("limit")) || 50),
  );
  const cursor = url.searchParams.get("cursor");
  if (cursor) filter.policyId = { $gt: cursor };
  const [rawRows, proposalKinds] = await Promise.all([
    db
      .collection("policy_registry")
      .find(filter)
      .sort({ policyId: 1 })
      .limit(limit + 25)
      .toArray(),
    db
      .collection("proposals")
      .find({}, { projection: { proposalId: 1, kind: 1 } })
      .toArray(),
  ]);
  const proposalKindMap = new Map(
    proposalKinds.map((p: any) => [
      String(p.proposalId),
      {
        proposalId: String(p.proposalId),
        kind: p.kind ? String(p.kind) : undefined,
      },
    ]),
  );
  const rows = rawRows.filter(
    (row: any) =>
      !isPolicyRegistryRecordForResolution(
        row,
        proposalKindMap.get(String(row.proposalId ?? row.policyId ?? "")),
      ),
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const data = page.map(publicPolicy);
  return publicJson(
    request,
    {
      data,
      meta: {
        limit,
        nextCursor: hasMore ? String(page.at(-1)?.policyId ?? "") : null,
      },
    },
    { env },
  );
};
