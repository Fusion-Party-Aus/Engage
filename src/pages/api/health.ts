import type { APIRoute } from "astro";
import { getDatabase, runtimeEnv } from "../../lib/db.ts";

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  try {
    const db = await getDatabase(runtimeEnv(locals));
    await db.command({ ping: 1 });
    return Response.json(
      { ok: true, status: "healthy" },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json(
      { ok: false, status: "unhealthy" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
};
