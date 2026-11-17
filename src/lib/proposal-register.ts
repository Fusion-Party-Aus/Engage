import type { Db } from "mongodb";
import {
  ballotOutcomeLabel,
  resolveBallotClosure,
  type FormalDecisionRecord,
} from "./ballots.ts";
import { normalizeProposalDoc, normalizeStage } from "./proposal-helpers.ts";
import { PROPOSAL_VOTES, proposalBallotId } from "./vote-storage.ts";
import type {
  PolicyProvenance,
  ProposalKind,
  ProposalRecord,
  ProposalStage,
  VoteTally,
} from "./types.ts";

/**
 * Admin register read model.
 *
 * The register is a list read, so it must not pay for data only the detail
 * workspace needs. This module:
 *
 * - paginates in MongoDB instead of sending every proposal;
 * - projects the register projection, which excludes `details` and `detailHtml`;
 * - never reads `proposal_votes` and never decrypts a ballot;
 * - reports the tally stored on `ballot_results` at certification, and shows a
 *   link instead of live counts when a ballot has no certified result.
 *
 * The live, bound tally stays on the detail workspace, which is the surface
 * that records and certifies outcomes.
 */

export const PROPOSAL_REGISTER_PAGE_SIZE = 25;
export const PROPOSAL_REGISTER_MAX_PAGE_SIZE = 100;

const REGISTER_STAGES: readonly ProposalStage[] = [
  "propose",
  "deliberate",
  "decide",
  "implement",
  "archived",
];

/**
 * Stored stage aliases `normalizeStage` still accepts. Filtering on the
 * normalised value keeps legacy rows in the tab and count they are reported in.
 */
const STAGE_STORAGE_VALUES: Record<ProposalStage, string[]> = {
  propose: ["propose", "draft"],
  deliberate: ["deliberate", "open"],
  decide: ["decide", "voting"],
  implement: ["implement", "adopted"],
  archived: ["archived"],
};

export type RegisterStageCounts = Record<"all" | ProposalStage, number>;

/** Fields the register row renders. Deliberately excludes rationale and votes. */
export interface ProposalRegisterRow {
  proposalId: string;
  slug: string;
  title: string;
  space: string;
  stage: ProposalStage;
  kind: ProposalKind;
  ballotRevisionId?: string;
  ballotClosesAt?: Date;
  ballotClosedAt?: Date;
  originatingBranchId?: string;
  governanceAuthorityBranchId?: string;
  jurisdictionBranchId?: string;
  provenance?: PolicyProvenance;
  commentCount: number;
}

/** The certified result stored on `ballot_results` when the ballot was decided. */
export interface CertifiedBallotResult {
  ballotId: string;
  result: FormalDecisionRecord["result"];
  computedResult?: FormalDecisionRecord["computedResult"];
  /** Versioned rule the computed outcome was derived from. */
  ruleBasis?: string;
  /** Votes bound to the ballot and revision at the moment of certification. */
  tally?: VoteTally;
  overridden: boolean;
  overrideReason?: string;
  recordedAt?: Date;
}

/**
 * What the register shows for a row's main ballot:
 * - `certified`: the immutable tally recorded at certification;
 * - `open`: a ballot that can still take votes, so no count is claimed;
 * - `closed`: closed but not certified, so no count is claimed;
 * - `none`: no ballot is recorded for this proposal.
 */
export type RegisterBallotState = "certified" | "open" | "closed" | "none";

export interface RegisterBallotDisplay {
  state: RegisterBallotState;
  /**
   * Short, factual text. Open ballots read "Open — view ballot"; no live vote
   * count is ever invented for them.
   */
  label: string;
  /** Where the officer can see the live tally or record an outcome. */
  href?: string;
  /** Present only for a certified ballot. */
  tally?: VoteTally;
  outcomeLabel?: string;
  computedLabel?: string;
  overridden?: boolean;
  overrideReason?: string;
  ruleBasisLabel?: string;
}

export interface ProposalRegisterEntry {
  row: ProposalRegisterRow;
  ballot: RegisterBallotDisplay;
}

export interface ProposalRegisterOptions {
  /** 1-based page. Invalid or out-of-range values clamp; see `page`. */
  page?: number;
  pageSize?: number;
  search?: string;
  /** Canonical stage or `all`. Use `parseRegisterStage` to normalise input. */
  stage?: string;
  /** Branch id or `all`. */
  branch?: string;
  /**
   * Branch ids whose proposals this viewer may administer. Omit for an
   * unrestricted (staff) register; an empty array matches no proposal.
   */
  branchScopeIds?: string[];
  /**
   * Branch ids where the viewer holds a ballot or amendment act. A matter is in
   * scope when any of its originating, governance-authority or jurisdiction
   * branch references is in the set. Delegated officers use this because their
   * authority can follow the governance branch rather than the origin.
   */
  anyBranchScopeIds?: string[];
}

