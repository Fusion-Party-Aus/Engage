import type { APIRoute } from "astro";
import { getDatabase, runtimeEnv } from "../../lib/db.ts";

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  const started = Date.now();
  try {
    const db = await getDatabase(runtimeEnv(locals));
    await db.command({ ping: 1 });
    return Response.json(
      {
        ok: true,
        status: "healthy",
        checks: { database: "ok" },
        latencyMs: Date.now() - started,
        timestamp: new Date().toISOString(),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json(
      {
        ok: false,
        status: "unhealthy",
        checks: { database: "error" },
        timestamp: new Date().toISOString(),
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
};
