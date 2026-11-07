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
  const rows = await db
    .collection("branches")
    .find({ recognised: true })
    .sort({ branchId: 1 })
    .toArray();
  const remaining = rows.filter(
    (branch) => !cursor || String(branch.branchId) > cursor,
  );
  const hasMore = remaining.length > limit;
  const page = remaining.slice(0, limit);
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
