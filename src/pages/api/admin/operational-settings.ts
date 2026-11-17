import type { APIRoute } from "astro";
import { getSessionUser } from "../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../lib/db.ts";
import { hasPermission } from "../../../lib/rbac.ts";
import { resolvePublicOrigin } from "../../../lib/public-origin.ts";
import {
  getCrmSettingsState,
  getJobsSettingsState,
  getOperationalSettingsState,
  listOperationalSettingsEvents,
  saveCrmSettings,
  saveJobsSettings,
  saveOperationalSettings,
  type OperationalSettingsSection,
} from "../../../lib/operational-settings.ts";

export const prerender = false;

const noStore = { "cache-control": "private, no-store" };
const READ_FAILED =
  "Couldn't read that request. Refresh the page and try again.";
const SECTIONS: OperationalSettingsSection[] = ["thresholds", "crm", "jobs"];

const SAVE_FAILED: Record<OperationalSettingsSection, string> = {
  thresholds: "Couldn't save thresholds. Try again.",
  crm: "Couldn't save CRM verification settings. Try again.",
  jobs: "Couldn't save scheduled job settings. Try again.",
};

function sameOrigin(request: Request, env: ReturnType<typeof runtimeEnv>): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  return origin === resolvePublicOrigin({ env, requestUrl: request.url });
}

function sectionFrom(body: Record<string, unknown>): OperationalSettingsSection | null {
  // Existing clients posted the threshold values without a section.
  if (body.section === undefined) return "thresholds";
  const section = String(body.section);
  return (SECTIONS as string[]).includes(section)
    ? (section as OperationalSettingsSection)
    : null;
}

export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user) {
    return Response.json(
      { error: "Sign in required." },
      { status: 401, headers: noStore },
    );
  }
  if (!hasPermission(user, "settings.manage")) {
    return Response.json(
      { error: "Administrator access required." },
      { status: 403, headers: noStore },
    );
  }
  if (!sameOrigin(request, env)) {
    return Response.json(
      { error: "Cross-site requests are not allowed." },
      { status: 403, headers: noStore },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: READ_FAILED }, { status: 400, headers: noStore });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: READ_FAILED }, { status: 400, headers: noStore });
  }

  const record = body as Record<string, unknown>;
  const section = sectionFrom(record);
  if (!section) {
    return Response.json(
      { error: "Unknown settings section." },
      { status: 400, headers: noStore },
    );
  }

  const actor = { memberId: user.memberId, name: user.name || user.email };

  try {
    const db = await getDatabase(env);

    let fieldErrors: Record<string, string> | null = null;
    let changedFields: string[] = [];
    let values: Record<string, unknown> = {};

    if (section === "crm") {
      const result = await saveCrmSettings(db, actor, record);
      if (!result.ok) fieldErrors = result.fieldErrors;
      else {
        values = { ...result.values };
        changedFields = result.changedFields;
      }
    } else if (section === "jobs") {
      const result = await saveJobsSettings(db, actor, record);
      if (!result.ok) fieldErrors = result.fieldErrors;
      else {
        values = { ...result.values };
        changedFields = result.changedFields;
      }
    } else {
      const result = await saveOperationalSettings(db, actor, record);
      if (!result.ok) fieldErrors = result.fieldErrors;
      else {
        values = result.values;
        changedFields = result.changedFields;
      }
    }

    if (fieldErrors) {
      return Response.json(
        { error: "Some fields need attention.", fieldErrors },
        { status: 422, headers: noStore },
      );
    }

    const [thresholdState, crmState, jobsState, events] = await Promise.all([
      section === "thresholds" ? getOperationalSettingsState(db) : null,
      section === "crm" ? getCrmSettingsState(db) : null,
      section === "jobs" ? getJobsSettingsState(db) : null,
      listOperationalSettingsEvents(db, 20, section),
    ]);
    const state = thresholdState ?? crmState ?? jobsState;

    return Response.json(
      {
        section,
        values,
        source: state?.source ?? "settings",
        updatedAt: state?.updatedAt ?? null,
        updatedByName: state?.updatedByName ?? null,
        changedFields,
        events,
      },
      { headers: noStore },
    );
  } catch {
    return Response.json(
      { error: SAVE_FAILED[section] },
      { status: 503, headers: noStore },
    );
  }
};
