import type { APIRoute } from "astro";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import { publicJson } from "../../../../lib/public-api.ts";
export const prerender = false;
export const GET: APIRoute = async ({ locals, request, url }) => {
  const env = runtimeEnv(locals);
  const db = await getDatabase(env);
  const limit = Math.min(
    100,
    Math.max(1, Number(url.searchParams.get("limit")) || 50),
  );
  const cursor = url.searchParams.get("cursor");
  const filter: Record<string, unknown> = { recognised: true };
  if (cursor) filter.branchId = { $gt: cursor };
  const rows = await db
    .collection("branches")
    .find(filter)
    .project({ _id: 0, branchId: 1, name: 1, kind: 1, parentBranchId: 1 })
    .sort({ branchId: 1 })
    .limit(limit + 1)
    .toArray();
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const data = page.map((branch) => ({
    branchId: branch.branchId,
    name: branch.name,
    kind: branch.kind,
    ...(branch.parentBranchId ? { parentBranchId: branch.parentBranchId } : {}),
    recognised: true,
  }));
  return publicJson(
    request,
    {
      data,
      meta: {
        limit,
        nextCursor: hasMore ? String(page.at(-1)?.branchId ?? "") : null,
      },
    },
    { env },
  );
};
