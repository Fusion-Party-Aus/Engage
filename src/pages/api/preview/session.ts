import { createPreviewSessionCookie, resolveIdentity } from "../../../lib/platform/auth";
import { json, platformEnv, readJson, requireSameOrigin } from "../../../lib/platform/http";
import type { RuntimeLocals } from "../../../lib/platform/types";

export const prerender = false;

export async function GET({ request, locals }: { request: Request; locals: RuntimeLocals }): Promise<Response> {
  const { identity } = await resolveIdentity(request, platformEnv(locals));
  return json({ identity: identity ? { ...identity, label: "Synthetic preview identity" } : null, syntheticOnly: true });
}

export async function POST({ request, locals }: { request: Request; locals: RuntimeLocals }): Promise<Response> {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const env = platformEnv(locals);
  if (env.APP_MODE !== "preview") return json({ error: "Synthetic sign-in is available only in the isolated preview environment." }, 404);
  const body = await readJson(request);
  if (!body || typeof body.memberId !== "string") return json({ error: "Choose a known synthetic member." }, 400);
  try {
    const cookie = await createPreviewSessionCookie(body.memberId, env);
    return json({ identity: { memberId: body.memberId, source: "synthetic", label: "Synthetic preview identity" }, syntheticOnly: true }, 200, { "set-cookie": cookie });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Synthetic sign-in is not configured.";
    return json({ error: message }, 503);
  }
}

export async function DELETE({ request, locals }: { request: Request; locals: RuntimeLocals }): Promise<Response> {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  if (platformEnv(locals).APP_MODE !== "preview") return json({ error: "Unavailable." }, 404);
  return json({ identity: null, syntheticOnly: true }, 200, { "set-cookie": "horizon_preview_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" });
}
