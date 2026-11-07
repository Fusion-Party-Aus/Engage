import type { PlatformEnv } from "./types.ts";

export interface PublicOriginInput {
  env?: Pick<PlatformEnv, "APP_MODE" | "BETTER_AUTH_URL" | "PUBLIC_ORIGIN">;
  requestUrl: string | URL;
  development?: boolean;
}

/**
 * Resolve the origin used in canonical metadata and public API Link headers.
 *
 * A configured origin always wins. Forwarded Host headers are never trusted.
 * Local development falls back to the incoming request origin so the developer
 * server keeps working without a public domain.
 */
export function resolvePublicOrigin({
  env = {},
  requestUrl,
  development = false,
}: PublicOriginInput): string {
  const request = new URL(
    typeof requestUrl === "string" ? requestUrl : requestUrl.href,
  );
  const configured = (env.PUBLIC_ORIGIN || env.BETTER_AUTH_URL || "").trim();
  if (configured) {
    try {
      const candidate = new URL(configured);
      const isDevelopment =
        development || env.APP_MODE !== "production";
      if (
        candidate.protocol === "https:" ||
        (isDevelopment && candidate.protocol === "http:")
      )
        return candidate.origin;
    } catch {
      // Fall through to the request origin; invalid configuration must not
      // become an attacker-controlled host.
    }
  }
  return request.origin;
}

/** Build an absolute canonical URL from a trusted path. */
export function canonicalUrl(
  path: string,
  input: PublicOriginInput,
): string {
  return new URL(path, `${resolvePublicOrigin(input)}/`).href;
}

/**
 * Accept either a full URL or a path and rebuild it against the trusted origin.
 * This intentionally discards any host supplied by the request or caller.
 */
export function trustedCanonical(
  value: string,
  input: PublicOriginInput,
): string {
  const path = value.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, "") || "/";
  return canonicalUrl(path.startsWith("/") ? path : `/${path}`, input);
}
