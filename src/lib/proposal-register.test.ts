import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDb, getDatabase } from "./db.ts";
import { GET as getBallotTally } from "../pages/api/admin/proposals/ballot-tally.ts";
import type { Db } from "mongodb";
import {
  PROPOSAL_REGISTER_PAGE_SIZE,
  describeRegisterBallot,
  listProposalRegister,
  loadProposalEditorRecord,
  parseRegisterPage,
  parseRegisterStage,
  registerPageHref,
  registerRuleBasisLabel,
  resolveRegisterPageSize,
} from "./proposal-register.ts";
import { PROPOSAL_VOTES, proposalBallotId } from "./vote-storage.ts";
import type { ProposalStage } from "./types.ts";

const STAGES: ProposalStage[] = [
  "propose",
  "deliberate",
  "decide",
  "implement",
  "archived",
];

const proposalIdAt = (index: number) => `POL-${String(index + 1).padStart(3, "0")}`;

async function seedRegister(count = 60): Promise<Db> {
  const db = createMemoryDb();
  const proposals = db.collection("proposals");
  await Promise.all(
    Array.from({ length: count }, (_value, index) => {
      const proposalId = proposalIdAt(index);
      return proposals.insertOne({
        proposalId,
        slug: proposalId.toLowerCase(),
        title: `Synthetic proposal ${index + 1}`,
        space: index % 3 === 0 ? "Governance" : "Economy",
        stage: STAGES[index % STAGES.length],
        kind: "policy",
        summary: `Summary for ${proposalId}`,
        details: index === 7 ? "Rationale mentions the zebra crossing pilot." : `Details for ${proposalId}`,
        originatingBranchId: index % 2 === 0 ? "branch-a" : "branch-b",
        jurisdictionBranchId: index % 2 === 0 ? "branch-a" : "branch-b",
        ...(index % STAGES.length === 2 ? { ballotRevisionId: "rev-1" } : {}),
        updatedAt: new Date(2026, 0, index + 1),
      });
    }),
  );
  await db.collection("comments").insertOne({
    commentId: "comment-1",
    proposalId: proposalIdAt(0),
    memberId: "member-1",
    stance: "support",
    body: "Synthetic stance",
    createdAt: new Date(),
  });
  await db.collection("comments").insertOne({
    commentId: "comment-2",
    proposalId: proposalIdAt(0),
    memberId: "member-2",
    stance: "concern",
    body: "Another stance",
    createdAt: new Date(),
  });
  return db;
}

/**
 * Wraps a database so tests can see exactly which collections and projections a
 * read touched. Proves the register never reaches for vote storage.
 */