export interface ProposalRegisterPage {
  entries: ProposalRegisterEntry[];
  /** Matching rows after search and filters. */
  total: number;
  /** Clamped, 1-based page actually read. */
  page: number;
  pageSize: number;
  /** At least 1, even when the register is empty. */
  pageCount: number;
  /** 1-based index of the first row on this page, or 0 when empty. */
  startIndex: number;
  /** 1-based index of the last row on this page, or 0 when empty. */
  endIndex: number;
  /** Counts across the viewer's whole register, before search and filters. */
  stageCounts: RegisterStageCounts;
  /** Decide proposals in scope without a bound wording revision. */
  unboundBallotCount: number;
  /** Every proposal id in scope, used for register-wide amendment counts. */
  scopedProposalIds: string[];
  /** Topic spaces in scope, used for the editor's suggestions. */
  spaces: string[];
}

export const EMPTY_PROPOSAL_REGISTER: ProposalRegisterPage = {
  entries: [],
  total: 0,
  page: 1,
  pageSize: PROPOSAL_REGISTER_PAGE_SIZE,
  pageCount: 1,
  startIndex: 0,
  endIndex: 0,
  stageCounts: {
    all: 0,
    propose: 0,
    deliberate: 0,
    decide: 0,
    implement: 0,
    archived: 0,
  },
  unboundBallotCount: 0,
  scopedProposalIds: [],
  spaces: [],
};

/** Canonical stage filter, or `''` for all stages. Unknown values mean all. */
export function parseRegisterStage(raw: string | null | undefined): "" | ProposalStage {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value || value === "all") return "";
  return REGISTER_STAGES.includes(value as ProposalStage)
    ? (value as ProposalStage)
    : "";
}

