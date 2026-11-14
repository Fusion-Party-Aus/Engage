import type { Db } from "mongodb";
import type { PlatformEnv } from "./types.ts";
import {
  clientAddress,
  consumeRateLimit,
  rateLimitResponse,
  type RateLimitAction,
} from "./rate-limit.ts";
import { TURNSTILE_ACTIONS } from "./turnstile-actions.ts";
import {
  turnstileFailureResponse,
  verifyTurnstile,
  type TurnstileEnv,
} from "./turnstile.ts";

/**
 * One gate for abuse-prone unauthenticated actions.
 *
 * Protected today:
 * - public Sense Box submission (`POST /api/sense-box`);
 * - magic-link sign-in, which also creates a first-time account
 *   (`POST /api/auth/sign-in/magic-link`);
 * - email sign-up (`POST /api/auth/sign-up/email`) if it is ever enabled.
 *
 * Deliberately not protected: authenticated voting, deliberation, endorsements
 * and ordinary authenticated reads/writes. D32 says routine challenges must not
 * interrupt authenticated voting, and every one of those routes already
 * requires a verified session.
 */

/** Better Auth routes that spend email or create an account. */
export const PROTECTED_AUTH_ROUTES: Record<string, RateLimitAction> = {
  "/sign-in/magic-link": "auth-magic-link",
  "/sign-up/email": "auth-sign-up",
};

const AUTH_BASE_PATH = "/api/auth";

/**
 * Map a request path to the protection it needs, if any. Accepts either the
 * full `/api/auth/...` path or the suffix Better Auth receives.
 */
export function protectedAuthAction(pathname: string): RateLimitAction | null {
  const suffix =
    pathname === AUTH_BASE_PATH || pathname.startsWith(`${AUTH_BASE_PATH}/`)
      ? pathname.slice(AUTH_BASE_PATH.length)
      : pathname;
  const normalised = suffix.replace(/\/+$/, "").toLowerCase();
  return PROTECTED_AUTH_ROUTES[normalised] ?? null;
}

/** The Turnstile widget action expected for each protected action. */
export function turnstileActionFor(action: RateLimitAction): string {
  switch (action) {
    case "sense-box-submit":
      return TURNSTILE_ACTIONS.senseBox;
    case "auth-sign-up":
      return TURNSTILE_ACTIONS.signUp;
    default:
      return TURNSTILE_ACTIONS.signIn;
  }
}

export interface AbuseProtectionInput {
  request: Request;
  env: PlatformEnv & TurnstileEnv;
  db: Db;
  action: RateLimitAction;
  /** Token supplied by the client. Missing or empty is a failure. */
  token: string;
  /** Adapter-provided fallback when no proxy header is present. */
  adapterAddress?: string;
}

/**
 * Returns `null` when the request may continue, or the response to send when it
 * must not. Rate limiting runs first so an unverified flood cannot amplify
 * calls to Cloudflare.
 */
export async function enforceAbuseProtection(
  input: AbuseProtectionInput,
): Promise<Response | null> {
  const identifier = clientAddress(input.request, input.adapterAddress);

  const decision = await consumeRateLimit(input.db, {
    action: input.action,
    identifier,
    env: input.env,
  });
  if (!decision.allowed) return rateLimitResponse(decision);

  const verdict = await verifyTurnstile({
    token: input.token,
    env: input.env,
    expectedAction: turnstileActionFor(input.action),
  });
  if (!verdict.ok) return turnstileFailureResponse(verdict);

  return null;
}
