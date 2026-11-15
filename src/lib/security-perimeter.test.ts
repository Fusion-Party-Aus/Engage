import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ANALYTICS_ORIGIN,
  CSP_DIRECTIVES,
  CSP_SCRIPT_RESOURCES,
  CSP_STYLE_ATTRIBUTE_RESOURCES,
  NON_DOCUMENT_CSP,
  SECURITY_HEADERS,
  STRICT_TRANSPORT_SECURITY,
  TURNSTILE_ORIGIN,
  applySecurityHeaders,
  evaluateStateChangingRequest,
  hasSessionCookie,
  isDocumentResponse,
  isSecureDeployment,
} from "./security-perimeter.ts";

const HTML_CONTENT_TYPE = "text/html; charset=utf-8";

function htmlResponse(): Response {
  return new Response("<!doctype html><html><body>ok</body></html>", {
    headers: { "content-type": HTML_CONTENT_TYPE },
  });
}

function jsonResponse(): Response {
  return Response.json({ ok: true });
}

function assertPerimeterHeaders(headers: Headers) {
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    headers.get("referrer-policy"),
    "strict-origin-when-cross-origin",
  );
  assert.equal(headers.get("x-frame-options"), "DENY");
  assert.equal(
    headers.get("permissions-policy"),
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  );
}

describe("perimeter security headers", () => {
  it("sends the exact header set on an HTML document", () => {
    const response = htmlResponse();
    applySecurityHeaders(response.headers, {
      hsts: false,
      documentResponse: true,
    });

    assertPerimeterHeaders(response.headers);
    assert.equal(
      response.headers.get("strict-transport-security"),
      null,
      "HSTS is a deployment decision, not a document default",
    );
    assert.equal(
      response.headers.get("content-security-policy"),
      null,
      "Astro renders the document policy; the middleware must not replace it",
    );
  });

  it("sends the same header set on a JSON API response with a deny-by-default policy", () => {
    const response = jsonResponse();
    applySecurityHeaders(response.headers, {
      hsts: false,
      documentResponse: false,
    });

    assertPerimeterHeaders(response.headers);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.equal(
      response.headers.get("content-security-policy"),
      NON_DOCUMENT_CSP,
    );
  });

  it("keeps a content security policy that Astro already rendered", () => {
    const response = htmlResponse();
    const policy = "default-src 'self'; frame-ancestors 'none'";
    response.headers.set("content-security-policy", policy);
    applySecurityHeaders(response.headers, {
      hsts: false,
      documentResponse: false,
    });
    assert.equal(response.headers.get("content-security-policy"), policy);
  });

  it("recognises HTML documents and other content types", () => {
    assert.equal(isDocumentResponse(HTML_CONTENT_TYPE), true);
    assert.equal(isDocumentResponse("TEXT/HTML"), true);
    assert.equal(isDocumentResponse("application/json"), false);
    assert.equal(isDocumentResponse("text/csv"), false);
    assert.equal(isDocumentResponse(null), false);
  });

  it("does not duplicate headers when applied twice", () => {
    const response = jsonResponse();
    applySecurityHeaders(response.headers, {
      hsts: true,
      documentResponse: false,
    });
    applySecurityHeaders(response.headers, {
      hsts: true,
      documentResponse: false,
    });
    assert.equal(
      response.headers.get("strict-transport-security"),
      STRICT_TRANSPORT_SECURITY,
    );
    assert.equal(
      response.headers.get("x-content-type-options"),
      SECURITY_HEADERS["x-content-type-options"],
    );
  });
});

