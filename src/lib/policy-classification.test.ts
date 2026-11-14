import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getDatabase } from "./db.ts";
import { createDevSessionCookie } from "./auth.ts";
import {
  isGovernanceResolution,
  isPolicyProposal,
  isPolicyRegistryRecordForResolution,
  saveProposal,
} from "./store.ts";
import { POST as postRatify } from "../pages/api/admin/policies/ratify.ts";
import { POST as postPublish } from "../pages/api/admin/policies/publish.ts";
import { POST as postWithdraw } from "../pages/api/admin/policies/withdraw.ts";
import { POST as postSupersede } from "../pages/api/admin/policies/supersede.ts";
import { POST as postReconcile } from "../pages/api/admin/policies/reconcile.ts";
import { GET as getPublicPolicies } from "../pages/api/v1/policies/index.ts";
import { GET as getPublicPolicy } from "../pages/api/v1/policies/[id].ts";
import type { SessionUser } from "./types.ts";

const env = {
  APP_MODE: "development",
  BETTER_AUTH_SECRET: "test-secret-policy-classification-key-32",
};

const nationalAdmin: SessionUser = {
  memberId: "pol-class-admin",
  name: "National Admin",
  email: "pol-admin@example.org",
  role: "administrator",
  status: "verified",
  canParticipate: true,
  isStaff: true,
  isAdmin: true,
  branchAdminIds: [],
  isBranchAdmin: false,
};

const branchAdmin: SessionUser = {
  memberId: "pol-class-branch-admin",
  name: "Branch Admin",
  email: "pol-branch-admin@example.org",
  role: "member",
  status: "verified",
  canParticipate: true,
  isStaff: false,
  isAdmin: false,
  branchAdminIds: ["vic"],
  isBranchAdmin: true,
};

function localsWithEnv() {
  return { runtime: { env } } as any;
}

