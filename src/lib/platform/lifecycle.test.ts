import assert from "node:assert/strict";
import test from "node:test";
import { loadPolicyCatalogue } from "./catalogue.ts";
import { getDatabase } from "./database.ts";
import { createSubmission, listPublicSubmissions, reviewSubmission } from "./consultations.ts";
import { castVote, getBallotResults, type BallotRecord } from "./ballots.ts";
import { validatePolicyRevisionInput } from "./policy-revisions.mjs";
import { createPreviewSessionCookie } from "./auth.ts";
import { POST as createPolicyPost } from "../../pages/api/admin/policies/index.ts";
import { POST as createRevisionPost } from "../../pages/api/admin/policies/[policyId]/revisions.ts";
import { PATCH as patchBallot } from "../../pages/api/admin/ballots/[ballotId].ts";
import { POST as createConsultationPost } from "../../pages/api/consultations/index.ts";
import { POST as reviewConsultationPost } from "../../pages/api/admin/consultations/[submissionId]/review.ts";
import { POST as castVotePost } from "../../pages/api/votes.ts";
import { GET as getPoliciesApi } from "../../pages/api/policies/index.ts";
import type { PlatformEnv, PlatformIdentity, RuntimeLocals } from "./types.ts";

const previewEnv: PlatformEnv = {
  APP_MODE: "preview",
  FORMAL_BALLOTS_ENABLED: "false",
  SESSION_SECRET: "preview-only-session-secret-change-before-sharing-0000",
};

const member1: PlatformIdentity = {
  memberId: "preview-member-01",
  source: "synthetic",
  roles: ["member"],
};

const member2: PlatformIdentity = {
  memberId: "preview-member-02",
  source: "synthetic",
  roles: ["member"],
};

const moderator: PlatformIdentity = {
  memberId: "preview-admin-01",
  source: "synthetic",
  roles: ["member", "moderator", "administrator"],
};

