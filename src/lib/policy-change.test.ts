import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDevSessionCookie } from "./auth.ts";
import { getDatabase } from "./db.ts";
import { applyBranchPolicyImport, planBranchPolicyImport } from "./policy-import.ts";
import { canViewProposal, saveProposal } from "./store.ts";
import {
  POLICY_CHANGE_GUIDANCE,
  defaultPolicyChangeTitle,
} from "./policy-change.ts";
import { POST as postRatify } from "../pages/api/admin/policies/ratify.ts";
import { POST as postPublish } from "../pages/api/admin/policies/publish.ts";
import type { SessionUser } from "./types.ts";

const env = {
  APP_MODE: "development",
  BETTER_AUTH_SECRET: "test-secret-policy-change-key-32",
};

const nationalAdmin: SessionUser = {
  memberId: "change-admin",
  name: "National Admin",
  email: "change-admin@example.org",
  role: "administrator",
  status: "verified",
  canParticipate: true,
  isStaff: true,
  isAdmin: true,
  branchAdminIds: [],
  isBranchAdmin: false,
};

const member: SessionUser = {
  memberId: "change-member",
  name: "Verified Member",
  email: "change-member@example.org",
  role: "member",
  status: "verified",
  canParticipate: true,
  isStaff: false,
  isAdmin: false,
  branchAdminIds: [],
  isBranchAdmin: false,
};

function localsWithEnv() {
  return { runtime: { env } } as any;
}

async function seedBranches(db: Awaited<ReturnType<typeof getDatabase>>) {
  for (const branch of [
    { branchId: "branch-nat", name: "Fusion National", kind: "national" },
    { branchId: "branch-vic", name: "Fusion Victoria", kind: "state" },
  ]) {
    await db.collection("branches").updateOne(
      { branchId: branch.branchId },
      { $setOnInsert: { ...branch, recognised: true } },
      { upsert: true },
    );
  }
  for (const user of [nationalAdmin, member]) {
    await db.collection("members").updateOne(
      { memberId: user.memberId },
      {
        $setOnInsert: {
          memberId: user.memberId,
          name: user.name,
          email: user.email,
        },
      },
      { upsert: true },
    );
    await db.collection("memberships").updateOne(
      { memberId: user.memberId },
      { $set: { memberId: user.memberId, status: "verified" } },
      { upsert: true },
    );
  }
  await db.collection("application_roles").updateOne(
    { memberId: nationalAdmin.memberId, role: "administrator" },
    { $set: { memberId: nationalAdmin.memberId, role: "administrator" } },
    { upsert: true },
  );
}

async function seedPublishedPolicy(
  db: Awaited<ReturnType<typeof getDatabase>>,
  policyId: string,
  extra: Record<string, unknown> = {},
) {
  await db.collection("policy_registry").updateOne(
    { policyId },
    {
      $setOnInsert: {
        policyId,
        title: "Open Government by Default",
        summary: "Publish government information before people ask.",
        commitments: ["Publish before people ask"],
        approvedWording: "The adopted wording.",
        revisionId: `rev-${policyId}-1`,
        revisionIds: [`rev-${policyId}-1`],
        status: "adopted",
        publicationStatus: "published",
        jurisdiction: "Victoria, Australia",
        jurisdictionBranchId: "branch-vic",
        governanceAuthorityBranchId: "branch-vic",
        recordOrigin: "branch-import",
        publishedAt: new Date("2026-11-15T00:00:00Z"),
        ...extra,
      },
    },
    { upsert: true },
  );
}

async function advanceToDecide(
  db: Awaited<ReturnType<typeof getDatabase>>,
  proposalId: string,
) {
  await db
    .collection("proposals")
    .updateOne({ proposalId }, { $set: { secondedAt: new Date() } });
  await saveProposal(db, nationalAdmin, { proposalId, stage: "deliberate" });
  await saveProposal(db, nationalAdmin, { proposalId, stage: "decide" });
  const proposal = await db.collection("proposals").findOne({ proposalId });
  assert.ok(proposal?.ballotRevisionId, "a ballot revision must be bound");
  return String(proposal.ballotRevisionId);
}

