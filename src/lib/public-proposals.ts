import type { Db } from "mongodb";
import { ballotExpired } from "./ballot-deadline.ts";
import {
  ballotTallyKey,
  emptyVoteTally,
  readBallotTallyProjections,
  type ProjectedBallotTally,
} from "./ballot-tallies.ts";
import { rankProposals, type ProposalRanking } from "./proposal-metrics.ts";
import {
  canViewProposal,
  normalizeProposalDoc,
  normalizeStage,
} from "./proposal-helpers.ts";
import type {
  ProposalRecord,
  ProposalStage,
  ProposalSummaryView,
  SessionUser,
  VoteTally,
} from "./types.ts";
import { proposalBallotId, type DecodedVoteRecord } from "./vote-storage.ts";

/**
 * Public proposal list read model.
 *
 * `/proposals/` previously loaded every proposal (including rationale), applied
 * search, stage, branch and sort in the page, and decrypted every vote so each
 * row could show a live total. This module:
 *
 * - reads a bounded display page of 25 rows from MongoDB;
 * - never reads `proposal_votes` and never decrypts a ballot;
 * - reports the certified tally from `ballot_results` where one exists;
 * - otherwise reads the display-only `ballot_tallies` projection, and shows a
 *   neutral "tally updating" state when that row is missing or stale.
 *
 * It does not decide eligibility, ballot binding, deadlines or outcomes. It
 * only controls how much of the list is fetched and where its aggregate vote
 * numbers come from.
 */

export const PUBLIC_PROPOSAL_PAGE_SIZE = 25;
export const PUBLIC_PROPOSAL_MAX_PAGE_SIZE = 100;

const LIST_STAGES: readonly ProposalStage[] = [
  "propose",
  "deliberate",
  "decide",
  "implement",
  "archived",
];

const STAGE_ALIASES = ["draft", "open", "voting", "adopted"];

/**
 * What the list may show for a row's vote total:
 * - `certified`: the immutable tally stored on `ballot_results`;
 * - `live`: a fresh display projection;
 * - `pending`: no trustworthy aggregate, so the row states that instead;
 * - `none`: the matter has no ballot.
 */
export type PublicTallyState = "certified" | "live" | "pending" | "none";

export interface PublicProposalRow extends ProposalSummaryView {
  tallyState: PublicTallyState;
  /** True while the matter's ballot can still accept votes. */
  ballotOpen: boolean;
  /** Only set by the paginated list, which reads the viewer's own votes. */
  hasVoted?: boolean;
}

export interface PublicProposalStageCounts {
  all: number;
  propose: number;
  deliberate: number;
  decide: number;
  implement: number;
  archived: number;
}

export interface PublicProposalPage {
  rows: PublicProposalRow[];
  /** Rows matching every filter, after the active sort. */
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  startIndex: number;
  endIndex: number;
  /** Counts across the viewer's visible register, before stage/joined filters. */
  stageCounts: PublicProposalStageCounts;
  /** Topics across visible, non-archived matters. */
  spaces: string[];
  /** Visible, non-archived matters, used for the header total. */
  availableCount: number;
}

export interface PublicProposalQuery {
  q?: string;
  stage?: string;
  branch?: string;
  space?: string;
  sort?: string;
  focus?: string;
  joined?: boolean;
}

/** Canonical stage filter, or `''` for all stages. Unknown values mean all. */
export function parsePublicProposalStage(
  raw: string | null | undefined,
): "" | ProposalStage {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value || value === "all") return "";
  if (
    !LIST_STAGES.includes(value as ProposalStage) &&
    !STAGE_ALIASES.includes(value)
  ) {
    return "";
  }
  return normalizeStage(value);
}

