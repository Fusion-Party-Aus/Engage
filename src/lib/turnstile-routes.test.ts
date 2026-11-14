import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ALL as authRoute } from "../pages/api/auth/[...all].ts";
import { POST as submitSense } from "../pages/api/sense-box.ts";
import { POST as castVoteRoute } from "../pages/api/votes.ts";
import { createDevSessionCookie } from "./auth.ts";
import { closeDatabase, getDatabase } from "./db.ts";
import { resolveLegacyPermissions } from "./rbac.ts";
import { saveProposal } from "./store.ts";
import { setTurnstileTransportForTests } from "./turnstile.ts";
import {
  enforceAbuseProtection,
  protectedAuthAction,
} from "./turnstile-guard.ts";
import type { SessionUser } from "./types.ts";

const SITE_KEY = "1x00000000000000000000AA";
const SECRET = "route-test-turnstile-secret";

const env = {
  APP_MODE: "development",
  // No database URI: the route falls back to the in-memory database.
  MONGODB_URI: "",
  MONGODB_DB_NAME: "",
  PUBLIC_ORIGIN: "https://engage.test",
  TURNSTILE_ENFORCEMENT: "on",
  TURNSTILE_SECRET_KEY: SECRET,
  PUBLIC_TURNSTILE_SITE_KEY: SITE_KEY,
  RATE_LIMIT_SECRET: "route-test-rate-limit-secret",
  SESSION_SECRET: "route-test-session-secret",
};

const locals = { runtime: { env } };

// A login-configured environment. `memory://` makes `getDatabase` fall back to
// the in-memory database immediately, so the auth route runs without a network
// or a real MongoDB.
const authEnv = {
  ...env,
  MONGODB_URI: "memory://engage-turnstile-route-test",
  MONGODB_DB_NAME: "engage_turnstile_route",
  BETTER_AUTH_URL: "https://engage.test",
  BETTER_AUTH_SECRET: "r".repeat(48),
  RESEND_API_KEY: "re_route_test_key",
  AUTH_EMAIL_FROM: "Engage <no-reply@engage.test>",
};
const authLocals = { runtime: { env: authEnv } };
let sequence = 0;

function senseBody(overrides: Record<string, unknown> = {}) {
  sequence += 1;
  return {
    requestId: crypto.randomUUID(),
    branchId: "branch-nat",
    title: `Regional transport ${sequence}`,
    detail: "More frequent trains would help our community.",
    locality: "Bendigo",
    topic: "transport",
    consent: true,
    ...overrides,
  };
}

