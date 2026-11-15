import { createHash, randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import type { PolicyProvenance, PolicyRevisionRecord } from "./types.ts";

/**
 * Branch policy import.
 *
 * A branch may already hold adopted policy outside Engage. Importing it must
 * preserve the exact source document, record why it is authoritative, and
 * never rewrite an adopted record because a source feed changed. A changed
 * source is reported as a conflict; the change lifecycle is the only path that
 * produces new adopted wording.
 *
 * This is deliberately separate from the deferred National Neon baseline
 * import (#36). No adoption may be inferred from a publisher field alone.
 */

export const BRANCH_POLICY_IMPORT_RUNS = "policy_import_runs";
export const POLICY_REVISIONS = "policy_revisions";

export interface BranchPolicyKeyPoint {
  point?: string;
  description?: string;
  [key: string]: unknown;
}

export interface BranchPolicySupportingResearch {
  title?: string;
  canonical_url?: string;
  [key: string]: unknown;
}

export interface BranchPolicySourcePolicy {
  id?: string;
  title?: string;
  slug?: string;
  canonical_url?: string;
  status?: string;
  summary?: string;
  hook?: string;
  pillar?: string;
  category?: string;
  delivery_horizon?: string;
  key_points?: BranchPolicyKeyPoint[];
  shareable_quote?: string;
  design_rationale?: string;
  system_interaction?: string;
  economic_logic?: string;
  risks_and_failure_modes?: string;
  evidence_and_precedent?: string;
  implementation_outline?: string;
  cost?: string;
  funding?: string;
  additional_content_text?: string;
  published_at?: string | null;
  substantive_updated_at?: string | null;
  change_summary?: string | null;
  updated_at?: string | null;
  supporting_research?: BranchPolicySupportingResearch[];
  authority?: {
    publisher?: string;
    jurisdiction?: string;
    status?: string;
    adopted_policy?: boolean;
    part_of?: string;
    [key: string]: unknown;
  };
  topics?: unknown[];
  references?: unknown[];
  [key: string]: unknown;
}

export interface BranchPolicySource {
  schema_version?: number;
  generated_at?: string;
  platform_updated_at?: string;
  policy_count?: number;
  organization?: { name?: string; jurisdiction?: string; canonical_url?: string };
  governing_philosophy?: Record<string, unknown>;
  policies?: BranchPolicySourcePolicy[];
  [key: string]: unknown;
}

export interface BranchImportAuthority {
  branchId: string;
  name: string;
  /** Short registry prefix, for example "vic" for branch-vic. */
  code: string;
}

export interface BranchPolicyImportOptions {
  source: BranchPolicySource;
  sourceUrl: string;
  branch: BranchImportAuthority;
  /** Who authorised importing these records as adopted policy. */
  authorityBasis: string;
  importedAt: Date;
  importedBy: string;
}

export type BranchPolicyImportAction =
  | "create"
  | "unchanged"
  | "changed"
  | "conflict"
  | "invalid"
  | "missing-from-source";

export interface BranchPolicyImportEntry {
  policyId: string;
  slug: string;
  title: string;
  action: BranchPolicyImportAction;
  reason?: string;
  contentHash?: string;
  existingPublicationStatus?: string;
  existingContentHash?: string;
  registry?: Record<string, unknown>;
  revision?: PolicyRevisionRecord;
}

export interface BranchPolicyImportCounts {
  total: number;
  create: number;
  unchanged: number;
  changed: number;
  conflict: number;
  invalid: number;
  missingFromSource: number;
}

export interface BranchPolicyImportPlan {
  runId: string;
  sourceUrl: string;
  branchId: string;
  authorityBasis: string;
  importedAt: Date;
  importedBy: string;
  counts: BranchPolicyImportCounts;
  entries: BranchPolicyImportEntry[];
  /** Existing records for this source that no longer appear in the feed. */
  missing: BranchPolicyImportEntry[];
  errors: string[];
}

export class BranchPolicySourceError extends Error {
  issues: string[];
  constructor(issues: string[]) {
    super(issues.join(" "));
    this.name = "BranchPolicySourceError";
    this.issues = issues;
  }
}

export function branchPolicyIdPrefix(branchId: string): string {
  return branchId.replace(/^branch-/, "").toLowerCase();
}

export function branchPolicyId(
  branchId: string,
  slug: string,
): string {
  return `${branchPolicyIdPrefix(branchId)}-${slug}`;
}

/** Stable JSON so a hash never changes because key order changed. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

export function branchPolicyContentHash(
  policy: BranchPolicySourcePolicy,
): string {
  return createHash("sha256").update(canonicalJson(policy)).digest("hex");
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalDate(value: unknown): Date | null {
  const raw = text(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * The wording shown as the adopted text is derived only from published source
 * fields, using the section labels the branch itself publishes. Nothing is
 * paraphrased or added.
 */
export function renderBranchPolicyWording(
  policy: BranchPolicySourcePolicy,
): string {
  const blocks: string[] = [];
  const summary = text(policy.summary);
  const hook = text(policy.hook);
  if (hook) blocks.push(`> ${hook}`);
  if (summary) blocks.push(summary);
  const points = Array.isArray(policy.key_points)
    ? policy.key_points.filter(
        (point) => text(point?.point) || text(point?.description),
      )
    : [];
  if (points.length) {
    blocks.push("**What it does**");
    blocks.push(
      points
        .map((point) => {
          const label = text(point.point);
          const description = text(point.description);
          if (label && description) return `- **${label}** — ${description}`;
          return `- ${label || description}`;
        })
        .join("\n"),
    );
  }
  const sections: Array<[string, unknown]> = [
    ["Design Rationale", policy.design_rationale],
    ["System Interaction", policy.system_interaction],
    ["Economic & Institutional Logic", policy.economic_logic],
    ["Risk & Failure Modes", policy.risks_and_failure_modes],
    ["Evidence & Precedent", policy.evidence_and_precedent],
    ["Implementation Outline", policy.implementation_outline],
    ["Additional Detail", policy.additional_content_text],
  ];
  for (const [heading, value] of sections) {
    const body = text(value);
    if (body) blocks.push(`**${heading}**`, body);
  }
  const cost = text(policy.cost);
  if (cost) blocks.push("**What it costs**", cost);
  const funding = text(policy.funding);
  if (funding) blocks.push("**Paid for by**", funding);
  const research = Array.isArray(policy.supporting_research)
    ? policy.supporting_research.filter((item) => text(item?.title))
    : [];
  if (research.length) {
    blocks.push("**Supporting research**");
    blocks.push(
      research
        .map((item) => {
          const title = text(item.title);
          const url = text(item.canonical_url);
          return url ? `- [${title}](${url})` : `- ${title}`;
        })
        .join("\n"),
    );
  }
  return blocks.join("\n\n");
}

function commitmentList(policy: BranchPolicySourcePolicy): string[] {
  return (Array.isArray(policy.key_points) ? policy.key_points : [])
    .map((point) => text(point?.point) || text(point?.description))
    .filter(Boolean);
}

export function validateBranchPolicySource(
  source: BranchPolicySource | null | undefined,
): string[] {
  const issues: string[] = [];
  if (!source || typeof source !== "object") {
    return ["The source document is not a JSON object."];
  }
  if (!Array.isArray(source.policies)) {
    issues.push("The source document has no policies array.");
    return issues;
  }
  if (
    source.policy_count !== undefined &&
    Number(source.policy_count) !== source.policies.length
  )
    issues.push(
      `The source declares ${String(source.policy_count)} policies but contains ${source.policies.length}.`,
    );
  const seen = new Map<string, number>();
  source.policies.forEach((policy, index) => {
    const slug = text(policy?.slug);
    if (!slug) issues.push(`Policy ${index + 1} has no slug.`);
    else if (!/^[a-z0-9][a-z0-9-]*$/.test(slug))
      issues.push(`Policy ${index + 1} has an unusable slug: ${slug}.`);
    else seen.set(slug, (seen.get(slug) ?? 0) + 1);
    if (!text(policy?.title)) issues.push(`Policy ${index + 1} has no title.`);
  });
  for (const [slug, count] of seen)
    if (count > 1) issues.push(`The source repeats the slug ${slug}.`);
  return issues;
}

export function buildImportedPolicyRecord(
  options: BranchPolicyImportOptions,
  policy: BranchPolicySourcePolicy,
): { registry: Record<string, unknown>; revision: PolicyRevisionRecord } {
  const slug = text(policy.slug);
  const policyId = branchPolicyId(options.branch.branchId, slug);
  const contentHash = branchPolicyContentHash(policy);
  const canonicalUrl = text(policy.canonical_url);
  const publisher = text(policy.authority?.publisher) || options.branch.name;
  const sourceStatus = text(policy.status) || "unknown";
  const sourcePublishedAt = optionalDate(policy.published_at);
  const revisionId = `rev-${policyId}-${contentHash.slice(0, 12)}`;
  const wording = renderBranchPolicyWording(policy);
  const provenance: PolicyProvenance = {
    category: "branch-import",
    label: `Imported from ${publisher}`,
    summary:
      "Published branch policy imported from the branch policy platform. Wording is reproduced from the source document; no Engage ballot produced this text.",
    evidenceBasis: options.authorityBasis,
    sourceTypes: ["branch-policy-json-api"],
    lineage: [
      ...(canonicalUrl
        ? [
            {
              label: "Published policy",
              url: canonicalUrl,
              description: "The branch's own published policy page.",
            },
          ]
        : []),
      {
        label: "Source feed",
        url: options.sourceUrl,
        description: "Machine-readable policy feed used for this import.",
      },
    ],
  };
  const revision: PolicyRevisionRecord = {
    revisionId,
    policyId,
    revisionType: "imported-policy",
    parentRevisionId: null,
    authorId: options.importedBy,
    createdAt: options.importedAt,
    snapshot: {
      title: text(policy.title),
      summary: text(policy.summary),
      outcomes: commitmentList(policy),
      details: wording,
      document: policy as Record<string, unknown>,
    },
    contentHash,
    provenance,
  };
  const branchSlug = options.branch.branchId.replace(/^branch-/, "").toLowerCase();
  const registry: Record<string, unknown> = {
    policyId,
    proposalId: null,
    /** Public address: /policies/<branchSlug>/<policySlug>/ */
    branchSlug,
    policySlug: slug,
    title: text(policy.title),
    summary: text(policy.summary),
    pillar: text(policy.pillar) || null,
    category: text(policy.category) || null,
    commitments: commitmentList(policy),
    approvedWording: wording,
    revisionId,
    revisionIds: [revisionId],
    status: "adopted",
    publicationStatus: "published",
    recordOrigin: "branch-import",
    provenance,
    jurisdiction:
      text(policy.authority?.jurisdiction) ||
      text(options.source.organization?.jurisdiction) ||
      null,
    jurisdictionBranchId: options.branch.branchId,
    governanceAuthorityBranchId: options.branch.branchId,
    ratification: null,
    effectiveAt: sourcePublishedAt,
    publishedAt: options.importedAt,
    import: {
      sourceUrl: options.sourceUrl,
      schemaVersion:
        typeof options.source.schema_version === "number"
          ? options.source.schema_version
          : null,
      sourceGeneratedAt: optionalDate(options.source.generated_at),
      sourcePlatformUpdatedAt: optionalDate(options.source.platform_updated_at),
      sourcePolicyId: text(policy.id) || null,
      sourceSlug: slug,
      canonicalUrl: canonicalUrl || null,
      sourceStatus,
      sourcePublishedAt,
      sourceSubstantiveUpdatedAt: optionalDate(
        policy.substantive_updated_at,
      ),
      sourceUpdatedAt: optionalDate(policy.updated_at),
      sourceChangeSummary: text(policy.change_summary) || null,
      contentHash,
      revisionId,
      authorityBasis: options.authorityBasis,
      importedAt: options.importedAt,
      importedBy: options.importedBy,
    },
  };
  return { registry, revision };
}

async function loadExisting(
  db: Db,
  policyIds: string[],
): Promise<{
  registry: Map<string, Record<string, any>>;
  revisions: Map<string, Record<string, any>>;
}> {
  if (!policyIds.length)
    return { registry: new Map(), revisions: new Map() };
  const [rows, revisions] = await Promise.all([
    db
      .collection("policy_registry")
      .find({ policyId: { $in: policyIds } })
      .toArray(),
    db
      .collection(POLICY_REVISIONS)
      .find({ policyId: { $in: policyIds } })
      .toArray(),
  ]);
  return {
    registry: new Map(rows.map((row) => [String(row.policyId), row])),
    revisions: new Map(
      revisions.map((row) => [String(row.revisionId), row]),
    ),
  };
}

/**
 * Build a reconciliation plan. Reads only; applying is a separate, explicit
 * step so a dry run can never write.
 */
export async function planBranchPolicyImport(
  db: Db,
  options: BranchPolicyImportOptions,
): Promise<BranchPolicyImportPlan> {
  const issues = validateBranchPolicySource(options.source);
  if (issues.length) throw new BranchPolicySourceError(issues);
  if (!text(options.authorityBasis))
    throw new BranchPolicySourceError([
      "An explicit authority basis is required. An import may not infer adoption.",
    ]);
  if (!text(options.branch?.branchId))
    throw new BranchPolicySourceError(["A branch is required."]);

  const policies = options.source.policies ?? [];
  const planned: Array<{
    policy: BranchPolicySourcePolicy;
    registry: Record<string, unknown>;
    revision: PolicyRevisionRecord;
  }> = [];
  const invalid: BranchPolicyImportEntry[] = [];
  for (const policy of policies) {
    const slug = text(policy.slug);
    const policyId = branchPolicyId(options.branch.branchId, slug);
    if (!text(policy.title) || !slug) {
      invalid.push({
        policyId,
        slug,
        title: text(policy.title),
        action: "invalid",
        reason: "The source policy is missing a title or slug.",
      });
      continue;
    }
    if (text(policy.status).toLowerCase() !== "adopted") {
      invalid.push({
        policyId,
        slug,
        title: text(policy.title),
        action: "invalid",
        reason: `The source marks this record '${text(policy.status) || "unknown"}', not adopted policy.`,
      });
      continue;
    }
    if (policy.authority?.adopted_policy === false) {
      invalid.push({
        policyId,
        slug,
        title: text(policy.title),
        action: "invalid",
        reason: "The source says this record is not adopted policy.",
      });
      continue;
    }
    const built = buildImportedPolicyRecord(options, policy);
    planned.push({ policy, ...built });
  }

  const existing = await loadExisting(
    db,
    planned.map((item) => String(item.registry.policyId)),
  );
  const entries: BranchPolicyImportEntry[] = [...invalid];
  for (const item of planned) {
    const policyId = String(item.registry.policyId);
    const contentHash = String(item.revision.contentHash);
    const current = existing.registry.get(policyId);
    if (!current) {
      entries.push({
        policyId,
        slug: text(item.policy.slug),
        title: text(item.policy.title),
        action: "create",
        contentHash,
        registry: item.registry,
        revision: item.revision,
      });
      continue;
    }
    const base = {
      policyId,
      slug: text(item.policy.slug),
      title: text(item.policy.title),
      contentHash,
      existingPublicationStatus: String(current.publicationStatus ?? ""),
      existingContentHash: String(current.import?.contentHash ?? ""),
    };
    if (current.recordOrigin !== "branch-import" || current.import?.sourceUrl !== options.sourceUrl) {
      entries.push({
        ...base,
        action: "conflict",
        reason:
          "A registry record with this identifier already exists from a different origin or source feed.",
      });
      continue;
    }
    if (current.publicationStatus !== "published") {
      entries.push({
        ...base,
        action: "conflict",
        reason: `The record is no longer published (${String(current.publicationStatus)}). A re-run will not republish it.`,
      });
      continue;
    }
    if (String(current.import?.contentHash ?? "") !== contentHash) {
      entries.push({
        ...base,
        action: "changed",
        reason:
          "The source wording has changed since import. A re-run will not overwrite adopted policy; start a change proposal so the change has a decision record.",
      });
      continue;
    }
    entries.push({ ...base, action: "unchanged" });
  }

  const entryIds = new Set(entries.map((entry) => entry.policyId));
  const missingCandidates = await db
    .collection("policy_registry")
    .find({
      "import.sourceUrl": options.sourceUrl,
      jurisdictionBranchId: options.branch.branchId,
    })
    .toArray();
  const missing: BranchPolicyImportEntry[] = missingCandidates
    .filter((row) => !entryIds.has(String(row.policyId)))
    .map((row) => ({
      policyId: String(row.policyId),
      slug: String(row.import?.sourceSlug ?? ""),
      title: String(row.title ?? ""),
      action: "missing-from-source" as const,
      reason:
        "This imported record is not in the current source feed. It is left untouched and reported for review.",
      existingPublicationStatus: String(row.publicationStatus ?? ""),
      existingContentHash: String(row.import?.contentHash ?? ""),
    }));

  const count = (action: BranchPolicyImportAction) =>
    entries.filter((entry) => entry.action === action).length;
  return {
    runId: randomUUID(),
    sourceUrl: options.sourceUrl,
    branchId: options.branch.branchId,
    authorityBasis: options.authorityBasis,
    importedAt: options.importedAt,
    importedBy: options.importedBy,
    counts: {
      total: policies.length,
      create: count("create"),
      unchanged: count("unchanged"),
      changed: count("changed"),
      conflict: count("conflict"),
      invalid: count("invalid"),
      missingFromSource: missing.length,
    },
    entries,
    missing,
    errors: [],
  };
}

/**
 * Apply a plan. Only `create` entries write. Every write is keyed so a
 * restarted run cannot duplicate or overwrite an adopted record.
 */
export async function applyBranchPolicyImport(
  db: Db,
  plan: BranchPolicyImportPlan,
): Promise<BranchPolicyImportPlan> {
  const errors: string[] = [];
  let created = 0;
  for (const entry of plan.entries) {
    if (entry.action !== "create" || !entry.registry || !entry.revision) continue;
    const policyId = entry.policyId;
    await db
      .collection(POLICY_REVISIONS)
      .updateOne(
        { revisionId: entry.revision.revisionId },
        { $setOnInsert: entry.revision },
        { upsert: true },
      );
    await db
      .collection("policy_registry")
      .updateOne(
        { policyId },
        { $setOnInsert: entry.registry },
        { upsert: true },
      );
    const saved = await db
      .collection("policy_registry")
      .findOne({ policyId });
    if (
      !saved ||
      String(saved.import?.contentHash ?? "") !== String(entry.contentHash)
    ) {
      errors.push(
        `${policyId}: an existing record differs from the source and was not overwritten.`,
      );
      entry.action = "conflict";
      continue;
    }
    created += 1;
  }
  const count = (action: BranchPolicyImportAction) =>
    plan.entries.filter((entry) => entry.action === action).length;
  plan.counts = {
    ...plan.counts,
    create: created,
    conflict: count("conflict"),
  };
  plan.errors = errors;
  await db.collection(BRANCH_POLICY_IMPORT_RUNS).insertOne({
    runId: plan.runId,
    sourceUrl: plan.sourceUrl,
    branchId: plan.branchId,
    authorityBasis: plan.authorityBasis,
    importedBy: plan.importedBy,
    importedAt: plan.importedAt,
    completedAt: new Date(),
    counts: plan.counts,
    errors,
  });
  return plan;
}

/** A compact, human-readable reconciliation summary for CLI output. */
export function formatBranchPolicyImportReport(
  plan: BranchPolicyImportPlan,
  options: { dryRun?: boolean } = {},
): string {
  const lines = [
    `${options.dryRun ? "Import preview" : "Import complete"}: ${plan.branchId}`,
    `Source: ${plan.sourceUrl}`,
    `Authority basis: ${plan.authorityBasis}`,
    "",
    `Total source policies: ${plan.counts.total}`,
    `Created: ${plan.counts.create}`,
    `Unchanged: ${plan.counts.unchanged}`,
    `Changed in source: ${plan.counts.changed}`,
    `Conflicts: ${plan.counts.conflict}`,
    `Invalid or not adopted: ${plan.counts.invalid}`,
    `Missing from source: ${plan.counts.missingFromSource}`,
  ];
  const notable = [
    ...plan.entries.filter((entry) =>
      ["changed", "conflict", "invalid"].includes(entry.action),
    ),
    ...plan.missing,
  ];
  if (notable.length) {
    lines.push("", "Needs review:");
    for (const entry of notable)
      lines.push(
        `- ${entry.policyId} (${entry.action}): ${entry.reason ?? ""}`,
      );
  }
  if (plan.errors.length) {
    lines.push("", "Errors:");
    for (const error of plan.errors) lines.push(`- ${error}`);
  }
  return lines.join("\n");
}
