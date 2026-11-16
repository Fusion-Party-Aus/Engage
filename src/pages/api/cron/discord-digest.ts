import type { APIRoute } from "astro";
import { getDatabase, runtimeEnv } from "../../../lib/db.ts";
import { safeEqual } from "../../../lib/engagement-email.ts";
import { runWeeklyDiscordDigest } from "../../../lib/discord-digest.ts";
import { withJobRun } from "../../../lib/job-runs.ts";

export const prerender = false;

/** External weekly scheduler only. Never run from a browser GET. */
export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  if (
    !env.ENGAGE_CRON_SECRET ||
    !safeEqual(request.headers.get("authorization") ?? "", `Bearer ${env.ENGAGE_CRON_SECRET}`)
  ) {
    return Response.json({ error: "Unauthorised" }, { status: 401 });
  }
  try {
    const db = await getDatabase(env);
    const result = await withJobRun(
      db,
      "discord-digest",
      () => runWeeklyDiscordDigest(db, env),
      {
        mode: "apply",
        summarise: (r) => ({
          status: r.status,
          featured: r.featured,
        }),
        ok: (r) => r.status !== "held",
      },
    );
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json(
      { error: "Discord digest failed. Inspect the delivery record before retrying." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
};