/** Requested page. Non-numeric and non-positive input means page 1. */
export function parseRegisterPage(raw: string | null | undefined): number {
  const parsed = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export function clampRegisterPage(page: number, pageCount: number): number {
  const safeCount = Math.max(1, pageCount);
  if (!Number.isFinite(page)) return 1;
  return Math.min(Math.max(Math.trunc(page), 1), safeCount);
}

export function resolveRegisterPageSize(raw: number | undefined): number {
  if (!raw || !Number.isFinite(raw)) return PROPOSAL_REGISTER_PAGE_SIZE;
  return Math.min(
    Math.max(Math.trunc(raw), 1),
    PROPOSAL_REGISTER_MAX_PAGE_SIZE,
  );
}

/**
 * Pagination link that carries the active filters and omits page 1. Filters are
 * part of the URL, so a filtered page 3 stays filtered when the officer moves
 * through pages; changing a filter submits without `page` and starts at page 1.
 */
export function registerPageHref(
  params: { q?: string; stage?: string; branch?: string },
  page: number,
): string {
  const search = new URLSearchParams();
  if (params.q?.trim()) search.set("q", params.q.trim());
  const stage = parseRegisterStage(params.stage);
  if (stage) search.set("stage", stage);
  if (params.branch && params.branch !== "all") search.set("branch", params.branch);
  if (Number.isFinite(page) && page > 1) search.set("page", String(page));
  const query = search.toString();
  return `/admin/proposals/${query ? `?${query}` : ""}`;
}

export function registerRuleBasisLabel(ruleBasis?: string): string | undefined {
  if (!ruleBasis) return undefined;
  if (ruleBasis === "simple-majority-d9-v1") return "Simple majority (D9)";
  if (ruleBasis === "two-tier-quorum-simple-majority-v1")
    return "Two-tier quorum and simple majority";
  return ruleBasis;
}

/**
 * The register's honest presentation of a ballot. A certified ballot shows the
 * tally stored at certification; anything else shows a link and no count.
 */
export function describeRegisterBallot(input: {
  stage: ProposalStage;
  slug: string;
  certified: CertifiedBallotResult | null;
  closed: boolean;
}): RegisterBallotDisplay {
  const workspace = `/admin/proposals/${input.slug}/#record-outcome`;
  if (input.certified) {
    return {
      state: "certified",
      label: `Certified ${ballotOutcomeLabel(input.certified.result)}`,
      href: workspace,
      ...(input.certified.tally ? { tally: input.certified.tally } : {}),
      outcomeLabel: ballotOutcomeLabel(input.certified.result),
      ...(input.certified.computedResult
        ? { computedLabel: ballotOutcomeLabel(input.certified.computedResult) }
        : {}),
      ...(input.certified.overridden ? { overridden: true } : {}),
      ...(input.certified.overrideReason
        ? { overrideReason: input.certified.overrideReason }
        : {}),
      ...(registerRuleBasisLabel(input.certified.ruleBasis)
        ? { ruleBasisLabel: registerRuleBasisLabel(input.certified.ruleBasis) }
        : {}),
    };
  }
  if (input.stage === "decide") {
    return input.closed
      ? { state: "closed", label: "Closed — record outcome", href: workspace }
      : { state: "open", label: "Open — view ballot", href: workspace };
  }
  return {
    state: "none",
    label: input.stage === "propose" || input.stage === "deliberate"
      ? "No ballot yet"
      : "No certified ballot",
  };
}

// Legacy records key the same facts under `policyId`, `status` and `category`.
// Project the aliases too so the shared normaliser reads them, without widening
// the projection to rationale or ballot data.
const REGISTER_PROJECTION = {
  _id: 0,
  proposalId: 1,
  policyId: 1,
  slug: 1,
  title: 1,
  space: 1,
  category: 1,
  stage: 1,
  status: 1,
  kind: 1,
  ballotRevisionId: 1,
  ballotClosesAt: 1,
  ballotClosedAt: 1,
  originatingBranchId: 1,
  governanceAuthorityBranchId: 1,
  jurisdictionBranchId: 1,
  provenance: 1,
} as const;

const REGISTER_METADATA_PROJECTION = {
  _id: 0,
  proposalId: 1,
  policyId: 1,
  stage: 1,
  status: 1,
  space: 1,
  category: 1,
  ballotRevisionId: 1,
} as const;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function registerScopeFilter(options: {
  branchScopeIds?: string[];
  anyBranchScopeIds?: string[];
}): Record<string, unknown> {
  if (options.anyBranchScopeIds !== undefined) {
    const ids = options.anyBranchScopeIds;
    return {
      $or: [
        { originatingBranchId: { $in: ids } },
        { governanceAuthorityBranchId: { $in: ids } },
        { jurisdictionBranchId: { $in: ids } },
      ],
    };
  }
  return options.branchScopeIds === undefined
    ? {}
    : { originatingBranchId: { $in: options.branchScopeIds } };
}

/**
 * The same filter semantics the register applied in memory before pagination:
 * search covers the identifier, title, topic space, summary and rationale;
 * branch matches any of the three branch references.
 */
function registerMatchFilter(options: {
  search?: string;
  stage?: string;
  branch?: string;
}): Record<string, unknown> {
  const clauses: Record<string, unknown>[] = [];
  const search = (options.search ?? "").trim();
  if (search) {
    const pattern = new RegExp(escapeRegex(search), "i");
    clauses.push({
      $or: [
        { proposalId: pattern },
        { policyId: pattern },
        { title: pattern },
        { space: pattern },
        { category: pattern },
        { summary: pattern },
        { details: pattern },
      ],
    });
  }
  const stage = parseRegisterStage(options.stage);
  if (stage) {
    const values = STAGE_STORAGE_VALUES[stage].map(
      (value) => new RegExp(`^\\s*${escapeRegex(value)}\\s*$`, "i"),
    );
    clauses.push({
      $or: [
        { stage: { $in: values } },
        { stage: { $exists: false }, status: { $in: values } },
      ],
    });
  }
  const branch = (options.branch ?? "").trim();
  if (branch && branch !== "all") {
    clauses.push({
      $or: [
        { originatingBranchId: branch },
        { governanceAuthorityBranchId: branch },
        { jurisdictionBranchId: branch },
      ],
    });
  }
  if (clauses.length === 0) return {};
  return clauses.length === 1 ? clauses[0]! : { $and: clauses };
}

function toNarrowRow(raw: Record<string, any>, commentCount: number): ProposalRegisterRow {
  const normalized = normalizeProposalDoc(raw);
  return {
    proposalId: normalized.proposalId,
    slug: normalized.slug,
    title: normalized.title,
    space: normalized.space,
    stage: normalized.stage,
    kind: normalized.kind as ProposalKind,
    ...(normalized.ballotRevisionId
      ? { ballotRevisionId: normalized.ballotRevisionId }
      : {}),
    ...(normalized.ballotClosesAt
      ? { ballotClosesAt: normalized.ballotClosesAt }
      : {}),
    ...(normalized.ballotClosedAt
      ? { ballotClosedAt: normalized.ballotClosedAt }
      : {}),
    ...(normalized.originatingBranchId
      ? { originatingBranchId: normalized.originatingBranchId }
      : {}),
    ...(normalized.governanceAuthorityBranchId
      ? { governanceAuthorityBranchId: normalized.governanceAuthorityBranchId }
      : {}),
    ...(normalized.jurisdictionBranchId
      ? { jurisdictionBranchId: normalized.jurisdictionBranchId }
      : {}),
    ...(normalized.provenance ? { provenance: normalized.provenance } : {}),
    commentCount,
  };
}

function asTally(raw: any): VoteTally | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const approve = Number(raw.approve ?? 0);
  const abstain = Number(raw.abstain ?? 0);
  const reject = Number(raw.reject ?? 0);
  const total = Number(raw.total ?? approve + abstain + reject);
  if (![approve, abstain, reject, total].every(Number.isFinite)) return undefined;
  return { approve, abstain, reject, total };
}