test("Complete policy lifecycle & Engage-readiness: consultation -> amendment review -> settled revision -> ballot vote -> recorded outcome", async () => {
  const db = await getDatabase(previewEnv);

  // 1. Verify initial catalogue loads 76 baseline policies + POL-077 continuous proposal
  const initialCatalogue = await loadPolicyCatalogue(previewEnv);
  assert.ok(initialCatalogue.length >= 77, `Expected >= 77 policies, got ${initialCatalogue.length}`);

  const pol025 = initialCatalogue.find((p) => p.id === "POL-025");
  assert.ok(pol025, "Expected POL-025 in catalogue");
  assert.equal(pol025.provenance.classification, "materially-revised");
  assert.ok(pol025.provenance.lineage.length >= 1, "Expected lineage on POL-025");

  // 2. Member submits an amendment to POL-077 in the follow-on consultation round (continuous-policy-round-2027-q1)
  // First verify round restriction: submitting POL-077 to first-priority-policy-round-2026 must be rejected
  await assert.rejects(
    () =>
      createSubmission(db, member1, {
        roundId: "first-priority-policy-round-2026",
        policyId: "POL-077",
        policyRevisionId: "POL-077:v1-proposed",
        kind: "amendment",
        title: "Wrong round test",
        body: "Attempting to submit POL-077 into the AGM round where it does not belong.",
      }),
    /not included in the selected consultation round/
  );

  // Now submit POL-077 to its own consultation round
  const submissionId = await createSubmission(db, member1, {
    roundId: "continuous-policy-round-2027-q1",
    policyId: "POL-077",
    policyRevisionId: "POL-077:v1-proposed",
    kind: "amendment",
    title: "Include independent diagnostic tools for medical devices",
    body: "Extend Outcome 1 so regional clinics and biomedical technicians also receive diagnostic schematics.",
  });
  assert.ok(submissionId, "Expected submissionId to be generated");

  // 3. Moderator reviews and accepts the amendment using the returned submissionId
  const reviewedOk = await reviewSubmission(
    db,
    moderator,
    submissionId,
    "accepted",
    "Accepted: incorporated into settled revision POL-077:v2-settled."
  );
  assert.equal(reviewedOk, true, "Expected reviewSubmission to match by submissionId");

  const publicSubs = await listPublicSubmissions(db, { policyId: "POL-077" });
  assert.ok(
    publicSubs.some((s) => s.submissionId === submissionId && s.status === "accepted"),
    "Expected accepted amendment to appear in public submissions"
  );

  // 4. Moderator creates an immutable settled policy revision POL-077:v2-settled
  const parsedRev = validatePolicyRevisionInput({
    version: "v2-settled",
    title: "Guarantee Right to Repair for Farm, Medical, and Consumer Equipment",
    statement:
      "Require manufacturers to provide fair access to diagnostic tools, spare parts, and repair manuals for agricultural, medical, and consumer equipment.",
    outcomes: [
      "Farmers, regional clinics, and independent repairers can access parts and diagnostics without dealer locks.",
      "Products carry a repairability score at point of sale.",
    ],
    details:
      "Settled after Q1 2027 member consultation to include regional medical equipment diagnostics alongside farm machinery.",
    changeSummary: "Added medical device diagnostic access per accepted member amendment.",
  });
  assert.ok(!("error" in parsedRev), "Expected revision input to validate");

  const settledRevisionId = `POL-077:${parsedRev.value.version}`;
  await db.collection("policy_revisions").insertOne({
    policyId: "POL-077",
    revisionId: settledRevisionId,
    ...parsedRev.value,
    body: parsedRev.value.details,
    division: "RECLAIM OUR ECONOMY",
    domain: "Thriving Economy",
    domainSlug: "/reclaim-our-economy/thriving-economy/",
    anchor: "guarantee-right-to-repair-for-farm-and-consumer-equipment",
    url: "/reclaim-our-economy/thriving-economy/#guarantee-right-to-repair-for-farm-and-consumer-equipment",
    createdAt: new Date(),
    createdBy: moderator.memberId,
  });

  // 5. Pin the draft ballot for POL-077 to the settled revision and open it for voting
  const ballotId = "ballot-pol-077";
  await db.collection("ballots").updateOne(
    { ballotId },
    {
      $set: {
        policyRevisionId: settledRevisionId,
        status: "open",
        opensAt: new Date(Date.now() - 60_000),
        closesAt: new Date(Date.now() + 3600_000),
      },
    }
  );

  const openBallot = await db.collection<BallotRecord>("ballots").findOne({ ballotId });
  assert.ok(openBallot, "Expected ballot to exist");

  // 6. Members cast votes on the settled revision
  await castVote(db, member1, openBallot, "approve", previewEnv);
  await castVote(db, member2, openBallot, "approve", previewEnv);

  // Verify no synthetic flag leaked onto the stored vote document
  const rawVote = await db.collection("votes").findOne({ ballotId, memberId: member1.memberId });
  assert.ok(rawVote, "Expected vote in unified votes collection");
  assert.equal("synthetic" in rawVote, false, "Vote record must not contain hardcoded synthetic flag");

  // 7. Close the ballot and verify recorded decision & adopted policy revision in catalogue
  await db.collection("ballots").updateOne(
    { ballotId },
    {
      $set: {
        status: "closed",
        closesAt: new Date(Date.now() - 1_000),
        closedAt: new Date(),
      },
    }
  );

  const closedBallot = await db.collection<BallotRecord>("ballots").findOne({ ballotId });
  assert.ok(closedBallot);
  const results = await getBallotResults(db, closedBallot);
  assert.deepEqual(results, {
    approve: 2,
    doNotApprove: 0,
    votesCast: 2,
    outcome: "approved",
  });

  const updatedCatalogue = await loadPolicyCatalogue(previewEnv);
  const pol077After = updatedCatalogue.find((p) => p.id === "POL-077");
  assert.ok(pol077After);
  assert.equal(pol077After.adoptedRevisionId, settledRevisionId);
  assert.equal(pol077After.adoptionIsSynthetic, true);
  assert.equal(pol077After.ballot?.outcome, "approved");
  assert.equal(pol077After.publishedRevisionId, settledRevisionId);
  assert.equal(pol077After.title, "Guarantee Right to Repair for Farm, Medical, and Consumer Equipment");
});

