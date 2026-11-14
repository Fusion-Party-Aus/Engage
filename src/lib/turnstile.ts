import { logOperationalEvent } from "./resilience.ts";

/**
 * Server-side Cloudflare Turnstile verification (decision register D32).
 *
 * Rules enforced here:
 * - the token is verified against Cloudflare, never trusted from the client;
 * - the secret never appears in a response, an error message or a log;
 * - a missing, malformed, expired, replayed or failed token is a failure;
 * - production without usable keys fails closed instead of silently allowing.
 *
 * What is sent to Cloudflare: the token, our secret, and the optional expected
 * action/hostname are validated locally. No member identity, email address or
 * raw client IP is sent. See `docs/security/turnstile.md`.
 */

export const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TURNSTILE_SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
export const TURNSTILE_TIMEOUT_MS = 5_000;
/** Cloudflare tokens are short strings; anything larger is not a real token. */
const MAX_TOKEN_LENGTH = 2_048;

export interface TurnstileEnv {
  APP_MODE?: string;
  TURNSTILE_SECRET_KEY?: string;
  PUBLIC_TURNSTILE_SITE_KEY?: string;
  TURNSTILE_ENFORCEMENT?: string;
  TURNSTILE_EXPECTED_HOSTNAME?: string;
}

export type TurnstileState = "disabled" | "enforced" | "misconfigured";

export interface TurnstileConfiguration {
  state: TurnstileState;
  /** Present only so the page can render the widget. Never secret. */
  siteKey: string;
  /** Configuration keys missing while enforcement was requested. */
  missing: string[];
  /** Why the state was chosen, for the operations log. Contains no secrets. */
  reason: string;
}

/**
 * Enforcement contract:
 *
 * - `TURNSTILE_ENFORCEMENT=off` disables it, in any mode. This is an incident
 *   control, not a normal production setting.
 * - Production enforces by default. If the secret or the public site key is
 *   missing, the state is `misconfigured` and protected routes fail closed.
 * - Outside production, enforcement requires `TURNSTILE_ENFORCEMENT=on`. Local
 *   development, preview and CI therefore keep working without keys.
 * - `TURNSTILE_ENFORCEMENT=on` without keys is `misconfigured` in any mode, so
 *   a staging deployment cannot believe it is protected when it is not.
 */
export function turnstileConfiguration(
  env: TurnstileEnv,
): TurnstileConfiguration {
  const siteKey = String(env.PUBLIC_TURNSTILE_SITE_KEY ?? "").trim();
  const secret = String(env.TURNSTILE_SECRET_KEY ?? "").trim();
  const enforcement = String(env.TURNSTILE_ENFORCEMENT ?? "")
    .trim()
    .toLowerCase();
  const production = env.APP_MODE === "production";

  if (enforcement === "off") {
    return {
      state: "disabled",
      siteKey,
      missing: [],
      reason: "explicitly_disabled",
    };
  }

  const required = enforcement === "on" || production;
  if (!required) {
    return {
      state: "disabled",
      siteKey,
      missing: [],
      reason: "not_configured_outside_production",
    };
  }

  const missing = [
    secret ? null : "TURNSTILE_SECRET_KEY",
    siteKey ? null : "PUBLIC_TURNSTILE_SITE_KEY",
  ].filter((key): key is string => Boolean(key));

  if (missing.length) {
    return {
      state: "misconfigured",
      siteKey,
      missing,
      reason: production
        ? "production_requires_turnstile"
        : "enforcement_requested_without_keys",
    };
  }

  return { state: "enforced", siteKey, missing: [], reason: "configured" };
}

export function turnstileEnforced(env: TurnstileEnv): boolean {
  return turnstileConfiguration(env).state === "enforced";
}

export type TurnstileFailureCode =
  | "TURNSTILE_REQUIRED"
  | "TURNSTILE_INVALID"
  | "TURNSTILE_EXPIRED"
  | "TURNSTILE_UNAVAILABLE"
  | "TURNSTILE_MISCONFIGURED";

export interface TurnstileFailure {
  ok: false;
  code: TurnstileFailureCode;
  /** Plain-language, safe to show in the interface. */
  message: string;
  status: 400 | 503;
  retryable: boolean;
}

export type TurnstileVerdict = { ok: true } | TurnstileFailure;

const FAILURES = {
  required: {
    ok: false,
    code: "TURNSTILE_REQUIRED",
    message: "Complete the verification check and try again.",
    status: 400,
    retryable: true,
  },
  invalid: {
    ok: false,
    code: "TURNSTILE_INVALID",
    message: "The verification check didn’t pass. Try it again.",
    status: 400,
    retryable: true,
  },
  expired: {
    ok: false,
    code: "TURNSTILE_EXPIRED",
    message: "That verification check has expired. Complete it again.",
    status: 400,
    retryable: true,
  },
  unavailable: {
    ok: false,
    code: "TURNSTILE_UNAVAILABLE",
    message: "Verification is temporarily unavailable. Try again in a moment.",
    status: 503,
    retryable: true,
  },
  misconfigured: {
    ok: false,
    code: "TURNSTILE_MISCONFIGURED",
    message: "Verification is temporarily unavailable. Try again later.",
    status: 503,
    retryable: false,
  },
} as const satisfies Record<string, TurnstileFailure>;

export type TurnstileTransport = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

let testTransport: TurnstileTransport | undefined;

/**
 * Test seam. Route and unit tests must never reach Cloudflare. The override is
 * ignored in production so it cannot become a runtime bypass.
 */
export function setTurnstileTransportForTests(
  transport?: TurnstileTransport,
): void {
  testTransport = transport;
}

