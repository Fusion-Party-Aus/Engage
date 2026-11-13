import type { APIRoute } from "astro";
import {
  dbCommandMonitoringEnabled,
  resetDbCommandMetrics,
  runtimeEnv,
  snapshotDbCommandMetrics,
} from "../../../lib/db.ts";

export const prerender = false;

/**
 * Development-only diagnostics for scripts/rendering-performance.mjs.
 *
 * Disabled unless ENGAGE_DB_COMMAND_MONITOR=1 and APP_MODE is not production.
 * POST resets the process-wide counters; GET returns a snapshot. It exposes no
 * database content, only command names and timings, and is never enabled in a
 * production runtime.
 */
export const GET: APIRoute = async ({ locals }) => {
  const env = runtimeEnv(locals);
  if (!dbCommandMonitoringEnabled(env)) {
    return new Response("Not found", { status: 404 });
  }
  return Response.json(snapshotDbCommandMetrics(env), {
    headers: { "cache-control": "no-store" },
  });
};

export const POST: APIRoute = async ({ locals }) => {
  const env = runtimeEnv(locals);
  if (!dbCommandMonitoringEnabled(env)) {
    return new Response("Not found", { status: 404 });
  }
  resetDbCommandMetrics();
  return Response.json({ reset: true }, {
    headers: { "cache-control": "no-store" },
  });
};
