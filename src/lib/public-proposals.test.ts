import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "mongodb";
import { createMemoryDb } from "./db.ts";
import {
  PUBLIC_PROPOSAL_PAGE_SIZE,
  attachPublicTallies,
  buildPublicProposalPage,
  clampPublicProposalPage,
  listPublicProposalCandidates,
  parsePublicProposalPage,
  parsePublicProposalStage,
  proposalListHref,
  publicTallyLabel,
  resolvePublicProposalPageSize,
} from "./public-proposals.ts";
import { BALLOT_TALLIES, BALLOT_TALLY_STALENESS_MS } from "./ballot-tallies.ts";
import { PROPOSAL_VOTES, proposalBallotId } from "./vote-storage.ts";
import type { SessionUser } from "./types.ts";

const NOW = new Date("2026-11-16T10:00:00.000Z");

function proposalAt(index: number, overrides: Record<string, unknown> = {}) {
  const proposalId = `PROP-${String(index).padStart(3, "0")}`;
  return {
    proposalId,
    slug: proposalId.toLowerCase(),
    title: `Synthetic proposal ${index}`,
    space: index % 3 === 0 ? "Governance" : "Economy",
    summary: `Summary for ${proposalId}`,
    details: index === 7 ? "Rationale mentions the zebra crossing pilot." : "",
    stage: "deliberate",
    publicationScope: "national",
    updatedAt: new Date(Date.UTC(2026, 0, index + 1)),
    createdAt: new Date(Date.UTC(2026, 0, index + 1)),
    ...overrides,
  };
}

async function seedProposals(db: Db, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await db.collection("proposals").insertOne(proposalAt(index + 1));
  }
}

const memberUser = (overrides: Partial<SessionUser> = {}): SessionUser => ({
  memberId: "member-1",
  name: "Member One",
  email: "member-1@example.test",
  role: "member",
  status: "verified",
  canParticipate: true,
  isStaff: false,
  isAdmin: false,
  activeBranchIds: ["branch-a"],
  branchAdminIds: [],
  ...overrides,
});

async function seedDecide(
  db: Db,
  proposalId: string,
  revisionId = "rev-1",
): Promise<void> {
  await db.collection("proposals").insertOne(
    proposalAt(Number(proposalId.slice(-3)) || 1, {
      proposalId,
      slug: proposalId.toLowerCase(),
      stage: "decide",
      ballotRevisionId: revisionId,
      ballotClosesAt: new Date(NOW.getTime() + 86_400_000),
    }),
  );
}

