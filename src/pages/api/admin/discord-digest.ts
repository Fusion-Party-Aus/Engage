import type { APIRoute } from "astro";
import { getSessionUser } from "../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../lib/db.ts";
import {
  previewWeeklyDiscordDigest,
  sendTestDiscordDigest,
} from "../../../lib/discord-digest.ts";
import { resolvePublicOrigin } from "../../../lib/public-origin.ts";

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: "Sign in required." }, { status: 401 });
  if (!user.isAdmin) return Response.json({ error: "Administrator access required." }, { status: 403 });
  try {
    const preview = await previewWeeklyDiscordDigest(await getDatabase(env), env, new Date(), true);
    return Response.json({
      weekKey: preview.weekKey,
      content: preview.content,
      featured: preview.candidates.length,
      testConfigured: Boolean(env.ENGAGE_DISCORD_TEST_WEBHOOK_URL),
      liveEnabled: env.ENGAGE_DISCORD_DIGEST_ENABLED === "true",
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return Response.json({ error: "Discord digest preview is unavailable." }, { status: 503 });
  }
};

export const POST: APIRoute = async ({ request, url, locals }) => {
  const env = runtimeEnv(locals);
  if (request.headers.get("origin") !== resolvePublicOrigin({ env, requestUrl: url })) {
    return Response.json({ error: "Open Engage directly and try again." }, { status: 403 });
  }
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: "Sign in required." }, { status: 401 });
  if (!user.isAdmin) return Response.json({ error: "Administrator access required." }, { status: 403 });
  try {
    const result = await sendTestDiscordDigest(
      await getDatabase(env),
      env,
      user.memberId,
    );
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return Response.json({
      error: "The test could not be started. Check the test webhook configuration.",
    }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
};
