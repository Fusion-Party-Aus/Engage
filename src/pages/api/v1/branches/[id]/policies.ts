import type { APIRoute } from "astro";
import { getDatabase, runtimeEnv } from "../../../../../lib/db.ts";
import { publicPolicy } from "../../../../../lib/public-policy.ts";
import { publicJson } from "../../../../../lib/public-api.ts";
export const prerender = false;
export const GET: APIRoute = async ({ params, locals, url, request }) => {
  const env = runtimeEnv(locals);
  const db = await getDatabase(env);
  const limit = Math.min(
    100,
    Math.max(1, Number(url.searchParams.get("limit")) || 50),
  );
  const cursor = url.searchParams.get("cursor");
  const q: Record<string, unknown> = {
    publicationStatus: "published",
    jurisdictionBranchId: params.id,
  };
  if (cursor) q.policyId = { $gt: cursor };
  const rows = await db
    .collection("policy_registry")
    .find(q)
    .sort({ policyId: 1 })
    .limit(limit + 1)
    .toArray();
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  return publicJson(
    request,
    {
      data: page.map(publicPolicy),
      meta: {
        limit,
        nextCursor: more ? String(page.at(-1)?.policyId ?? "") : null,
      },
    },
    { env },
  );
};
