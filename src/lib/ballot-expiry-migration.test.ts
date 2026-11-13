import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { createMemoryDb } from "./db.ts";
import {
  OPEN_BALLOT_EXPIRY_DEADLINE,
  ballotDeadlineDateLabel,
  ballotDeadlineLabel,
  ballotDeadlineShortLabel,
  ballotExpired,
} from "./ballot-deadline.ts";
import {
  OPEN_BALLOT_EXPIRY_MIGRATION,
  applyOpenBallotExpiryMigration,
  previewOpenBallotExpiryMigration,
} from "./ballot-expiry-migration.ts";
import { castVote } from "./store.ts";
import { PROPOSAL_VOTES, proposalBallotId } from "./vote-storage.ts";
import type { SessionUser } from "./types.ts";

describe("open ballot expiry migration (14 January 2027)", () => {
  it("formats 2027-01-14T13:00:00.000Z in Australia/Melbourne time and enforces exclusive boundary", () => {
    const deadline = new Date(OPEN_BALLOT_EXPIRY_DEADLINE);
    assert.equal(ballotDeadlineDateLabel(deadline), "14 January 2027");
    assert.equal(ballotDeadlineShortLabel(deadline), "14 Jan 2027");
    assert.match(
      ballotDeadlineLabel(deadline),
      /Thursday, 14 January 2027 at 11:59\s*pm \(Melbourne time\)/i,
    );

    // 1ms before midnight AEDT (23:59:59.999 AEDT on 14 Jan 2027): permitted
    assert.equal(
      ballotExpired({ ballotClosesAt: deadline }, new Date("2027-01-14T12:59:59.999Z")),
      false,
    );
    // At midnight AEDT (00:00:00.000 AEDT on 15 Jan 2027): rejected
    assert.equal(
      ballotExpired({ ballotClosesAt: deadline }, new Date("2027-01-14T13:00:00.000Z")),
      true,
    );
  });

  it("assigns the target deadline to open ballots without deadlines, preserves existing deadlines and inactive ballots, and is idempotent", async () => {
    const db = createMemoryDb();
    const now = new Date("2026-11-13T08:00:00Z");
    const existingDeadline = new Date("2026-12-01T13:00:00.000Z");
    const targetDate = new Date(OPEN_BALLOT_EXPIRY_DEADLINE);

    for (const doc of [
      {
        proposalId: "POL-OPEN-NO-EXPIRY",
        slug: "pol-open-no-expiry",
        title: "Open policy without deadline",
        kind: "policy",
        stage: "decide",
        ballotRevisionId: "rev-1",
        publicationScope: "national",
        createdAt: now,
        updatedAt: now,
      },
      {
        proposalId: "GOV-OPEN-NO-EXPIRY",
        slug: "gov-open-no-expiry",
        title: "Open resolution without deadline",
        kind: "resolution",
        stage: "decide",
        ballotRevisionId: "rev-gov-1",
        publicationScope: "national",
        createdAt: now,
        updatedAt: now,
      },
      {
        proposalId: "POL-EXISTING-DEADLINE",
        slug: "pol-existing-deadline",
        title: "Open policy with explicit deadline",
        kind: "policy",
        stage: "decide",
        ballotRevisionId: "rev-2",
        ballotClosesAt: existingDeadline,
        publicationScope: "national",
        createdAt: now,
        updatedAt: now,
      },
      {
        proposalId: "POL-IMPLEMENT",
        slug: "pol-implement",
        title: "Completed policy in implement",
        kind: "policy",
        stage: "implement",
        ballotRevisionId: "rev-3",
        publicationScope: "national",
        createdAt: now,
        updatedAt: now,
      },
      {
        proposalId: "POL-ARCHIVED",
        slug: "pol-archived",
        title: "Archived policy",
        kind: "policy",
        stage: "archived",
        ballotRevisionId: "rev-4",
        publicationScope: "national",
        createdAt: now,
        updatedAt: now,
      },
    ]) {
      await db.collection("proposals").insertOne(doc);
    }

    for (const doc of [
      {
        amendmentId: "AMD-OPEN",
        proposalId: "POL-OPEN-NO-EXPIRY",
        title: "Open amendment",
        status: "voting",
      },
      {
        amendmentId: "AMD-CLOSED",
        proposalId: "POL-OPEN-NO-EXPIRY",
        title: "Closed amendment",
        status: "accepted",
      },
    ]) {
      await db.collection("amendments").insertOne(doc);
    }

    await db.collection(PROPOSAL_VOTES).insertOne({
      ballotId: proposalBallotId("POL-OPEN-NO-EXPIRY"),
      proposalId: "POL-OPEN-NO-EXPIRY",
      revisionId: "rev-1",
      memberId: "m-1",
      choice: "approve",
      updatedAt: now,
    });
    await db.collection("ballot_results").insertOne({
      proposalId: "POL-IMPLEMENT",
      revisionId: "rev-3",
      result: "successful",
      decisionEventId: "dec-1",
      recordedBy: "admin-1",
      recordedAt: now,
    });

    // Dry-run preview
    const preview = await previewOpenBallotExpiryMigration(db);
    assert.equal(preview.mode, "dry-run");
    assert.equal(preview.counts.eligible, 3);
    assert.equal(preview.counts.skipped, 1);
    assert.equal(preview.counts.conflicting, 0);
    assert.equal(preview.counts.inactiveExcluded, 3);

    // Apply
    const applied = await applyOpenBallotExpiryMigration(db, {
      actorId: "admin-1",
      dryRun: false,
      now,
    });
    assert.equal(applied.mode, "apply");
    assert.equal(applied.counts.updated, 3);
    assert.equal(applied.counts.skipped, 1);

    const openPol = await db.collection("proposals").findOne({ proposalId: "POL-OPEN-NO-EXPIRY" });
    const openGov = await db.collection("proposals").findOne({ proposalId: "GOV-OPEN-NO-EXPIRY" });
    const existingPol = await db.collection("proposals").findOne({ proposalId: "POL-EXISTING-DEADLINE" });
    const implementPol = await db.collection("proposals").findOne({ proposalId: "POL-IMPLEMENT" });
    const archivedPol = await db.collection("proposals").findOne({ proposalId: "POL-ARCHIVED" });
    const openAmd = await db.collection("amendments").findOne({ amendmentId: "AMD-OPEN" });
    const closedAmd = await db.collection("amendments").findOne({ amendmentId: "AMD-CLOSED" });

    assert.equal(new Date(openPol?.ballotClosesAt).toISOString(), targetDate.toISOString());
    assert.equal(new Date(openGov?.ballotClosesAt).toISOString(), targetDate.toISOString());
    assert.equal(new Date(openAmd?.ballotClosesAt).toISOString(), targetDate.toISOString());
    assert.equal(new Date(existingPol?.ballotClosesAt).toISOString(), existingDeadline.toISOString());
    assert.equal(implementPol?.ballotClosesAt, undefined);
    assert.equal(archivedPol?.ballotClosesAt, undefined);
    assert.equal(closedAmd?.ballotClosesAt, undefined);

    // Wording revision, existing vote, and recorded decision remain untouched
    assert.equal(openPol?.ballotRevisionId, "rev-1");
    const existingVote = await db.collection(PROPOSAL_VOTES).findOne({ memberId: "m-1" });
    assert.equal(existingVote?.choice, "approve");
    assert.equal(existingVote?.revisionId, "rev-1");
    const decision = await db.collection("ballot_results").findOne({ proposalId: "POL-IMPLEMENT" });
    assert.equal(decision?.result, "successful");

    // Re-run is idempotent and makes zero additional changes
    const rerun = await applyOpenBallotExpiryMigration(db, {
      actorId: "admin-1",
      dryRun: false,
      now,
    });
    assert.equal(rerun.counts.eligible, 0);
    assert.equal(rerun.counts.updated, 0);
    assert.equal(rerun.counts.skipped, 4);
  });

  it("reports malformed deadlines as conflicts without guessing", async () => {
    const db = createMemoryDb();
    await db.collection("proposals").insertOne({
      proposalId: "POL-BAD-DATE",
      title: "Bad date ballot",
      stage: "decide",
      ballotClosesAt: "not-a-valid-date",
    });

    const preview = await previewOpenBallotExpiryMigration(db);
    assert.equal(preview.counts.eligible, 0);
    assert.equal(preview.counts.conflicting, 1);
    assert.equal(preview.conflicts[0]?.id, "POL-BAD-DATE");
  });

  it("enforces the migrated expiry server-side when casting or changing votes", async () => {
    const db = createMemoryDb();
    const memberId = new ObjectId().toString();
    const user: SessionUser = {
      memberId,
      name: "Voter",
      email: "voter@example.test",
      role: "member",
      status: "verified",
      canParticipate: true,
      isStaff: false,
      isAdmin: false,
    };

    await db.collection("proposals").insertOne({
      proposalId: "POL-EXPIRY-CHECK",
      slug: "pol-expiry-check",
      title: "Expiry enforcement",
      kind: "policy",
      stage: "decide",
      ballotRevisionId: "rev-1",
      publicationScope: "national",
      createdAt: new Date("2026-11-01T00:00:00Z"),
      updatedAt: new Date("2026-11-01T00:00:00Z"),
    });
    await db.collection("proposal_revisions").insertOne({
      proposalId: "POL-EXPIRY-CHECK",
      revisionId: "rev-1",
      createdAt: new Date("2026-11-01T00:00:00Z"),
    });

    await applyOpenBallotExpiryMigration(db, {
      actorId: "admin-1",
      dryRun: false,
      now: new Date("2026-11-13T08:00:00Z"),
    });

    // Simulate expired clock on the proposal document to verify server-side rejection at boundary
    const proposal = await db.collection("proposals").findOne({ proposalId: "POL-EXPIRY-CHECK" });
    assert.equal(
      ballotExpired(
        { ballotClosesAt: proposal?.ballotClosesAt },
        new Date("2027-01-14T12:59:59.999Z"),
      ),
      false,
    );
    assert.equal(
      ballotExpired(
        { ballotClosesAt: proposal?.ballotClosesAt },
        new Date("2027-01-14T13:00:00.000Z"),
      ),
      true,
    );

    // When ballotClosesAt is in the past, castVote rejects
    await db
      .collection("proposals")
      .updateOne({ proposalId: "POL-EXPIRY-CHECK" }, { $set: { ballotClosesAt: new Date(Date.now() - 1000) } });
    await assert.rejects(
      castVote(db, user, { proposalId: "POL-EXPIRY-CHECK", choice: "approve" }),
      /closed/,
    );
  });
});
