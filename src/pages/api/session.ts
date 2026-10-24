import { resolveIdentity } from "../../lib/platform/auth.ts";
import { getDatabase } from "../../lib/platform/database.ts";
import { membershipStatus } from "../../lib/platform/membership.ts";
import { getAuth, loginConfigured } from "../../lib/platform/better-auth.ts";
import { json, platformEnv, requireSameOrigin } from "../../lib/platform/http.ts";
import type { RuntimeLocals } from "../../lib/platform/types.ts";
import { DELETE as previewLogout } from "./preview/session.ts";
export const prerender = false;
export async function GET({ request, locals }: { request: Request; locals: RuntimeLocals }) {
  const env = platformEnv(locals);
  try {
    const { identity } = await resolveIdentity(request, env);
    return json({ identity, syntheticOnly: env.APP_MODE === "preview", loginAvailable: loginConfigured(env), membershipStatus: identity ? identity.source === "synthetic" ? "preview" : await membershipStatus(await getDatabase(env), identity.memberId) : null });
  } catch { return json({ error: "Your session is temporarily unavailable." }, 503); }
}
export async function DELETE(context: { request: Request; locals: RuntimeLocals }) {
  const error = requireSameOrigin(context.request); if (error) return error;
  const env = platformEnv(context.locals);
  if (env.APP_MODE === "preview") return previewLogout(context);
  return (await getAuth(env)).api.signOut({ headers: context.request.headers, asResponse: true });
}
