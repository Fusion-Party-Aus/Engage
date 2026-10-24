import test from "node:test";
import assert from "node:assert/strict";
import { validPolicyId, validatePolicyRevisionInput } from "./policy-revisions.mjs";

const revision = {
  version: "v2.1",
  title: "A revised policy",
  statement: "A concise statement of the revised policy.",
  details: "Detailed policy text with sufficient explanatory content.",
  outcomes: ["A measurable outcome."],
  domain: "Housing",
};

function errorMessage(result: object): string {
  return "error" in result && typeof result.error === "string" ? result.error : "";
}

test("policy revisions validate and normalize a complete immutable revision", () => {
  assert.deepEqual(validatePolicyRevisionInput(revision), { value: revision });
  assert.equal(validPolicyId("POL-010"), true);
  assert.equal(validPolicyId(""), false);
});

test("policy revisions reject unsupported fields, invalid versions and oversized content", () => {
  assert.match(errorMessage(validatePolicyRevisionInput({ ...revision, status: "published" })), /unsupported/);
  assert.match(errorMessage(validatePolicyRevisionInput({ ...revision, version: "<script>" })), /Version/);
  assert.match(errorMessage(validatePolicyRevisionInput({ ...revision, details: "x".repeat(24_001) })), /within their size limits/);
  assert.match(errorMessage(validatePolicyRevisionInput({ ...revision, outcomes: [] })), /between 1 and 15/);
});
