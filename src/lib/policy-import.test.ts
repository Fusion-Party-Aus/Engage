import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDb } from "./db.ts";
import {
  applyBranchPolicyImport,
  BranchPolicySourceError,
  branchPolicyContentHash,
  branchPolicyId,
  planBranchPolicyImport,
  renderBranchPolicyWording,
  type BranchPolicyImportOptions,
  type BranchPolicySource,
} from "./policy-import.ts";

const SOURCE_URL = "https://vic.example.org/api/policies.json";
const BRANCH = { branchId: "branch-vic", name: "Fusion Victoria", code: "vic" };
const AUTHORITY =
  "Adopted by the Victorian branch executive; recorded for the test fixture.";

function source(): BranchPolicySource {
  return {
    schema_version: 1,
    generated_at: "2026-11-14T23:45:52.617Z",
    organization: { name: "Fusion Party Victoria", jurisdiction: "Victoria, Australia" },
    policy_count: 2,
    policies: [
      {
        id: "policy-open-government",
        title: "Open Government by Default",
        slug: "open-government-by-default",
        canonical_url: "https://vic.example.org/policies/open-government-by-default",
        status: "adopted",
        summary: "Publish government information before people have to ask.",
        hook: "If the public paid for it, the public should see it.",
        pillar: "RECLAIM OUR DEMOCRACY",
        category: "Integrity & Accountability",
        key_points: [
          { point: "Publish before people ask", description: "Release routinely releasable material." },
          { point: "Make power legible", description: "Link diaries, gifts and decisions." },
        ],
        design_rationale: "Victoria already has proactive-release guidance.",
        cost: "Digital publication costs.",
        funding: "Government-services budgets.",
        published_at: "2026-09-27T14:30:00Z",
        updated_at: "2026-10-10T15:56:54Z",
        authority: { publisher: "Fusion Party Victoria", adopted_policy: true },
        supporting_research: [
          { title: "Open Government research", canonical_url: "https://vic.example.org/research/open-government" },
        ],
      },
      {
        id: "policy-complete-neighbourhoods",
        title: "Complete Neighbourhoods",
        slug: "complete-neighbourhoods",
        canonical_url: "https://vic.example.org/policies/complete-neighbourhoods",
        status: "adopted",
        summary: "Stop approving dormitory suburbs.",
        key_points: [{ point: "Stop approving dormitory suburbs", description: "Require services first." }],
        published_at: "2026-09-27T13:20:00Z",
        authority: { publisher: "Fusion Party Victoria", adopted_policy: true },
      },
    ],
  };
}

function options(overrides: Partial<BranchPolicyImportOptions> = {}): BranchPolicyImportOptions {
  return {
    source: source(),
    sourceUrl: SOURCE_URL,
    branch: BRANCH,
    authorityBasis: AUTHORITY,
    importedAt: new Date("2026-11-15T00:00:00Z"),
    importedBy: "system:branch-policy-import",
    ...overrides,
  };
}