describe("strict transport security deployment condition", () => {
  it("is absent outside production even when the request is HTTPS", () => {
    for (const appMode of [undefined, "development", "test", "preview"]) {
      const secure = isSecureDeployment({
        env: { APP_MODE: appMode },
        forwardedProto: "https",
        requestProtocol: "https:",
        publicOrigin: "https://engage.fusionparty.org.au",
      });
      assert.equal(secure, false, `APP_MODE=${appMode} must not send HSTS`);
      const response = htmlResponse();
      applySecurityHeaders(response.headers, {
        hsts: secure,
        documentResponse: true,
      });
      assert.equal(response.headers.get("strict-transport-security"), null);
    }
  });

  it("is absent in production on plain HTTP with no proxy evidence", () => {
    assert.equal(
      isSecureDeployment({
        env: { APP_MODE: "production" },
        forwardedProto: null,
        requestProtocol: "http:",
        publicOrigin: "http://localhost:4399",
      }),
      false,
      "a local HTTP server must not pin localhost with HSTS",
    );
  });

  it("is present for the production HTTPS configuration", () => {
    assert.equal(
      isSecureDeployment({
        env: { APP_MODE: "production" },
        forwardedProto: null,
        requestProtocol: "http:",
        publicOrigin: "https://engage.fusionparty.org.au",
      }),
      true,
    );
    assert.equal(
      isSecureDeployment({
        env: { APP_MODE: "production" },
        forwardedProto: "https, http",
        requestProtocol: "http:",
        publicOrigin: "http://internal:4321",
      }),
      true,
      "the TLS-terminating proxy is the first forwarded value",
    );
    assert.equal(
      isSecureDeployment({
        env: { APP_MODE: "production" },
        forwardedProto: null,
        requestProtocol: "https:",
        publicOrigin: "http://internal:4321",
      }),
      true,
    );

    const response = htmlResponse();
    applySecurityHeaders(response.headers, {
      hsts: true,
      documentResponse: true,
    });
    assert.equal(
      response.headers.get("strict-transport-security"),
      "max-age=31536000; includeSubDomains",
    );
  });
});

describe("state-changing request origin rule", () => {
  const expectedOrigin = "https://engage.fusionparty.org.au";

  it("allows a same-origin JSON POST, as admin pages send", () => {
    assert.deepEqual(
      evaluateStateChangingRequest({
        method: "POST",
        origin: expectedOrigin,
        secFetchSite: "same-origin",
        cookieHeader: "better-auth.session_token=abc",
        expectedOrigin,
      }),
      { allowed: true },
    );
  });

  it("rejects a cross-origin POST whatever its content type", () => {
    assert.deepEqual(
      evaluateStateChangingRequest({
        method: "POST",
        origin: "https://attacker.example",
        secFetchSite: "cross-site",
        expectedOrigin,
      }),
      { allowed: false, reason: "cross-site-fetch" },
    );
    assert.deepEqual(
      evaluateStateChangingRequest({
        method: "POST",
        origin: "https://attacker.example",
        secFetchSite: "same-site",
        expectedOrigin,
      }),
      { allowed: false, reason: "cross-origin" },
    );
    assert.deepEqual(
      evaluateStateChangingRequest({
        method: "POST",
        origin: "null",
        expectedOrigin,
      }),
      { allowed: false, reason: "cross-origin" },
    );
  });

  it("rejects a cross-site Sec-Fetch-Site even with a matching Origin", () => {
    assert.deepEqual(
      evaluateStateChangingRequest({
        method: "PUT",
        origin: expectedOrigin,
        secFetchSite: "cross-site",
        expectedOrigin,
      }),
      { allowed: false, reason: "cross-site-fetch" },
    );
  });

  it("allows a Bearer-authenticated cron call with no Origin and no cookie", () => {
    assert.deepEqual(
      evaluateStateChangingRequest({
        method: "POST",
        origin: null,
        secFetchSite: null,
        cookieHeader: null,
        expectedOrigin,
      }),
      { allowed: true },
    );
  });

  it("allows a server-to-server webhook with no Origin and no cookie", () => {
    assert.deepEqual(
      evaluateStateChangingRequest({
        method: "POST",
        origin: null,
        secFetchSite: null,
        cookieHeader: null,
        expectedOrigin,
      }),
      { allowed: true },
    );
  });

  it("rejects a POST with no Origin when a session cookie is present", () => {
    for (const cookieHeader of [
      "engage_dev_user=member",
      "better-auth.session_token=abc",
      "__Secure-better-auth.session_token=abc",
      "theme=dark; better-auth.session_data=xyz",
    ]) {
      assert.deepEqual(
        evaluateStateChangingRequest({
          method: "POST",
          origin: null,
          cookieHeader,
          expectedOrigin,
        }),
        { allowed: false, reason: "missing-origin-with-session-cookie" },
        cookieHeader,
      );
    }
  });

  it("does not block safe methods", () => {
    for (const method of ["GET", "HEAD", "OPTIONS", "TRACE"]) {
      assert.deepEqual(
        evaluateStateChangingRequest({
          method,
          origin: "https://attacker.example",
          secFetchSite: "cross-site",
          cookieHeader: "better-auth.session_token=abc",
          expectedOrigin,
        }),
        { allowed: true },
      );
    }
  });

  it("detects only authentication cookies", () => {
    assert.equal(hasSessionCookie("theme=dark; locale=en"), false);
    assert.equal(hasSessionCookie(""), false);
    assert.equal(hasSessionCookie(null), false);
    assert.equal(hasSessionCookie("engage_dev_user=member"), true);
    assert.equal(hasSessionCookie("better-auth.session_token=abc"), true);
    assert.equal(hasSessionCookie("__Secure-better-auth.session_token=abc"), true);
    assert.equal(hasSessionCookie("not-better-auth.session_token=abc"), false);
  });
});

