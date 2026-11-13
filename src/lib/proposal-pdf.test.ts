import assert from "node:assert/strict";
import test from "node:test";
import { getDatabase } from "./db.ts";
import { saveProposal } from "./store.ts";
import { buildProposalPdfReport } from "./proposal-pdf.ts";
import { GET as getProposalPdf } from "../pages/api/admin/reports/proposal-pdf.ts";
import type { CommentRecord, ProposalSummaryView, SessionUser } from "./types.ts";

function makeProposal(overrides: Partial<ProposalSummaryView> = {}): ProposalSummaryView {
  const now = new Date("2026-11-10T10:00:00.000Z");
  return {
    proposalId: "POL-TEST-1",
    slug: "test-policy-proposal",
    title: "Test Policy Proposal for PDF Reporting",
    kind: "policy",
    space: "Economy",
    stage: "decide",
    summary: "Summary of the test policy proposal.",
    outcomes: ["Outcome one", "Outcome two"],
    details: "Detailed rationale for the proposal.",
    authorId: "member-secret-id",
    authorName: "Alice Example",
    originatingBranchId: "national",
    jurisdictionBranchId: "national",
    governanceAuthorityBranchId: "national",
    publicationScope: "national",
    createdAt: now,
    updatedAt: now,
    commentCount: 1,
    votes: { approve: 12, abstain: 3, reject: 5, total: 20 },
    ...overrides,
  };
}

function makeComment(overrides: Partial<CommentRecord> = {}): CommentRecord {
  return {
    commentId: "cmt-1",
    proposalId: "POL-TEST-1",
    memberId: "member-private-999",
    authorName: "Bob Contributor",
    stance: "support",
    body: "This is a constructive comment on the proposal.",
    upvotes: [],
    createdAt: new Date("2026-11-11T12:00:00.000Z"),
    ...overrides,
  };
}

test("buildProposalPdfReport produces a valid PDF distinguishing open vs completed ballots", () => {
  const openBytes = buildProposalPdfReport({
    proposal: makeProposal({ stage: "decide" }),
    comments: [
      makeComment({
        feedback: {
          status: "incorporated",
          note: "Updated section 2",
          updatedBy: "admin-1",
          updatedByName: "Admin Reviewer",
          updatedAt: new Date("2026-11-12T08:00:00.000Z"),
        },
      }),
    ],
    jurisdictionName: "National",
    originatingBranchName: "National",
    authorityBranchName: "National",
    ballotResult: null,
  });

  const openText = Buffer.from(openBytes).toString("latin1");
  assert.ok(openText.startsWith("%PDF-1.4\n"));
  assert.ok(openText.includes("xref\n"));
  assert.ok(openText.trimEnd().endsWith("%%EOF"));
  assert.ok(openText.includes("POL-TEST-1"));
  assert.ok(openText.includes("Policy proposal"));
  assert.ok(openText.includes("interim totals"));
  assert.ok(openText.includes("formal policy adoption"));
  assert.ok(openText.includes("12 \\(60%\\)"));
  assert.ok(openText.includes("Bob Contributor"));
  assert.ok(openText.includes("Admin response \\(incorporated\\)"));
  assert.ok(!openText.includes("member-private-999"), "must not leak memberId");

  const completedBytes = buildProposalPdfReport({
    proposal: makeProposal({
      proposalId: "GOV-TEST-2",
      kind: "resolution",
      stage: "implement",
      implementationNote: "Implemented by NEC.",
    }),
    comments: [],
    jurisdictionName: "National",
    originatingBranchName: "National",
    authorityBranchName: "National",
    ballotResult: {
      result: "successful",
      decisionEventId: "NEC-2026-11",
      recordedAt: new Date("2026-11-12T09:00:00.000Z"),
    },
  });

  const completedText = Buffer.from(completedBytes).toString("latin1");
  assert.ok(completedText.includes("Governance resolution"));
  assert.ok(completedText.includes('outcome recorded as "successful"'));
  assert.ok(completedText.includes("Implemented by NEC."));
  assert.ok(!completedText.includes("interim totals"));
});

