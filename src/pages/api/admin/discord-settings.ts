import type { APIRoute } from "astro";
import { getSessionUser } from "../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../lib/db.ts";
import { hasPermission } from "../../../lib/rbac.ts";
import { resolvePublicOrigin } from "../../../lib/public-origin.ts";
import {
  DiscordSettingsError,
  getDiscordSettingsSummary,
  updateDiscordSettings,
  type DiscordSettingsPatch,
} from "../../../lib/discord-settings.ts";

export const prerender = false;
const noStore = { "Cache-Control": "private, no-store" };

export const GET: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: "Sign in required." }, { status: 401, headers: noStore });
  if (!hasPermission(user, "settings.manage")) {
    return Response.json({ error: "Administrator access required." }, { status: 403, headers: noStore });
  }
  try {
    return Response.json({
      config: await getDiscordSettingsSummary(await getDatabase(env)),
    }, { headers: noStore });
  } catch {
    return Response.json({ error: "Couldn't load Discord settings." }, { status: 503, headers: noStore });
  }
};

export const PATCH: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  if (request.headers.get("origin") !==
      resolvePublicOrigin({ env, requestUrl: request.url })) {
    return Response.json({ error: "Open Engage directly and try again." }, { status: 403, headers: noStore });
  }
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: "Sign in required." }, { status: 401, headers: noStore });
  if (!hasPermission(user, "settings.manage")) {
    return Response.json({ error: "Administrator access required." }, { status: 403, headers: noStore });
  }
  try {
    const raw = await request.json() as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new DiscordSettingsError("Invalid settings request.");
    }
    const body = raw as Record<string, unknown>;
    const keys = [
      "enabled", "liveWebhookUrl", "testWebhookUrl", "clearLiveWebhook",
      "clearTestWebhook", "liveRoleId", "testRoleId", "dayOfWeek", "hourOfDay",
    ];
    if (Object.keys(body).some((key) => !keys.includes(key))) {
      throw new DiscordSettingsError("This request contains unsupported settings.");
    }
    const config = await updateDiscordSettings(
      await getDatabase(env),
      env,
      { memberId: user.memberId, name: user.name || user.email },
      body as DiscordSettingsPatch,
    );
    return Response.json({ config }, { headers: noStore });
  } catch (error) {
    return Response.json({
      error: error instanceof DiscordSettingsError
        ? error.message
        : "Couldn't save Discord settings.",
    }, {
      status: error instanceof DiscordSettingsError ? error.status : 503,
      headers: noStore,
    });
  }
};
