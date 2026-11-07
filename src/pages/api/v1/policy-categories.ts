import type { APIRoute } from "astro";
import { getDatabase, runtimeEnv } from "../../../lib/db.ts";
import { publicJson } from "../../../lib/public-api.ts";
export const prerender = false;
export const GET: APIRoute = async ({ locals, request }) => {
  const env = runtimeEnv(locals);
  const db = await getDatabase(env);
  const rows = await db
    .collection("policy_registry")
    .find({ publicationStatus: "published" })
    .toArray();
  const data = [
    ...new Set(
      rows
        .map((row) => row.category)
        .filter(
          (value): value is string =>
            typeof value === "string" && value.length > 0,
        ),
    ),
  ].sort();
  return publicJson(request, { data }, { maxAge: 300, env });
};
