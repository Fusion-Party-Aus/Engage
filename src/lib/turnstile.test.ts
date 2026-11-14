import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  readTurnstileToken,
  setTurnstileTransportForTests,
  tokenFromBody,
  turnstileConfiguration,
  turnstileFailureResponse,
  verifyTurnstile,
  TURNSTILE_VERIFY_URL,
} from "./turnstile.ts";

const SECRET = "turnstile-test-secret-not-real";
const SITE_KEY = "1x00000000000000000000AA";
const configured = {
  APP_MODE: "development",
  TURNSTILE_ENFORCEMENT: "on",
  TURNSTILE_SECRET_KEY: SECRET,
  PUBLIC_TURNSTILE_SITE_KEY: SITE_KEY,
};

type Captured = { url: string; body: URLSearchParams; init: RequestInit };

function responding(
  payload: unknown,
  capture?: Captured[],
): (url: string, init: RequestInit) => Promise<Response> {
  return async (url, init) => {
    if (capture) {
      capture.push({
        url,
        body: new URLSearchParams(String(init.body)),
        init,
      });
    }
    return new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json" },
    });
  };
}

afterEach(() => setTurnstileTransportForTests(undefined));

describe("Turnstile configuration", () => {
  it("is disabled outside production unless enforcement is explicit", () => {
    assert.equal(turnstileConfiguration({}).state, "disabled");
    assert.equal(
      turnstileConfiguration({
        APP_MODE: "development",
        TURNSTILE_SECRET_KEY: SECRET,
        PUBLIC_TURNSTILE_SITE_KEY: SITE_KEY,
      }).state,
      "disabled",
    );
    assert.equal(
      turnstileConfiguration({
        APP_MODE: "development",
        TURNSTILE_ENFORCEMENT: "on",
        TURNSTILE_SECRET_KEY: SECRET,
        PUBLIC_TURNSTILE_SITE_KEY: SITE_KEY,
      }).state,
      "enforced",
    );
  });

  it("fails closed in production when the secret or site key is missing", () => {
    const neither = turnstileConfiguration({ APP_MODE: "production" });
    assert.equal(neither.state, "misconfigured");
    assert.deepEqual(neither.missing.sort(), [
      "PUBLIC_TURNSTILE_SITE_KEY",
      "TURNSTILE_SECRET_KEY",
    ]);

    const secretOnly = turnstileConfiguration({
      APP_MODE: "production",
      TURNSTILE_SECRET_KEY: SECRET,
    });
    assert.equal(secretOnly.state, "misconfigured");
    assert.deepEqual(secretOnly.missing, ["PUBLIC_TURNSTILE_SITE_KEY"]);

    assert.equal(
      turnstileConfiguration({
        APP_MODE: "production",
        TURNSTILE_SECRET_KEY: SECRET,
        PUBLIC_TURNSTILE_SITE_KEY: SITE_KEY,
      }).state,
      "enforced",
    );
  });

  it("honours an explicit off switch and never reports the secret", () => {
    const off = turnstileConfiguration({
      APP_MODE: "production",
      TURNSTILE_ENFORCEMENT: "off",
    });
    assert.equal(off.state, "disabled");
    assert.equal(JSON.stringify(off).includes(SECRET), false);
  });

  it("treats requested enforcement without keys as misconfigured in any mode", () => {
    const state = turnstileConfiguration({
      APP_MODE: "preview",
      TURNSTILE_ENFORCEMENT: "on",
    });
    assert.equal(state.state, "misconfigured");
    assert.equal(state.reason, "enforcement_requested_without_keys");
  });
});

