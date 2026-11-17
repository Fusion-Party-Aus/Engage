import type { APIRoute } from "astro";
import { getSessionUser } from "../../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import { listMembers } from "../../../../lib/members-store.ts";
import { hasPermission } from "../../../../lib/rbac.ts";

export const prerender = false;

/** A small member search for the operational-owner pickers. */
export const GET: APIRoute = async ({ request, locals, url }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: "Sign in required." }, { status: 401 });
  if (!hasPermission(user, "collaboration.manage")) {
    return Response.json({ error: "You do not have permission for this search." }, { status: 403 });
  }
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 80);
  if (q.length < 2) return Response.json({ results: [] });
  const members = await listMembers(await getDatabase(env), q);
  return Response.json(
    {
      results: members
        .filter((member) => !member.disabled)
        .slice(0, 10)
        .map((member) => ({
          id: member.memberId,
          label: member.name || "Member",
          detail: member.status,
        })),
    },
    { headers: { "cache-control": "private, no-store" } },
  );
};
