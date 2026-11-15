import type { APIRoute } from "astro";
import { getDatabase, runtimeEnv } from "../../../../../../lib/db.ts";
import { publicJson } from "../../../../../../lib/public-api.ts";
import { toPublicRevisionDto } from "../../../../../../lib/api-contracts.ts";
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
  // Engage-ratified policy revisions live with the proposal; imported and
  // change revisions live in policy_revisions. Both are part of one history.
  const [proposalRows, policyRows] = await Promise.all([
    db
      .collection("proposal_revisions")
      .find({ revisionId: { $in: p.revisionIds ?? [] } })
      .toArray(),
    db
      .collection("policy_revisions")
      .find({ revisionId: { $in: p.revisionIds ?? [] } })
      .toArray(),
  ]);
  const allRows = [...proposalRows, ...policyRows].sort((a, b) =>
    String(a.revisionId) < String(b.revisionId) ? -1 : 1,
  );
  const rows = allRows.filter(
    (row) => !cursor || String(row.revisionId) > cursor,
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return publicJson(
    request,
    {
      data: page.map(toPublicRevisionDto),
      meta: {
        limit,
        nextCursor: hasMore ? String(page.at(-1)?.revisionId ?? "") : null,
      },
    },
    { env },
  );
};
