import type { APIRoute } from "astro";
import { getDatabase, runtimeEnv } from "../../../lib/db.ts";
import { safeEqual } from "../../../lib/engagement-email.ts";
import { withJobRun } from "../../../lib/job-runs.ts";
import { getCrmSettingsState } from "../../../lib/operational-settings.ts";
import { CrmConfigurationError } from "../../../lib/underground-crm.ts";
import { runVerificationCycle } from "../../../lib/membership-verification.ts";
import type { PlatformEnv } from "../../../lib/types.ts";

export const prerender = false;

const noStore = { "cache-control": "no-store" };

/**
 * Scheduled automatic membership verification and reconciliation.
 *
 * The job is off until an administrator turns it on under Platform settings.
 * The gate and tuning are read from the database, never from the deployment
 * environment. A CRM outage is handled inside the cycle as a retryable
 * operational failure; it is never treated as a verification failure and never
 * revokes a membership.
 *
 * Authorised runs are recorded in the job-run ledger, successful or not. An
 * unauthenticated call (401) and a disabled feature (409) are not scheduled
 * runs and are not recorded.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals) as PlatformEnv &
    Record<string, string | undefined>;
  const secret = String(env.ENGAGE_CRM_VERIFICATION_CRON_SECRET ?? "");
  if (
    !secret ||
    !safeEqual(request.headers.get("authorization") ?? "", `Bearer ${secret}`)
  ) {
    return Response.json({ error: "Unauthorised" }, { status: 401 });
  }

  try {
    const db = await getDatabase(env);
    const settings = await getCrmSettingsState(db);
    if (settings.readFailed) {
      return Response.json(
        {
          error:
            "Saved CRM verification settings could not be read. Try again.",
        },
        { status: 503, headers: noStore },
      );
    }
    if (settings.invalidFields.length > 0) {
      return Response.json(
        {
          error:
            "Saved CRM verification settings are invalid. Open Platform settings and correct them.",
        },
        { status: 503, headers: noStore },
      );
    }
    if (!settings.values.crmVerificationEnabled) {
      return Response.json(
        {
          error: "Automatic CRM membership verification is not enabled.",
        },
        { status: 409, headers: noStore },
      );
    }

    const report = await withJobRun(
      db,
      "membership-verification",
      () =>
        runVerificationCycle(db, env, {
          crmSettings: settings.values,
        }),
      {
        mode: "apply",
        summarise: (cycle) => ({
          processed: cycle.processed,
          verified: cycle.verified,
          reviews: cycle.reviews,
          retried: cycle.retried,
          blocked: cycle.blocked,
          reconciled: cycle.reconciled,
        }),
      },
    );
    return Response.json(report, { headers: noStore });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof CrmConfigurationError
            ? error.message
            : "Membership verification could not run; existing statuses are unchanged.",
      },
      { status: 503, headers: noStore },
    );
  }
};
