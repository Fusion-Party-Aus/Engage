import type { APIRoute } from "astro";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import { publicPolicy } from "../../../../lib/public-policy.ts";
import { publicJson } from "../../../../lib/public-api.ts";
export const prerender = false;
export const GET: APIRoute = async ({ params, locals, request }) => {
  const db = await getDatabase(runtimeEnv(locals));
  const row = await db
    .collection("policy_registry")
    .findOne({ policyId: params.id, publicationStatus: "published" });
  if (!row)
    return Response.json({ error: "Policy not found." }, { status: 404 });
  const data = publicPolicy(row);
  return publicJson(
    request,
    { data },
    {
      canonical: new URL(
        `/api/v1/policies/${encodeURIComponent(data.policyId)}`,
        request.url,
      ).href,
    },
  );
};