test("Provenance verification & synthetic governance markers preserve uncertainty and distinguish fixtures from real party decisions", async () => {
  const catalogue = await loadPolicyCatalogue(previewEnv);
  const baseline76 = catalogue.filter((p) => Number(p.id.slice(4)) <= 76);
  assert.equal(baseline76.length, 76);

  // Verify both the prior 13/13/22/5/23 heuristic breakdown and the stricter evidence-audited 9/17/22/5/23 breakdown
  const priorCounts: Record<string, number> = {};
  const auditedCounts: Record<string, number> = {};
  for (const p of baseline76) {
    const prior = p.provenance.priorHeuristicCategory ?? p.provenance.category;
    priorCounts[prior] = (priorCounts[prior] ?? 0) + 1;
    auditedCounts[p.provenance.category] = (auditedCounts[p.provenance.category] ?? 0) + 1;
    assert.equal(p.provenance.materialEquivalenceVerified, false, `${p.id} must preserve materialEquivalenceVerified=false`);
    assert.ok(p.provenance.uncertaintyNote, `${p.id} must carry an explicit uncertaintyNote`);
  }

  assert.deepEqual(priorCounts, {
    "existing-repackaged": 13,
    "materially-revised": 13,
    "new-proposal": 22,
    "draft-derived": 5,
    unverified: 23,
  });

  assert.deepEqual(auditedCounts, {
    "existing-repackaged": 9,
    "materially-revised": 17,
    "new-proposal": 22,
    "draft-derived": 5,
    unverified: 23,
  });

  // Submission-only and FAQ-only policies must not remain in existing-repackaged
  for (const id of ["POL-027", "POL-041", "POL-049", "POL-056"]) {
    const item = baseline76.find((p) => p.id === id)!;
    assert.equal(item.provenance.category, "materially-revised", `${id} should be reclassified out of existing-repackaged`);
  }

  // POL-010 has an unapproved synthetic v2-settled revision pinned to its open preview ballot:
  // verify the public policy text remains the authentic baseline demo-v1:POL-010 until approved,
  // while POL-010:v2-settled is exposed as pendingSettledRevision with syntheticFixture=true.
  const pol010 = baseline76.find((p) => p.id === "POL-010")!;
  assert.equal(pol010.publishedRevisionId, "demo-v1:POL-010");
  assert.equal(pol010.statement.includes("five-year credit window"), false);
  assert.ok(pol010.pendingSettledRevision);
  assert.equal(pol010.pendingSettledRevision.revisionId, "POL-010:v2-settled");
  assert.equal(pol010.pendingSettledRevision.syntheticFixture, true);

  // Verify continuous-policy-round-2027-q1 and POL-077 are explicitly marked syntheticFixture=true
  const pol077 = catalogue.find((p) => p.id === "POL-077")!;
  assert.equal(pol077.syntheticFixture, true);
  assert.ok(pol077.consultationRounds.some((r) => r.roundId === "continuous-policy-round-2027-q1" && r.syntheticFixture === true));
});

