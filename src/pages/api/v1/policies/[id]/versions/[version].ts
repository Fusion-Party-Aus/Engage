import type { APIRoute } from "astro";
import { getDatabase, runtimeEnv } from "../../../../../../lib/db.ts";
import { publicJson } from "../../../../../../lib/public-api.ts";
export const prerender = false;
export const GET: APIRoute = async ({ params, locals, request }) => {
  const env = runtimeEnv(locals);
  const db = await getDatabase(env);
  const p = await db
    .collection("policy_registry")
    .findOne({ policyId: params.id, publicationStatus: "published" });
  if (!p) return Response.json({ error: "Policy not found." }, { status: 404 });
  const r = await db
    .collection("proposal_revisions")
    .findOne({ revisionId: params.version, proposalId: p.proposalId });
  if (!r)
    return Response.json({ error: "Version not found." }, { status: 404 });
  const { _id, authorId, ...data } = r;
  return publicJson(
    request,
    { data },
    {
      immutable: true,
      canonical: `/api/v1/policies/${encodeURIComponent(params.id!)}/versions/${encodeURIComponent(params.version!)}`,
      env,
    },
  );
};
