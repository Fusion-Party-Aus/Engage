import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MongoClient } from "mongodb";
import { createMemoryDb } from "./db.ts";
import {
  clientAddress,
  consumeRateLimit,
  hashRateLimitIdentifier,
  RATE_LIMIT_COLLECTION,
  RATE_LIMITS,
  rateLimitDocumentId,
  rateLimitResponse,
} from "./rate-limit.ts";

// Aligned to a 60-second boundary so window maths is explicit.
const WINDOW_START = 1_699_999_980_000;
const rule = { limit: 3, windowMs: 60_000 };

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://engage.test/api/sense-box", {
    method: "POST",
    headers,
  });
}

describe("rate limit windows", () => {
  it("allows the configured number of requests and refuses the next one", async () => {
    const db = createMemoryDb();
    const outcomes = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      outcomes.push(
        await consumeRateLimit(db, {
          action: "sense-box-submit",
          identifier: "203.0.113.9",
          now: WINDOW_START + 1_000,
          rule,
          env: { BETTER_AUTH_SECRET: "test-secret" },
        }),
      );
    }

    assert.deepEqual(outcomes.map((entry) => entry.allowed), [
      true,
      true,
      true,
      false,
    ]);
    assert.deepEqual(outcomes.map((entry) => entry.remaining), [2, 1, 0, 0]);
    assert.equal(outcomes[3]!.retryAfterSeconds, 59);
    assert.equal(outcomes[0]!.windowStart.getTime(), WINDOW_START);
    assert.equal(outcomes[0]!.resetAt.getTime(), WINDOW_START + 60_000);
  });

  it("starts a fresh budget in the next window and keeps stale rows harmless", async () => {
    const db = createMemoryDb();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await consumeRateLimit(db, {
        action: "sense-box-submit",
        identifier: "203.0.113.9",
        now: WINDOW_START,
        rule,
        env: { BETTER_AUTH_SECRET: "test-secret" },
      });
    }
    const exhausted = await consumeRateLimit(db, {
      action: "sense-box-submit",
      identifier: "203.0.113.9",
      now: WINDOW_START + 59_000,
      rule,
      env: { BETTER_AUTH_SECRET: "test-secret" },
    });
    assert.equal(exhausted.allowed, false);

    const nextWindow = await consumeRateLimit(db, {
      action: "sense-box-submit",
      identifier: "203.0.113.9",
      now: WINDOW_START + 60_000,
      rule,
      env: { BETTER_AUTH_SECRET: "test-secret" },
    });
    assert.equal(nextWindow.allowed, true);
    assert.equal(nextWindow.remaining, 2);
    // The previous window's counter remains until the TTL monitor removes it;
    // it cannot grant requests because the window is part of the document key.
    assert.equal(await db.collection(RATE_LIMIT_COLLECTION).countDocuments(), 2);
  });

  it("isolates budgets by action and by subject", async () => {
    const db = createMemoryDb();
    const env = { BETTER_AUTH_SECRET: "test-secret" };
    const base = {
      now: WINDOW_START,
      rule,
      env,
    } as const;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await consumeRateLimit(db, {
        ...base,
        action: "sense-box-submit",
        identifier: "203.0.113.9",
      });
    }
    assert.equal(
      (
        await consumeRateLimit(db, {
          ...base,
          action: "auth-magic-link",
          identifier: "203.0.113.9",
        })
      ).allowed,
      true,
    );
    assert.equal(
      (
        await consumeRateLimit(db, {
          ...base,
          action: "sense-box-submit",
          identifier: "198.51.100.4",
        })
      ).allowed,
      true,
    );
  });

  it("stores only a keyed hash of the subject and marks the expiry", async () => {
    const db = createMemoryDb();
    const address = "203.0.113.9";
    const env = { BETTER_AUTH_SECRET: "test-secret" };
    await consumeRateLimit(db, {
      action: "sense-box-submit",
      identifier: address,
      now: WINDOW_START,
      rule,
      env,
    });

    const rows = await db.collection(RATE_LIMIT_COLLECTION).find({}).toArray();
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.action, "sense-box-submit");
    assert.equal(
      row.identifierHash,
      hashRateLimitIdentifier(`sense-box-submit:${address}`, "test-secret"),
    );
    assert.equal(row.count, 1);
    assert.equal(new Date(row.expiresAt).getTime(), WINDOW_START + 60_000);
    assert.equal(new Date(row.windowStart).getTime(), WINDOW_START);
    assert.equal(JSON.stringify(rows).includes(address), false);
  });

  it("uses a different document key per window and per action", () => {
    const hash = hashRateLimitIdentifier("sense-box-submit:203.0.113.9", "s");
    const first = rateLimitDocumentId("sense-box-submit", 1, hash);
    assert.notEqual(first, rateLimitDocumentId("sense-box-submit", 2, hash));
    assert.notEqual(first, rateLimitDocumentId("auth-magic-link", 1, hash));
    assert.equal(first.length, 32);
  });

  it("declares a sensible default for every protected action", () => {
    for (const [action, defaults] of Object.entries(RATE_LIMITS)) {
      assert.ok(defaults.limit > 0, `${action} needs a positive limit`);
      assert.ok(defaults.windowMs >= 60_000, `${action} window is too short`);
    }
    assert.equal(RATE_LIMITS["sense-box-submit"].limit, 10);
  });
});

