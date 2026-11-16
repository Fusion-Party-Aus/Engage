import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryDb } from "./db.ts";
import { recordAuthenticatedActivity } from "./member-presence.ts";

test("authenticated activity is recorded at most once per member per day", async () => {
  const db = createMemoryDb();
  const now = new Date("2026-11-16T03:00:00.000Z");
  await recordAuthenticatedActivity(db, "member-1", now);
  await recordAuthenticatedActivity(db, "member-1", now);
  assert.equal(
    await db
      .collection("engagement_lifecycle_events")
      .countDocuments({ memberId: "member-1", event: "activity_day" }),
    1,
  );
  const stored = await db
    .collection("engagement_lifecycle_events")
    .findOne({ memberId: "member-1", event: "activity_day" });
  assert.equal(String(stored?._id), "activity_day:member-1:2026-11-16");
});

test("a new day creates a new activity record", async () => {
  const db = createMemoryDb();
  await recordAuthenticatedActivity(
    db,
    "member-2",
    new Date("2026-11-16T03:00:00.000Z"),
  );
  await recordAuthenticatedActivity(
    db,
    "member-2",
    new Date("2026-11-17T03:00:00.000Z"),
  );
  assert.equal(
    await db
      .collection("engagement_lifecycle_events")
      .countDocuments({ memberId: "member-2", event: "activity_day" }),
    2,
  );
});

test("activity recording tolerates an empty member identifier", async () => {
  const db = createMemoryDb();
  await recordAuthenticatedActivity(db, "   ");
  assert.equal(
    await db.collection("engagement_lifecycle_events").countDocuments({}),
    0,
  );
});
