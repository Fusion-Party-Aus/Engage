import type { APIRoute } from "astro";
import { getDatabase, runtimeEnv } from "../../../../../../lib/db.ts";
import { publicJson } from "../../../../../../lib/public-api.ts";
export const prerender = false;
export const GET: APIRoute = async ({ params, locals, request, url }) => {
  const env = runtimeEnv(locals);
  const db = await getDatabase(env);
  const p = await db
    .collection("policy_registry")
    .findOne({ policyId: params.id, publicationStatus: "published" });
  if (!p) return Response.json({ error: "Policy not found." }, { status: 404 });
  const limit = Math.min(
    100,
    Math.max(1, Number(url.searchParams.get("limit")) || 50),
  );
  const cursor = url.searchParams.get("cursor");
  const allRows: any[] = await db
    .collection("proposal_revisions")
    .find({ revisionId: { $in: p.revisionIds ?? [] } })
    .sort({ revisionId: 1 })
    .toArray();
  const rows = allRows.filter(
    (row) => !cursor || String(row.revisionId) > cursor,
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return publicJson(
    request,
    {
      data: page.map(({ _id, authorId, ...r }) => r),
      meta: {
        limit,
        nextCursor: hasMore ? String(page.at(-1)?.revisionId ?? "") : null,
      },
    },
    { env },
  );
};