describe("client address resolution", () => {
  it("prefers Cloudflare, then the proxy header, then the socket address", () => {
    assert.equal(
      clientAddress(
        request({
          "cf-connecting-ip": "203.0.113.7",
          "x-real-ip": "198.51.100.1",
          "x-forwarded-for": "192.0.2.1, 10.0.0.1",
        }),
      ),
      "203.0.113.7",
    );
    assert.equal(
      clientAddress(request({ "x-real-ip": "198.51.100.1" })),
      "198.51.100.1",
    );
    assert.equal(
      clientAddress(request({ "x-forwarded-for": "192.0.2.1, 10.0.0.1" })),
      "192.0.2.1",
    );
    assert.equal(clientAddress(request(), "127.0.0.1"), "127.0.0.1");
    assert.equal(clientAddress(request()), "unknown");
  });

  it("bounds an oversized forwarded value", () => {
    const address = clientAddress(request({ "cf-connecting-ip": "a".repeat(500) }));
    assert.equal(address.length, 200);
  });
});

describe("rate limit response", () => {
  it("returns 429 with a retry hint and no internal detail", async () => {
    const db = createMemoryDb();
    const decision = await consumeRateLimit(db, {
      action: "sense-box-submit",
      identifier: "203.0.113.9",
      rule: { limit: 1, windowMs: 60_000 },
      now: WINDOW_START,
      env: { BETTER_AUTH_SECRET: "test-secret" },
    });
    await consumeRateLimit(db, {
      action: "sense-box-submit",
      identifier: "203.0.113.9",
      rule: { limit: 1, windowMs: 60_000 },
      now: WINDOW_START,
      env: { BETTER_AUTH_SECRET: "test-secret" },
    });
    const refusal = await consumeRateLimit(db, {
      action: "sense-box-submit",
      identifier: "203.0.113.9",
      rule: { limit: 1, windowMs: 60_000 },
      now: WINDOW_START,
      env: { BETTER_AUTH_SECRET: "test-secret" },
    });
    assert.equal(decision.allowed, true);

    const response = rateLimitResponse(refusal);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "60");
    assert.deepEqual(await response.json(), {
      error: "Too many attempts. Please wait a few minutes and try again.",
      code: "RATE_LIMITED",
    });
  });
});

const uri = process.env.VOTING_TEST_MONGODB_URI;

describe("durable rate limits on real MongoDB", { skip: !uri }, () => {
  it("shares one budget across application instances and creates the TTL index", async () => {
    assert.ok(uri);
    const dbName = `engage_rate_limit_${crypto.randomUUID().replaceAll("-", "")}`;
    const clients = await Promise.all([
      new MongoClient(uri!).connect(),
      new MongoClient(uri!).connect(),
    ]);
    try {
      const [dbA, dbB] = [clients[0]!.db(dbName), clients[1]!.db(dbName)];
      const env = { BETTER_AUTH_SECRET: "rate-limit-test-secret" };
      const now = Math.ceil((Date.now() + 3_600_000) / 60_000) * 60_000;
      const input = {
        action: "auth-magic-link" as const,
        identifier: "203.0.113.44",
        now,
        rule: { limit: 5, windowMs: 60_000 },
        env,
      };

      const results = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          consumeRateLimit(index % 2 === 0 ? dbA : dbB, input),
        ),
      );
      assert.equal(results.filter((entry) => entry.allowed).length, 5);

      const rows = await dbA.collection(RATE_LIMIT_COLLECTION).find({}).toArray();
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.count, 20);
      assert.equal(new Date(rows[0]!.expiresAt).getTime(), now + 60_000);
      assert.equal(
        JSON.stringify(rows).includes(input.identifier),
        false,
        "raw addresses must never be stored",
      );

      const indexes = await dbA.collection(RATE_LIMIT_COLLECTION).indexes();
      const ttl = indexes.find((index) => index.name === "rate_limit_expiry");
      assert.ok(ttl, "the TTL index must exist");
      assert.equal(ttl!.expireAfterSeconds, 0);
      assert.deepEqual(ttl!.key, { expiresAt: 1 });

      // The next window is independent of the exhausted one.
      const next = await consumeRateLimit(dbB, {
        ...input,
        now: now + 60_000,
      });
      assert.equal(next.allowed, true);
      assert.equal(next.remaining, 4);
    } finally {
      // Drop from one connection only: concurrent drops on the same database
      // fail with DatabaseDropPending.
      await clients[0]!.db(dbName).dropDatabase().catch(() => {});
      await Promise.all(clients.map((client) => client.close()));
    }
  });
});
