import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_MATTER_REGISTRY,
  assertMatterCapability,
  matterHasCapability,
  normalizeMatterType,
  validateMatterTransition,
} from "./matters.ts";

const GOVERNANCE_CAPABILITIES = [
  "supportsDeliberation",
  "supportsAmendments",
  "supportsBallots",
  "supportsRatification",
  "supportsPolicyPublication",
  "supportsSupersession",
] as const;

test("a collaboration matter is a registered matter type", () => {
  assert.equal(DEFAULT_MATTER_REGISTRY.has("collaboration"), true);
  assert.equal(normalizeMatterType("collaboration", "STORY-1"), "collaboration");
  assert.equal(DEFAULT_MATTER_REGISTRY.get("collaboration")?.label, "Collaboration matter");
});

test("a collaboration matter supports no governance capability", () => {
  for (const capability of GOVERNANCE_CAPABILITIES) {
    assert.equal(
      matterHasCapability({ kind: "collaboration" }, capability),
      false,
      `${capability} must be unavailable to a collaboration matter`,
    );
    assert.throws(
      () => assertMatterCapability({ kind: "collaboration" }, capability, "a formal decision"),
      /do not support/,
    );
  }
});

test("a collaboration matter cannot enter any governance lifecycle stage", () => {
  for (const stage of ["propose", "deliberate", "decide", "implement", "archived"] as const) {
    assert.throws(
      () => validateMatterTransition("collaboration", "propose", stage),
      /cannot enter lifecycle stage|not permitted/,
    );
  }
});

test("policy and resolution matters keep their existing capabilities", () => {
  assert.equal(matterHasCapability({ kind: "policy" }, "supportsBallots"), true);
  assert.equal(matterHasCapability({ kind: "resolution" }, "supportsBallots"), true);
  assert.equal(matterHasCapability({ kind: "resolution" }, "supportsRatification"), false);
  assert.equal(validateMatterTransition("policy", "propose", "deliberate")?.requiredPermission, "proposals.edit");
});
