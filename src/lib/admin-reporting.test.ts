import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildBallotProgressRows,
  buildBranchSummaryRows,
  proposalsSummaryToCsv,
} from "./admin-reporting.ts";
import { GET as exportProposalsCsv } from "../pages/api/admin/reports/proposals.csv.ts";
import { getDatabase } from "./db.ts";
import type { ProposalSummaryView } from "./types.ts";

function makeProposal(
  overrides: Partial<ProposalSummaryView> = {},
): ProposalSummaryView {
  return {
    proposalId: "PROP-100",
    slug: "prop-100",
    title: "Test Proposal",
    space: "General",
    summary: "Summary",
    outcomes: ["Outcome 1"],
    details: "Details",
    stage: "decide",
    createdAt: new Date("2026-10-01T00:00:00Z"),
    updatedAt: new Date("2026-11-01T00:00:00Z"),
    kind: "policy",
    originatingBranchId: "vic",
    commentCount: 3,
    votes: { approve: 10, abstain: 2, reject: 1, total: 13 },
    ...overrides,
  };
}

describe("admin reporting", () => {
  it("builds open ballot progress rows with unbound ballots prioritised", () => {
    const branchNames = new Map([
      ["vic", "Victoria"],
      ["nsw", "New South Wales"],
    ]);
    const rows = buildBallotProgressRows(
      [
        makeProposal({
          proposalId: "PROP-1",
          ballotRevisionId: "rev-1",
          originatingBranchId: "vic",
        }),
        makeProposal({
          proposalId: "GOV-2",
          kind: "resolution",
          ballotRevisionId: undefined,
          originatingBranchId: "nsw",
        }),
        makeProposal({
          proposalId: "PROP-3",
          stage: "deliberate",
        }),
      ],
      branchNames,
    );

    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.proposalId, "GOV-2");
    assert.equal(rows[0]!.bound, false);
    assert.equal(rows[0]!.branchName, "New South Wales");
    assert.equal(rows[1]!.proposalId, "PROP-1");
    assert.equal(rows[1]!.bound, true);
    assert.equal(rows[1]!.total, 13);
  });

  it("builds aggregate branch summaries without exposing member identities", () => {
    const summary = buildBranchSummaryRows(
      [
        makeProposal({ proposalId: "P1", stage: "decide", originatingBranchId: "vic" }),
        makeProposal({
          proposalId: "P2",
          stage: "deliberate",
          originatingBranchId: "vic",
          votes: { approve: 0, abstain: 0, reject: 0, total: 0 },
        }),
      ],
      [{ branchId: "vic", name: "Victoria", kind: "state" }],
      new Map([["vic", 42]]),
    );

    assert.equal(summary.length, 1);
    assert.equal(summary[0]!.verifiedMembers, 42);
    assert.equal(summary[0]!.decide, 1);
    assert.equal(summary[0]!.deliberate, 1);
    assert.equal(summary[0]!.totalProposals, 2);
    assert.equal(summary[0]!.totalVotes, 13);

    // Branch-scoped admin only sees allowed branches even if a cross-branch proposal exists
    const scoped = buildBranchSummaryRows(
      [
        makeProposal({
          proposalId: "P3",
          originatingBranchId: "nsw",
          jurisdictionBranchId: "vic",
        }),
      ],
      [
        { branchId: "vic", name: "Victoria", kind: "state" },
        { branchId: "nsw", name: "New South Wales", kind: "state" },
      ],
      new Map([
        ["vic", 42],
        ["nsw", 99],
      ]),
      new Set(["vic"]),
    );
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0]!.branchId, "vic");
  });

  it("exports formula-safe CSV with aggregate counts only", () => {
    const csv = proposalsSummaryToCsv(
      [
        makeProposal({
          proposalId: "PROP-9",
          title: '=HYPERLINK("http://bad")',
          supersededByProposalId: "PROP-10",
        }),
      ],
      new Map([["vic", "Victoria"]]),
    );
    const lines = csv.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /^proposalId,title,kind,stage/);
    assert.ok(lines[1]!.includes("'=HYPERLINK"));
    assert.ok(lines[1]!.includes("PROP-10"));
    assert.ok(!lines[1]!.includes("@"));
  });

  it("enforces admin/branch-admin authorisation on CSV export endpoint", async () => {
    const env = { APP_MODE: "development" };
    await getDatabase(env);

    const unauth = await exportProposalsCsv({
      locals: { runtime: { env } },
      request: new Request("http://localhost/api/admin/reports/proposals.csv"),
      url: new URL("http://localhost/api/admin/reports/proposals.csv"),
    } as never);
    assert.equal(unauth.status, 401);
  });
});