async function recordResult(
  db: Awaited<ReturnType<typeof getDatabase>>,
  proposalId: string,
  revisionId: string,
  result: "successful" | "unsuccessful",
  decisionEventId: string,
) {
  await db.collection("ballot_results").updateOne(
    { proposalId },
    {
      $set: {
        proposalId,
        revisionId,
        result,
        decisionEventId,
        authorityBranchId: "branch-vic",
        recordedAt: new Date(),
      },
    },
    { upsert: true },
  );
}

function ratifyRequest(proposalId: string, revisionId: string, decisionEventId: string, key: string) {
  return {
    request: new Request("http://localhost/api/admin/policies/ratify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: createDevSessionCookie("administrator").split(";")[0]!,
        "idempotency-key": key,
      },
      body: JSON.stringify({
        proposalId,
        revisionId,
        decisionEventId,
        authorityBranchId: "branch-vic",
      }),
    }),
    locals: localsWithEnv(),
  } as any;
}

function publishRequest(policyId: string, key: string) {
  return {
    request: new Request("http://localhost/api/admin/policies/publish", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: createDevSessionCookie("administrator").split(";")[0]!,
        "idempotency-key": key,
      },
      body: JSON.stringify({ policyId }),
    }),
    locals: localsWithEnv(),
  } as any;
}

