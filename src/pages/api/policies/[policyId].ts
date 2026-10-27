import type { APIRoute } from "astro";
import { getSessionUser } from "../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../lib/db.ts";
import { deletePolicy, getPolicyDetail, savePolicy } from "../../../lib/store.ts";

export const prerender = false;

export const GET: APIRoute = async ({ params, request, locals }) => {
  const env = runtimeEnv(locals);
  const [db, user] = await Promise.all([getDatabase(env), getSessionUser(request, env)]);
  const detail = await getPolicyDetail(db, params.policyId ?? "", user);
  if (!detail) return Response.json({ error: "Policy not found." }, { status: 404 });
  return Response.json(detail, { headers: { "cache-control": "private, no-store" } });
};

export const PATCH: APIRoute = async ({ params, request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: "Sign in required." }, { status: 401 });
  if (!user.isStaff) return Response.json({ error: "Staff access required." }, { status: 403 });

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const db = await getDatabase(env);
    const policy = await savePolicy(db, user, { ...body, policyId: params.policyId });
    return Response.json({ policy });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not update policy." },
      { status: 400 },
    );
  }
};

export const DELETE: APIRoute = async ({ params, request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: "Sign in required." }, { status: 401 });
  if (!user.isAdmin) return Response.json({ error: "Administrator access required." }, { status: 403 });

  try {
    const db = await getDatabase(env);
    await deletePolicy(db, user, params.policyId ?? "");
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not delete policy." },
      { status: 400 },
    );
  }
};
