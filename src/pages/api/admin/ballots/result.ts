import type { APIRoute } from "astro";
import { getSessionUser } from "../../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../../lib/db.ts";
import {
  authoriseGovernanceRoute,
  governanceRouteError,
  runGovernanceRoute,
  type GovernanceRouteKey,
} from "../../../../lib/route-policy.ts";

export const prerender = false;

const ROUTE: GovernanceRouteKey = "POST /api/admin/ballots/result";

export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  const user = await getSessionUser(request, env);
  if (!user)
    return Response.json({ error: "Sign in required." }, { status: 401 });
  const denial = authoriseGovernanceRoute(user, ROUTE);
  if (denial) return Response.json(denial.body, { status: denial.status });
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const outcome = await runGovernanceRoute(
      ROUTE,
      { env, user, getDb: () => getDatabase(env) },
      body,
    );
    return Response.json(outcome.body, {
      status: outcome.status,
      ...(outcome.headers ? { headers: outcome.headers } : {}),
    });
  } catch (error) {
    const outcome = governanceRouteError(ROUTE, error);
    return Response.json(outcome.body, { status: outcome.status });
  }
};
