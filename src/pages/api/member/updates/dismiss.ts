import type { APIRoute } from "astro";
import { getSessionUser } from "../../../../lib/auth.ts";
import { runtimeEnv } from "../../../../lib/db.ts";
import { resolvePublicOrigin } from "../../../../lib/public-origin.ts";
import {
  catchUpCookieOptions,
  MEMBER_CATCHUP_COOKIE,
  safeCatchUpReturn,
} from "../../../../lib/member-catchup.ts";

export const prerender = false;

/**
 * Mark My Engage updates as seen. This is the only place that advances the
 * unread cursor; rendering My Engage never does.
 */
export const POST: APIRoute = async ({ request, locals, url, cookies, redirect }) => {
  const env = runtimeEnv(locals);
  const publicOrigin = resolvePublicOrigin({ env, requestUrl: url });
  if (request.headers.get("origin") !== publicOrigin) {
    return Response.json({ error: "Invalid origin" }, { status: 403 });
  }
  const user = await getSessionUser(request, env);
  if (!user) {
    return Response.json({ error: "Sign in required" }, { status: 401 });
  }
  const form = await request.formData().catch(() => null);
  const destination = new URL(
    safeCatchUpReturn(String(form?.get("returnTo") ?? "")),
    publicOrigin,
  );
  destination.searchParams.set("updates", "seen");
  cookies.set(
    MEMBER_CATCHUP_COOKIE,
    new Date().toISOString(),
    catchUpCookieOptions(url.protocol === "https:"),
  );
  return redirect(
    `${destination.pathname}${destination.search}${destination.hash}`,
    303,
  );
};