test("Engage readiness & dynamic publication via application HTTP APIs for a newly created synthetic policy (POL-078)", async () => {
  const locals: RuntimeLocals = { runtime: { env: previewEnv } };
  const adminCookie = (await createPreviewSessionCookie("preview-admin-01", previewEnv, false)).split(";")[0]!;
  const member1Cookie = (await createPreviewSessionCookie("preview-member-01", previewEnv, false)).split(";")[0]!;
  const member2Cookie = (await createPreviewSessionCookie("preview-member-02", previewEnv, false)).split(";")[0]!;

  function jsonReq(url: string, method: string, cookie: string, body?: unknown): Request {
    return new Request(url, {
      method,
      headers: {
        origin: "http://localhost:4321",
        cookie,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  // 1. CREATE: Admin creates brand-new synthetic policy POL-078 via POST /api/admin/policies
  const createRes = await createPolicyPost({
    request: jsonReq("http://localhost:4321/api/admin/policies", "POST", adminCookie, {
      policyId: "POL-078",
      version: "v1-proposed",
      division: "RECLAIM OUR ECONOMY",
      domain: "Build up Small Businesses",
      roundId: "continuous-policy-round-2027-q1",
      title: "Establish Regional Open-Access Fibre Backhaul",
      statement: "Provide open-access wholesale dark fibre along regional highway and rail corridors so small ISPs and regional businesses can connect on non-discriminatory terms.",
      outcomes: [
        "Regional businesses gain symmetric gigabit broadband at metropolitan wholesale prices.",
        "Competitive retail telecommunications providers can enter regional markets without duplicating backhaul.",
      ],
      details: "**Initial v1 proposal**\n\nRegional small businesses face high wholesale backhaul charges and single-carrier bottlenecks.",
    }),
    locals,
  });
  assert.equal(createRes.status, 201);
  const createdBody = await createRes.json();
  assert.equal(createdBody.policy.policyId, "POL-078");
  assert.equal(createdBody.policy.revisionId, "POL-078:v1-proposed");
  assert.equal(createdBody.policy.syntheticFixture, true);
  assert.equal(createdBody.ballot.ballotId, "ballot-pol-078");

  // 2. REVIEW: Verify POL-078 appears immediately in the public policy catalogue API with v1-proposed wording
  const reviewRes1 = await getPoliciesApi({
    request: new Request("http://localhost:4321/api/policies?policyId=POL-078"),
    locals,
  });
  const reviewData1 = await reviewRes1.json();
  assert.equal(reviewData1.policies.length, 1);
  assert.equal(reviewData1.policies[0].publishedRevisionId, "POL-078:v1-proposed");
  assert.equal(reviewData1.policies[0].syntheticFixture, true);
  assert.equal(reviewData1.policies[0].adoptedRevisionId, null);

  // 3. COMMENT / AMEND: Member submits an amendment via POST /api/consultations, Moderator accepts via POST /api/admin/consultations/[submissionId]/review
  const subRes = await createConsultationPost({
    request: jsonReq("http://localhost:4321/api/consultations", "POST", member1Cookie, {
      roundId: "continuous-policy-round-2027-q1",
      policyId: "POL-078",
      policyRevisionId: "POL-078:v1-proposed",
      kind: "amendment",
      title: "Add SLA uptime guarantees and emergency bushfire resilience",
      body: "Include statutory wholesale repair SLAs and underground conduit protection in bushfire-prone regional corridors.",
    }),
    locals,
  });
  assert.equal(subRes.status, 201);
  const { submissionId } = await subRes.json();
  assert.ok(submissionId);

  const modRes = await reviewConsultationPost({
    request: jsonReq(`http://localhost:4321/api/admin/consultations/${submissionId}/review`, "POST", adminCookie, {
      status: "accepted",
      moderatorResponse: "Accepted and incorporated into settled revision POL-078:v2-settled.",
    }),
    params: { submissionId },
    locals,
  });
  assert.equal(modRes.status, 200);

  // 4. SETTLE REVISION: Admin creates POL-078:v2-settled and pins/opens ballot-pol-078
  const settleRes = await createRevisionPost({
    request: jsonReq("http://localhost:4321/api/admin/policies/POL-078/revisions", "POST", adminCookie, {
      version: "v2-settled",
      title: "Establish Resilient Regional Open-Access Fibre Backhaul",
      statement: "Provide open-access wholesale dark fibre with bushfire-resilient underground conduits and enforceable repair SLAs along regional highway and rail corridors.",
      outcomes: [
        "Regional businesses gain symmetric gigabit broadband with binding wholesale repair SLAs.",
        "Underground conduit standards protect regional communications during bushfire emergencies.",
        "Competitive retail providers can enter regional markets on non-discriminatory wholesale terms.",
      ],
      details: "**Settled v2 proposal**\n\nUpdated following member consultation to mandate underground bushfire-resilient conduit standards and enforceable wholesale repair SLAs.",
      changeSummary: "Added bushfire-resilient conduit standards and wholesale repair SLAs per accepted member amendment.",
    }),
    params: { policyId: "POL-078" },
    locals,
  });
  assert.equal(settleRes.status, 201);

  const pinRes = await patchBallot({
    request: jsonReq("http://localhost:4321/api/admin/ballots/ballot-pol-078", "PATCH", adminCookie, {
      policyRevisionId: "POL-078:v2-settled",
    }),
    params: { ballotId: "ballot-pol-078" },
    locals,
  });
  assert.equal(pinRes.status, 200);

  const openRes = await patchBallot({
    request: jsonReq("http://localhost:4321/api/admin/ballots/ballot-pol-078", "PATCH", adminCookie, {
      status: "open",
    }),
    params: { ballotId: "ballot-pol-078" },
    locals,
  });
  assert.equal(openRes.status, 200);

  // Verify BEFORE ballot approval: displayed public policy text is still v1-proposed while v2-settled is held as pendingSettledRevision
  const beforeApproveCatalogue = await loadPolicyCatalogue(previewEnv);
  const pol078BeforeApprove = beforeApproveCatalogue.find((p) => p.id === "POL-078")!;
  assert.equal(pol078BeforeApprove.publishedRevisionId, "POL-078:v1-proposed");
  assert.equal(pol078BeforeApprove.title, "Establish Regional Open-Access Fibre Backhaul");
  assert.equal(pol078BeforeApprove.pendingSettledRevision?.revisionId, "POL-078:v2-settled");
  assert.equal(pol078BeforeApprove.adoptedRevisionId, null);

  // 5. VOTE: Members vote Approve via POST /api/votes
  const vote1 = await castVotePost({
    request: jsonReq("http://localhost:4321/api/votes", "POST", member1Cookie, {
      ballotId: "ballot-pol-078",
      choice: "approve",
    }),
    locals,
  });
  assert.equal(vote1.status, 200);

  const vote2 = await castVotePost({
    request: jsonReq("http://localhost:4321/api/votes", "POST", member2Cookie, {
      ballotId: "ballot-pol-078",
      choice: "approve",
    }),
    locals,
  });
  assert.equal(vote2.status, 200);

  // 6. RECORD OUTCOME & PUBLISH: Admin closes ballot-pol-078 via PATCH /api/admin/ballots/ballot-pol-078
  const closeRes = await patchBallot({
    request: jsonReq("http://localhost:4321/api/admin/ballots/ballot-pol-078", "PATCH", adminCookie, {
      status: "closed",
    }),
    params: { ballotId: "ballot-pol-078" },
    locals,
  });
  assert.equal(closeRes.status, 200);
  const closeData = await closeRes.json();
  assert.equal(closeData.outcome, "approved");
  assert.equal(closeData.publishedRevisionId, "POL-078:v2-settled");
  assert.equal(closeData.syntheticOutcome, true);

  // 7. VERIFY PUBLICATION: Public policy view now displays POL-078:v2-settled (title, statement, outcomes, detailHtml) without static JSON edits or rebuild
  const afterApproveCatalogue = await loadPolicyCatalogue(previewEnv);
  const pol078AfterApprove = afterApproveCatalogue.find((p) => p.id === "POL-078")!;
  assert.equal(pol078AfterApprove.adoptedRevisionId, "POL-078:v2-settled");
  assert.equal(pol078AfterApprove.publishedRevisionId, "POL-078:v2-settled");
  assert.equal(pol078AfterApprove.adoptionIsSynthetic, true);
  assert.equal(pol078AfterApprove.pendingSettledRevision, null);
  assert.equal(pol078AfterApprove.title, "Establish Resilient Regional Open-Access Fibre Backhaul");
  assert.ok(pol078AfterApprove.statement.includes("bushfire-resilient underground conduits"));
  assert.equal(pol078AfterApprove.outcomes.length, 3);
  assert.ok(pol078AfterApprove.detailHtml.includes("Settled v2 proposal"));
  assert.ok(pol078AfterApprove.detailHtml.includes("Added bushfire-resilient conduit standards"));
});