function senseRequest(
  body: Record<string, unknown>,
  options: { token?: string; address?: string } = {},
): Parameters<typeof submitSense>[0] {
  const url = new URL("https://engage.test/api/sense-box");
  const payload =
    options.token === undefined
      ? body
      : { ...body, "cf-turnstile-response": options.token };
  const request = new Request(url, {
    method: "POST",
    headers: {
      origin: "https://engage.test",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return {
    request,
    url,
    locals,
    clientAddress: options.address ?? "203.0.113.5",
  } as unknown as Parameters<typeof submitSense>[0];
}

function authRequest(
  path: string,
  body: Record<string, unknown>,
  options: { token?: string; address?: string; context?: typeof locals } = {},
): Parameters<typeof authRoute>[0] {
  const url = new URL(path, "https://engage.test");
  const headers = new Headers({
    origin: "https://engage.test",
    "content-type": "application/json",
  });
  if (options.token) headers.set("x-turnstile-token", options.token);
  if (options.address) headers.set("cf-connecting-ip", options.address);
  return {
    request: new Request(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    url,
    locals: options.context ?? locals,
  } as unknown as Parameters<typeof authRoute>[0];
}

function verifying(action: string) {
  return async () =>
    Response.json({ success: true, action, hostname: "engage.test" });
}

afterEach(() => setTurnstileTransportForTests(undefined));

describe("public Sense Box route", () => {
  it("refuses a submission without a verification token and stores nothing", async () => {
    setTurnstileTransportForTests(async () => {
      throw new Error("Cloudflare must not be contacted without a token");
    });
    const body = senseBody();
    const response = await submitSense(senseRequest(body));
    assert.equal(response.status, 400);
    const json = await response.json();
    assert.equal(json.code, "TURNSTILE_REQUIRED");
    assert.match(json.error, /verification check/i);

    const db = await getDatabase(env);
    const stored = await db
      .collection("sense_submissions")
      .findOne({ submissionId: body.requestId });
    assert.equal(stored, null);
  });

  it("refuses an invalid or expired token with a plain-language error", async () => {
    for (const [payload, code] of [
      [{ success: false, "error-codes": ["invalid-input-response"] }, "TURNSTILE_INVALID"],
      [{ success: false, "error-codes": ["timeout-or-duplicate"] }, "TURNSTILE_EXPIRED"],
    ] as const) {
      setTurnstileTransportForTests(async () => Response.json(payload));
      const response = await submitSense(
        senseRequest(senseBody(), { token: "unusable-token", address: "198.51.100.20" }),
      );
      assert.equal(response.status, 400);
      const json = await response.json();
      assert.equal(json.code, code);
      assert.equal(JSON.stringify(json).includes(SECRET), false);
    }
  });

  it("accepts a verified submission and sends the expected action to Cloudflare", async () => {
    const captured: URLSearchParams[] = [];
    setTurnstileTransportForTests(async (_url, init) => {
      captured.push(new URLSearchParams(String(init.body)));
      return Response.json({
        success: true,
        action: "sense-box",
        hostname: "engage.test",
      });
    });

    const body = senseBody();
    const response = await submitSense(
      senseRequest(body, { token: "valid-token", address: "198.51.100.21" }),
    );
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { saved: true });

    const db = await getDatabase(env);
    const stored = await db
      .collection("sense_submissions")
      .findOne({ submissionId: body.requestId });
    assert.ok(stored, "the submission must be persisted");
    assert.equal(stored?.title, body.title);

    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.get("response"), "valid-token");
    assert.equal(captured[0]!.get("secret"), SECRET);
  });

  it("treats a replayed token as expired", async () => {
    const used = new Set<string>();
    setTurnstileTransportForTests(async (_url, init) => {
      const token = new URLSearchParams(String(init.body)).get("response") ?? "";
      if (used.has(token)) {
        return Response.json({
          success: false,
          "error-codes": ["timeout-or-duplicate"],
        });
      }
      used.add(token);
      return Response.json({ success: true, action: "sense-box" });
    });

    const first = await submitSense(
      senseRequest(senseBody(), { token: "one-shot-token", address: "198.51.100.22" }),
    );
    assert.equal(first.status, 201);

    const replay = await submitSense(
      senseRequest(senseBody(), { token: "one-shot-token", address: "198.51.100.22" }),
    );
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).code, "TURNSTILE_EXPIRED");
  });

  it("shares one submission budget per address and reports Retry-After", async () => {
    setTurnstileTransportForTests(verifying("sense-box"));
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await submitSense(
        senseRequest(senseBody(), {
          token: `rate-token-${attempt}`,
          address: "198.51.100.90",
        }),
      );
      statuses.push(response.status);
      if (response.status === 429) {
        assert.ok(Number(response.headers.get("retry-after")) > 0);
        assert.equal((await response.json()).code, "RATE_LIMITED");
      }
    }
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(201));
    assert.equal(statuses[10], 429);
  });
});

describe("abuse protection for authentication requests", () => {
  it("maps only the routes that send email or create an account", () => {
    assert.equal(
      protectedAuthAction("/api/auth/sign-in/magic-link"),
      "auth-magic-link",
    );
    assert.equal(protectedAuthAction("/sign-in/magic-link/"), "auth-magic-link");
    assert.equal(protectedAuthAction("/api/auth/sign-up/email"), "auth-sign-up");
    for (const path of [
      "/api/auth/sign-in/passkey",
      "/api/auth/sign-in/social",
      "/api/auth/get-session",
      "/api/auth/callback/google",
    ]) {
      assert.equal(protectedAuthAction(path), null, `${path} must not be challenged`);
    }
  });

  it("refuses a magic-link request without a token and never reaches Better Auth", async () => {
    let transportCalls = 0;
    setTurnstileTransportForTests(async () => {
      transportCalls += 1;
      throw new Error("Cloudflare must not be contacted without a token");
    });
    const response = await authRoute(
      authRequest(
        "/api/auth/sign-in/magic-link",
        { email: "member@example.test" },
        { context: authLocals, address: "203.0.113.40" },
      ),
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "TURNSTILE_REQUIRED");
    assert.equal(transportCalls, 0);
  });

  it("continues to Better Auth when the token verifies", async () => {
    setTurnstileTransportForTests(verifying("signin"));
    let response: Response | undefined;
    let failure: unknown;
    try {
      response = await authRoute(
        authRequest(
          "/api/auth/sign-in/magic-link",
          // Better Auth rejects this address itself, so no email is sent. The
          // point of the test is that the Turnstile gate did not refuse it.
          { email: "not-an-email" },
          { context: authLocals, token: "verified-token", address: "203.0.113.41" },
        ),
      );
    } catch (error) {
      failure = error;
    }

    if (failure) {
      // The in-memory preview cannot run Better Auth's own database rate
      // limiter (it needs `aggregate`). Reaching that point proves the gate
      // allowed the request; record the limitation instead of pretending.
      assert.doesNotMatch(
        String((failure as Error).message),
        /TURNSTILE_|RATE_LIMITED/,
      );
      return;
    }

    const payload = await response!.json().catch(() => ({}));
    assert.notEqual(payload.code, "RATE_LIMITED");
    assert.equal(
      typeof payload.code === "string" && payload.code.startsWith("TURNSTILE_"),
      false,
      `the gate must not refuse a verified request: ${JSON.stringify(payload)}`,
    );
    // Better Auth's own validation is the next thing that can fail; a 503 here
    // would mean the gate or the auth stack was still unavailable.
    assert.notEqual(response!.status, 503);
  });

  it(
    "lets a verified magic-link request reach Better Auth on real MongoDB",
    { skip: !process.env.VOTING_TEST_MONGODB_URI },
    async () => {
      const dbName = `engage_turnstile_auth_${crypto.randomUUID().replaceAll("-", "")}`;
      const realEnv = {
        ...authEnv,
        MONGODB_URI: process.env.VOTING_TEST_MONGODB_URI!,
        MONGODB_DB_NAME: dbName,
      };
      try {
        // Clear any development fallback recorded by the in-memory tests.
        await closeDatabase();
        setTurnstileTransportForTests(verifying("signin"));
        const response = await authRoute(
          authRequest(
            "/api/auth/sign-in/magic-link",
            { email: "not-an-email" },
            {
              context: { runtime: { env: realEnv } },
              token: "verified-token",
              address: "203.0.113.42",
            },
          ),
        );
        const payload = await response.json().catch(() => ({}));
        // Better Auth rejects the malformed address; the security gate let the
        // request through and no email was sent.
        assert.equal(response.status, 400);
        assert.notEqual(payload.code, "RATE_LIMITED");
        assert.equal(
          typeof payload.code === "string" &&
            payload.code.startsWith("TURNSTILE_"),
          false,
        );
      } finally {
        await (await getDatabase(realEnv)).dropDatabase();
        await closeDatabase();
      }
    },
  );
});