describe("Turnstile verification", () => {
  it("allows a request when enforcement is disabled", async () => {
    const verdict = await verifyTurnstile({
      token: "",
      env: {},
      transport: async () => {
        throw new Error("must not be called");
      },
    });
    assert.deepEqual(verdict, { ok: true });
  });

  it("refuses protected requests when production is misconfigured", async () => {
    const verdict = await verifyTurnstile({
      token: "anything",
      env: { APP_MODE: "production" },
      transport: async () => {
        throw new Error("must not be called");
      },
    });
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.equal(verdict.code, "TURNSTILE_MISCONFIGURED");
    assert.equal(verdict.status, 503);
    assert.equal(JSON.stringify(verdict).includes(SECRET), false);
  });

  it("requires a token and rejects oversized or malformed tokens without a network call", async () => {
    let calls = 0;
    const transport = async () => {
      calls += 1;
      return new Response("{}");
    };

    for (const [token, code] of [
      ["", "TURNSTILE_REQUIRED"],
      ["   ", "TURNSTILE_REQUIRED"],
      [null, "TURNSTILE_REQUIRED"],
      [123, "TURNSTILE_REQUIRED"],
      ["x".repeat(3000), "TURNSTILE_INVALID"],
    ] as const) {
      const verdict = await verifyTurnstile({
        token,
        env: configured,
        transport,
      });
      assert.equal(verdict.ok, false);
      if (!verdict.ok) assert.equal(verdict.code, code);
    }
    assert.equal(calls, 0);
  });

  it("posts the token to Cloudflare with the secret and no client address", async () => {
    const captured: Captured[] = [];
    const verdict = await verifyTurnstile({
      token: "  token-value  ",
      env: configured,
      expectedAction: "signin",
      transport: responding(
        { success: true, action: "signin", hostname: "engage.example" },
        captured,
      ),
    });

    assert.deepEqual(verdict, { ok: true });
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.url, TURNSTILE_VERIFY_URL);
    assert.equal(captured[0]!.body.get("secret"), SECRET);
    assert.equal(captured[0]!.body.get("response"), "token-value");
    assert.equal(captured[0]!.body.has("remoteip"), false);
    assert.ok(captured[0]!.init.signal);
  });

  it("maps Cloudflare error codes to plain-language failures", async () => {
    for (const [payload, code] of [
      [{ success: false, "error-codes": ["timeout-or-duplicate"] }, "TURNSTILE_EXPIRED"],
      [{ success: false, "error-codes": ["invalid-input-response"] }, "TURNSTILE_INVALID"],
      [{ success: false, "error-codes": ["missing-input-response"] }, "TURNSTILE_INVALID"],
      [{ success: false, "error-codes": ["invalid-input-secret"] }, "TURNSTILE_MISCONFIGURED"],
      [{ success: false, "error-codes": ["internal-error"] }, "TURNSTILE_UNAVAILABLE"],
      [{ success: false }, "TURNSTILE_INVALID"],
    ] as const) {
      const verdict = await verifyTurnstile({
        token: "token-value",
        env: configured,
        transport: responding(payload),
      });
      assert.equal(verdict.ok, false);
      if (!verdict.ok) {
        assert.equal(verdict.code, code);
        assert.ok(verdict.message.length > 10);
        assert.equal(JSON.stringify(verdict).includes(SECRET), false);
      }
    }
  });

  it("treats timeouts, transport errors, HTTP errors and malformed JSON as unavailable", async () => {
    const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    const cases = [
      async () => {
        throw timeout;
      },
      async () => new Response("nope", { status: 502 }),
      async () =>
        new Response("<html>maintenance</html>", {
          headers: { "content-type": "text/html" },
        }),
      async () => new Response(JSON.stringify(null), {
        headers: { "content-type": "application/json" },
      }),
    ];
    for (const transport of cases) {
      const verdict = await verifyTurnstile({
        token: "token-value",
        env: configured,
        transport,
      });
      assert.equal(verdict.ok, false);
      if (!verdict.ok) assert.equal(verdict.code, "TURNSTILE_UNAVAILABLE");
    }
  });

  it("refuses a token issued for a different action or hostname", async () => {
    const wrongAction = await verifyTurnstile({
      token: "token-value",
      env: configured,
      expectedAction: "signin",
      transport: responding({
        success: true,
        action: "sense-box",
        hostname: "engage.example",
      }),
    });
    assert.equal(wrongAction.ok, false);
    if (!wrongAction.ok) assert.equal(wrongAction.code, "TURNSTILE_INVALID");

    const wrongHost = await verifyTurnstile({
      token: "token-value",
      env: { ...configured, TURNSTILE_EXPECTED_HOSTNAME: "engage.example" },
      transport: responding({
        success: true,
        action: "signin",
        hostname: "attacker.example",
      }),
    });
    assert.equal(wrongHost.ok, false);
    if (!wrongHost.ok) assert.equal(wrongHost.code, "TURNSTILE_INVALID");

    const matching = await verifyTurnstile({
      token: "token-value",
      env: { ...configured, TURNSTILE_EXPECTED_HOSTNAME: "engage.example" },
      expectedAction: "signin",
      transport: responding({
        success: true,
        action: "signin",
        hostname: "engage.example",
      }),
    });
    assert.deepEqual(matching, { ok: true });
  });

  it("builds an accessible JSON error response", async () => {
    const response = turnstileFailureResponse({
      ok: false,
      code: "TURNSTILE_REQUIRED",
      message: "Complete the verification check and try again.",
      status: 400,
      retryable: true,
    });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), {
      error: "Complete the verification check and try again.",
      code: "TURNSTILE_REQUIRED",
    });
  });
});

describe("Turnstile token extraction", () => {
  it("prefers the header, then reads JSON and form bodies without consuming them", async () => {
    const headerRequest = new Request("https://engage.test/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-turnstile-token": "header-token",
      },
      body: JSON.stringify({ "cf-turnstile-response": "body-token" }),
    });
    assert.equal(await readTurnstileToken(headerRequest), "header-token");

    const jsonRequest = new Request("https://engage.test/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "member@example.test", "cf-turnstile-response": "body-token" }),
    });
    assert.equal(await readTurnstileToken(jsonRequest), "body-token");
    // The caller can still read its own body.
    assert.equal((await jsonRequest.json()).email, "member@example.test");

    const formRequest = new Request("https://engage.test/api/sense-box", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ "cf-turnstile-response": "form-token" }),
    });
    assert.equal(await readTurnstileToken(formRequest), "form-token");

    const missing = new Request("https://engage.test/api/sense-box", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "member@example.test" }),
    });
    assert.equal(await readTurnstileToken(missing), "");

    const malformed = new Request("https://engage.test/api/sense-box", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    assert.equal(await readTurnstileToken(malformed), "");
  });

  it("recognises both accepted body field names", () => {
    assert.equal(tokenFromBody({ "cf-turnstile-response": "a" }), "a");
    assert.equal(tokenFromBody({ turnstileToken: " b " }), "b");
    assert.equal(tokenFromBody({ token: "not-accepted" }), "");
    assert.equal(tokenFromBody(null), "");
    assert.equal(tokenFromBody([]), "");
  });
});