/** Records which collections and projections a read touched. */
function spyDb(db: Db) {
  const accesses: Array<{
    name: string;
    projection?: Record<string, unknown>;
  }> = [];
  const wrapped = new Proxy(db as any, {
    get(target, property) {
      if (property === "collection") {
        return (name: string) => {
          const record: {
            name: string;
            projection?: Record<string, unknown>;
          } = { name };
          accesses.push(record);
          const collection = target.collection(name);
          return new Proxy(collection, {
            get(source, key) {
              if (key === "find") {
                return (
                  filter?: Record<string, unknown>,
                  options?: { projection?: Record<string, unknown> },
                ) => {
                  if (options?.projection) record.projection = options.projection;
                  return source.find(filter ?? {}, options);
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

describe("proposal list pagination", () => {
  it("reads 25 rows by default and reports totals and page boundaries", async () => {
    const db = createMemoryDb();
    await seedProposals(db, 60);
    const candidates = await listPublicProposalCandidates(db, { user: null });

    const first = await buildPublicProposalPage(db, candidates, { now: NOW });
    assert.equal(first.pageSize, PUBLIC_PROPOSAL_PAGE_SIZE);
    assert.equal(first.total, 60);
    assert.equal(first.pageCount, 3);
    assert.equal(first.page, 1);
    assert.equal(first.rows.length, 25);
    assert.equal(first.startIndex, 1);
    assert.equal(first.endIndex, 25);

    const last = await buildPublicProposalPage(db, candidates, {
      page: 3,
      now: NOW,
    });
    assert.deepEqual(
      { page: last.page, rows: last.rows.length, start: last.startIndex, end: last.endIndex },
      { page: 3, rows: 10, start: 51, end: 60 },
    );
  });

  it("clamps invalid and out-of-range pages", async () => {
    assert.equal(parsePublicProposalPage("abc"), 1);
    assert.equal(parsePublicProposalPage("0"), 1);
    assert.equal(parsePublicProposalPage("-4"), 1);
    assert.equal(parsePublicProposalPage("2"), 2);
    assert.equal(clampPublicProposalPage(9, 3), 3);
    assert.equal(clampPublicProposalPage(0, 3), 1);
    assert.equal(clampPublicProposalPage(Number.NaN, 3), 1);
    assert.equal(resolvePublicProposalPageSize(undefined), 25);
    assert.equal(resolvePublicProposalPageSize(0), 25);

    const db = createMemoryDb();
    await seedProposals(db, 60);
    const candidates = await listPublicProposalCandidates(db, { user: null });
    const clamped = await buildPublicProposalPage(db, candidates, {
      page: "99",
      now: NOW,
    });
    assert.equal(clamped.page, 3);
    assert.equal(clamped.rows.length, 10);

    const invalid = await buildPublicProposalPage(db, candidates, {
      page: "not-a-page",
      now: NOW,
    });
    assert.equal(invalid.page, 1);
  });

  it("returns an explicit empty page", async () => {
    const db = createMemoryDb();
    const candidates = await listPublicProposalCandidates(db, {
      user: null,
      search: "nothing matches this",
    });
    const page = await buildPublicProposalPage(db, candidates, { now: NOW });
    assert.equal(page.total, 0);
    assert.equal(page.rows.length, 0);
    assert.equal(page.page, 1);
    assert.equal(page.pageCount, 1);
    assert.equal(page.startIndex, 0);
    assert.equal(page.endIndex, 0);
    assert.equal(page.availableCount, 0);
  });

  it("orders ties deterministically by proposal id", async () => {
    const db = createMemoryDb();
    const sameTime = new Date("2026-02-01T00:00:00.000Z");
    for (const id of ["PROP-C", "PROP-A", "PROP-B"]) {
      await db.collection("proposals").insertOne({
        ...proposalAt(1),
        proposalId: id,
        slug: id.toLowerCase(),
        updatedAt: sameTime,
        createdAt: sameTime,
      });
    }
    const candidates = await listPublicProposalCandidates(db, { user: null });
    const first = await buildPublicProposalPage(db, candidates, { now: NOW });
    const second = await buildPublicProposalPage(db, candidates, { now: NOW });
    assert.deepEqual(
      first.rows.map((row) => row.proposalId),
      ["PROP-A", "PROP-B", "PROP-C"],
    );
    assert.deepEqual(
      second.rows.map((row) => row.proposalId),
      first.rows.map((row) => row.proposalId),
    );
  });

  it("keeps filters on page links and drops the page when a filter changes", () => {
    assert.equal(
      proposalListHref(
        { q: "zebra", stage: "decide", branch: "branch-a", sort: "recent" },
        2,
      ),
      "/proposals/?q=zebra&stage=decide&branch=branch-a&sort=recent&page=2",
    );
    assert.equal(
      proposalListHref({
        q: "zebra",
        stage: "decide",
        branch: "branch-a",
        sort: "recent",
      }),
      "/proposals/?q=zebra&stage=decide&branch=branch-a&sort=recent",
    );
    // Defaults are omitted so the unfiltered first page has one address.
    assert.equal(proposalListHref({ stage: "all", sort: "priority" }, 1), "/proposals/");
    assert.equal(proposalListHref({}, 4), "/proposals/?page=4");
    // Legacy aliases normalise to the canonical stage name.
    assert.equal(proposalListHref({ stage: "voting" }, 1), "/proposals/?stage=decide");
    assert.equal(parsePublicProposalStage("all"), "");
    assert.equal(parsePublicProposalStage("nonsense"), "");
    assert.equal(parsePublicProposalStage("adopted"), "implement");
  });
});

describe("proposal list filtering", () => {
  it("filters stage, branch, space and search while counting before the stage filter", async () => {
    const db = createMemoryDb();
    await db.collection("proposals").insertOne(
      proposalAt(1, {
        stage: "decide",
        ballotRevisionId: "rev-1",
        ballotClosesAt: new Date(NOW.getTime() + 86_400_000),
        jurisdictionBranchId: "branch-a",
      }),
    );
    await db.collection("proposals").insertOne(
      proposalAt(2, { stage: "implement", jurisdictionBranchId: "branch-b" }),
    );
    await db.collection("proposals").insertOne(
      proposalAt(3, { stage: "deliberate", jurisdictionBranchId: "branch-b" }),
    );
    await db.collection("proposals").insertOne(
      proposalAt(7, { stage: "propose", jurisdictionBranchId: "branch-a" }),
    );

    const candidates = await listPublicProposalCandidates(db, { user: null });
    const page = await buildPublicProposalPage(db, candidates, {
      stage: "decide",
      now: NOW,
    });
    assert.deepEqual(page.stageCounts, {
      all: 4,
      propose: 1,
      deliberate: 1,
      decide: 1,
      implement: 1,
      archived: 0,
    });
    assert.deepEqual(
      page.rows.map((row) => row.proposalId),
      ["PROP-001"],
    );

    const branchPage = await buildPublicProposalPage(db, candidates, {
      branch: "branch-a",
      now: NOW,
    });
    assert.deepEqual(
      branchPage.rows.map((row) => row.proposalId).sort(),
      ["PROP-001", "PROP-007"],
    );

    const searched = await listPublicProposalCandidates(db, {
      user: null,
      search: "zebra",
    });
    assert.deepEqual(
      searched.map((row) => row.proposalId),
      ["PROP-007"],
    );
    const searchedPage = await buildPublicProposalPage(db, searched, { now: NOW });
    // Search matches rationale in MongoDB; the display read excludes it.
    assert.equal(searchedPage.rows.length, 1);
  });

  it("applies the joined and outstanding-ballot filters", async () => {
    const db = createMemoryDb();
    await seedProposals(db, 6);
    const candidates = await listPublicProposalCandidates(db, { user: null });

    const joined = await buildPublicProposalPage(db, candidates, {
      joinedOnly: true,
      joinedProposalIds: ["PROP-002", "PROP-004"],
      now: NOW,
    });
    assert.equal(joined.total, 2);

    const outstanding = await buildPublicProposalPage(db, candidates, {
      focus: "needs-vote",
      outstandingProposalIds: ["PROP-003"],
      now: NOW,
    });
    assert.deepEqual(
      outstanding.rows.map((row) => row.proposalId),
      ["PROP-003"],
    );
  });

  it("counts eligible open ballots only", async () => {
    const db = createMemoryDb();
    await db.collection("proposals").insertOne(
      proposalAt(1, {
        stage: "decide",
        ballotRevisionId: "rev-1",
        ballotClosesAt: new Date(NOW.getTime() + 86_400_000),
      }),
    );
    await db.collection("proposals").insertOne(
      proposalAt(2, {
        stage: "decide",
        ballotRevisionId: "rev-1",
        ballotClosesAt: new Date(NOW.getTime() - 86_400_000),
      }),
    );
    await db.collection("proposals").insertOne(
      proposalAt(3, { stage: "decide" }),
    );
    const candidates = await listPublicProposalCandidates(db, { user: null });
    const page = await buildPublicProposalPage(db, candidates, { now: NOW });
    assert.equal(page.stageCounts.decide, 1);
    const decide = await buildPublicProposalPage(db, candidates, {
      stage: "decide",
      now: NOW,
    });
    assert.deepEqual(
      decide.rows.map((row) => row.proposalId),
      ["PROP-001"],
    );
  });

  it("never widens visibility for anonymous or branch-scoped viewers", async () => {
    const db = createMemoryDb();
    await db.collection("proposals").insertOne(proposalAt(1));
    await db.collection("proposals").insertOne(
      proposalAt(2, { publicationScope: "branch", jurisdictionBranchId: "branch-a" }),
    );
    await db.collection("proposals").insertOne(
      proposalAt(3, { publicationScope: "private", originatingBranchId: "branch-b" }),
    );
    await db.collection("proposals").insertOne(
      proposalAt(4, { publicationScope: "private", originatingBranchId: "branch-a" }),
    );

    const anonymous = await listPublicProposalCandidates(db, { user: null });
    assert.deepEqual(
      anonymous.map((row) => row.proposalId),
      ["PROP-001"],
    );

    const member = await listPublicProposalCandidates(db, {
      user: memberUser(),
    });
    assert.deepEqual(
      member.map((row) => row.proposalId).sort(),
      ["PROP-001", "PROP-002"],
    );
  });
});

describe("public list tallies", () => {
  it("shows fresh projection counts and a neutral state for stale or missing rows", async () => {
    const db = createMemoryDb();
    await seedDecide(db, "PROP-001");
    await seedDecide(db, "PROP-002");
    await seedDecide(db, "PROP-003");
    await db.collection(BALLOT_TALLIES).insertOne({
      ballotId: proposalBallotId("PROP-001"),
      revisionId: "rev-1",
      approve: 4,
      abstain: 1,
      reject: 2,
      total: 7,
      updatedAt: new Date(NOW.getTime() - 60_000),
    });
    await db.collection(BALLOT_TALLIES).insertOne({
      ballotId: proposalBallotId("PROP-002"),
      revisionId: "rev-1",
      approve: 80,
      abstain: 0,
      reject: 1,
      total: 81,
      updatedAt: new Date(NOW.getTime() - BALLOT_TALLY_STALENESS_MS - 1),
    });

    const candidates = await listPublicProposalCandidates(db, { user: null });
    const page = await buildPublicProposalPage(db, candidates, { now: NOW });
    const byId = new Map(page.rows.map((row) => [row.proposalId, row]));

    assert.deepEqual(byId.get("PROP-001")!.votes, {
      approve: 4,
      abstain: 1,
      reject: 2,
      total: 7,
    });
    assert.equal(byId.get("PROP-001")!.tallyState, "live");
    assert.equal(publicTallyLabel(byId.get("PROP-001")!), null);

    assert.equal(byId.get("PROP-002")!.tallyState, "pending");
    assert.equal(byId.get("PROP-002")!.votes.total, 0);
    assert.equal(
      publicTallyLabel(byId.get("PROP-002")!),
      "Voting open — tally updating",
    );

    assert.equal(byId.get("PROP-003")!.tallyState, "pending");
    assert.equal(
      publicTallyLabel(byId.get("PROP-003")!),
      "Voting open — tally updating",
    );
  });

  it("prefers the certified result over any projection", async () => {
    const db = createMemoryDb();
    await seedDecide(db, "PROP-001");
    await db.collection(BALLOT_TALLIES).insertOne({
      ballotId: proposalBallotId("PROP-001"),
      revisionId: "rev-1",
      approve: 99,
      abstain: 0,
      reject: 0,
      total: 99,
      updatedAt: new Date(NOW.getTime() - BALLOT_TALLY_STALENESS_MS - 1),
    });
    await db.collection("ballot_results").insertOne({
      ballotId: proposalBallotId("PROP-001"),
      proposalId: "PROP-001",
      revisionId: "rev-1",
      result: "successful",
      tally: { approve: 5, abstain: 1, reject: 2, total: 8 },
      ruleBasis: "simple-majority-d9-v1",
    });

    const candidates = await listPublicProposalCandidates(db, { user: null });
    const page = await buildPublicProposalPage(db, candidates, { now: NOW });
    const row = page.rows[0]!;
    assert.equal(row.tallyState, "certified");
    assert.deepEqual(row.votes, { approve: 5, abstain: 1, reject: 2, total: 8 });
    assert.equal(row.ballotOpen, false);
  });

  it("never invents a count for a legacy certified result without a tally", async () => {
    const db = createMemoryDb();
    await seedDecide(db, "PROP-001");
    await db.collection("ballot_results").insertOne({
      ballotId: proposalBallotId("PROP-001"),
      proposalId: "PROP-001",
      revisionId: "rev-1",
      result: "successful",
    });
    const candidates = await listPublicProposalCandidates(db, { user: null });
    const page = await buildPublicProposalPage(db, candidates, { now: NOW });
    assert.equal(page.rows[0]!.tallyState, "pending");
    assert.equal(page.rows[0]!.votes.total, 0);
  });

  it("overlays tallies on the home register without reading votes", async () => {
    const db = createMemoryDb();
    await seedDecide(db, "PROP-001");
    await seedDecide(db, "PROP-002");
    await db.collection(BALLOT_TALLIES).insertOne({
      ballotId: proposalBallotId("PROP-001"),
      revisionId: "rev-1",
      approve: 3,
      abstain: 0,
      reject: 1,
      total: 4,
      updatedAt: new Date(NOW.getTime() - 60_000),
    });
    const candidates = await listPublicProposalCandidates(db, { user: null });
    const summaries = candidates.map((row) => ({
      ...row,
      commentCount: 0,
      votes: { approve: 0, abstain: 0, reject: 0, total: 0 },
    }));
    const withTallies = await attachPublicTallies(db, summaries, { now: NOW });
    const byId = new Map(withTallies.map((row) => [row.proposalId, row]));
    assert.equal(byId.get("PROP-001")!.votes.total, 4);
    assert.equal(byId.get("PROP-001")!.tallyState, "live");
    assert.equal(byId.get("PROP-002")!.tallyState, "pending");
  });
});

describe("public list read cost and privacy", () => {
  it("never reads proposal_votes and excludes the rationale from display rows", async () => {
    const db = createMemoryDb();
    await seedProposals(db, 30);
    const spy = spyDb(db);
    const candidates = await listPublicProposalCandidates(spy.db, {
      user: null,
    });
    const page = await buildPublicProposalPage(spy.db, candidates, { now: NOW });

    assert.equal(page.rows.length, 25);
    assert.equal(
      spy.accesses.some((access) => access.name === PROPOSAL_VOTES),
      false,
      "the public list must not read proposal_votes",
    );
    assert.equal(
      spy.accesses.some(
        (access) =>
          access.name === "proposals" &&
          access.projection?.detailHtml === 0 &&
          access.projection?.details === 0,
      ),
      true,
      "the display page asks MongoDB to exclude rationale fields",
    );
    const candidateAccess = spy.accesses.find(
      (access) => access.name === "proposals",
    );
    assert.equal(candidateAccess?.projection?.details, undefined);
    assert.equal(candidateAccess?.projection?.detailHtml, undefined);
  });

  it("renders no voter identity, choice or envelope", async () => {
    const db = createMemoryDb();
    await db.collection("proposals").insertOne(
      proposalAt(1, {
        stage: "decide",
        ballotRevisionId: "rev-1",
        ballotClosesAt: new Date(NOW.getTime() + 86_400_000),
      }),
    );
    await db.collection(BALLOT_TALLIES).insertOne({
      ballotId: proposalBallotId("PROP-001"),
      revisionId: "rev-1",
      approve: 2,
      abstain: 0,
      reject: 1,
      total: 3,
      updatedAt: new Date(NOW.getTime() - 60_000),
    });
    await db.collection(PROPOSAL_VOTES).insertOne({
      ballotId: proposalBallotId("PROP-001"),
      proposalId: "PROP-001",
      revisionId: "rev-1",
      memberId: "member-secret",
      authorName: "Secret Member",
      choice: "approve",
      updatedAt: new Date(),
    });
    const candidates = await listPublicProposalCandidates(db, { user: null });
    const page = await buildPublicProposalPage(db, candidates, { now: NOW });
    const serialised = JSON.stringify(page.rows);
    assert.equal(serialised.includes("member-secret"), false);
    assert.equal(serialised.includes("Secret Member"), false);
    assert.equal(serialised.includes("voteEnvelope"), false);
    const projection = (await db
      .collection(BALLOT_TALLIES)
      .findOne({})) as Record<string, unknown>;
    for (const forbidden of ["memberId", "choice", "authorName", "voterBlindIndex"]) {
      assert.equal(forbidden in projection, false);
    }
  });

  it("marks a row as voted only for the viewer's own matching ballot", async () => {
    const db = createMemoryDb();
    await seedDecide(db, "PROP-001");
    const candidates = await listPublicProposalCandidates(db, { user: null });
    const page = await buildPublicProposalPage(db, candidates, {
      now: NOW,
      memberVotes: [
        {
          ballotId: proposalBallotId("PROP-001"),
          proposalId: "PROP-001",
          revisionId: "rev-1",
          choice: "approve",
          reason: "",
          updatedAt: new Date(),
          encrypted: false,
        },
        {
          ballotId: proposalBallotId("PROP-001"),
          proposalId: "PROP-001",
          revisionId: "rev-old",
          choice: "reject",
          reason: "",
          updatedAt: new Date(),
          encrypted: false,
        },
      ],
    });
    assert.equal(page.rows[0]!.hasVoted, true);
  });
});
