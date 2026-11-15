import type { APIRoute } from "astro";
import { getDatabase, runtimeEnv } from "../../../lib/db.ts";
import { runBallotDigests, safeEqual } from "../../../lib/engagement-email.ts";
import { withJobRun } from "../../../lib/job-runs.ts";

export const prerender = false;

/**
 * Scheduled ballot digest.
 *
 * Authorised runs are recorded in the job-run ledger, successful or not. The
 * response contract is unchanged: an unauthenticated call is 401 and a failed
 * run is 503 with a fixed message, whatever the provider said.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  if (
    !env.ENGAGE_CRON_SECRET ||
    !safeEqual(
      request.headers.get("authorization") || "",
      `Bearer ${env.ENGAGE_CRON_SECRET}`,
    )
  ) {
    return Response.json({ error: "Unauthorised" }, { status: 401 });
  }
  try {
    const db = await getDatabase(env);
    const result = await withJobRun(
      db,
      "ballot-digest",
      () => runBallotDigests(db, env),
      {
        mode: "apply",
        summarise: (digest) => {
          const summary = digest as {
            disabled?: boolean;
            sent?: number;
            held?: number;
          };
          return {
            disabled: summary.disabled === true,
            sent: Number(summary.sent ?? 0),
            held: Number(summary.held ?? 0),
          };
        },
      },
    );
    return Response.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      {
        error:
          "Digest job failed; inspect delivery holds before retrying.",
      },
      { status: 503 },
    );
  }
};