describe("branch policy import", () => {
  it("derives stable registry identifiers and content hashes", () => {
    assert.equal(branchPolicyId("branch-vic", "complete-neighbourhoods"), "vic-complete-neighbourhoods");
    const a = branchPolicyContentHash({ slug: "x", title: "A", key_points: [{ point: "p" }] });
    const b = branchPolicyContentHash({ key_points: [{ point: "p" }], title: "A", slug: "x" });
    assert.equal(a, b, "hash must not depend on key order");
  });

  it("renders wording from published source fields only", () => {
    const wording = renderBranchPolicyWording(source().policies![0]!);
    assert.match(wording, /> If the public paid for it/);
    assert.match(wording, /\*\*What it does\*\*/);
    assert.match(wording, /\*\*Design Rationale\*\*/);
    assert.match(wording, /\*\*Paid for by\*\*/);
    assert.match(wording, /\[Open Government research\]/);
  });

  it("plans without writing and imports only adopted records", async () => {
    const db = createMemoryDb();
    const plan = await planBranchPolicyImport(db, options());
    assert.equal(plan.counts.create, 2);
    assert.equal(await db.collection("policy_registry").countDocuments({}), 0);
    assert.equal(await db.collection("policy_revisions").countDocuments({}), 0);
  });

  it("creates published, adopted, branch-authorised records with immutable revisions", async () => {
    const db = createMemoryDb();
    const plan = await planBranchPolicyImport(db, options());
    const applied = await applyBranchPolicyImport(db, plan);
    assert.equal(applied.counts.create, 2, "the report must state what the run actually created");
    const open = await db.collection("policy_registry").findOne({ policyId: "vic-open-government-by-default" });
    assert.equal(open?.status, "adopted");
    assert.equal(open?.publicationStatus, "published");
    assert.equal(open?.recordOrigin, "branch-import");
    assert.equal(open?.branchSlug, "vic");
    assert.equal(open?.policySlug, "open-government-by-default");
    assert.equal(open?.pillar, "RECLAIM OUR DEMOCRACY");
    assert.equal(open?.jurisdictionBranchId, "branch-vic");
    assert.equal(open?.governanceAuthorityBranchId, "branch-vic");
    assert.equal(open?.ratification, null);
    assert.equal(open?.import.authorityBasis, AUTHORITY);
    assert.equal(open?.import.sourceUrl, SOURCE_URL);
    assert.equal(open?.commitments.length, 2);
    assert.equal(open?.provenance.category, "branch-import");

    const revision = await db.collection("policy_revisions").findOne({ revisionId: open?.revisionId });
    assert.equal(revision?.revisionType, "imported-policy");
    assert.equal(revision?.parentRevisionId, null);
    assert.equal(revision?.snapshot.document.slug, "open-government-by-default");
    assert.equal(revision?.contentHash, open?.import.contentHash);
  });

  it("is idempotent and reports unchanged records on re-run", async () => {
    const db = createMemoryDb();
    await applyBranchPolicyImport(db, await planBranchPolicyImport(db, options()));
    const second = await planBranchPolicyImport(db, options({ importedAt: new Date("2026-11-16T00:00:00Z") }));
    assert.equal(second.counts.create, 0);
    assert.equal(second.counts.unchanged, 2);
    await applyBranchPolicyImport(db, second);
    assert.equal(await db.collection("policy_registry").countDocuments({}), 2);
    assert.equal(await db.collection("policy_revisions").countDocuments({}), 2);
  });

  it("reports changed source wording as a conflict and never overwrites adopted policy", async () => {
    const db = createMemoryDb();
    await applyBranchPolicyImport(db, await planBranchPolicyImport(db, options()));
    const updated = source();
    updated.policies![0]!.summary = "Rewritten wording that was never decided in Engage.";
    const plan = await planBranchPolicyImport(db, options({ source: updated }));
    assert.equal(plan.counts.changed, 1);
    assert.equal(plan.counts.unchanged, 1);
    await applyBranchPolicyImport(db, plan);
    const open = await db.collection("policy_registry").findOne({ policyId: "vic-open-government-by-default" });
    assert.equal(open?.summary, "Publish government information before people have to ask.");
    assert.equal(plan.errors.length, 0, "a conflict is a review item, not a failed write");
  });

  it("refuses to claim a record adopted through Engage", async () => {
    const db = createMemoryDb();
    await db.collection("policy_registry").insertOne({
      policyId: "vic-open-government-by-default",
      title: "Engage-ratified policy",
      publicationStatus: "published",
      status: "adopted",
      revisionId: "rev-engage",
    });
    const plan = await planBranchPolicyImport(db, options());
    const entry = plan.entries.find((item) => item.policyId === "vic-open-government-by-default");
    assert.equal(entry?.action, "conflict");
    assert.match(String(entry?.reason), /different origin/);
  });

  it("does not republish a withdrawn or repealed record", async () => {
    const db = createMemoryDb();
    await applyBranchPolicyImport(db, await planBranchPolicyImport(db, options()));
    await db.collection("policy_registry").updateOne(
      { policyId: "vic-complete-neighbourhoods" },
      { $set: { publicationStatus: "repealed" } },
    );
    const plan = await planBranchPolicyImport(db, options());
    const entry = plan.entries.find((item) => item.policyId === "vic-complete-neighbourhoods");
    assert.equal(entry?.action, "conflict");
    assert.match(String(entry?.reason), /not republish/);
  });

  it("reports records that disappeared from the feed without deleting them", async () => {
    const db = createMemoryDb();
    await applyBranchPolicyImport(db, await planBranchPolicyImport(db, options()));
    const trimmed = source();
    trimmed.policies = trimmed.policies!.slice(0, 1);
    trimmed.policy_count = 1;
    const plan = await planBranchPolicyImport(db, options({ source: trimmed }));
    assert.equal(plan.counts.missingFromSource, 1);
    assert.equal(plan.missing[0]?.policyId, "vic-complete-neighbourhoods");
    await applyBranchPolicyImport(db, plan);
    assert.equal(await db.collection("policy_registry").countDocuments({}), 2);
  });

  it("rejects non-adopted source records", async () => {
    const db = createMemoryDb();
    const draft = source();
    draft.policies![1]!.status = "draft";
    const plan = await planBranchPolicyImport(db, options({ source: draft }));
    assert.equal(plan.counts.create, 1);
    assert.equal(plan.counts.invalid, 1);
    assert.match(String(plan.entries.find((entry) => entry.action === "invalid")?.reason), /not adopted/);
  });

  it("fails closed without an explicit authority basis", async () => {
    const db = createMemoryDb();
    await assert.rejects(
      () => planBranchPolicyImport(db, options({ authorityBasis: "  " })),
      (error: unknown) => error instanceof BranchPolicySourceError && /authority basis/.test((error as Error).message),
    );
  });

  it("rejects malformed and duplicate sources", async () => {
    const db = createMemoryDb();
    const duplicate = source();
    duplicate.policy_count = 1;
    duplicate.policies![1]!.slug = duplicate.policies![0]!.slug;
    await assert.rejects(
      () => planBranchPolicyImport(db, options({ source: duplicate })),
      (error: unknown) =>
        error instanceof BranchPolicySourceError &&
        error.issues.some((issue) => /repeats the slug/.test(issue)) &&
        error.issues.some((issue) => /declares/.test(issue)),
    );
  });
});