describe("post-ratification policy lifecycle", () => {
  it("names the chosen action and describes when it takes effect", () => {
    const title = "Turn Trams into Surface Rapid Transit";
    assert.equal(defaultPolicyChangeTitle("repeal", title), `Repeal: ${title}`);
    assert.equal(defaultPolicyChangeTitle("amend", title), `Amend: ${title}`);
    assert.equal(
      defaultPolicyChangeTitle("replace", title),
      `Replace: ${title}`,
    );
    assert.match(POLICY_CHANGE_GUIDANCE.repeal.effect, /ratified/);
    assert.match(POLICY_CHANGE_GUIDANCE.amend.effect, /published/);
    assert.match(POLICY_CHANGE_GUIDANCE.replace.effect, /published/);
  });

  it("inherits the policy topic and keeps only the fields the action uses", async () => {
    const db = await getDatabase(env);
    await seedBranches(db);
    await seedPublishedPolicy(db, "vic-transport-policy", {
      category: "Transport & Infrastructure",
    });

    const amendment = await saveProposal(db, member, {
      title: "Amend: Open Government by Default",
      space: "A different topic",
      summary: "Change the publication commitment.",
      targetSection: "Commitment 2",
      proposedWording: "Ignored for an amendment.",
      targetPolicyId: "vic-transport-policy",
      changeType: "amend",
    });
    assert.equal(amendment.space, "Transport & Infrastructure");
    assert.equal(amendment.targetSection, "Commitment 2");
    assert.equal(amendment.proposedWording, undefined);

    const replacement = await saveProposal(db, member, {
      title: "Replace: Open Government by Default",
      summary: "Replace the policy with a narrower one.",
      proposedWording: "The replacement wording.",
      targetSection: "Ignored for a replacement.",
      targetPolicyId: "vic-transport-policy",
      changeType: "replace",
    });
    assert.equal(replacement.space, "Transport & Infrastructure");
    assert.equal(replacement.proposedWording, "The replacement wording.");
    assert.equal(replacement.targetSection, undefined);

    const repeal = await saveProposal(db, member, {
      title: "Repeal: Open Government by Default",
      summary: "This policy should be removed.",
      targetSection: "Ignored for a repeal.",
      proposedWording: "Ignored for a repeal.",
      targetPolicyId: "vic-transport-policy",
      changeType: "repeal",
    });
    assert.equal(repeal.targetSection, undefined);
    assert.equal(repeal.proposedWording, undefined);
  });

  it("creates a change proposal against a published policy and inherits its authority", async () => {
    const db = await getDatabase(env);
    await seedBranches(db);
    await seedPublishedPolicy(db, "vic-open-government-by-default");

    const proposal = await saveProposal(db, member, {
      title: "Amend: Open Government by Default",
      space: "Integrity & Accountability",
      summary: "Extend proactive publication to council-controlled entities.",
      outcomes: ["Add a council register."],
      details: "Extends the publication default.",
      targetPolicyId: "vic-open-government-by-default",
      changeType: "amend",
    });

    assert.equal(proposal.targetPolicyId, "vic-open-government-by-default");
    assert.equal(proposal.targetPolicyRevisionId, "rev-vic-open-government-by-default-1");
    assert.equal(proposal.changeType, "amend");
    assert.equal(proposal.originatingBranchId, "branch-vic");
    assert.equal(proposal.governanceAuthorityBranchId, "branch-vic");
    assert.equal(proposal.jurisdictionBranchId, "branch-vic");
    // Visibility is not eligibility: an ordinary member's proposal is visible
    // even though only Victorian members vote on a Victorian policy.
    assert.equal(proposal.publicationScope, "national");
  });

  it("refuses to change an unpublished or missing policy and cannot retarget afterwards", async () => {
    const db = await getDatabase(env);
    await seedBranches(db);
    await seedPublishedPolicy(db, "vic-draft-policy", {
      publicationStatus: "unpublished",
    });

    await assert.rejects(
      () =>
        saveProposal(db, member, {
          title: "Amend: Draft policy",
          space: "Integrity",
          summary: "Attempt to change a policy that is not published.",
          targetPolicyId: "vic-draft-policy",
          changeType: "amend",
        }),
      /Only a currently published policy/,
    );
    await assert.rejects(
      () =>
        saveProposal(db, member, {
          title: "Amend: Missing policy",
          space: "Integrity",
          summary: "Attempt to change a policy that does not exist.",
          targetPolicyId: "vic-missing",
          changeType: "amend",
        }),
      /Only a currently published policy/,
    );

    const created = await saveProposal(db, member, {
      title: "Amend: Open Government by Default",
      space: "Integrity",
      summary: "A valid starting point for the retarget check.",
      targetPolicyId: "vic-open-government-by-default",
      changeType: "amend",
    });
    await assert.rejects(
      () =>
        saveProposal(db, member, {
          proposalId: created.proposalId,
          targetPolicyId: "vic-other-policy",
          changeType: "repeal",
        }),
      /fixed when it is created/,
    );
  });

  it("does not change the policy while the proposal is a draft", async () => {
    const db = await getDatabase(env);
    await seedBranches(db);
    await seedPublishedPolicy(db, "vic-draft-scope-policy");
    await saveProposal(db, member, {
      title: "Amend: Open Government by Default",
      space: "Integrity",
      summary: "Draft amendments must not alter published policy.",
      targetPolicyId: "vic-draft-scope-policy",
      changeType: "amend",
    });
    const policy = await db
      .collection("policy_registry")
      .findOne({ policyId: "vic-draft-scope-policy" });
    assert.equal(policy?.publicationStatus, "published");
    assert.equal(policy?.title, "Open Government by Default");
    assert.equal(policy?.supersededBy, undefined);
  });

  it("supersedes the predecessor only when the ratified amendment is published", async () => {
    const db = await getDatabase(env);
    await seedBranches(db);
    await seedPublishedPolicy(db, "vic-amend-target");

    const proposal = await saveProposal(db, member, {
      title: "Amend: Open Government by Default",
      space: "Integrity",
      summary: "Extend proactive publication to council-controlled entities.",
      details: "Extended wording.",
      targetPolicyId: "vic-amend-target",
      changeType: "amend",
    });
    const revisionId = await advanceToDecide(db, proposal.proposalId);
    await recordResult(db, proposal.proposalId, revisionId, "successful", "dec-amend-1");
    await saveProposal(db, nationalAdmin, {
      proposalId: proposal.proposalId,
      stage: "implement",
    });

    const ratified = await postRatify(ratifyRequest(proposal.proposalId, revisionId, "dec-amend-1", "k-amend-1"));
    assert.equal(ratified.status, 201);
    const afterRatification = await db
      .collection("policy_registry")
      .findOne({ policyId: "vic-amend-target" });
    assert.equal(
      afterRatification?.publicationStatus,
      "published",
      "ratification alone must not remove the current wording from the public registry",
    );

    const successor = await db
      .collection("policy_registry")
      .findOne({ policyId: proposal.proposalId });
    assert.equal(successor?.publicationStatus, "unpublished");
    assert.equal(successor?.changeType, "amend");
    assert.deepEqual(successor?.supersedes, ["vic-amend-target"]);
    assert.equal(successor?.recordOrigin, "engage-ratification");

    const published = await postPublish(publishRequest(proposal.proposalId, "k-amend-pub-1"));
    assert.equal(published.status, 201);
    const superseded = await db
      .collection("policy_registry")
      .findOne({ policyId: "vic-amend-target" });
    assert.equal(superseded?.publicationStatus, "superseded");
    assert.equal(superseded?.supersededBy, proposal.proposalId);
    assert.equal(superseded?.supersededByChangeType, "amend");
    assert.ok(superseded?.supersessionReason);

    const events = await db
      .collection("governance_events")
      .find({ matterId: "vic-amend-target" })
      .toArray();
    assert.ok(events.some((event: any) => event.eventType === "policy.superseded"));
  });

  it("repeals a policy with the deciding proposal recorded as its lineage", async () => {
    const db = await getDatabase(env);
    await seedBranches(db);
    await seedPublishedPolicy(db, "vic-repeal-target");

    const proposal = await saveProposal(db, member, {
      title: "Repeal: Open Government by Default",
      space: "Integrity",
      summary: "The publication default is now handled by the national platform.",
      targetPolicyId: "vic-repeal-target",
      changeType: "repeal",
    });
    const revisionId = await advanceToDecide(db, proposal.proposalId);
    await recordResult(db, proposal.proposalId, revisionId, "successful", "dec-repeal-1");
    await saveProposal(db, nationalAdmin, {
      proposalId: proposal.proposalId,
      stage: "implement",
    });

    const response = await postRatify(ratifyRequest(proposal.proposalId, revisionId, "dec-repeal-1", "k-repeal-1"));
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.repealed, true);
    assert.equal(body.policy.publicationStatus, "repealed");
    assert.equal(body.policy.repealedBy.proposalId, proposal.proposalId);
    assert.equal(body.policy.repealedBy.decisionEventId, "dec-repeal-1");

    assert.equal(
      await db.collection("policy_registry").countDocuments({ policyId: proposal.proposalId }),
      0,
      "a repeal does not create replacement wording",
    );

    const retried = await postRatify(ratifyRequest(proposal.proposalId, revisionId, "dec-repeal-1", "k-repeal-2"));
    assert.equal(retried.status, 200, "a repeat ratification is idempotent");
  });

  it("leaves the policy untouched when the change ballot is unsuccessful", async () => {
    const db = await getDatabase(env);
    await seedBranches(db);
    await seedPublishedPolicy(db, "vic-reject-target");

    const proposal = await saveProposal(db, member, {
      title: "Repeal: Open Government by Default",
      space: "Integrity",
      summary: "This repeal will not win its ballot.",
      targetPolicyId: "vic-reject-target",
      changeType: "repeal",
    });
    const revisionId = await advanceToDecide(db, proposal.proposalId);
    await recordResult(db, proposal.proposalId, revisionId, "unsuccessful", "dec-reject-1");

    // A defeated change cannot reach Implement at all, so it can never be
    // ratified into the registry by bypassing the ballot outcome.
    await assert.rejects(
      () =>
        saveProposal(db, nationalAdmin, {
          proposalId: proposal.proposalId,
          stage: "implement",
        }),
      /successful ballot result/,
    );
    const response = await postRatify(ratifyRequest(proposal.proposalId, revisionId, "dec-reject-1", "k-reject-1"));
    assert.equal(response.status, 409);
    const policy = await db
      .collection("policy_registry")
      .findOne({ policyId: "vic-reject-target" });
    assert.equal(policy?.publicationStatus, "published");
    assert.equal(policy?.repealedBy, undefined);
  });

  it("refuses a change proposed against wording that has since been superseded", async () => {
    const db = await getDatabase(env);
    await seedBranches(db);
    await seedPublishedPolicy(db, "vic-stale-target");

    const amendment = await saveProposal(db, member, {
      title: "Amend: Open Government by Default",
      space: "Integrity",
      summary: "First amendment.",
      targetPolicyId: "vic-stale-target",
      changeType: "amend",
    });
    const stale = await saveProposal(db, member, {
      title: "Amend: Open Government by Default again",
      space: "Integrity",
      summary: "Second amendment started against the same wording.",
      targetPolicyId: "vic-stale-target",
      changeType: "amend",
    });

    const amendmentRevision = await advanceToDecide(db, amendment.proposalId);
    await recordResult(db, amendment.proposalId, amendmentRevision, "successful", "dec-first-1");
    await saveProposal(db, nationalAdmin, { proposalId: amendment.proposalId, stage: "implement" });
    assert.equal(
      (await postRatify(ratifyRequest(amendment.proposalId, amendmentRevision, "dec-first-1", "k-first-1"))).status,
      201,
    );
    assert.equal((await postPublish(publishRequest(amendment.proposalId, "k-first-pub"))).status, 201);

    const staleRevision = await advanceToDecide(db, stale.proposalId);
    await recordResult(db, stale.proposalId, staleRevision, "successful", "dec-second-1");
    await saveProposal(db, nationalAdmin, { proposalId: stale.proposalId, stage: "implement" });
    const response = await postRatify(ratifyRequest(stale.proposalId, staleRevision, "dec-second-1", "k-second-1"));
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.match(String(body.error), /wording changed|still published/);
  });

  it("keeps imported policy and Engage change lineage readable together", async () => {
    const db = await getDatabase(env);
    await seedBranches(db);
    const plan = await planBranchPolicyImport(db, {
      source: {
        schema_version: 1,
        policies: [
          {
            id: "policy-open-government",
            title: "Set the Rules for Data Centres",
            slug: "set-the-rules-for-data-centres",
            canonical_url: "https://vic.example.org/policies/data-centres",
            status: "adopted",
            summary: "Publish government information before people ask.",
            key_points: [{ point: "Publish before people ask" }],
            authority: { publisher: "Fusion Party Victoria", adopted_policy: true },
          },
        ],
      },
      sourceUrl: "https://vic.example.org/api/policies.json",
      branch: { branchId: "branch-vic", name: "Fusion Victoria", slug: "vic" },
      authorityBasis: "Adopted by the Victorian branch executive.",
      importedAt: new Date("2026-11-15T00:00:00Z"),
      importedBy: "system:branch-policy-import",
    });
    await applyBranchPolicyImport(db, plan);

    const proposal = await saveProposal(db, member, {
      title: "Amend: Open Government by Default",
      space: "Integrity",
      summary: "Data centres should fund the grid capacity they require.",
      targetPolicyId: "vic-set-the-rules-for-data-centres",
      changeType: "amend",
    });
    assert.equal(proposal.governanceAuthorityBranchId, "branch-vic");
    const target = await db
      .collection("policy_registry")
      .findOne({ policyId: "vic-set-the-rules-for-data-centres" });
    assert.equal(target?.recordOrigin, "branch-import");
    assert.equal(target?.ratification, null);
    assert.ok(target?.revisionId);
  });

  it("hides private change proposals from members who cannot see them", async () => {
    const db = await getDatabase(env);
    await seedBranches(db);
    const proposal = {
      proposalId: "PROP-PRIVATE",
      slug: "private",
      title: "Private change",
      space: "Integrity",
      summary: "x",
      outcomes: [],
      details: "",
      stage: "propose" as const,
      publicationScope: "private" as const,
      authorId: "someone-else",
      createdAt: new Date(),
      updatedAt: new Date(),
      targetPolicyId: "vic-open-government-by-default",
      changeType: "amend" as const,
    };
    assert.equal(canViewProposal(proposal as any, member), false);
    assert.equal(canViewProposal(proposal as any, nationalAdmin), true);
  });
});
