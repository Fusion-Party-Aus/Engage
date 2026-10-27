import type { APIRoute } from "astro";
import { getSessionUser } from "../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../lib/db.ts";
import { listPolicies, savePolicy } from "../../../lib/store.ts";

export const prerender = false;

export const GET: APIRoute = async ({ request, url, locals }) => {
  const env = runtimeEnv(locals);
  const [db, user] = await Promise.all([getDatabase(env), getSessionUser(request, env)]);
  const policies = await listPolicies(db, {
    includeDrafts: Boolean(user?.isStaff),
    search: url.searchParams.get("q") ?? "",
    category: url.searchParams.get("category") ?? "",
    status: url.searchParams.get("status") ?? "",
    kind: url.searchParams.get("kind") ?? "",
  });
  return Response.json({ policies }, { headers: { "cache-control": "private, no-store" } });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: "Sign in required." }, { status: 401 });
  if (!user.isStaff) return Response.json({ error: "Staff access required." }, { status: 403 });

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const db = await getDatabase(env);
    const policy = await savePolicy(db, user, body);
    return Response.json({ policy }, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not save proposal." },
      { status: 400 },
    );
  }
};
