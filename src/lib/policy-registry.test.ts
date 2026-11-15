import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDb } from "./db.ts";
import {
  branchPublicSlug,
  branchSlugFor,
  findBranchBySlug,
  findPolicyByBranchPath,
  groupRegistryByBranch,
  groupRegistryPolicies,
  humanisePolicyLabel,
  policyCanonicalPath,
  policySlugFromTitle,
  policyStatusLabel,
  uniquePolicySlug,
} from "./policy-registry.ts";

const branches = [
  { branchId: "branch-vic", name: "Fusion Victoria", kind: "state" },
  { branchId: "branch-nat", name: "Fusion National", kind: "national" },
  { branchId: "branch-act", name: "Fusion Australian Capital Territory", kind: "territory" },
];

const policy = (
  overrides: Record<string, unknown>,
): Record<string, any> => ({
  policyId: "vic-open-government",
  branchSlug: "vic",
  policySlug: "open-government",
  title: "Open Government by Default",
  summary: "Publish before people ask.",
  pillar: "RECLAIM OUR DEMOCRACY",
  category: "Integrity & Accountability",
  publicationStatus: "published",
  jurisdictionBranchId: "branch-vic",
  recordOrigin: "branch-import",
  ...overrides,
});

describe("policy registry routing", () => {
  it("addresses branch policy as /policies/<branch>/<slug>/", () => {
    assert.equal(branchSlugFor("branch-vic"), "vic");
    assert.equal(branchSlugFor("branch-nat"), "nat");
    assert.equal(
      branchPublicSlug({ branchId: "f6d3c0b9-legacy", slug: "vic" }),
      "vic",
      "a legacy branch record can hold the stable public slug",
    );
    assert.equal(branchPublicSlug({ branchId: "branch-nsw" }), "nsw");
    assert.equal(policyCanonicalPath(policy({})), "/policies/vic/open-government/");
    assert.equal(
      policyCanonicalPath({ policyId: "PROP-001-AB12" }),
      "/policies/PROP-001-AB12/",
      "a record without a branch path keeps its legacy address",
    );
  });

  it("builds stable slugs for ratified policy", () => {
    assert.equal(policySlugFromTitle("Open Government by Default"), "open-government-by-default");
    assert.equal(policySlugFromTitle("Amend: Homes & Stations"), "amend-homes-stations");
    assert.equal(policySlugFromTitle("Économie — Réforme"), "economie-reforme");
  });

  it("keeps a public slug unique within a branch without failing", async () => {
    const db = createMemoryDb();
    await db.collection("policy_registry").insertOne(policy({ policySlug: "same-title" }));
    await db.collection("policy_registry").insertOne(
      policy({ policyId: "vic-other", policySlug: "same-title-2" }),
    );
    assert.equal(await uniquePolicySlug(db, "vic", "same-title", "PROP-9"), "same-title-3");
    assert.equal(await uniquePolicySlug(db, "nsw", "same-title", "PROP-9"), "same-title");
  });

  it("resolves the canonical path and the legacy composite identifier", async () => {
    const db = createMemoryDb();
    await db.collection("policy_registry").insertOne(policy({}));
    const canonical = await findPolicyByBranchPath(db, "vic", "open-government");
    assert.equal(canonical?.policyId, "vic-open-government");

    await db.collection("policy_registry").insertOne({
      policyId: "vic-legacy-only",
      title: "Legacy",
      publicationStatus: "published",
    });
    const legacy = await findPolicyByBranchPath(db, "vic", "legacy-only");
    assert.equal(legacy?.policyId, "vic-legacy-only");
    assert.equal(await findPolicyByBranchPath(db, "vic", "absent"), null);
  });

  it("resolves a branch by its explicit slug even when its ID is legacy", async () => {
    const db = createMemoryDb();
    await db.collection("branches").insertOne({
      branchId: "f6d3c0b9-legacy",
      slug: "vic",
      name: "Fusion Victoria",
      kind: "state",
      recognised: true,
    });
    const branch = await findBranchBySlug(db, "vic");
    assert.equal(branch?.branchId, "f6d3c0b9-legacy");
    assert.equal(await findBranchBySlug(db, "nsw"), null);
  });
});

describe("policy registry grouping", () => {
  it("humanises published pillar labels but preserves mixed case", () => {
    assert.equal(humanisePolicyLabel("RECLAIM OUR INFRASTRUCTURE"), "Reclaim our infrastructure");
    assert.equal(humanisePolicyLabel("Integrity & Accountability"), "Integrity & Accountability");
    assert.equal(humanisePolicyLabel(""), "Other");
  });

  it("groups by topic, alphabetically, with Other last", () => {
    const groups = groupRegistryPolicies([
      policy({ policyId: "a", title: "B policy", pillar: "RECLAIM OUR DEMOCRACY" }),
      policy({ policyId: "b", title: "A policy", pillar: "RECLAIM OUR INFRASTRUCTURE" }),
      policy({ policyId: "c", title: "C policy", pillar: null, category: null }),
    ]);
    assert.deepEqual(
      groups.map((group) => group.label),
      ["Reclaim our democracy", "Reclaim our infrastructure", "Other"],
    );
    assert.equal(groups[0]?.items[0]?.title, "B policy");
  });

  it("groups past records by what happened to them, in consequence order", () => {
    const groups = groupRegistryPolicies(
      [
        policy({ policyId: "a", publicationStatus: "repealed" }),
        policy({ policyId: "b", publicationStatus: "withdrawn" }),
        policy({ policyId: "c", publicationStatus: "superseded" }),
      ],
      { groupBy: "status" },
    );
    assert.deepEqual(
      groups.map((group) => group.label),
      ["Withdrawn", "Superseded", "Repealed"],
    );
    assert.ok(groups.every((group) => group.description));
  });

  it("collates by branch, national first, then each branch's topics", () => {
    const sections = groupRegistryByBranch(
      [
        policy({ policyId: "vic-1", title: "Vic housing", pillar: "RECLAIM OUR INFRASTRUCTURE" }),
        policy({ policyId: "vic-2", title: "Vic integrity", pillar: "RECLAIM OUR DEMOCRACY" }),
        policy({
          policyId: "nat-1",
          branchSlug: "nat",
          policySlug: "national-policy",
          title: "National policy",
          pillar: "RECLAIM OUR DEMOCRACY",
          jurisdictionBranchId: "branch-nat",
          recordOrigin: "engage-ratification",
        }),
      ],
      branches,
    );
    assert.deepEqual(
      sections.map((section) => section.label),
      ["Fusion National", "Fusion Victoria"],
    );
    assert.equal(sections[0]?.href, "/policies/nat/");
    assert.equal(sections[1]?.groups.length, 2);
  });

  it("names publication states in member language", () => {
    assert.equal(policyStatusLabel("published"), "Current policy");
    assert.equal(policyStatusLabel("repealed"), "Repealed");
  });
});
