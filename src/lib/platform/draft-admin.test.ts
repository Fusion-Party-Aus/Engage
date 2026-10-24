import test from "node:test";
import assert from "node:assert/strict";
import { validateDraftBallotPatch, validateDraftRoundPatch } from "./draft-admin.mjs";

const now = new Date("2026-10-24T00:00:00Z");
const current = {
  opensAt: new Date("2026-10-26T00:00:00Z"),
  closesAt: new Date("2026-11-27T00:00:00Z"),
  policyRevisionId: "POL-010-v1",
  priority: 0,
};

function errorMessage(result: object): string {
  return "error" in result && typeof result.error === "string" ? result.error : "";
}

test("draft consultation schedules accept future ordered times only", () => {
  const valid = validateDraftRoundPatch({ opensAt: "2026-11-01T00:00:00Z" }, current, now);
  if ("error" in valid) throw new Error(valid.error);
  assert.equal(valid.opensAt.toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(valid.closesAt.toISOString(), current.closesAt.toISOString());
  assert.match(errorMessage(validateDraftRoundPatch({ closesAt: "2026-10-23T00:00:00Z" }, current, now)), /future/);
  assert.match(errorMessage(validateDraftRoundPatch({ opensAt: "bad", closesAt: "2026-11-01T00:00:00Z" }, current, now)), /valid/);
  assert.match(errorMessage(validateDraftRoundPatch({ status: "open" }, current, now)), /Only opening and closing/);
});

test("draft ballot editing permits a pinned policy revision, schedule and bounded priority only", () => {
  const valid = validateDraftBallotPatch({ policyRevisionId: "POL-010-v2", priority: 42 }, current, now);
  if ("error" in valid) throw new Error(valid.error);
  assert.equal(valid.policyRevisionId, "POL-010-v2");
  assert.equal(valid.priority, 42);
  assert.equal(valid.opensAt.toISOString(), current.opensAt.toISOString());
  assert.match(errorMessage(validateDraftBallotPatch({ status: "open" }, current, now)), /Only policy version/);
  assert.match(errorMessage(validateDraftBallotPatch({ priority: 1000 }, current, now)), /0 to 999/);
  assert.match(errorMessage(validateDraftBallotPatch({ policyRevisionId: "" }, current, now)), /immutable policy revision/);
});