describe("content security policy configuration", () => {
  const allDirectives = [
    ...CSP_DIRECTIVES,
    `script-src ${CSP_SCRIPT_RESOURCES.join(" ")}`,
    ...CSP_STYLE_ATTRIBUTE_RESOURCES.map(
      (entry) => `style-src-attr ${entry.resource}`,
    ),
  ].join("; ");

  it("allows the resources the application loads", () => {
    assert.ok(CSP_SCRIPT_RESOURCES.includes("'self'"));
    assert.ok(CSP_SCRIPT_RESOURCES.includes(TURNSTILE_ORIGIN));
    assert.ok(CSP_SCRIPT_RESOURCES.includes(ANALYTICS_ORIGIN));

    const connect = CSP_DIRECTIVES.find((directive) =>
      directive.startsWith("connect-src "),
    );
    assert.ok(connect?.includes("'self'"));
    assert.ok(connect?.includes(TURNSTILE_ORIGIN));
    assert.ok(connect?.includes(ANALYTICS_ORIGIN));

    const frame = CSP_DIRECTIVES.find((directive) =>
      directive.startsWith("frame-src "),
    );
    assert.equal(frame, `frame-src ${TURNSTILE_ORIGIN}`);
  });

  it("locks down documents without unsafe eval or unsafe scripts", () => {
    for (const directive of [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ]) {
      assert.ok(
        CSP_DIRECTIVES.includes(directive as (typeof CSP_DIRECTIVES)[number]),
        `missing ${directive}`,
      );
    }

    assert.equal(/unsafe-eval/.test(allDirectives), false);
    assert.equal(
      CSP_SCRIPT_RESOURCES.join(" ").includes("'unsafe-inline'"),
      false,
      "scripts use Astro hashes, never unsafe-inline",
    );

    // The one documented weakening: inline style attributes are used for
    // progress widths. Stylesheets and <style> elements stay hash-based.
    assert.deepEqual([...CSP_STYLE_ATTRIBUTE_RESOURCES], [
      { resource: "'unsafe-inline'", kind: "attribute" },
    ]);
    for (const directive of CSP_DIRECTIVES) {
      assert.equal(
        directive.includes("style-src"),
        false,
        "style-src is configured through styleDirective, not directives",
      );
    }
  });

  it("keeps Astro's origin check and wires the policy and trusted production host into astro.config.mjs", () => {
    const config = readFileSync(
      new URL("../../astro.config.mjs", import.meta.url),
      "utf8",
    );
    assert.match(config, /checkOrigin:\s*true/);
    assert.match(config, /CSP_DIRECTIVES/);
    assert.match(config, /csp:\s*\{/);
    assert.match(config, /allowedDomains:\s*\[/);
    assert.match(config, /hostname:\s*"engage\.fusionparty\.org\.au"/);
    assert.match(config, /protocol:\s*"https"/);
    assert.equal(/unsafe-eval/.test(config), false);
  });
});