/** Requested page. Non-numeric and non-positive input means page 1. */
export function parsePublicProposalPage(
  raw: string | number | null | undefined,
): number {
  const parsed =
    typeof raw === "number"
      ? Math.trunc(raw)
      : Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export function clampPublicProposalPage(
  page: number,
  pageCount: number,
): number {
  const safeCount = Math.max(1, pageCount);
  if (!Number.isFinite(page)) return 1;
  return Math.min(Math.max(Math.trunc(page), 1), safeCount);
}

export function resolvePublicProposalPageSize(raw: number | undefined): number {
  if (!raw || !Number.isFinite(raw)) return PUBLIC_PROPOSAL_PAGE_SIZE;
  return Math.min(
    Math.max(Math.trunc(raw), 1),
    PUBLIC_PROPOSAL_MAX_PAGE_SIZE,
  );
}

/**
 * The self-referencing address of a page: active filters are preserved and page
 * 1 is the unfiltered default address. Changing any filter drops `page`, so a
 * new filter always starts at page 1.
 */
export function proposalListHref(
  query: PublicProposalQuery = {},
  page = 1,
): string {
  const params = new URLSearchParams();
  if (query.q?.trim()) params.set("q", query.q.trim());
  const stage = parsePublicProposalStage(query.stage);
  if (stage) params.set("stage", stage);
  if (query.branch && query.branch !== "all") params.set("branch", query.branch);
  if (query.space && query.space !== "all") params.set("space", query.space);
  if (query.sort && query.sort !== "priority") params.set("sort", query.sort);
  if (query.focus && query.focus !== "all") params.set("focus", query.focus);
  if (query.joined) params.set("joined", "1");
  if (Number.isFinite(page) && page > 1) params.set("page", String(page));
  const search = params.toString();
  return `/proposals/${search ? `?${search}` : ""}`;
}

export type PublicTallyDisplay = {
  tally: VoteTally;
  state: PublicTallyState;
  open: boolean;
};

/**
 * The text a row shows instead of a number. It names the state, never a guessed
 * count, and the caller links it to the matter.
 */
export function publicTallyLabel(row: {
  tallyState: PublicTallyState;
  ballotOpen: boolean;
  stage?: ProposalStage;
}): string | null {
  if (row.tallyState !== "pending") return null;
  if (row.ballotOpen) return "Voting open — tally updating";
  if (row.stage === "decide") return "Voting closed — tally pending";
  return "Tally pending";
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Coarse MongoDB visibility pre-filter that can only be wider than
 * `canViewProposal`. Every candidate is re-checked with the shared predicate, so
 * this cannot widen what a viewer sees.
 */
export function proposalVisibilityFilter(
  user: SessionUser | null,
): Record<string, unknown> {
  if (user?.isStaff || user?.isAdmin) return {};
  const clauses: Record<string, unknown>[] = [
    {
      $or: [
        { publicationScope: { $exists: false } },
        { publicationScope: null },
        { publicationScope: "national" },
      ],
    },
  ];
  if (user) {
    const branchIds = [
      ...new Set([
        ...(user.activeBranchIds ?? []),
        ...(user.branchAdminIds ?? []),
      ]),
    ];
    const authored = { authorId: user.memberId };
    clauses.push({
      publicationScope: "branch",
      $or: [
        authored,
        ...(branchIds.length
          ? [
              { jurisdictionBranchId: { $in: branchIds } },
              { originatingBranchId: { $in: branchIds } },
            ]
          : []),
      ],
    });
    clauses.push({
      publicationScope: "private",
      $or: [
        authored,
        ...((user.branchAdminIds ?? []).length
          ? [{ originatingBranchId: { $in: user.branchAdminIds } }]
          : []),
      ],
    });
  }
  return { $or: clauses };
}

function proposalSearchFilter(search: string | undefined): Record<string, unknown> {
  const query = (search ?? "").trim();
  if (!query) return {};
  const pattern = new RegExp(escapeRegex(query), "i");
  return {
    $or: [
      { proposalId: pattern },
      { policyId: pattern },
      { title: pattern },
      { space: pattern },
      { category: pattern },
      { summary: pattern },
      { details: pattern },
    ],
  };
}

function combineFilters(
  ...filters: Array<Record<string, unknown>>
): Record<string, unknown> {
  const clauses = filters.filter((filter) => Object.keys(filter).length > 0);
  if (clauses.length === 0) return {};
  return clauses.length === 1 ? clauses[0]! : { $and: clauses };
}

// Read the list fields once. Search can match long-form wording without returning it.
const LIST_CANDIDATE_PROJECTION = {
  _id: 0,
  proposalId: 1,
  policyId: 1,
  slug: 1,
  title: 1,
  summary: 1,
  statement: 1,
  space: 1,
  category: 1,
  stage: 1,
  status: 1,
  kind: 1,
  publicationScope: 1,
  authorId: 1,
  createdAt: 1,
  updatedAt: 1,
  ballotRevisionId: 1,
  ballotClosesAt: 1,
  ballotClosedAt: 1,
  originatingBranchId: 1,
  governanceAuthorityBranchId: 1,
  jurisdictionBranchId: 1,
} as const;

/**
 * Read the visible matters that can match the list's search. This is the only
 * unfiltered-by-stage proposal read. Its projection supports counts, ordering
 * and rendering without returning rationale or votes.
 */
export async function listPublicProposalCandidates(
  db: Db,
  options: { user?: SessionUser | null; search?: string } = {},
): Promise<ProposalRecord[]> {
  const user = options.user ?? null;
  const where = combineFilters(
    proposalVisibilityFilter(user),
    proposalSearchFilter(options.search),
  );
  const rows = await db
    .collection<ProposalRecord>("proposals")
    .find(where, { projection: LIST_CANDIDATE_PROJECTION })
    .toArray();
  return rows
    .map(normalizeProposalDoc)
    .filter((proposal) => canViewProposal(proposal, user));
}

async function loadCommentCounts(
  db: Db,
  proposalIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (proposalIds.length === 0) return counts;
  const rows = await db
    .collection("comments")
    .find(
      {
        $or: [
          { proposalId: { $in: proposalIds } },
          { policyId: { $in: proposalIds } },
        ],
      },
      { projection: { _id: 0, proposalId: 1, policyId: 1 } },
    )
    .toArray();
  for (const raw of rows as Array<Record<string, any>>) {
    const id = String(raw.proposalId ?? raw.policyId ?? "");
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

function asTally(raw: unknown): VoteTally | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const approve = Number(value.approve ?? 0);
  const abstain = Number(value.abstain ?? 0);
  const reject = Number(value.reject ?? 0);
  const total = Number(value.total ?? approve + abstain + reject);
  if (![approve, abstain, reject, total].every(Number.isFinite)) return null;
  return { approve, abstain, reject, total };
}

interface PublicTallyContext {
  certified: Map<string, VoteTally | null>;
  projections: Map<string, ProjectedBallotTally>;
  now: Date;
}

async function loadPublicTallyContext(
  db: Db,
  rows: ProposalRecord[],
  now: Date,
): Promise<PublicTallyContext> {
  const withBallot = rows.filter(
    (row): row is ProposalRecord & { ballotRevisionId: string } =>
      Boolean(row.ballotRevisionId),
  );
  const proposalIds = rows.map((row) => row.proposalId);
  const ballotIds = rows.map((row) => proposalBallotId(row.proposalId));
  const [projections, resultRows] = await Promise.all([
    readBallotTallyProjections(
      db,
      withBallot.map((row) => ({
        ballotId: proposalBallotId(row.proposalId),
        revisionId: row.ballotRevisionId,
      })),
      { now },
    ),
    ballotIds.length
      ? db
          .collection("ballot_results")
          .find(
            {
              $or: [
                { ballotId: { $in: ballotIds } },
                { proposalId: { $in: proposalIds }, ballotId: { $exists: false } },
              ],
            },
            { projection: { _id: 0, ballotId: 1, proposalId: 1, tally: 1 } },
          )
          .toArray()
      : Promise.resolve([] as Array<Record<string, any>>),
  ]);
  const certified = new Map<string, VoteTally | null>();
  for (const raw of resultRows as Array<Record<string, any>>) {
    const ballotId = String(
      raw.ballotId ?? proposalBallotId(String(raw.proposalId ?? "")),
    );
    // A legacy result without a stored tally is still authoritative: it proves
    // the ballot was certified, so no projection is shown for it.
    certified.set(ballotId, asTally(raw.tally));
  }
  return { certified, projections, now };
}

function resolvePublicTally(
  row: Pick<
    ProposalRecord,
    "proposalId" | "stage" | "ballotRevisionId" | "ballotClosesAt"
  >,
  context: PublicTallyContext,
): PublicTallyDisplay {
  const open =
    row.stage === "decide" &&
    Boolean(row.ballotRevisionId) &&
    !ballotExpired(row, context.now);
  const ballotId = proposalBallotId(row.proposalId);
  if (context.certified.has(ballotId)) {
    const tally = context.certified.get(ballotId);
    return tally
      ? { tally, state: "certified", open: false }
      : { tally: emptyVoteTally(), state: "pending", open: false };
  }
  if (!row.ballotRevisionId) {
    return { tally: emptyVoteTally(), state: "none", open: false };
  }
  const projected = context.projections.get(
    ballotTallyKey(ballotId, row.ballotRevisionId),
  );
  if (projected?.fresh) {
    return { tally: projected.tally, state: "live", open };
  }
  return { tally: emptyVoteTally(), state: "pending", open };
}

/**
 * Overlay display-only tallies on an existing summary list. Used by `/`, which
 * still reads the whole visible register for its stage composition but must not
 * scan or decrypt votes.
 */
export async function attachPublicTallies(
  db: Db,
  proposals: ProposalSummaryView[],
  options: { now?: Date } = {},
): Promise<PublicProposalRow[]> {
  const now = options.now ?? new Date();
  const context = await loadPublicTallyContext(db, proposals, now);
  return proposals.map((proposal) => {
    const display = resolvePublicTally(proposal, context);
    return {
      ...proposal,
      votes: display.tally,
      tallyState: display.state,
      ballotOpen: display.open,
    };
  });
}

export interface BuildPublicProposalPageOptions {
  page?: string | number;
  pageSize?: number;
  stage?: string;
  branch?: string;
  space?: string;
  sort?: string;
  focus?: string;
  joinedOnly?: boolean;
  joinedProposalIds?: Iterable<string>;
  outstandingProposalIds?: Iterable<string>;
  memberVotes?: DecodedVoteRecord[];
  now?: Date;
}

const RANKINGS: ProposalRanking[] = ["divisive", "approved", "active"];

/**
 * Apply the list's filters, ordering and pagination, then load one display page.
 * No proposal_votes read and no decryption happens here.
 */
export async function buildPublicProposalPage(
  db: Db,
  candidates: ProposalRecord[],
  options: BuildPublicProposalPageOptions = {},
): Promise<PublicProposalPage> {
  const now = options.now ?? new Date();
  const pageSize = resolvePublicProposalPageSize(options.pageSize);
  const stage = parsePublicProposalStage(options.stage);
  const branch = (options.branch ?? "").trim();
  const space = (options.space ?? "").trim();

  const available = candidates.filter((row) => row.stage !== "archived");
  const raw = candidates.filter((row) => {
    if (space && space !== "all" && row.space !== space) return false;
    if (
      branch &&
      branch !== "all" &&
      ![
        row.originatingBranchId,
        row.governanceAuthorityBranchId,
        row.jurisdictionBranchId,
      ].includes(branch)
    ) {
      return false;
    }
    return true;
  });

  const stageCounts: PublicProposalStageCounts = {
    all: raw.length,
    propose: raw.filter((row) => row.stage === "propose").length,
    deliberate: raw.filter((row) => row.stage === "deliberate").length,
    decide: raw.filter(
      (row) =>
        row.stage === "decide" &&
        Boolean(row.ballotRevisionId) &&
        !ballotExpired(row, now),
    ).length,
    implement: raw.filter((row) => row.stage === "implement").length,
    archived: raw.filter((row) => row.stage === "archived").length,
  };
  const spaces = [...new Set(available.map((row) => row.space))].sort();

  const joinedIds = new Set(
    [...(options.joinedProposalIds ?? [])].map((id) => String(id)),
  );
  const outstandingIds = new Set(
    [...(options.outstandingProposalIds ?? [])].map((id) => String(id)),
  );
  const countDataset = raw.filter((row) => {
    if (options.joinedOnly && !joinedIds.has(row.proposalId)) return false;
    if (options.focus === "needs-vote" && !outstandingIds.has(row.proposalId)) {
      return false;
    }
    return true;
  });
  const filtered = countDataset.filter((row) => {
    if (!stage) return true;
    if (row.stage !== stage) return false;
    if (stage === "decide") {
      return Boolean(row.ballotRevisionId) && !ballotExpired(row, now);
    }
    return true;
  });

  const [commentCounts, tallyContext] = await Promise.all([
    loadCommentCounts(
      db,
      filtered.map((row) => row.proposalId),
    ),
    loadPublicTallyContext(db, filtered, now),
  ]);

  const decorated = filtered.map((row) => {
    const display = resolvePublicTally(row, tallyContext);
    return {
      ...row,
      commentCount: commentCounts.get(row.proposalId) ?? 0,
      votes: display.tally,
      tallyState: display.state,
      ballotOpen: display.open,
    } satisfies PublicProposalRow;
  });
  type DecoratedRow = (typeof decorated)[number];

  const requestedSort = (options.sort ?? "priority").trim();
  const effectiveSort =
    options.focus === "recent" && requestedSort === "priority"
      ? "recent"
      : requestedSort;
  const ordered: DecoratedRow[] = RANKINGS.includes(
    effectiveSort as ProposalRanking,
  )
    ? (rankProposals(
        decorated as ProposalSummaryView[],
        effectiveSort as ProposalRanking,
      ) as DecoratedRow[])
    : [...decorated].sort((a, b) => {
        if (effectiveSort === "recent") {
          return (
            time(b.updatedAt) - time(a.updatedAt) ||
            a.proposalId.localeCompare(b.proposalId)
          );
        }
        if (effectiveSort === "ballots") {
          return (
            b.votes.total - a.votes.total ||
            b.commentCount - a.commentCount ||
            a.proposalId.localeCompare(b.proposalId)
          );
        }
        if (effectiveSort === "contributions") {
          return (
            b.commentCount - a.commentCount ||
            b.votes.total - a.votes.total ||
            a.proposalId.localeCompare(b.proposalId)
          );
        }
        const priority: Record<ProposalStage, number> = {
          decide: 0,
          deliberate: 1,
          propose: 2,
          implement: 3,
          archived: 4,
        };
        return (
          priority[a.stage] - priority[b.stage] ||
          time(b.updatedAt) - time(a.updatedAt) ||
          a.proposalId.localeCompare(b.proposalId)
        );
      });

  const total = ordered.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = clampPublicProposalPage(
    parsePublicProposalPage(options.page ?? 1),
    pageCount,
  );
  const start = (page - 1) * pageSize;
  const pageItems = ordered.slice(start, start + pageSize);

  const memberVotes = options.memberVotes ?? [];
  const rows: PublicProposalRow[] = [];
  for (const item of pageItems) {
    const hasVoted = memberVotes.some(
      (vote) =>
        String(vote.proposalId) === item.proposalId &&
        vote.ballotId === proposalBallotId(item.proposalId) &&
        Boolean(item.ballotRevisionId) &&
        vote.revisionId === item.ballotRevisionId,
    );
    rows.push({
      ...item,
      hasVoted,
    });
  }

  return {
    rows,
    total,
    page,
    pageSize,
    pageCount,
    startIndex: total === 0 ? 0 : start + 1,
    endIndex: total === 0 ? 0 : start + rows.length,
    stageCounts,
    spaces,
    availableCount: available.length,
  };
}

function time(value: Date | string | undefined): number {
  if (!value) return 0;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.getTime() : 0;
}
