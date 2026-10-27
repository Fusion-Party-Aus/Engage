import type { APIRoute } from "astro";
import { getSessionUser } from "../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../lib/db.ts";
import { listMembers, saveMember } from "../../../lib/store.ts";

export const prerender = false;

export const GET: APIRoute = async ({ request, url, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: "Sign in required." }, { status: 401 });
  if (!user.isAdmin) return Response.json({ error: "Administrator access required." }, { status: 403 });

  const db = await getDatabase(env);
  const accounts = await listMembers(db, url.searchParams.get("q") ?? "");
  return Response.json(
    { accounts, currentMemberId: user.memberId },
    { headers: { "cache-control": "private, no-store" } },
  );
};

export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: "Sign in required." }, { status: 401 });
  if (!user.isAdmin) return Response.json({ error: "Administrator access required." }, { status: 403 });

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const db = await getDatabase(env);
    const result = await saveMember(db, user, body, true);
    return Response.json(result, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not create account." },
      { status: 400 },
    );
  }
};

export const PATCH: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: "Sign in required." }, { status: 401 });
  if (!user.isAdmin) return Response.json({ error: "Administrator access required." }, { status: 403 });

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const db = await getDatabase(env);
    const result = await saveMember(db, user, body, false);
    return Response.json(result);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not update account." },
      { status: 400 },
    );
  }
};