describe("abuse protection guard", () => {
  it("returns null once a token verifies, and reports the expected action", async () => {
    const db = await getDatabase(env);
    const captured: string[] = [];
    setTurnstileTransportForTests(async (_url, init) => {
      captured.push(String(init.body));
      return Response.json({ success: true, action: "signin" });
    });
    const refusal = await enforceAbuseProtection({
      request: new Request("https://engage.test/api/auth/sign-in/magic-link", {
        method: "POST",
        headers: { "cf-connecting-ip": "203.0.113.31" },
      }),
      env,
      db,
      action: "auth-magic-link",
      token: "verified-token",
    });
    assert.equal(refusal, null);
    assert.equal(captured.length, 1);
    assert.match(captured[0]!, /response=verified-token/);
  });

  it("refuses without a token before contacting Cloudflare", async () => {
    const db = await getDatabase(env);
    let calls = 0;
    setTurnstileTransportForTests(async () => {
      calls += 1;
      return Response.json({ success: true, action: "signin" });
    });
    const refusal = await enforceAbuseProtection({
      request: new Request("https://engage.test/api/auth/sign-in/magic-link", {
        method: "POST",
        headers: { "cf-connecting-ip": "203.0.113.32" },
      }),
      env,
      db,
      action: "auth-magic-link",
      token: "",
    });
    assert.ok(refusal);
    assert.equal(refusal!.status, 400);
    assert.equal((await refusal!.json()).code, "TURNSTILE_REQUIRED");
    assert.equal(calls, 0);
  });
});

describe("authenticated voting", () => {
  it("is not challenged by Turnstile or the unauthenticated rate limiter", async () => {
    const db = await getDatabase(env);
    const admin: SessionUser = {
      memberId: "route-test-admin",
      name: "Route Test Admin",
      email: "admin@engage.test",
      status: "verified",
      role: "administrator",
      roles: ["administrator"],
      permissions: resolveLegacyPermissions(["administrator"], []),
      canParticipate: true,
      isStaff: true,
      isAdmin: true,
      isBranchAdmin: false,
      branchAdminIds: [],
      activeBranchIds: [],
    };
    const proposal = await saveProposal(db, admin, {
      title: `Turnstile exemption ${crypto.randomUUID().slice(0, 8)}`,
      space: "Governance",
      summary: "Authenticated voting must not require a challenge.",
      stage: "decide",
      ballotClosesAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    });

    let transportCalls = 0;
    setTurnstileTransportForTests(async () => {
      transportCalls += 1;
      throw new Error("voting must not be challenged");
    });

    const before = await db.collection("rate_limits").countDocuments();
    const url = new URL("https://engage.test/api/votes");
    const request = new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: createDevSessionCookie("member"),
      },
      body: JSON.stringify({ proposalId: proposal.proposalId, choice: "approve" }),
    });
    const response = await castVoteRoute({
      request,
      url,
      locals,
    } as unknown as Parameters<typeof castVoteRoute>[0]);

    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    assert.equal(result.choice, "approve");
    assert.equal(transportCalls, 0, "voting must not call Turnstile");

    // No rate-limit budget was consumed for the voting address.
    assert.equal(await db.collection("rate_limits").countDocuments(), before);
  });
});