export interface VerifyTurnstileInput {
  token: unknown;
  env: TurnstileEnv;
  /** The widget action this request expects, e.g. `signin` or `sense-box`. */
  expectedAction?: string;
  /** Defaults to `TURNSTILE_EXPECTED_HOSTNAME`. */
  expectedHostname?: string;
  transport?: TurnstileTransport;
}

function logFailure(
  event: string,
  details: Record<string, unknown> = {},
): void {
  // Never log the token, the secret, or the raw client address.
  logOperationalEvent("warn", event, details);
}

// A misconfigured deployment fails every protected request; report it as an
// operational incident once a minute instead of flooding the log.
let lastMisconfiguredLog = 0;
function logMisconfigured(configuration: TurnstileConfiguration): void {
  const now = Date.now();
  if (now - lastMisconfiguredLog < 60_000) return;
  lastMisconfiguredLog = now;
  logOperationalEvent("error", "turnstile_misconfigured", {
    reason: configuration.reason,
    missing: configuration.missing,
  });
}

export async function verifyTurnstile(
  input: VerifyTurnstileInput,
): Promise<TurnstileVerdict> {
  const configuration = turnstileConfiguration(input.env);
  if (configuration.state === "disabled") return { ok: true };
  if (configuration.state === "misconfigured") {
    logMisconfigured(configuration);
    return FAILURES.misconfigured;
  }

  const token = typeof input.token === "string" ? input.token.trim() : "";
  if (!token) return FAILURES.required;
  if (token.length > MAX_TOKEN_LENGTH) return FAILURES.invalid;

  const secret = String(input.env.TURNSTILE_SECRET_KEY ?? "").trim();
  const body = new URLSearchParams({ secret, response: token });
  // Deliberately no `remoteip`: it would send the member's address to a third
  // party for no decision this application needs.

  const transport: TurnstileTransport =
    input.transport ??
    (input.env.APP_MODE === "production" ? undefined : testTransport) ??
    ((url, init) => fetch(url, init));

  let response: Response;
  try {
    response = await transport(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    logFailure("turnstile_verification_unavailable", { reason: name });
    return FAILURES.unavailable;
  }

  if (!response.ok) {
    logFailure("turnstile_verification_unavailable", {
      reason: "http_status",
      status: response.status,
    });
    return FAILURES.unavailable;
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    logFailure("turnstile_verification_malformed", { reason: "invalid_json" });
    return FAILURES.unavailable;
  }
  if (!payload || typeof payload !== "object") {
    logFailure("turnstile_verification_malformed", { reason: "invalid_body" });
    return FAILURES.unavailable;
  }

  if (payload.success !== true) {
    const codes = Array.isArray(payload["error-codes"])
      ? payload["error-codes"].filter(
          (code): code is string => typeof code === "string",
        )
      : [];
    const verdict = failureForErrorCodes(codes);
    logFailure("turnstile_verification_refused", {
      reason: verdict.code,
      errorCodes: codes,
    });
    return verdict;
  }

  const expectedAction = input.expectedAction?.trim();
  const returnedAction =
    typeof payload.action === "string" ? payload.action.trim() : "";
  if (expectedAction && returnedAction !== expectedAction) {
    logFailure("turnstile_verification_refused", {
      reason: "action_mismatch",
      expectedAction,
    });
    return FAILURES.invalid;
  }

  const expectedHostname =
    input.expectedHostname?.trim() ??
    String(input.env.TURNSTILE_EXPECTED_HOSTNAME ?? "").trim();
  const returnedHostname =
    typeof payload.hostname === "string" ? payload.hostname.trim() : "";
  if (expectedHostname && returnedHostname !== expectedHostname) {
    logFailure("turnstile_verification_refused", {
      reason: "hostname_mismatch",
    });
    return FAILURES.invalid;
  }

  return { ok: true };
}

function failureForErrorCodes(codes: string[]): TurnstileFailure {
  for (const code of codes) {
    switch (code) {
      case "timeout-or-duplicate":
        return FAILURES.expired;
      case "invalid-input-secret":
      case "missing-input-secret":
        return FAILURES.misconfigured;
      case "internal-error":
        return FAILURES.unavailable;
    }
  }
  // `missing-input-response`, `invalid-input-response`, `bad-request` and any
  // unknown code all mean "this token is not usable".
  return FAILURES.invalid;
}

/** Read a token from a JSON or form body without consuming the caller's body. */
export async function readTurnstileToken(request: Request): Promise<string> {
  const header = request.headers.get("x-turnstile-token")?.trim();
  if (header) return header;

  // Better Auth reads the same request later, so inspect a clone.
  const clone = request.clone();
  const contentType = (clone.headers.get("content-type") ?? "").toLowerCase();
  try {
    if (contentType.includes("application/json")) {
      return tokenFromBody((await clone.json()) as Record<string, unknown>);
    }
    if (
      contentType.includes("application/x-www-form-urlencoded") ||
      contentType.includes("multipart/form-data")
    ) {
      const form = await clone.formData();
      const value = form.get("cf-turnstile-response");
      return typeof value === "string" ? value.trim() : "";
    }
  } catch {
    // An unreadable body is treated as a missing token, never as a pass.
  }
  return "";
}

/** Extract the standard Turnstile field from an already parsed JSON body. */
export function tokenFromBody(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "";
  const record = body as Record<string, unknown>;
  for (const key of ["cf-turnstile-response", "turnstileToken"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** Build the JSON error response for a refused verification. */
export function turnstileFailureResponse(failure: TurnstileFailure): Response {
  return Response.json(
    { error: failure.message, code: failure.code },
    { status: failure.status, headers: { "cache-control": "private, no-store" } },
  );
}
