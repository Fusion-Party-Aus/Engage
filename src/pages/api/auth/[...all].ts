import type { APIRoute } from "astro";
import { getAuth } from "../../../lib/platform/better-auth.ts";
import { platformEnv, json } from "../../../lib/platform/http.ts";
export const prerender = false;
export const ALL: APIRoute = async ({ request, locals }) => {
  try { return await (await getAuth(platformEnv(locals))).handler(request); }
  catch { return json({ error: "Sign-in is temporarily unavailable." }, 503); }
};