describe("governance resolution vs policy classification", () => {
  it("prefers canonical proposal kind over GOV- identifier prefix", () => {
    assert.equal(
      isGovernanceResolution({ proposalId: "GOV-001", kind: "resolution" }),
      true,
    );
    assert.equal(
      isGovernanceResolution({ proposalId: "GOV-001", kind: "proposal" }),
      true,
    );
    assert.equal(
      isGovernanceResolution({ proposalId: "GOV-001", kind: undefined }),
      true,
    );
    assert.equal(
      isGovernanceResolution({ proposalId: "GOV-999", kind: "policy" }),
      false,
    );
    assert.equal(
      isPolicyProposal({ proposalId: "GOV-999", kind: "policy" }),
      true,
    );
    assert.equal(
      isGovernanceResolution({ proposalId: "POL-888", kind: "resolution" }),
      true,
    );
    assert.equal(
      isPolicyRegistryRecordForResolution(
        { policyId: "GOV-001", proposalId: "GOV-001" },
        { proposalId: "GOV-001", kind: "resolution" },
      ),
      true,
    );
    assert.equal(
      isPolicyRegistryRecordForResolution(
        { policyId: "GOV-999", proposalId: "GOV-999" },
        { proposalId: "GOV-999", kind: "policy" },
      ),
      false,
    );
  });

  it("rejects governance resolutions from ratification, publication, withdrawal, supersession, and reconciliation", async () => {
    const db = await getDatabase(env);
    await db.collection("branches").updateOne(
      { branchId: "national" },
      {
        $setOnInsert: {
          branchId: "national",
          name: "Fusion National",
          kind: "national",
          recognised: true,
        },
      },
      { upsert: true },
    );
    await db.collection("branches").updateOne(
      { branchId: "vic" },
      {
        $setOnInsert: {
          branchId: "vic",
          name: "Victoria",
          kind: "state",
          recognised: true,
        },
      },
      { upsert: true },
    );
    await db.collection("members").updateOne(
      { memberId: nationalAdmin.memberId },
      { $setOnInsert: { memberId: nationalAdmin.memberId, name: nationalAdmin.name, email: nationalAdmin.email } },
      { upsert: true },
    );
    await db.collection("memberships").updateOne(
      { memberId: nationalAdmin.memberId },
      { $set: { memberId: nationalAdmin.memberId, status: "verified" } },
      { upsert: true },
    );
    await db.collection("application_roles").updateOne(
      { memberId: nationalAdmin.memberId, role: "administrator" },
      { $set: { memberId: nationalAdmin.memberId, role: "administrator" } },
      { upsert: true },
    );
    await db.collection("members").updateOne(
      { memberId: branchAdmin.memberId },
      { $setOnInsert: { memberId: branchAdmin.memberId, name: branchAdmin.name, email: branchAdmin.email } },
      { upsert: true },
    );
    await db.collection("memberships").updateOne(
      { memberId: branchAdmin.memberId },
      { $set: { memberId: branchAdmin.memberId, status: "verified" } },
      { upsert: true },
    );
    await db.collection("branch_memberships").updateOne(
      { branchId: "vic", memberId: branchAdmin.memberId },
      { $set: { branchId: "vic", memberId: branchAdmin.memberId, status: "active", branchRole: "administrator" } },
      { upsert: true },
    );

    const govRes = await saveProposal(db, nationalAdmin, {
      proposalId: "GOV-TEST-001",
      title: "Adopt internal governance motion",
      space: "Party Governance",
      summary: "Internal party governance motion that must not enter policy registry.",
      outcomes: ["Adopt governance process."],
      details: "Governance resolution details.",
      kind: "resolution",
      stage: "propose",
    });
    // D3 fixture: this test is about classification, not seconding.
    await db
      .collection("proposals")
      .updateOne(
        { proposalId: govRes.proposalId },
        { $set: { secondedAt: new Date() } },
      );
    await saveProposal(db, nationalAdmin, {
      proposalId: govRes.proposalId,
      stage: "deliberate",
    });
    await saveProposal(db, nationalAdmin, {
      proposalId: govRes.proposalId,
      stage: "decide",
      ballotClosesAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    });
    const rev = await db
      .collection("proposal_revisions")
      .findOne({ proposalId: govRes.proposalId });
    assert.ok(rev);
    await db.collection("ballot_results").updateOne(
      { proposalId: govRes.proposalId },
      {
        $set: {
          proposalId: govRes.proposalId,
          revisionId: rev.revisionId,
          result: "successful",
          decisionEventId: "dec-gov-test-1",
          recordedAt: new Date(),
        },
      },
      { upsert: true },
    );
    await saveProposal(db, nationalAdmin, {
      proposalId: govRes.proposalId,
      stage: "implement",
    });

    const adminCookie = createDevSessionCookie("administrator").split(";")[0]!;
    const branchAdminCookie = createDevSessionCookie("member").split(";")[0]!;

    // Non-national admin is rejected (403)
    const branchRatifyRes = await postRatify({
      request: new Request("http://localhost/api/admin/policies/ratify", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: branchAdminCookie,
          "idempotency-key": "k-branch-ratify",
        },
        body: JSON.stringify({
          proposalId: govRes.proposalId,
          revisionId: rev.revisionId,
          decisionEventId: "dec-gov-test-1",
          authorityBranchId: "national",
        }),
      }),
      locals: localsWithEnv(),
    } as any);
    assert.equal(branchRatifyRes.status, 403);

    // National admin attempting to ratify a governance resolution is rejected (409)
    const govRatifyRes = await postRatify({
      request: new Request("http://localhost/api/admin/policies/ratify", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: adminCookie,
          "idempotency-key": "k-gov-ratify-1",
        },
        body: JSON.stringify({
          proposalId: govRes.proposalId,
          revisionId: rev.revisionId,
          decisionEventId: "dec-gov-test-1",
          authorityBranchId: "national",
        }),
      }),
      locals: localsWithEnv(),
    } as any);
    assert.equal(govRatifyRes.status, 409);
    assert.equal(
      await db.collection("policy_registry").findOne({ proposalId: govRes.proposalId }),
      null,
    );

    // Simulate a legacy misclassified policy_registry row for GOV-TEST-001
    await db.collection("policy_registry").insertOne({
      policyId: govRes.proposalId,
      proposalId: govRes.proposalId,
      title: govRes.title,
      summary: govRes.summary,
      revisionId: rev.revisionId,
      status: "adopted",
      publicationStatus: "unpublished",
      ratification: {
        decisionEventId: "dec-gov-test-1",
        authorityBranchId: "national",
        ratifiedAt: new Date(),
      },
    });

    // Publish, withdraw, supersede must all reject it (409)
    const govPublishRes = await postPublish({
      request: new Request("http://localhost/api/admin/policies/publish", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: adminCookie,
          "idempotency-key": "k-gov-pub-1",
        },
        body: JSON.stringify({ policyId: govRes.proposalId }),
      }),
      locals: localsWithEnv(),
    } as any);
    assert.equal(govPublishRes.status, 409);

    // Even if a pending publication_event existed, reconcile skips it
    await db.collection("publication_events").insertOne({
      eventId: "pub-legacy-gov-1",
      policyId: govRes.proposalId,
      revisionId: rev.revisionId,
      status: "pending",
      publishedAt: new Date(),
    });
    const reconcileRes = await postReconcile({
      request: new Request("http://localhost/api/admin/policies/reconcile", {
        method: "POST",
        headers: { cookie: adminCookie },
      }),
      locals: localsWithEnv(),
    } as any);
    assert.equal(reconcileRes.status, 200);
    const stillUnpublished = await db
      .collection("policy_registry")
      .findOne({ policyId: govRes.proposalId });
    assert.equal(stillUnpublished?.publicationStatus, "unpublished");

    // Simulate a misclassified published resolution row: public API must exclude it
    await db
      .collection("policy_registry")
      .updateOne(
        { policyId: govRes.proposalId },
        { $set: { publicationStatus: "published", publishedAt: new Date() } },
      );

    const govWithdrawRes = await postWithdraw({
      request: new Request("http://localhost/api/admin/policies/withdraw", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: adminCookie,
          "idempotency-key": "k-gov-withdraw-1",
        },
        body: JSON.stringify({
          policyId: govRes.proposalId,
          reason: "Cleanup test",
        }),
      }),
      locals: localsWithEnv(),
    } as any);
    assert.equal(govWithdrawRes.status, 409);

    const publicListRes = await getPublicPolicies({
      locals: localsWithEnv(),
      url: new URL("http://localhost/api/v1/policies"),
      request: new Request("http://localhost/api/v1/policies"),
    } as any);
    assert.equal(publicListRes.status, 200);
    const publicListJson = (await publicListRes.json()) as {
      data: Array<{ policyId: string }>;
    };
    assert.ok(!publicListJson.data.some((p) => p.policyId === govRes.proposalId));

    const publicItemRes = await getPublicPolicy({
      params: { id: govRes.proposalId },
      locals: localsWithEnv(),
      request: new Request(`http://localhost/api/v1/policies/${govRes.proposalId}`),
    } as any);
    assert.equal(publicItemRes.status, 404);

    // Meanwhile, a legitimate policy proposal can still be ratified and published
    const pol = await saveProposal(db, nationalAdmin, {
      proposalId: "POL-TEST-100",
      title: "Legitimate Clean Energy Policy",
      space: "Energy",
      summary: "A valid policy proposal eligible for ratification and publication.",
      outcomes: ["Expand clean energy storage."],
      details: "Policy proposal details.",
      kind: "policy",
      stage: "propose",
    });
    // D3 fixture: this test is about ratification classification, not seconding.
    await db
      .collection("proposals")
      .updateOne(
        { proposalId: pol.proposalId },
        { $set: { secondedAt: new Date() } },
      );
    await saveProposal(db, nationalAdmin, {
      proposalId: pol.proposalId,
      stage: "deliberate",
    });
    await saveProposal(db, nationalAdmin, {
      proposalId: pol.proposalId,
      stage: "decide",
      ballotClosesAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    });
    const polRev = await db
      .collection("proposal_revisions")
      .findOne({ proposalId: pol.proposalId });
    assert.ok(polRev);
    await db.collection("ballot_results").updateOne(
      { proposalId: pol.proposalId },
      {
        $set: {
          proposalId: pol.proposalId,
          revisionId: polRev.revisionId,
          result: "successful",
          decisionEventId: "dec-pol-test-100",
          recordedAt: new Date(),
        },
      },
      { upsert: true },
    );
    await saveProposal(db, nationalAdmin, {
      proposalId: pol.proposalId,
      stage: "implement",
    });

    const polRatifyRes = await postRatify({
      request: new Request("http://localhost/api/admin/policies/ratify", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: adminCookie,
          "idempotency-key": "k-pol-ratify-100",
        },
        body: JSON.stringify({
          proposalId: pol.proposalId,
          revisionId: polRev.revisionId,
          decisionEventId: "dec-pol-test-100",
          authorityBranchId: "national",
        }),
      }),
      locals: localsWithEnv(),
    } as any);
    assert.equal(polRatifyRes.status, 201);

    const polPublishRes = await postPublish({
      request: new Request("http://localhost/api/admin/policies/publish", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: adminCookie,
          "idempotency-key": "k-pol-pub-100",
        },
        body: JSON.stringify({ policyId: pol.proposalId }),
      }),
      locals: localsWithEnv(),
    } as any);
    assert.equal(polPublishRes.status, 201);

    // Superseding a policy with a resolution must also be rejected (409)
    const govSupersedeRes = await postSupersede({
      request: new Request("http://localhost/api/admin/policies/supersede", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: adminCookie,
          "idempotency-key": "k-gov-sup-1",
        },
        body: JSON.stringify({
          policyId: pol.proposalId,
          successorPolicyId: govRes.proposalId,
          reason: "Invalid successor",
        }),
      }),
      locals: localsWithEnv(),
    } as any);
    assert.equal(govSupersedeRes.status, 409);

    const publicPolRes = await getPublicPolicy({
      params: { id: pol.proposalId },
      locals: localsWithEnv(),
      request: new Request(`http://localhost/api/v1/policies/${pol.proposalId}`),
    } as any);
    assert.equal(publicPolRes.status, 200);
  });
});
