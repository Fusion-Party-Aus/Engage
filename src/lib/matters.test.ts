import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MATTER_REGISTRY,
  MatterValidationError,
  assertMatterCapability,
  createMatterRegistry,
  getMatterDefinition,
  isRegisteredMatterType,
  matterHasCapability,
  normalizeMatterType,
  validateMatterTransition,
  type MatterTypeDefinition,
} from "./matters.ts";

describe("extensible governance matter model & type-aware lifecycle", () => {
  it("validates registered matter types at runtime and rejects unknown types", () => {
    assert.equal(isRegisteredMatterType("policy"), true);
    assert.equal(isRegisteredMatterType("resolution"), true);
    assert.equal(isRegisteredMatterType("consultation"), false);

    assert.equal(normalizeMatterType(undefined, "POL-001"), "policy");
    assert.equal(normalizeMatterType(undefined, "GOV-001"), "resolution");
    assert.equal(normalizeMatterType("governance", "ANY-1"), "resolution");
    assert.equal(normalizeMatterType("POLICY", "ANY-1"), "policy");

    assert.throws(
      () => normalizeMatterType("unknown_process", "POL-999"),
      (err: unknown) =>
        err instanceof MatterValidationError &&
        err.code === "UNSUPPORTED_MATTER_TYPE" &&
        err.status === 400,
    );
  });

  it("enforces matter capabilities: policy vs governance resolution", () => {
    assert.equal(
      matterHasCapability({ kind: "policy", proposalId: "POL-1" }, "supportsRatification"),
      true,
    );
    assert.equal(
      matterHasCapability({ kind: "policy", proposalId: "POL-1" }, "supportsPolicyPublication"),
      true,
    );

    assert.equal(
      matterHasCapability({ kind: "resolution", proposalId: "GOV-1" }, "supportsRatification"),
      false,
    );
    assert.equal(
      matterHasCapability({ kind: "resolution", proposalId: "GOV-1" }, "supportsPolicyPublication"),
      false,
    );
    assert.equal(
      matterHasCapability({ kind: "resolution", proposalId: "GOV-1" }, "supportsBallots"),
      true,
    );

    assert.throws(
      () =>
        assertMatterCapability(
          { kind: "resolution", proposalId: "GOV-1" },
          "supportsRatification",
          "policy ratification",
        ),
      (err: unknown) =>
        err instanceof MatterValidationError &&
        err.code === "UNSUPPORTED_MATTER_CAPABILITY" &&
        err.status === 409,
    );
  });

  it("validates type-aware lifecycle transitions and distinguishes workflow from governance authority", () => {
    const wf = validateMatterTransition("policy", "propose", "deliberate");
    assert.equal(wf?.authorityKind, "workflow");
    assert.equal(wf?.requiredPermission, "proposals.edit");

    const gov = validateMatterTransition("policy", "deliberate", "decide");
    assert.equal(gov?.authorityKind, "governance");

    assert.throws(
      () => validateMatterTransition("policy", "propose", "decide"),
      /must undergo member deliberation/,
    );
    assert.throws(
      () => validateMatterTransition("resolution", "deliberate", "implement"),
      /must be voted on in the Decide stage/,
    );
  });

  it("proves extensibility with a test-only hypothetical matter type without modifying production registry", () => {
    const hypotheticalConsultation: MatterTypeDefinition = {
      type: "consultation",
      label: "Member consultation",
      pluralLabel: "Member consultations",
      description: "Test-only hypothetical consultative matter.",
      capabilities: {
        supportsDeliberation: true,
        supportsAmendments: false,
        supportsBallots: true,
        supportsRatification: false,
        supportsPolicyPublication: false,
        supportsSupersession: false,
        allowedStages: ["propose", "deliberate", "decide", "archived"],
        compatibleSupersessionTargets: [],
      },
      transitions: [
        {
          from: "propose",
          to: "deliberate",
          requiredPermission: "proposals.edit",
          authorityKind: "workflow",
          description: "Open consultation.",
        },
        {
          from: "deliberate",
          to: "decide",
          requiredPermission: "proposals.edit",
          authorityKind: "governance",
          description: "Open consultative poll.",
        },
        {
          from: "decide",
          to: "archived",
          requiredPermission: "proposals.edit",
          authorityKind: "workflow",
          description: "Close consultation.",
        },
      ],
    };

    // Production registry remains untouched
    assert.equal(DEFAULT_MATTER_REGISTRY.has("consultation"), false);

    // Isolated test registry supports the new type end-to-end
    const testRegistry = createMatterRegistry([hypotheticalConsultation]);
    assert.equal(isRegisteredMatterType("consultation", testRegistry), true);
    assert.equal(normalizeMatterType("consultation", "CON-1", testRegistry), "consultation");
    assert.equal(getMatterDefinition("consultation", testRegistry).label, "Member consultation");

    // Supported operations work
    assert.equal(
      matterHasCapability({ kind: "consultation" }, "supportsDeliberation", testRegistry),
      true,
    );
    assert.equal(
      matterHasCapability({ kind: "consultation" }, "supportsBallots", testRegistry),
      true,
    );
    const transition = validateMatterTransition("consultation", "propose", "deliberate", {
      registry: testRegistry,
    });
    assert.equal(transition?.requiredPermission, "proposals.edit");

    // Unsupported operations and stages are rejected
    assert.throws(
      () =>
        assertMatterCapability(
          { kind: "consultation" },
          "supportsRatification",
          "policy ratification",
          testRegistry,
        ),
      /do not support policy ratification/,
    );
    assert.throws(
      () =>
        assertMatterCapability(
          { kind: "consultation" },
          "supportsAmendments",
          "formal amendments",
          testRegistry,
        ),
      /do not support formal amendments/,
    );
    assert.throws(
      () =>
        validateMatterTransition("consultation", "decide", "implement", {
          registry: testRegistry,
        }),
      /cannot enter lifecycle stage 'implement'/,
    );
  });
});
