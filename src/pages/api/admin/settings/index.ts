import type { APIRoute } from "astro";
import { getSessionUser } from "../../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import { hasPermission } from "../../../../lib/rbac.ts";
import {
  getSiteConfig,
  listSiteConfigEvents,
  updateSiteConfig,
  validateSiteConfigInput,
} from "../../../../lib/site-config.ts";

export const prerender = false;

/** Infrastructure descriptions are not editable: they must match the deployment. */
const READ_ONLY_KEYS = ["backupSummary", "handoverSummary", "docsUrl", "repoUrl"];
const SECTIONS = ["visibility", "features", "social", "directory", "general"];
const noStore = { "cache-control": "private, no-store" };

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host ||
      origin === request.headers.get("x-forwarded-origin");
  } catch {
    return false;
  }
}

async function authorise(request: Request, locals: unknown) {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user)
    return { env, user, error: Response.json({ error: "Sign in required." }, { status: 401 }) };
  if (!hasPermission(user, "settings.manage"))
    return {
      env,
      user,
      error: Response.json({ error: "Administrator access required." }, { status: 403 }),
    };
  return { env, user, error: null };
}

export const GET: APIRoute = async ({ request, locals }) => {
  const { env, error } = await authorise(request, locals);
  if (error) return error;
  const db = await getDatabase(env);
  const [config, events] = await Promise.all([
    getSiteConfig(db, env),
    listSiteConfigEvents(db),
  ]);
  return Response.json({ config, events }, { headers: noStore });
};

export const PATCH: APIRoute = async ({ request, locals }) => {
  const { env, user, error } = await authorise(request, locals);
  if (error) return error;
  if (!sameOrigin(request))
    return Response.json({ error: "Cross-site requests are not allowed." }, { status: 403 });
  try {
    const body = (await request.json()) as Record<string, unknown>;
    for (const key of READ_ONLY_KEYS) delete body[key];
    if (body.section !== undefined && !SECTIONS.includes(String(body.section)))
      return Response.json({ error: "Unknown settings section." }, { status: 400 });
    const fieldErrors = validateSiteConfigInput(body);
    if (Object.keys(fieldErrors).length)
      return Response.json(
        { error: "Some fields need attention.", fieldErrors },
        { status: 422 },
      );
    const db = await getDatabase(env);
    const config = await updateSiteConfig(
      db,
      env,
      user!.memberId,
      body,
      user!.name || user!.email,
    );
    const events = await listSiteConfigEvents(db);
    return Response.json({ config, events }, { headers: noStore });
  } catch (cause) {
    return Response.json(
      { error: cause instanceof Error ? cause.message : "Could not update settings." },
      { status: 400 },
    );
  }
};

/** Restore the values an earlier change replaced. Recorded as a new change. */
export const POST: APIRoute = async ({ request, locals }) => {
  const { env, user, error } = await authorise(request, locals);
  if (error) return error;
  if (!sameOrigin(request))
    return Response.json({ error: "Cross-site requests are not allowed." }, { status: 403 });
  try {
    const body = (await request.json()) as { eventId?: string };
    const db = await getDatabase(env);
    const event = (await listSiteConfigEvents(db, 200)).find(
      (item) => item.eventId === body.eventId,
    );
    if (!event)
      return Response.json({ error: "That change could not be found." }, { status: 404 });
    const values: Record<string, unknown> = { ...event.before };
    for (const key of READ_ONLY_KEYS) delete values[key];
    if (!Object.keys(values).length)
      return Response.json({ error: "Nothing in that change can be restored." }, { status: 409 });
    const fieldErrors = validateSiteConfigInput(values);
    if (Object.keys(fieldErrors).length)
      return Response.json(
        { error: "The earlier values are no longer valid and cannot be restored.", fieldErrors },
        { status: 422 },
      );
    const config = await updateSiteConfig(db, env, user!.memberId, {
      ...values,
      section: "restore",
      changeSummary: `Restored: ${event.summary}`,
    }, user!.name || user!.email);
    return Response.json(
      { config, events: await listSiteConfigEvents(db) },
      { headers: noStore },
    );
  } catch (cause) {
    return Response.json(
      { error: cause instanceof Error ? cause.message : "Could not restore." },
      { status: 400 },
    );
  }
};
