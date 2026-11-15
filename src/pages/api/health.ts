import type { APIRoute } from "astro";
import { getDatabase, runtimeEnv } from "../../lib/db.ts";
import {
  evaluateOperationalHealth,
  type OperationalHealthReport,
  type OperationalHealthStatus,
} from "../../lib/operational-health.ts";

export const prerender = false;

const SEVERITY: Record<OperationalHealthStatus, number> = {
  ok: 0,
  unknown: 1,
  degraded: 2,
  failing: 3,
};

function worstStatus(statuses: OperationalHealthStatus[]): OperationalHealthStatus {
  return statuses.reduce<OperationalHealthStatus>(
    (worst, status) => (SEVERITY[status] > SEVERITY[worst] ? status : worst),
    "ok",
  );
}

/**
 * Coarse container probe.
 *
 * Three rules matter more than detail here:
 *
 * 1. A database failure is 503. The process cannot serve without MongoDB, so a
 *    restart or rollback is the right response.
 * 2. A degraded or failing *job* is 200. Restarting the container cannot make a
 *    missing external scheduler run, so returning 503 would start a restart loop
 *    that hides the real problem. `npm run ops:health` is the detailed,
 *    exit-coded command for operators and alerting.
 * 3. Checks are status strings only. `/api/health` is unauthenticated, so it
 *    must not become a source of counts, identifiers or configuration detail.
 *
 * `governanceScheduler` covers scheduled advancement/closure and the evidence
 * that ballot deadlines were actually closed. `jobs` covers the digest,
 * membership verification and email delivery. Turnstile is checked by
 * `ops:health` but not published here; its misconfiguration already fails
 * protected actions closed.
 */
export const GET: APIRoute = async ({ locals }) => {
  const started = Date.now();
  const env = runtimeEnv(locals);
  try {
    const db = await getDatabase(env);
    await db.command({ ping: 1 });

    let governanceScheduler: OperationalHealthStatus = "unknown";
    let jobs: OperationalHealthStatus = "unknown";
    try {
      const report: OperationalHealthReport = await evaluateOperationalHealth({
        db,
        env,
      });
      const statusOf = (id: string): OperationalHealthStatus =>
        report.checks.find((check) => check.id === id)?.status ?? "unknown";
      governanceScheduler = worstStatus([
        statusOf("governance-scheduler"),
        statusOf("ballot-deadlines"),
      ]);
      jobs = worstStatus([
        statusOf("digest"),
        statusOf("membership-verification"),
        statusOf("email-delivery"),
      ]);
    } catch {
      // The database responded but health evidence could not be read. Serving
      // continues; report the gap rather than failing the probe.
    }

    const status =
      governanceScheduler === "ok" && jobs === "ok" ? "healthy" : "degraded";
    return Response.json(
      {
        ok: true,
        status,
        checks: { database: "ok", governanceScheduler, jobs },
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
