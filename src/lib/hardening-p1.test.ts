import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDb } from "./db.ts";
import {
  StandaloneMembershipAuthority,
  parseIdempotencyKey,
} from "./integrations.ts";
import { buildAuthorizedMatterBriefing } from "./read-models.ts";
import { parsePaginationParams } from "./resilience.ts";
import type { SessionUser } from "./types.ts";

describe("P1 integration boundaries, read models, and operational resilience", () => {
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

  it("builds confidentiality-safe matter briefings with bound wording and hides private branch matters", async () => {
    const db = createMemoryDb();
    const now = new Date("2026-11-13T08:00:00Z");

    await db.collection("proposals").insertOne({
      proposalId: "POL-BRIEF",
      slug: "pol-brief",
      title: "Private Branch Policy",
      kind: "policy",
      stage: "decide",
      publicationScope: "private",
      originatingBranchId: "branch-vic",
      governanceAuthorityBranchId: "branch-vic",
      ballotRevisionId: "rev-brief-1",
      createdAt: now,
      updatedAt: now,
    });
    await db.collection("proposal_revisions").insertOne({
      proposalId: "POL-BRIEF",
      revisionId: "rev-brief-1",
      contentHash: "hash-123",
      snapshot: {
        title: "Bound Title",
        summary: "Bound Summary",
        outcomes: ["Outcome 1"],
        details: "Bound Details",
      },
      createdAt: now,
    });

    // Unauthorised outsider cannot view private branch matter
    const outsider: SessionUser = {
      memberId: "m-outsider",
      name: "Outsider",
      email: "out@example.test",
      role: "member",
      status: "verified",
      canParticipate: true,
      isStaff: false,
      isAdmin: false,
      verifiedBranchIds: ["branch-nsw"],
    };
    const deniedBriefing = await buildAuthorizedMatterBriefing(db, "POL-BRIEF", outsider);
    assert.equal(deniedBriefing, null);

    // National admin receives bound wording without identifiable ballots
    const admin: SessionUser = {
      memberId: "m-admin",
      name: "Admin",
      email: "admin@example.test",
      role: "administrator",
      status: "verified",
      canParticipate: true,
      isStaff: true,
      isAdmin: true,
    };
    const briefing = await buildAuthorizedMatterBriefing(db, "POL-BRIEF", admin);
    assert.ok(briefing);
    assert.equal(briefing.boundRevision?.revisionId, "rev-brief-1");
    assert.equal(briefing.boundRevision?.title, "Bound Title");
    assert.equal(briefing.confidentiality.identifiableBallotsIncluded, false);
    assert.equal(briefing.confidentiality.viewerHasIdentifiableAccess, true);
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
