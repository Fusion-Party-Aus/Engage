import type { APIRoute } from "astro";
import { getAuth, loginConfigured } from "../../../lib/auth.ts";
import { runtimeEnv } from "../../../lib/db.ts";

export const prerender = false;

export const ALL: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  if (!loginConfigured(env)) {
    return Response.json(
      { error: "Member sign-in is not configured." },
      { status: 503 },
    );
  }
  const auth = await getAuth(env);
  return auth.handler(request);
};