function toCertifiedResult(raw: Record<string, any>): CertifiedBallotResult {
  const overrideReason =
    typeof raw.override?.reason === "string" && raw.override.reason
      ? raw.override.reason
      : undefined;
  return {
    ballotId: String(
      raw.ballotId ?? proposalBallotId(String(raw.proposalId ?? "")),
    ),
    result: raw.result as FormalDecisionRecord["result"],
    ...(raw.computedResult
      ? {
          computedResult:
            raw.computedResult as FormalDecisionRecord["computedResult"],
        }
      : {}),
    ...(raw.ruleBasis ? { ruleBasis: String(raw.ruleBasis) } : {}),
    ...(asTally(raw.tally) ? { tally: asTally(raw.tally)! } : {}),
    overridden: Boolean(overrideReason),
    ...(overrideReason ? { overrideReason } : {}),
    ...(raw.recordedAt ? { recordedAt: new Date(raw.recordedAt) } : {}),
  };
}

interface RegisterMetadataRow {
  proposalId: string;
  stage: ProposalStage;
  space: string;
  ballotRevisionId?: string;
}

/**
 * Counts, unbound wording and space suggestions need every proposal in scope but
 * only a handful of fields, so this read is scoped and projected: it never loads
 * rationale, ballots or votes.
 */
async function readScopedMetadata(
  db: Db,
  scopeFilter: Record<string, unknown>,
): Promise<RegisterMetadataRow[]> {
  const rows = await db
    .collection<ProposalRecord>("proposals")
    .find(scopeFilter, { projection: REGISTER_METADATA_PROJECTION })
    .toArray();
  return rows.map((row: Record<string, any>) => ({
    proposalId: String(row.proposalId ?? row.policyId ?? ""),
    stage: normalizeStage(row.stage ?? row.status),
    space: String(row.space ?? row.category ?? "General"),
    ...(row.ballotRevisionId ? { ballotRevisionId: String(row.ballotRevisionId) } : {}),
  }));
}

