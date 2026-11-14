import type { APIRoute } from "astro";
import { getAuth, loginConfigured } from "../../../lib/auth.ts";
import { getDatabase, runtimeEnv } from "../../../lib/db.ts";
import {
  enforceAbuseProtection,
  protectedAuthAction,
} from "../../../lib/turnstile-guard.ts";
import { readTurnstileToken } from "../../../lib/turnstile.ts";

export const prerender = false;

export const ALL: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals);
  if (!loginConfigured(env)) {
    return Response.json(
      { error: "Member sign-in is not configured." },
      { status: 503 },
    );
  }

  // Turnstile and the shared rate limiter guard the routes that send email or
  // create an account. Passkey and OAuth traffic is untouched.
  if (request.method === "POST") {
    const action = protectedAuthAction(new URL(request.url).pathname);
    if (action) {
      const refusal = await enforceAbuseProtection({
        request,
        env,
        db: await getDatabase(env),
        action,
        token: await readTurnstileToken(request),
      });
      if (refusal) return refusal;
    }
  }

  const auth = await getAuth(env);
  return auth.handler(request);
};
