import { defineMiddleware } from "astro:middleware";
import { runtimeEnv } from "./lib/db.ts";
import { resolvePublicOrigin } from "./lib/public-origin.ts";
import {
  applySecurityHeaders,
  evaluateStateChangingRequest,
  isDocumentResponse,
  isSecureDeployment,
} from "./lib/security-perimeter.ts";

const BLOCKED_MESSAGE = "Cross-site request blocked.";

function finish(response: Response, secure: boolean): Response {
  const options = {
    hsts: secure,
    documentResponse: isDocumentResponse(
      response.headers.get("content-type"),
    ),
  };
  try {
    applySecurityHeaders(response.headers, options);
    return response;
  } catch {
    // Some responses (redirects, for example) have immutable headers. Copy the
    // response so the headers still apply without altering its body or status.
    const copy = new Response(response.body, response);
    applySecurityHeaders(copy.headers, options);
    return copy;
  }
}

/**
 * Application perimeter.
 *
 * Astro runs its own `security.checkOrigin` middleware before this one, so a
 * cross-site form post it already refuses never reaches these lines. This
 * middleware adds the headers to everything it does see, and closes the
 * content-type and missing-Origin gaps that Astro's check intentionally
 * leaves. See `docs/security/perimeter.md`.
 */
export const onRequest = defineMiddleware(async (context, next) => {
  const started = performance.now();
  const env = runtimeEnv(context.locals);
  const publicOrigin = resolvePublicOrigin({
    env,
    requestUrl: context.url,
    development: import.meta.env.DEV,
  });
  const secure = isSecureDeployment({
    env,
    forwardedProto: context.request.headers.get("x-forwarded-proto"),
    requestProtocol: context.url.protocol,
    publicOrigin,
  });

  const decision = evaluateStateChangingRequest({
    method: context.request.method,
    origin: context.request.headers.get("origin"),
    secFetchSite: context.request.headers.get("sec-fetch-site"),
    cookieHeader: context.request.headers.get("cookie"),
    expectedOrigin: publicOrigin,
  });

  if (!decision.allowed) {
    return finish(
      new Response(BLOCKED_MESSAGE, {
        status: 403,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        },
      }),
      secure,
    );
  }

  const response = finish(await next(), secure);
  if (context.request.method === "GET" && isDocumentResponse(response.headers.get("content-type"))) {
    // Time to an application response, excluding the proxy and browser.
    response.headers.append("Server-Timing", `app;dur=${(performance.now() - started).toFixed(1)}`);
  }
  return response;
});