test("buildProposalPdfReport paginates cleanly across multiple pages for many comments", () => {
  const manyComments = Array.from({ length: 35 }, (_, i) =>
    makeComment({
      commentId: `cmt-${i}`,
      authorName: `Member ${i + 1}`,
      body: `Detailed deliberation point ${i + 1} discussing governance, clarity, and implementation details across Australia.`,
    }),
  );

  const bytes = buildProposalPdfReport({
    proposal: makeProposal({ commentCount: manyComments.length }),
    comments: manyComments,
    jurisdictionName: "National",
    originatingBranchName: "National",
    authorityBranchName: "National",
  });
  const text = Buffer.from(bytes).toString("latin1");
  assert.ok(text.includes("Page 1 of "));
  assert.ok(text.includes("Page 2 of "));
});

test("proposal PDF endpoint enforces authentication, branch scope, and returns application/pdf", async () => {
  const prevMode = process.env.APP_MODE;
  process.env.APP_MODE = "test";
  try {
    const db = await getDatabase({ APP_MODE: "test" });
    await db.collection("branches").updateOne(
      { branchId: "vic" },
      { $setOnInsert: { branchId: "vic", name: "Victoria", kind: "state", recognised: true } },
      { upsert: true },
    );
    const adminUser: SessionUser = {
      memberId: "admin-pdf-1",
      email: "admin@test.local",
      name: "Test Admin",
      role: "administrator",
      status: "verified",
      canParticipate: true,
      isStaff: true,
      isAdmin: true,
      isBranchAdmin: false,
      branchAdminIds: [],
    };
    const created = await saveProposal(db, adminUser, {
      title: "Branch Scoped PDF Test Proposal",
      summary: "Summary for branch scoped PDF test.",
      details: "Details for branch scoped PDF test.",
      space: "Governance",
      originatingBranchId: "vic",
      jurisdictionBranchId: "vic",
      governanceAuthorityBranchId: "vic",
      publicationScope: "branch",
    });

    // Unauthenticated -> 401
    const unauth = await getProposalPdf({
      request: new Request(`http://localhost/api/admin/reports/proposal-pdf?proposalId=${created.proposalId}`),
      url: new URL(`http://localhost/api/admin/reports/proposal-pdf?proposalId=${created.proposalId}`),
      locals: { env: { APP_MODE: "test" } },
    } as any);
    assert.equal(unauth.status, 401);

    // Regular member -> 403
    const memberRes = await getProposalPdf({
      request: new Request(`http://localhost/api/admin/reports/proposal-pdf?proposalId=${created.proposalId}`, {
        headers: { Cookie: "engage_dev_user=member" },
      }),
      url: new URL(`http://localhost/api/admin/reports/proposal-pdf?proposalId=${created.proposalId}`),
      locals: { env: { APP_MODE: "test" } },
    } as any);
    assert.equal(memberRes.status, 403);

    // National administrator -> 200 application/pdf
    const adminRes = await getProposalPdf({
      request: new Request(`http://localhost/api/admin/reports/proposal-pdf?proposalId=${created.proposalId}`, {
        headers: { Cookie: "engage_dev_user=administrator" },
      }),
      url: new URL(`http://localhost/api/admin/reports/proposal-pdf?proposalId=${created.proposalId}`),
      locals: { env: { APP_MODE: "test" } },
    } as any);
    assert.equal(adminRes.status, 200);
    assert.equal(adminRes.headers.get("content-type"), "application/pdf");
    const pdfBuf = new Uint8Array(await adminRes.arrayBuffer());
    const pdfStr = Buffer.from(pdfBuf).toString("latin1");
    assert.ok(pdfStr.startsWith("%PDF-1.4"));
    assert.ok(pdfStr.includes("Authorised governance administrators"));
    assert.ok(pdfStr.includes("individual member votes are omitted"));
  } finally {
    process.env.APP_MODE = prevMode;
  }
});
