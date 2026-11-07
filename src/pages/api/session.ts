import type { APIRoute } from "astro";
import {
  clearDevSessionCookie,
  createDevSessionCookie,
  devLoginEnabled,
  getAuth,
  getSessionUser,
  loginConfigured,
} from "../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../lib/db.ts";
import { listUserActivity } from "../../lib/store.ts";

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  const activity = user
    ? await listUserActivity(await getDatabase(env), user.memberId)
    : null;
  return Response.json(
    {
      identity: user,
      membershipStatus: user?.status ?? null,
      loginAvailable: loginConfigured(env) || devLoginEnabled(env),
      activity,
    },
    { headers: { "cache-control": "private, no-store" } },
  );
};

export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  if (!devLoginEnabled(env)) {
    return Response.json(
      { error: "Development sign-in is disabled." },
      { status: 403 },
    );
  }
  const body = await request.json().catch(() => ({}));
  const role = body?.role === "administrator" ? "administrator" : "member";
  return Response.json(
    { ok: true, role },
    {
      headers: {
        "set-cookie": createDevSessionCookie(role),
        "cache-control": "private, no-store",
      },
    },
  );
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const headers = new Headers({
    "cache-control": "private, no-store",
    "set-cookie": clearDevSessionCookie(),
  });
  if (loginConfigured(env)) {
    try {
      const auth = await getAuth(env);
      const response = await auth.api.signOut({
        headers: request.headers,
        asResponse: true,
      });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) headers.append("set-cookie", setCookie);
    } catch {
      // Ignore if session already expired
    }
  }
  return Response.json({ ok: true }, { headers });
};
