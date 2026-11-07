import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoClient } from "mongodb";
import {
  createEngageAuth,
  devLoginEnabled,
  getSessionUser,
} from "./auth.ts";
import { POST as createDevSession } from "../pages/api/session.ts";

const uri = process.env.AUTH_TEST_MONGODB_URI;

function devRequest(role: "member" | "administrator"): Request {
  return new Request("http://localhost/api/session", {
    headers: { Cookie: `engage_dev_user=${role}` },
  });
}

test("production ignores the development login cookie", async () => {
  const user = await getSessionUser(devRequest("administrator"), {
    APP_MODE: "production",
  });
  assert.equal(user, null);
});

test("explicit development and preview modes allow local sign-in", async () => {
  const development = await getSessionUser(devRequest("administrator"), {
    APP_MODE: "development",
  });
  assert.equal(development?.role, "administrator");
  assert.equal(development?.isAdmin, true);

  const preview = await getSessionUser(devRequest("member"), {
    APP_MODE: "preview",
  });
  assert.equal(preview?.role, "member");
  assert.equal(preview?.isAdmin, false);
});

test("missing or inconsistent APP_MODE fails closed for development sign-in", async () => {
  for (const env of [
    {},
    { APP_MODE: "" },
    { APP_MODE: "prod" },
    { APP_MODE: "Production" },
    { APP_MODE: "staging" },
  ]) {
    assert.equal(devLoginEnabled(env), false);
    assert.equal(await getSessionUser(devRequest("administrator"), env), null);
  }
});

test("unknown development cookie values do not authenticate", async () => {
  const user = await getSessionUser(
    new Request("http://localhost/api/session", {
      headers: { Cookie: "engage_dev_user=superuser" },
    }),
    { APP_MODE: "development" },
  );
  assert.equal(user, null);
});

test("development sign-in endpoint fails closed outside explicit development modes", async () => {
  const call = (env: { APP_MODE?: string }) =>
    createDevSession({
      request: new Request("http://localhost/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "administrator" }),
      }),
      locals: { runtime: { env } },
    } as never);

  for (const env of [
    { APP_MODE: "production" },
    {},
    { APP_MODE: "" },
    { APP_MODE: "prod" },
    { APP_MODE: "staging" },
  ]) {
    const response = await call(env);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("set-cookie"), null);
  }

  const development = await call({ APP_MODE: "development" });
  assert.equal(development.status, 200);
  assert.match(
    development.headers.get("set-cookie") ?? "",
    /engage_dev_user=administrator/,
  );
});

test(
  "Google links a pre-created account only when its email is verified",
  { skip: !uri },
  async () => {
    const client = await new MongoClient(uri!).connect();
    const db = client.db(
      `engage_auth_test_${crypto.randomUUID().replaceAll("-", "")}`,
    );
    try {
      for (const verified of [true, false]) {
        await db.collection("user").insertOne({
          name: "Synthetic Member",
          email: `${verified}@example.test`,
          emailVerified: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
      const auth = createEngageAuth(db, {
        APP_MODE: "production",
        BETTER_AUTH_URL: "https://example.test",
        BETTER_AUTH_SECRET: "synthetic-secret-at-least-32-characters-long",
        GOOGLE_CLIENT_ID: "synthetic",
        GOOGLE_CLIENT_SECRET: "synthetic",
      });
      const context = await auth.$context;
      const provider = context.socialProviders.find(
        (item) => item.id === "google",
      )!;
      provider.validateAuthorizationCode = async () => ({
        idToken: "synthetic",
      });
      for (const verified of [true, false]) {
        const subject = `synthetic-${verified}`;
        provider.getUserInfo = async () => ({
          user: {
            email: `${verified}@example.test`,
            emailVerified: verified,
            name: "Synthetic Member",
          },
          data: { sub: subject },
        });
        const start = await auth.handler(
          new Request("https://example.test/api/auth/sign-in/social", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: "https://example.test",
            },
            body: JSON.stringify({
              provider: "google",
              callbackURL: "/member/",
            }),
          }),
        );
        assert.equal(start.status, 200);
        const body = (await start.json()) as { url: string };
        const state = new URL(body.url).searchParams.get("state");
        assert.ok(state);
        const cookie = start.headers
          .getSetCookie()
          .map((item) => item.split(";")[0])
          .join("; ");
        const callback = await auth.handler(
          new Request(
            `https://example.test/api/auth/callback/google?code=synthetic&state=${encodeURIComponent(state)}`,
            { headers: { cookie } },
          ),
        );
        const hasSession = callback.headers
          .getSetCookie()
          .some((item) =>
            item.startsWith("__Secure-better-auth.session_token="),
          );
        assert.equal(hasSession, verified);
        assert.equal(
          Boolean(
            await db.collection("account").findOne({ accountId: subject }),
          ),
          verified,
        );
        assert.equal(
          await db
            .collection("user")
            .countDocuments({ email: `${verified}@example.test` }),
          1,
        );
      }
    } finally {
      await db.dropDatabase();
      await client.close();
    }
  },
);
