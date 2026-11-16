import type { APIRoute } from "astro";
import { getSessionUser } from "../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../lib/db.ts";
import { hasPermission } from "../../../lib/rbac.ts";
import { resolvePublicOrigin } from "../../../lib/public-origin.ts";
import {
  getOperationalSettingsState,
  listOperationalSettingsEvents,
  saveOperationalSettings,
} from "../../../lib/operational-settings.ts";

export const prerender = false;

const noStore = { "cache-control": "private, no-store" };
const READ_FAILED =
  "Couldn't read that request. Refresh the page and try again.";

function sameOrigin(request: Request, env: ReturnType<typeof runtimeEnv>): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  return origin === resolvePublicOrigin({ env, requestUrl: request.url });
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

  try {
    const db = await getDatabase(env);
    const result = await saveOperationalSettings(
      db,
      { memberId: user.memberId, name: user.name || user.email },
      body as Record<string, unknown>,
    );
    if (!result.ok) {
      return Response.json(
        {
          error: "Some fields need attention.",
          fieldErrors: result.fieldErrors,
        },
        { status: 422, headers: noStore },
      );
    }

    const [state, events] = await Promise.all([
      getOperationalSettingsState(db),
      listOperationalSettingsEvents(db),
    ]);
    return Response.json(
      {
        values: state.values,
        source: state.source,
        updatedAt: state.updatedAt ?? null,
        updatedByName: state.updatedByName ?? null,
        changedFields: result.changedFields,
        events,
      },
      { headers: noStore },
    );
  } catch {
    return Response.json(
      { error: "Couldn't save thresholds. Try again." },
      { status: 503, headers: noStore },
    );
  }
};
