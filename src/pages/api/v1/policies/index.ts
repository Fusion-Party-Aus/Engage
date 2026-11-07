import type { APIRoute } from "astro";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import { publicPolicy } from "../../../../lib/public-policy.ts";
import { publicJson } from "../../../../lib/public-api.ts";
export const prerender = false;
export const GET: APIRoute = async ({ locals, url, request }) => {
  const db = await getDatabase(runtimeEnv(locals));
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
  const rows = await db
    .collection("policy_registry")
    .find(filter)
    .sort({ policyId: 1 })
    .limit(limit + 1)
    .toArray();
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const data = page.map(publicPolicy);
  return publicJson(request, {
    data,
    meta: {
      limit,
      nextCursor: hasMore ? String(page.at(-1)?.policyId ?? "") : null,
    },
  });
};
