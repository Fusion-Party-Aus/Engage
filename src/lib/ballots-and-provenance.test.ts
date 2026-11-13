import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDb } from "./db.ts";
import {
  BALLOTS_COLLECTION,
  BallotDomainError,
  listMatterBallots,
  recordFormalDecision,
  upsertMatterBallot,
} from "./ballots.ts";
import {
  GOVERNANCE_EVENTS_COLLECTION,
  GovernanceRelationshipError,
  detectCircularSupersession,
  recordGovernanceEvent,
  recordGovernanceRelationship,
} from "./governance-relationships.ts";

describe("decoupled ballots, formal decisions, and governance provenance", () => {
  it("supports distinct ballot records, one-to-many matter ballots, and legacy synthesis", async () => {
    const db = createMemoryDb();
    const now = new Date("2026-11-13T08:00:00Z");

    await db.collection("proposals").insertOne({
      proposalId: "POL-MULTI",
      slug: "pol-multi",
      title: "Multi-ballot policy",
      kind: "policy",
      stage: "decide",
      ballotRevisionId: "rev-1",
      publicationScope: "national",
      createdAt: now,
      updatedAt: now,
    });

    // Primary ballot + additional consultation/amendment ballot on same matter
    const primary = await upsertMatterBallot(db, {
      ballotId: "proposal:POL-MULTI",
      matterId: "POL-MULTI",
      matterType: "policy",
      purpose: "matter_adoption",
      revisionId: "rev-1",
      now,
    });
    const secondary = await upsertMatterBallot(db, {
      ballotId: "POL-MULTI:consultation:1",
      matterId: "POL-MULTI",
      matterType: "policy",
      purpose: "consultation",
      revisionId: "rev-1",
      now,
    });

    assert.equal(primary.ballotId, "proposal:POL-MULTI");
    assert.equal(secondary.purpose, "consultation");

    const list = await listMatterBallots(db, "POL-MULTI");
    assert.equal(list.length, 2);

    // Rejects silently rebinding an existing ballot to a different wording revision
    await assert.rejects(
      upsertMatterBallot(db, {
        ballotId: "proposal:POL-MULTI",
        matterId: "POL-MULTI",
        revisionId: "rev-2",
        now,
      }),
      (err: unknown) =>
        err instanceof BallotDomainError && err.code === "BALLOT_REVISION_CONFLICT",
    );

    // Formal decision certifies the ballot and cannot be overwritten
    const decision = await recordFormalDecision(db, {
      ballotId: "proposal:POL-MULTI",
      matterId: "POL-MULTI",
      revisionId: "rev-1",
      result: "successful",
      decisionEventId: "dec-multi-1",
      recordedBy: "admin-1",
      now,
    });
    assert.equal(decision.result, "successful");

    const certified = await db
      .collection(BALLOTS_COLLECTION)
      .findOne({ ballotId: "proposal:POL-MULTI" });
    assert.equal(certified?.status, "certified");

    await assert.rejects(
      recordFormalDecision(db, {
        ballotId: "proposal:POL-MULTI",
        matterId: "POL-MULTI",
        revisionId: "rev-1",
        result: "unsuccessful",
        decisionEventId: "dec-multi-2",
        recordedBy: "admin-1",
        now,
      }),
      /already recorded/,
    );
  });

  it("synthesises legacy proposal ballots without requiring a ballots collection row", async () => {
    const db = createMemoryDb();
    const now = new Date("2026-11-13T08:00:00Z");

    await db.collection("proposals").insertOne({
      proposalId: "POL-LEGACY",
      slug: "pol-legacy",
      title: "Legacy proposal",
      kind: "policy",
      stage: "decide",
      ballotRevisionId: "rev-legacy-1",
      jurisdictionBranchId: "branch-vic",
      publicationScope: "branch",
      createdAt: now,
      updatedAt: now,
    });

    const ballots = await listMatterBallots(db, "POL-LEGACY");
    assert.equal(ballots.length, 1);
    assert.equal(ballots[0]?.ballotId, "proposal:POL-LEGACY");
    assert.equal(ballots[0]?.revisionId, "rev-legacy-1");
    assert.equal(ballots[0]?.electorate.scope, "branch");
    assert.equal(ballots[0]?.electorate.branchId, "branch-vic");
  });

  it("validates governance relationships, prevents circular supersession, and records append-only events", async () => {
    const db = createMemoryDb();
    const now = new Date("2026-11-13T08:00:00Z");

    for (const doc of [
      { proposalId: "POL-A", kind: "policy", title: "Policy A", stage: "implement", createdAt: now, updatedAt: now },
      { proposalId: "POL-B", kind: "policy", title: "Policy B", stage: "implement", createdAt: now, updatedAt: now },
      { proposalId: "GOV-1", kind: "resolution", title: "Resolution 1", stage: "implement", createdAt: now, updatedAt: now },
    ]) {
      await db.collection("proposals").insertOne(doc);
    }

    // Valid supersession: POL-B supersedes POL-A
    const rel = await recordGovernanceRelationship(db, {
      sourceMatterId: "POL-B",
      targetMatterId: "POL-A",
      relationshipType: "supersedes",
      actorId: "admin-1",
      note: "Replaces Policy A",
    });
    assert.equal(rel.relationshipType, "supersedes");

    // Circular supersession: POL-A -> POL-B is rejected
    assert.equal(await detectCircularSupersession(db, "POL-A", "POL-B"), true);
    await assert.rejects(
      recordGovernanceRelationship(db, {
        sourceMatterId: "POL-A",
        targetMatterId: "POL-B",
        relationshipType: "supersedes",
        actorId: "admin-1",
      }),
      (err: unknown) =>
        err instanceof GovernanceRelationshipError &&
        err.code === "CIRCULAR_SUPERSESSION",
    );

    // Self-relationship rejected
    await assert.rejects(
      recordGovernanceRelationship(db, {
        sourceMatterId: "POL-A",
        targetMatterId: "POL-A",
        relationshipType: "supersedes",
        actorId: "admin-1",
      }),
      /cannot reference itself/,
    );

    // Incompatible matter types for supersession rejected
    await assert.rejects(
      recordGovernanceRelationship(db, {
        sourceMatterId: "POL-A",
        targetMatterId: "GOV-1",
        relationshipType: "supersedes",
        actorId: "admin-1",
      }),
      (err: unknown) =>
        err instanceof GovernanceRelationshipError &&
        err.code === "INCOMPATIBLE_MATTER_TYPES",
    );

    // Append-only audit events recorded
    await recordGovernanceEvent(db, {
      eventType: "matter.ratified",
      matterId: "POL-B",
      actorId: "admin-1",
      revisionId: "rev-b",
    });
    const events = await db
      .collection(GOVERNANCE_EVENTS_COLLECTION)
      .find({ matterId: "POL-B" })
      .toArray();
    assert.equal(events.length, 2);
  });
});
