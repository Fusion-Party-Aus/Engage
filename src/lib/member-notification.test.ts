import { test } from "node:test";
import assert from "node:assert/strict";
import { POST, PATCH } from "../pages/api/admin/members.ts";

test("verification reports email delivery without undoing account changes", async () => {
  const originalFetch = globalThis.fetch;
  let shouldFail = false;
  globalThis.fetch = async () =>
    shouldFail
      ? new Response(null, { status: 503 })
      : Response.json({ id: "synthetic" });
  const locals = {
    env: {
      APP_MODE: "preview",
      MONGODB_URI: "",
      RESEND_API_KEY: "synthetic",
      AUTH_EMAIL_FROM: "test@example.test",
      BETTER_AUTH_URL: "https://example.test",
    },
  };
  const request = (method: string, body: object) =>
    new Request("https://example.test/api/admin/members", {
      method,
      headers: {
        cookie: "engage_dev_user=administrator",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  try {
    const email = `member-${crypto.randomUUID()}@example.test`;
    const created = await POST({
      request: request("POST", {
        name: "Synthetic Member",
        email,
        status: "pending",
      }),
      locals,
    } as never);
    assert.equal(created.status, 201);
    const { memberId } = (await created.json()) as { memberId: string };
    shouldFail = true;
    const updated = await PATCH({
      request: request("PATCH", { memberId, status: "verified" }),
      locals,
    } as never);
    assert.equal(updated.status, 200);
    assert.equal(
      ((await updated.json()) as { notification: string }).notification,
      "held",
    );
    shouldFail = false;
    const unchanged = await PATCH({
      request: request("PATCH", { memberId, status: "verified" }),
      locals,
    } as never);
    assert.equal(
      ((await unchanged.json()) as { notification: string }).notification,
      "not-needed",
    );
    const disabled = await PATCH({
      request: request("PATCH", { memberId, disabled: true }),
      locals,
    } as never);
    assert.equal(
      ((await disabled.json()) as { notification: string }).notification,
      "not-needed",
    );
    const reenabled = await PATCH({
      request: request("PATCH", { memberId, disabled: false }),
      locals,
    } as never);
    assert.equal(
      ((await reenabled.json()) as { notification: string }).notification,
      "not-needed",
    );
    const preverified = await POST({
      request: request("POST", {
        name: "Synthetic Member",
        email: `new-${crypto.randomUUID()}@example.test`,
        status: "verified",
      }),
      locals,
    } as never);
    assert.equal(preverified.status, 201);
    assert.equal(
      ((await preverified.json()) as { notification: string }).notification,
      "sent",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
