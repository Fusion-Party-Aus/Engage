import type { APIRoute } from "astro";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import { publicPolicy } from "../../../../lib/public-policy.ts";
import { publicJson } from "../../../../lib/public-api.ts";
import { isPolicyRegistryRecordForResolution } from "../../../../lib/store.ts";
export const prerender = false;
export const GET: APIRoute = async ({ params, locals, request }) => {
  const env = runtimeEnv(locals);
  const db = await getDatabase(env);
  const row = await db
    .collection("policy_registry")
    .findOne({ policyId: params.id, publicationStatus: "published" });
  if (!row)
    return Response.json({ error: "Policy not found." }, { status: 404 });
  const linkedProposal = await db
    .collection("proposals")
    .findOne({ proposalId: String(row.proposalId ?? row.policyId) });
  if (
    isPolicyRegistryRecordForResolution(
      row as { policyId?: string; proposalId?: string; kind?: string },
      linkedProposal as { kind?: string; proposalId?: string } | null,
    )
  )
    return Response.json({ error: "Policy not found." }, { status: 404 });
  const data = publicPolicy(row);
  return publicJson(
    request,
    { data },
    {
      canonical: `/api/v1/policies/${encodeURIComponent(data.policyId)}`,
      env,
    },
  );
};
