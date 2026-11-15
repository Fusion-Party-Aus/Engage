import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Db } from "mongodb";
import { createDevSessionCookie } from "./auth.ts";
import { getDatabase } from "./db.ts";
import { GET as getProfile, POST as postProfile } from "../pages/api/member/profile.ts";
import { MEMBER_BIO_MAX_LENGTH } from "./member-profile.ts";
import type { PlatformEnv } from "./types.ts";

/**
 * Route-level checks for the owner-only biography write. The read model has
 * separate tests; these prove origin enforcement, session enforcement and that
 * one account cannot write another account's profile.
 */

const env: PlatformEnv = { APP_MODE: "development", MONGODB_URI: "" };
const origin = "http://localhost";
const endpoint = `${origin}/api/member/profile`;
const cookie = createDevSessionCookie("member");

let db: Db;

beforeEach(async () => {
  db = await getDatabase(env);
  await db.collection<Record<string, any>>("user").deleteMany({
    _id: { $in: ["dev-member-01", "other-profile-account"] },
  } as any);
  await db.collection<Record<string, any>>("user").insertOne({
    _id: "dev-member-01",
    name: "Local Verified Member",
    email: "member@local.test",
    createdAt: new Date(),
    disabled: false,
  } as any);
  await db.collection<Record<string, any>>("user").insertOne({
    _id: "other-profile-account",
    name: "Other Member",
    email: "other@local.test",
    createdAt: new Date(),
    bio: "Leave me alone.",
    disabled: false,
  } as any);
});

afterEach(async () => {
  await db.collection<Record<string, any>>("user").deleteMany({
    _id: { $in: ["dev-member-01", "other-profile-account"] },
  } as any);
});

function request(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Request {
  return new Request(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function context(req: Request) {
  return {
    request: req,
    locals: { runtime: { env } },
    url: new URL(endpoint),
  } as never;
}

describe("public profile biography route", () => {
  it("requires a session", async () => {
    const response = await postProfile(context(request({ bio: "Hello" })));
    assert.equal(response.status, 401);
  });

  it("rejects a cross-origin write before touching the account", async () => {
    const response = await postProfile(
      context(request({ bio: "Hello" }, { origin: "https://evil.example" })),
    );
    assert.equal(response.status, 403);
    const account = await db
      .collection("user")
      .findOne({ _id: "dev-member-01" as any });
    assert.equal(account?.bio, undefined);
  });

  it("saves only the signed-in account's biography", async () => {
    const response = await postProfile(
      context(request({ bio: "Transparent process matters." }, { cookie })),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      bio: "Transparent process matters.",
    });

    const own = await db
      .collection("user")
      .findOne({ _id: "dev-member-01" as any });
    const other = await db
      .collection("user")
      .findOne({ _id: "other-profile-account" as any });
    assert.equal(own?.bio, "Transparent process matters.");
    assert.equal(other?.bio, "Leave me alone.");
  });

  it("rejects an overlong biography and leaves the stored value unchanged", async () => {
    const response = await postProfile(
      context(
        request(
          { bio: "x".repeat(MEMBER_BIO_MAX_LENGTH + 1) },
          { cookie },
        ),
      ),
    );
    assert.equal(response.status, 400);
    const account = await db
      .collection("user")
      .findOne({ _id: "dev-member-01" as any });
    assert.equal(account?.bio, undefined);
  });

  it("returns the owner's biography and never an email address", async () => {
    await postProfile(
      context(request({ bio: "Public biography." }, { cookie })),
    );
    const response = await getProfile(context(request({}, { cookie })));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload, { bio: "Public biography." });
    assert.equal(JSON.stringify(payload).includes("member@local.test"), false);
  });
});