/** Vote-free, rationale-free register read with server-side pagination. */
export async function listProposalRegister(
  db: Db,
  options: ProposalRegisterOptions = {},
): Promise<ProposalRegisterPage> {
  const pageSize = resolveRegisterPageSize(options.pageSize);
  const scopeFilter = registerScopeFilter({
    branchScopeIds: options.branchScopeIds,
    anyBranchScopeIds: options.anyBranchScopeIds,
  });
  const matchFilter = registerMatchFilter({
    search: options.search,
    stage: options.stage,
    branch: options.branch,
  });
  const where =
    Object.keys(scopeFilter).length === 0
      ? matchFilter
      : Object.keys(matchFilter).length === 0
        ? scopeFilter
        : { $and: [scopeFilter, matchFilter] };

  const [metadata, total] = await Promise.all([
    readScopedMetadata(db, scopeFilter),
    db.collection<ProposalRecord>("proposals").countDocuments(where),
  ]);

  const stageCounts: RegisterStageCounts = {
    all: metadata.length,
    propose: 0,
    deliberate: 0,
    decide: 0,
    implement: 0,
    archived: 0,
  };
  let unboundBallotCount = 0;
  for (const row of metadata) {
    stageCounts[row.stage] += 1;
    if (row.stage === "decide" && !row.ballotRevisionId) unboundBallotCount += 1;
  }
  const spaces = [...new Set(metadata.map((row) => row.space))].sort();

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = clampRegisterPage(parseRegisterPage(String(options.page ?? 1)), pageCount);
  const skip = (page - 1) * pageSize;

  const rawRows = await db
    .collection<ProposalRecord>("proposals")
    .aggregate([
      { $match: where },
      {
        $addFields: {
          _effectiveProposalId: { $ifNull: ["$proposalId", "$policyId"] },
        },
      },
      { $sort: { _effectiveProposalId: 1, _id: 1 } },
      { $skip: skip },
      { $limit: pageSize },
      { $project: REGISTER_PROJECTION },
    ])
    .toArray();
  const pageIds = rawRows.map((row) =>
    String((row as any).proposalId ?? (row as any).policyId ?? ""),
  );

  const commentCounts = new Map<string, number>();
  if (pageIds.length) {
    const commentRows = await db
      .collection("comments")
      .find(
        {
          $or: [{ proposalId: { $in: pageIds } }, { policyId: { $in: pageIds } }],
          deletedAt: { $exists: false },
        },
        { projection: { _id: 0, proposalId: 1, policyId: 1 } },
      )
      .toArray();
    for (const comment of commentRows as Array<Record<string, any>>) {
      const id = String(comment.proposalId ?? comment.policyId ?? "");
      if (!id) continue;
      commentCounts.set(id, (commentCounts.get(id) ?? 0) + 1);
    }
  }

  const mainBallotIds = pageIds.map((id) => proposalBallotId(id));
  const [resultRows, ballotRows] = pageIds.length
    ? await Promise.all([
        db
          .collection("ballot_results")
          .find(
            {
              $or: [
                { ballotId: { $in: mainBallotIds } },
                { proposalId: { $in: pageIds }, ballotId: { $exists: false } },
              ],
            },
            {
              // The tally stored at certification, plus the outcome context an
              // officer needs. Identifiable voter records are never stored here.
              projection: {
                _id: 0,
                ballotId: 1,
                proposalId: 1,
                result: 1,
                computedResult: 1,
                ruleBasis: 1,
                tally: 1,
                override: 1,
                recordedAt: 1,
              },
            },
          )
          .toArray(),
        db
          .collection("ballots")
          .find(
            { ballotId: { $in: mainBallotIds } },
            { projection: { _id: 0, ballotId: 1, status: 1, closesAt: 1 } },
          )
          .toArray(),
      ])
    : [[], []];

  const resultsByBallot = new Map<string, CertifiedBallotResult>();
  for (const raw of resultRows as Array<Record<string, any>>) {
    const key = String(raw.ballotId ?? proposalBallotId(String(raw.proposalId ?? "")));
    resultsByBallot.set(key, toCertifiedResult(raw));
  }
  const ballotsById = new Map<string, Record<string, any>>();
  for (const raw of ballotRows as Array<Record<string, any>>) {
    ballotsById.set(String(raw.ballotId), raw);
  }

  const now = new Date();
  const entries: ProposalRegisterEntry[] = rawRows.map((raw, index) => {
    const id = pageIds[index]!;
    const row = toNarrowRow(raw as Record<string, any>, commentCounts.get(id) ?? 0);
    const ballotId = proposalBallotId(row.proposalId);
    const closure = resolveBallotClosure({
      ballot: ballotsById.get(ballotId) ?? null,
      matter: row,
      now,
    });
    return {
      row,
      ballot: describeRegisterBallot({
        stage: row.stage,
        slug: row.slug,
        certified: resultsByBallot.get(ballotId) ?? null,
        closed: closure.closed,
      }),
    };
  });

  return {
    entries,
    total,
    page,
    pageSize,
    pageCount,
    startIndex: total === 0 ? 0 : skip + 1,
    endIndex: total === 0 ? 0 : skip + entries.length,
    stageCounts,
    unboundBallotCount,
    scopedProposalIds: metadata.map((row) => row.proposalId),
    spaces,
  };
}

/**
 * The editor needs the full record, including rationale, but only for the one
 * proposal being edited or revised. It also needs the vote count for the
 * integrity lock and the delete warning; counting votes is not decryption.
 */
export async function loadProposalEditorRecord(
  db: Db,
  proposalId: string,
): Promise<{ proposal: ProposalRecord; voteCount: number } | null> {
  const id = proposalId.trim();
  if (!id) return null;
  const raw = await db
    .collection<ProposalRecord>("proposals")
    .findOne(
      { $or: [{ proposalId: id }, { policyId: id } as any] },
      { projection: { detailHtml: 0 } },
    );
  if (!raw) return null;
  const [proposal, voteCount] = await Promise.all([
    Promise.resolve(normalizeProposalDoc(raw)),
    db.collection(PROPOSAL_VOTES).countDocuments({
      $or: [{ proposalId: id }, { policyId: id } as any],
    }),
  ]);
  return { proposal, voteCount };
}
