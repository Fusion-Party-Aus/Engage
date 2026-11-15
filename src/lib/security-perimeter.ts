/**
 * Perimeter controls shared by the Astro middleware, the CSP configuration and
 * the tests.
 *
 * Keep this module free of Astro, Node and database imports: `astro.config.mjs`
 * loads it outside the application runtime, and the middleware is the only
 * caller that has a request. Everything here is a pure decision so the rules
 * can be tested without a browser or a server.
 */

export interface PerimeterEnv {
  APP_MODE?: string;
  PUBLIC_ORIGIN?: string;
  BETTER_AUTH_URL?: string;
}

/**
 * Headers sent on every response the application renders.
 *
 * `permissions-policy` denies only capabilities Engage does not use. A future
 * integration that needs one of them must remove it deliberately rather than
 * discover the denial in production.
 */
export const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "permissions-policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
} as const;

/**
 * Only sent when the deployment is production **and** HTTPS is provable: the
 * first forwarded protocol value, the request protocol, or the trusted public
 * origin is HTTPS. Sending HSTS over plain HTTP is pointless, and sending it
 * from a development server would pin localhost.
 */
export const STRICT_TRANSPORT_SECURITY = "max-age=31536000; includeSubDomains";

/**
 * A restrictive fallback for responses that are not HTML documents (JSON, CSV,
 * PDF). Astro renders the full policy header for pages; this makes sure an API
 * response cannot be treated as a document, framed or used as a base.
 */
export const NON_DOCUMENT_CSP =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);
const SESSION_COOKIE = /^(?:(?:__Secure-|__Host-)?better-auth\.session_(?:token|data))$/;
const DEV_SESSION_COOKIE = "engage_dev_user";

/** True when the request carries a cookie that can authenticate a member. */
export function hasSessionCookie(
  cookieHeader: string | null | undefined,
): boolean {
  if (!cookieHeader) return false;
  for (const part of cookieHeader.split(";")) {
    const equals = part.indexOf("=");
    const name = (equals === -1 ? part : part.slice(0, equals)).trim();
    if (name === DEV_SESSION_COOKIE || SESSION_COOKIE.test(name)) return true;
  }
  return false;
}

export type OriginDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "cross-site-fetch"
        | "cross-origin"
        | "missing-origin-with-session-cookie";
    };

export interface StateChangingRequestInput {
  method: string;
  origin?: string | null;
  secFetchSite?: string | null;
  cookieHeader?: string | null;
  /** Trusted public origin, never a forwarded Host header. */
  expectedOrigin: string;
}

/**
 * Origin/CSRF rule for state-changing requests.
 *
 * Astro's `security.checkOrigin` already rejects some cross-site form posts,
 * but it deliberately exempts non-form content types (JSON) and only compares
 * the Origin header. This adds the parts it does not cover:
 *
 * - `Sec-Fetch-Site: cross-site` is refused even when Origin is absent.
 * - An Origin that does not equal the trusted public origin is refused,
 *   whatever the content type.
 * - A request with no Origin at all is refused when it carries a session
 *   cookie. Browsers send Origin on state-changing requests, so an absent
 *   Origin with a cookie is either a very old client or an attempt to avoid
 *   the check. Requests from cron jobs, webhooks and other servers carry no
 *   cookie and remain allowed.
 */
export function evaluateStateChangingRequest(
  input: StateChangingRequestInput,
): OriginDecision {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return { allowed: true };

  const secFetchSite = (input.secFetchSite ?? "").trim().toLowerCase();
  if (secFetchSite === "cross-site") {
    return { allowed: false, reason: "cross-site-fetch" };
  }

  const origin = (input.origin ?? "").trim();
  if (origin) {
    return origin === input.expectedOrigin
      ? { allowed: true }
      : { allowed: false, reason: "cross-origin" };
  }

  if (hasSessionCookie(input.cookieHeader)) {
    return { allowed: false, reason: "missing-origin-with-session-cookie" };
  }

  return { allowed: true };
}

export interface SecureDeploymentInput {
  env: PerimeterEnv;
  forwardedProto?: string | null;
  /** `URL.protocol` of the request URL, for example `https:`. */
  requestProtocol: string;
  /** Trusted public origin resolved from configuration or the request. */
  publicOrigin: string;
}

/**
 * HSTS is a deployment property, not a per-request preference. It is enabled
 * only in production, and only when HTTPS is provable: a trusted proxy says so,
 * the request itself is TLS, or the configured public origin is HTTPS.
 */
export function isSecureDeployment(input: SecureDeploymentInput): boolean {
  if (input.env.APP_MODE !== "production") return false;
  const forwarded = (input.forwardedProto ?? "")
    .split(",")[0]
    ?.trim()
    .toLowerCase();
  if (forwarded === "https") return true;
  if (input.requestProtocol === "https:") return true;
  return /^https:\/\//i.test(input.publicOrigin);
}

export interface SecurityHeaderInput {
  /** Send HSTS. Resolve with `isSecureDeployment`. */
  hsts: boolean;
  /** True for an HTML document. Astro supplies the policy for those. */
  documentResponse: boolean;
}

/** Apply the perimeter headers, preserving a policy Astro already rendered. */
export function applySecurityHeaders(
  headers: Headers,
  input: SecurityHeaderInput,
): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  if (input.hsts) {
    headers.set("strict-transport-security", STRICT_TRANSPORT_SECURITY);
  }
  if (!input.documentResponse && !headers.has("content-security-policy")) {
    headers.set("content-security-policy", NON_DOCUMENT_CSP);
  }
}

export function isDocumentResponse(contentType: string | null): boolean {
  return (contentType ?? "").toLowerCase().includes("text/html");
}

/* -------------------------------------------------------------------------- */
/* Content Security Policy configuration                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every external origin in the policy, and why:
 *
 * - `challenges.cloudflare.com` — Turnstile script, widget iframe and the
 *   client-side challenge request. See `docs/security/turnstile.md`.
 * - `analytics.fusionparty.org.au` — the first-party Plausible tracker. The
 *   bundled library posts events with `fetch`; the script source is allowed so
 *   the hosted tracker variant keeps working. See `docs/analytics-tracking.md`.
 */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";
export const ANALYTICS_ORIGIN = "https://analytics.fusionparty.org.au";

/**
 * Astro hashes its own inline scripts and styles, so `script-src` does not need
 * `'unsafe-inline'` and must never contain `'unsafe-eval'`.
 */
export const CSP_SCRIPT_RESOURCES = [
  "'self'",
  TURNSTILE_ORIGIN,
  ANALYTICS_ORIGIN,
] as const;

/**
 * The application renders progress bars and column widths as inline `style`
 * attributes (`style={{ width: ... }}` in React, `style={...}` in Astro).
 * A hash-based `style-src` cannot cover attributes, so inline style attributes
 * are allowed while stylesheets and `<style>` elements stay restricted to
 * `'self'` plus Astro's hashes. This is the one deliberate `'unsafe-inline'`;
 * it is scoped to `style-src-attr` only.
 */
export const CSP_STYLE_ATTRIBUTE_RESOURCES = [
  { resource: "'unsafe-inline'", kind: "attribute" },
] as const;

export const CSP_DIRECTIVES = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  // Proposal attachments may be an absolute HTTPS image; everything else is
  // served from this origin.
  "img-src 'self' https:",
  "font-src 'self'",
  `connect-src 'self' ${TURNSTILE_ORIGIN} ${ANALYTICS_ORIGIN}`,
  `frame-src ${TURNSTILE_ORIGIN}`,
  "manifest-src 'self'",
  "worker-src 'self'",
] as const;
