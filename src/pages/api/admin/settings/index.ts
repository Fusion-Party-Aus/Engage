import type { APIRoute } from "astro";
import { getSessionUser } from "../../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import { getSiteConfig, updateSiteConfig } from "../../../../lib/site-config.ts";

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user) {
    return Response.json({ error: "Sign in required." }, { status: 401 });
  }
  if (!user.isAdmin) {
    return Response.json(
      { error: "Administrator access required." },
      { status: 403 },
    );
  }
  const db = await getDatabase(env);
  const config = await getSiteConfig(db, env);
  return Response.json(
    { config },
    { headers: { "cache-control": "private, no-store" } },
  );
};

export const PATCH: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user) {
    return Response.json({ error: "Sign in required." }, { status: 401 });
  }
  if (!user.isAdmin) {
    return Response.json(
      { error: "Administrator access required." },
      { status: 403 },
    );
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const db = await getDatabase(env);
    const config = await updateSiteConfig(db, env, user.memberId, body);
    return Response.json({ config });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not update site configuration.",
      },
      { status: 400 },
    );
  }
};
