import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDb } from "./db.ts";
import {
  StandaloneMembershipAuthority,
  parseIdempotencyKey,
} from "./integrations.ts";
import { parsePaginationParams } from "./resilience.ts";

describe("P1 integration boundaries and operational resilience", () => {
  it("verifies branch membership standalone without requiring external CRM availability", async () => {
    const db = createMemoryDb();
    await db.collection("branch_memberships").insertOne({
      memberId: "m-1",
      branchId: "branch-vic",
      status: "active",
      source: "engage-local",
    });

    const adapter = new StandaloneMembershipAuthority();
    const active = await adapter.verifyMembership(db, "m-1", "branch-vic");
    assert.equal(active.verified, true);
    assert.equal(active.source, "engage-local");

    const missing = await adapter.verifyMembership(db, "m-1", "branch-nsw");
    assert.equal(missing.verified, false);
  });

  it("validates Idempotency-Key headers safely", () => {
    const validReq = new Request("https://example.test", {
      headers: { "idempotency-key": "req-123" },
    });
    assert.equal(parseIdempotencyKey(validReq), "req-123");

    const missingReq = new Request("https://example.test");
    assert.equal(parseIdempotencyKey(missingReq), null);

    const tooLongReq = new Request("https://example.test", {
      headers: { "idempotency-key": "x".repeat(201) },
    });
    assert.equal(parseIdempotencyKey(tooLongReq), null);
  });

  it("bounds pagination parameters to safe defaults and maximums", () => {
    const clamped = parsePaginationParams(
      new URL("https://example.test/api?page=0&limit=99999"),
      { defaultLimit: 25, maxLimit: 100 },
    );
    assert.equal(clamped.page, 1);
    assert.equal(clamped.limit, 100);
    assert.equal(clamped.skip, 0);

    const pageTwo = parsePaginationParams(
      new URL("https://example.test/api?page=2&limit=20"),
    );
    assert.equal(pageTwo.page, 2);
    assert.equal(pageTwo.limit, 20);
    assert.equal(pageTwo.skip, 20);
  });
});