function spyDb(db: Db) {
  const accesses: Array<{ name: string; projection?: Record<string, unknown> }> = [];
  const wrapped = new Proxy(db as any, {
    get(target, property) {
      if (property === "collection") {
        return (name: string) => {
          const record: { name: string; projection?: Record<string, unknown> } = { name };
          accesses.push(record);
          const collection = target.collection(name);
          return new Proxy(collection, {
            get(source, key) {
              if (key === "find") {
                return (filter?: Record<string, unknown>, options?: { projection?: Record<string, unknown> }) => {
                  if (options?.projection) record.projection = options.projection;
                  return source.find(filter ?? {}, options);
                };
              }
              if (key === "aggregate") {
                return (pipeline: Array<Record<string, any>>) => {
                  const projectStage = pipeline.find((stage) => stage.$project);
                  if (projectStage?.$project) record.projection = projectStage.$project;
                  return source.aggregate(pipeline);
                };
              }
              const value = (source as any)[key];
              return typeof value === "function" ? value.bind(source) : value;
            },
          });
        };
      }
      const value = (target as any)[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: wrapped as Db, accesses };
}

describe("admin proposal register pagination", () => {
  it("reads 25 rows by default and reports the total and page count", async () => {
    const db = await seedRegister(60);
    const first = await listProposalRegister(db);

    assert.equal(first.pageSize, PROPOSAL_REGISTER_PAGE_SIZE);
    assert.equal(first.total, 60);
    assert.equal(first.pageCount, 3);
    assert.equal(first.page, 1);
    assert.equal(first.entries.length, 25);
    assert.equal(first.startIndex, 1);
    assert.equal(first.endIndex, 25);
    assert.equal(first.entries[0]!.row.proposalId, "POL-001");
    assert.equal(first.entries[24]!.row.proposalId, "POL-025");
  });

  it("returns the last partial page and clamps out-of-range pages", async () => {
    const db = await seedRegister(60);
    const last = await listProposalRegister(db, { page: 3 });
    assert.equal(last.page, 3);
    assert.equal(last.entries.length, 10);
    assert.equal(last.startIndex, 51);
    assert.equal(last.endIndex, 60);
    assert.equal(last.entries[9]!.row.proposalId, "POL-060");

    const beyond = await listProposalRegister(db, { page: 99 });
    assert.equal(beyond.page, 3, "a page past the end clamps to the last page");
    assert.equal(beyond.entries.length, 10);

    const below = await listProposalRegister(db, { page: -4 });
    assert.equal(below.page, 1, "a page below 1 clamps to the first page");

    const nonsense = await listProposalRegister(db, { page: Number.NaN });
    assert.equal(nonsense.page, 1);
  });

  it("orders rows stably by proposal id across pages", async () => {
    const db = await seedRegister(60);
    const pages = await Promise.all(
      [1, 2, 3].map((page) => listProposalRegister(db, { page })),
    );
    const ids = pages.flatMap((page) => page.entries.map((entry) => entry.row.proposalId));
    assert.equal(ids.length, 60);
    assert.deepEqual(ids, [...ids].sort());
    assert.equal(new Set(ids).size, 60);
  });

  it("applies stage, branch and search filters to the total and the page", async () => {
    const db = await seedRegister(60);

    const decide = await listProposalRegister(db, { stage: "decide" });
    assert.equal(decide.total, 12);
    assert.ok(decide.entries.every((entry) => entry.row.stage === "decide"));

    const branchA = await listProposalRegister(db, { branch: "branch-a" });
    assert.equal(branchA.total, 30);
    assert.ok(branchA.entries.every((entry) => entry.row.originatingBranchId === "branch-a"));

    const searched = await listProposalRegister(db, { search: "POL-042" });
    assert.equal(searched.total, 1);
    assert.equal(searched.entries[0]!.row.proposalId, "POL-042");

    const unknownStage = await listProposalRegister(db, { stage: "not-a-stage" });
    assert.equal(unknownStage.total, 60, "an unknown stage means all stages");
  });

  it("keeps legacy stored stage values in the stage they normalise to", async () => {
    const db = await seedRegister(10);
    await db.collection("proposals").insertOne({
      proposalId: "POL-LEGACY",
      slug: "pol-legacy",
      title: "Legacy voting row",
      space: "Governance",
      stage: "voting",
      kind: "policy",
      summary: "Legacy stage name",
      details: "",
      originatingBranchId: "branch-a",
      updatedAt: new Date(),
    });

    const decide = await listProposalRegister(db, { stage: "decide" });
    assert.equal(decide.stageCounts.decide, 3, "counts normalise the stored stage");
    assert.equal(decide.total, 3, "the filter matches the same rows the count reports");
    assert.ok(decide.entries.some((entry) => entry.row.proposalId === "POL-LEGACY"));
  });

  it("reads legacy policyId/status/category records without loading rationale", async () => {
    const db = await seedRegister(5);
    await db.collection("proposals").insertOne({
      policyId: "POL-LEGACY-2",
      title: "Legacy policy record",
      category: "Legacy space",
      status: "voting",
      statement: "Legacy statement text",
      slug: "legacy-policy-record",
      kind: "policy",
      details: "Legacy rationale that mentions a legacycanary.",
      originatingBranchId: "branch-b",
      updatedAt: new Date(),
    });

    const all = await listProposalRegister(db);
    assert.equal(all.total, 6, "legacy identifiers are counted");
    assert.deepEqual(all.spaces, ["Economy", "Governance", "Legacy space"]);

    const legacy = all.entries.find((entry) => entry.row.proposalId === "POL-LEGACY-2");
    assert.ok(legacy, "the row is keyed by its legacy policy id");
    assert.equal(legacy.row.stage, "decide", "the legacy status maps to its stage");
    assert.equal(legacy.row.space, "Legacy space");

    const decide = await listProposalRegister(db, { stage: "decide" });
    assert.ok(decide.entries.some((entry) => entry.row.proposalId === "POL-LEGACY-2"));
    assert.equal(decide.total, decide.entries.length);

    const searched = await listProposalRegister(db, { search: "legacycanary" });
    assert.equal(searched.total, 1, "search still matches legacy rationale");
    assert.equal(searched.entries[0]!.row.proposalId, "POL-LEGACY-2");
    assert.equal("details" in searched.entries[0]!.row, false);
  });

  it("keeps search working on rationale without loading it", async () => {
    const db = await seedRegister(60);
    const result = await listProposalRegister(db, { search: "zebra crossing" });
    assert.equal(result.total, 1);
    assert.equal(result.entries[0]!.row.proposalId, "POL-008");
    assert.equal("details" in result.entries[0]!.row, false);
  });

  it("returns a sensible empty page", async () => {
    const db = await seedRegister(10);
    const empty = await listProposalRegister(db, { search: "nothing matches this" });
    assert.equal(empty.total, 0);
    assert.equal(empty.page, 1);
    assert.equal(empty.pageCount, 1);
    assert.equal(empty.entries.length, 0);
    assert.equal(empty.startIndex, 0);
    assert.equal(empty.endIndex, 0);
    assert.equal(empty.stageCounts.all, 10);
  });

  it("counts stages and unbound ballots across the whole register, not the page", async () => {
    const db = await seedRegister(60);
    const page = await listProposalRegister(db, { page: 2, stage: "archived" });
    assert.equal(page.total, 12);
    assert.equal(page.stageCounts.all, 60);
    assert.equal(page.stageCounts.decide, 12);
    assert.equal(page.stageCounts.archived, 12);
    assert.equal(page.unboundBallotCount, 0);
    assert.equal(page.scopedProposalIds.length, 60);
    assert.equal(page.spaces.length, 2);
  });

  it("limits a branch administrator to their own register", async () => {
    const db = await seedRegister(60);
    const scoped = await listProposalRegister(db, { branchScopeIds: ["branch-a"] });
    assert.equal(scoped.total, 30);
    assert.equal(scoped.stageCounts.all, 30);
    assert.ok(scoped.scopedProposalIds.every((id) => {
      const index = Number(id.slice(4)) - 1;
      return index % 2 === 0;
    }));

    const none = await listProposalRegister(db, { branchScopeIds: [] });
    assert.equal(none.total, 0);
    assert.equal(none.entries.length, 0);
  });

  it("clamps page sizes", () => {
    assert.equal(resolveRegisterPageSize(undefined), 25);
    assert.equal(resolveRegisterPageSize(0), 25);
    assert.equal(resolveRegisterPageSize(-5), 1);
    assert.equal(resolveRegisterPageSize(25.9), 25);
    assert.equal(resolveRegisterPageSize(1000), 100);
  });

  it("parses pages and stages deterministically", () => {
    assert.equal(parseRegisterPage(null), 1);
    assert.equal(parseRegisterPage(""), 1);
    assert.equal(parseRegisterPage("abc"), 1);
    assert.equal(parseRegisterPage("0"), 1);
    assert.equal(parseRegisterPage("-2"), 1);
    assert.equal(parseRegisterPage("4"), 4);

    assert.equal(parseRegisterStage(null), "");
    assert.equal(parseRegisterStage("all"), "");
    assert.equal(parseRegisterStage("DECIDE"), "decide");
    assert.equal(parseRegisterStage("archived"), "archived");
    assert.equal(parseRegisterStage("bogus"), "");
  });

  it("builds pagination links that keep filters and drop page 1", () => {
    const filters = { q: "zebra", stage: "decide", branch: "branch-a" };
    const first = registerPageHref(filters, 1);
    assert.equal(first, "/admin/proposals/?q=zebra&stage=decide&branch=branch-a");
    assert.equal(first.includes("page="), false, "page 1 has no page parameter");

    const second = registerPageHref(filters, 2);
    assert.equal(second, "/admin/proposals/?q=zebra&stage=decide&branch=branch-a&page=2");

    assert.equal(registerPageHref({ stage: "all" }, 1), "/admin/proposals/");
    assert.equal(registerPageHref({ q: "  " }, 1), "/admin/proposals/");
    assert.equal(registerPageHref({ q: "a b&c" }, 1), "/admin/proposals/?q=a+b%26c");
  });
});

describe("admin proposal register read shape", () => {
  it("never reads proposal_votes and projects rationale out of the list", async () => {
    const seeded = await seedRegister(60);
    const { db, accesses } = spyDb(seeded);
    const page = await listProposalRegister(db, { page: 2, search: "Synthetic" });

    assert.ok(page.entries.length > 0);
    assert.equal(
      accesses.some((access) => access.name === PROPOSAL_VOTES),
      false,
      "the register must never read or decrypt proposal_votes",
    );

    const proposalReads = accesses.filter((access) => access.name === "proposals" && access.projection);
    assert.ok(proposalReads.length >= 2, "metadata and page reads are both projected");
    for (const read of proposalReads) {
      assert.equal("details" in read.projection!, false);
      assert.equal("detailHtml" in read.projection!, false);
      assert.equal(read.projection!.proposalId, 1);
    }

    for (const entry of page.entries) {
      assert.equal("details" in entry.row, false);
      assert.equal("detailHtml" in entry.row, false);
      assert.equal("votes" in entry.row, false);
    }
  });

  it("loads the full record only for an explicit edit, even from a later page", async () => {
    const db = await seedRegister(60);
    const third = await listProposalRegister(db, { page: 3 });
    const target = third.entries[0]!.row;

    assert.ok(
      third.scopedProposalIds.includes(target.proposalId),
      "the page can resolve an editor target that is not on page 1",
    );

    await db.collection(PROPOSAL_VOTES).insertOne({
      proposalId: target.proposalId,
      ballotId: proposalBallotId(target.proposalId),
      memberId: "member-1",
      choice: "approve",
      updatedAt: new Date(),
    });

    const editor = await loadProposalEditorRecord(db, target.proposalId);
    assert.ok(editor);
    assert.equal(editor.proposal.proposalId, target.proposalId);
    assert.equal(typeof editor.proposal.details, "string");
    assert.ok(editor.proposal.details.length > 0);
    assert.equal(editor.voteCount, 1);

    assert.equal(await loadProposalEditorRecord(db, "POL-999"), null);
    assert.equal(await loadProposalEditorRecord(db, "  "), null);
  });
});

describe("admin proposal register ballot display", () => {
  it("shows the tally stored at certification", async () => {
    const db = await seedRegister(60);
    const decideId = proposalIdAt(2); // stage decide with a bound revision
    await db.collection("ballot_results").insertOne({
      ballotId: proposalBallotId(decideId),
      proposalId: decideId,
      revisionId: "rev-1",
      result: "successful",
      computedResult: "successful",
      ruleBasis: "simple-majority-d9-v1",
      tally: { approve: 7, abstain: 1, reject: 2, total: 10 },
      recordedAt: new Date("2026-02-01T00:00:00Z"),
    });

    const page = await listProposalRegister(db, { stage: "decide" });
    const entry = page.entries.find((row) => row.row.proposalId === decideId);
    assert.ok(entry);
    assert.equal(entry.ballot.state, "certified");
    assert.equal(entry.ballot.label, "Certified Successful");
    assert.deepEqual(entry.ballot.tally, { approve: 7, abstain: 1, reject: 2, total: 10 });
    assert.equal(entry.ballot.outcomeLabel, "Successful");
    assert.equal(entry.ballot.computedLabel, "Successful");
    assert.equal(entry.ballot.ruleBasisLabel, "Simple majority (D9)");
    assert.equal(entry.ballot.overridden, undefined);
  });

  it("shows the stored override and computed result", async () => {
    const db = await seedRegister(60);
    const decideId = proposalIdAt(2);
    await db.collection("ballot_results").insertOne({
      ballotId: proposalBallotId(decideId),
      proposalId: decideId,
      result: "inconclusive",
      computedResult: "unsuccessful",
      ruleBasis: "simple-majority-d9-v1",
      tally: { approve: 2, abstain: 0, reject: 2, total: 4 },
      override: { reason: "Quorum question referred to the NEC.", by: "admin-1", at: new Date() },
      recordedAt: new Date(),
    });
    const entry = (await listProposalRegister(db, { stage: "decide" })).entries.find(
      (row) => row.row.proposalId === decideId,
    );
    assert.ok(entry);
    assert.equal(entry.ballot.overridden, true);
    assert.equal(entry.ballot.overrideReason, "Quorum question referred to the NEC.");
    assert.equal(entry.ballot.computedLabel, "Unsuccessful");
    assert.equal(entry.ballot.outcomeLabel, "Inconclusive");
  });

  it("links to an open ballot instead of claiming live counts", async () => {
    const db = await seedRegister(60);
    const openId = proposalIdAt(2);
    const entry = (await listProposalRegister(db, { stage: "decide" })).entries.find(
      (row) => row.row.proposalId === openId,
    );
    assert.ok(entry);
    assert.equal(entry.ballot.state, "open");
    assert.equal(entry.ballot.label, "Open — view ballot");
    assert.equal(entry.ballot.tally, undefined, "an open ballot has no certified tally");
    assert.equal(entry.ballot.href, `/admin/proposals/${openId.toLowerCase()}/#record-outcome`);
  });

  it("distinguishes a closed but uncertified ballot", async () => {
    const db = await seedRegister(60);
    const closedId = proposalIdAt(2);
    await db.collection("ballots").insertOne({
      ballotId: proposalBallotId(closedId),
      proposalId: closedId,
      status: "closed",
    });
    const entry = (await listProposalRegister(db, { stage: "decide" })).entries.find(
      (row) => row.row.proposalId === closedId,
    );
    assert.ok(entry);
    assert.equal(entry.ballot.state, "closed");
    assert.equal(entry.ballot.label, "Closed — record outcome");
    assert.equal(entry.ballot.tally, undefined);
  });

  it("describes the same ballot state without a database", () => {
    assert.deepEqual(
      describeRegisterBallot({ stage: "propose", slug: "pol-001", certified: null, closed: false }),
      { state: "none", label: "No ballot yet" },
    );
    assert.equal(
      describeRegisterBallot({ stage: "implement", slug: "pol-001", certified: null, closed: true }).label,
      "No certified ballot",
    );
    assert.equal(
      registerRuleBasisLabel("simple-majority-d9-v1"),
      "Simple majority (D9)",
    );
    assert.equal(registerRuleBasisLabel(undefined), undefined);
  });

  it("matches legacy policyId and category in search and normalises whitespace/case in legacy status", async () => {
    const db = createMemoryDb();
    await db.collection("proposals").insertOne({
      policyId: "LEG-101",
      slug: "leg-101",
      title: "Legacy Transport Charter",
      category: "Infrastructure",
      status: " Voting ",
      summary: "Legacy summary.",
    });
    await db.collection("proposals").insertOne({
      proposalId: "POL-202",
      slug: "pol-202",
      title: "Modern Education Motion",
      space: "Education",
      stage: "propose",
      summary: "Modern summary.",
    });

    const byPolicyId = await listProposalRegister(db, { search: "LEG-101" });
    assert.equal(byPolicyId.total, 1);
    assert.equal(byPolicyId.entries[0]?.row.proposalId, "LEG-101");

    const byCategory = await listProposalRegister(db, { search: "Infrastructure" });
    assert.equal(byCategory.total, 1);
    assert.equal(byCategory.entries[0]?.row.proposalId, "LEG-101");

    const decide = await listProposalRegister(db, { stage: "decide" });
    assert.equal(decide.total, 1);
    assert.equal(decide.stageCounts.decide, 1);
    assert.equal(decide.entries[0]?.row.proposalId, "LEG-101");
  });

  it("orders multiple legacy policyId records deterministically across page boundaries", async () => {
    const db = createMemoryDb();
    await db.collection("proposals").insertOne({ policyId: "LEG-003", slug: "leg-003", title: "Third", category: "General", status: "draft" });
    await db.collection("proposals").insertOne({ policyId: "LEG-001", slug: "leg-001", title: "First", category: "General", status: "draft" });
    await db.collection("proposals").insertOne({ policyId: "LEG-002", slug: "leg-002", title: "Second", category: "General", status: "draft" });
    await db.collection("proposals").insertOne({ proposalId: "POL-004", slug: "pol-004", title: "Fourth", space: "General", stage: "propose" });

    const page1 = await listProposalRegister(db, { page: 1, pageSize: 2 });
    const page2 = await listProposalRegister(db, { page: 2, pageSize: 2 });
    assert.deepEqual(
      page1.entries.map((entry) => entry.row.proposalId),
      ["LEG-001", "LEG-002"],
    );
    assert.deepEqual(
      page2.entries.map((entry) => entry.row.proposalId),
      ["LEG-003", "POL-004"],
    );
  });
});

describe("on-demand ballot tally endpoint", () => {
  const devEnv = { APP_MODE: "development" };
  const callTally = (url: string, cookie?: string) =>
    getBallotTally({
      request: new Request(url, {
        headers: cookie ? { cookie } : {},
      }),
      url: new URL(url),
      locals: { runtime: { env: devEnv } },
    } as any);

  it("enforces auth, validates input, and returns the bound tally only on demand", async () => {
    const db = await getDatabase(devEnv);
    const id = `TALLY-${crypto.randomUUID().slice(0, 8)}`;
    await db.collection("proposals").insertOne({
      proposalId: id,
      slug: id.toLowerCase(),
      title: "On-demand tally proposal",
      space: "Governance",
      stage: "decide",
      kind: "policy",
      ballotRevisionId: "rev-tally-1",
      ballotClosesAt: new Date("2020-01-01T00:00:00Z"),
    });
    await db.collection(PROPOSAL_VOTES).insertOne({
      ballotId: proposalBallotId(id),
      proposalId: id,
      memberId: "voter-1",
      choice: "approve",
      revisionId: "rev-tally-1",
      createdAt: new Date(),
    });

    const unauth = await callTally(`https://engage.test/api/admin/proposals/ballot-tally?proposalId=${id}`);
    assert.equal(unauth.status, 401);

    const memberRes = await callTally(
      `https://engage.test/api/admin/proposals/ballot-tally?proposalId=${id}`,
      "engage_dev_user=member",
    );
    assert.equal(memberRes.status, 403);

    const missingId = await callTally(
      "https://engage.test/api/admin/proposals/ballot-tally",
      "engage_dev_user=administrator",
    );
    assert.equal(missingId.status, 400);

    const notFound = await callTally(
      "https://engage.test/api/admin/proposals/ballot-tally?proposalId=DOES-NOT-EXIST",
      "engage_dev_user=administrator",
    );
    assert.equal(notFound.status, 404);

    const okRes = await callTally(
      `https://engage.test/api/admin/proposals/ballot-tally?proposalId=${id}`,
      "engage_dev_user=administrator",
    );
    assert.equal(okRes.status, 200);
    assert.equal(okRes.headers.get("cache-control"), "private, no-store");
    const body = (await okRes.json()) as any;
    assert.equal(body.proposalId, id);
    assert.equal(body.closed, true);
    assert.equal(body.computedLabel, "Successful");
    assert.deepEqual(body.summary.tally, { approve: 1, abstain: 0, reject: 0, total: 1 });
  });
});
