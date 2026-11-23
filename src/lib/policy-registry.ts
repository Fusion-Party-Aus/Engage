import type { Db } from "mongodb";

/**
 * Public policy registry routing and grouping.
 *
 * A branch policy lives at /policies/<branch>/<policy-slug>/. Its internal
 * `policyId` stays stable and is not presented as the public address. Records
 * created before branch paths existed still resolve at /policies/<policyId>/,
 * which redirects to the canonical path when one is known.
 */

export const POLICY_PUBLICATION_STATES = [
  "published",
  "withdrawn",
  "superseded",
  "repealed",
] as const;

export function branchSlugFor(branchId: string | null | undefined): string | null {
  if (!branchId) return null;
  return String(branchId).replace(/^branch-/, "").toLowerCase() || null;
}

/**
 * The public slug for a branch record. A branch may predate the standard
 * identifier scheme (production's Victorian branch has a UUID), so the record
 * carries an explicit slug. Fall back to the identifier suffix.
 */
export function branchPublicSlug(branch: Record<string, any> | null | undefined): string | null {
  if (!branch) return null;
  const explicit = typeof branch.slug === "string" ? branch.slug.trim().toLowerCase() : "";
  if (explicit) return explicit;
  return branchSlugFor(branch.branchId);
}

export function policyCanonicalPath(
  policy: Record<string, any> | { policyId?: unknown; branchSlug?: unknown; policySlug?: unknown },
): string {
  const branchSlug =
    typeof policy.branchSlug === "string" && policy.branchSlug
      ? policy.branchSlug
      : null;
  const policySlug =
    typeof policy.policySlug === "string" && policy.policySlug
      ? policy.policySlug
      : null;
  if (branchSlug && policySlug)
    return `/policies/${encodeURIComponent(branchSlug)}/${encodeURIComponent(policySlug)}/`;
  return `/policies/${encodeURIComponent(String(policy.policyId ?? ""))}/`;
}

export function policyBranchPath(branchSlug: string): string {
  return `/policies/${encodeURIComponent(branchSlug)}/`;
}

/** Lowercase kebab slug used for new public policy paths. */
export function policySlugFromTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
}

/**
 * Choose a public slug that is unique within a branch. A collision is not an
 * error: two adopted policies may share a title on different dates.
 */
export async function uniquePolicySlug(
  db: Db,
  branchSlug: string,
  desired: string,
  fallbackSuffix: string,
): Promise<string> {
  const base = desired || policySlugFromTitle(fallbackSuffix) || "policy";
  const existing = await db
    .collection("policy_registry")
    .find({ branchSlug })
    .project({ policySlug: 1 })
    .toArray();
  const taken = new Set(
    existing.map((row: any) => String(row.policySlug ?? "")).filter(Boolean),
  );
  if (!taken.has(base)) return base;
  // Deterministic and readable: title-2, title-3. The ordering of adoption is
  // the ordering a reader expects, and a re-run cannot invent a new suffix.
  let counter = 2;
  let candidate = `${base}-${counter}`;
  while (taken.has(candidate)) candidate = `${base}-${++counter}`;
  return candidate;
}

export interface PolicyRegistryGroup {
  key: string;
  label: string;
  description?: string;
  items: Array<Record<string, any>>;
}

const STATUS_ORDER = ["withdrawn", "superseded", "repealed"] as const;

const STATUS_DESCRIPTION: Record<string, string> = {
  withdrawn:
    "Withdrawn from publication by the responsible authority, including corrections to an incorrect publication.",
  superseded:
    "Replaced by a later policy. The successor is the current policy.",
  repealed:
    "Repealed by a member decision. This policy no longer applies.",
};

export function humanisePolicyLabel(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "Other";
  // Source pillars are published in capitals. Present them as sentence case
  // without touching mixed-case categories such as "Integrity & Accountability".
  if (trimmed === trimmed.toUpperCase()) {
    const lower = trimmed.toLowerCase();
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }
  return trimmed;
}

function topicKey(policy: Record<string, any>): string {
  const pillar = typeof policy.pillar === "string" ? policy.pillar.trim() : "";
  const category =
    typeof policy.category === "string" ? policy.category.trim() : "";
  return pillar || category || "Other";
}

/**
 * Group current policy by the branch's own topic structure, or past records by
 * what happened to them. Grouping is the primary navigation; a flat list of 41
 * policies is not.
 */
export function groupRegistryPolicies(
  policies: Array<Record<string, any>>,
  options: { groupBy?: "topic" | "status" } = {},
): PolicyRegistryGroup[] {
  const groupBy = options.groupBy ?? "topic";
  const groups = new Map<string, PolicyRegistryGroup>();
  for (const policy of policies) {
    const rawKey =
      groupBy === "status"
        ? String(policy.publicationStatus ?? "withdrawn")
        : topicKey(policy);
    const key = rawKey || "Other";
    if (!groups.has(key))
      groups.set(key, {
        key,
        label:
          groupBy === "status"
            ? policyStatusLabel(key)
            : humanisePolicyLabel(key),
        ...(groupBy === "status" && STATUS_DESCRIPTION[key]
          ? { description: STATUS_DESCRIPTION[key] }
          : {}),
        items: [],
      });
    groups.get(key)!.items.push(policy);
  }
  const ordered = [...groups.values()];
  ordered.sort((a, b) => {
    if (groupBy === "status") {
      const ai = STATUS_ORDER.indexOf(a.key as (typeof STATUS_ORDER)[number]);
      const bi = STATUS_ORDER.indexOf(b.key as (typeof STATUS_ORDER)[number]);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    }
    if (a.key === "Other") return 1;
    if (b.key === "Other") return -1;
    return a.label.localeCompare(b.label, "en-AU");
  });
  for (const group of ordered)
    group.items.sort((a, b) =>
      String(a.title ?? "").localeCompare(String(b.title ?? ""), "en-AU"),
    );
  return ordered;
}

export interface PolicyRegistrySection {
  key: string;
  /** Null when the page is already scoped to one branch. */
  label: string | null;
  href?: string;
  description?: string;
  groups: PolicyRegistryGroup[];
}

const BRANCH_KIND_ORDER: Record<string, number> = {
  national: 0,
  state: 1,
  territory: 2,
  constituent: 3,
};

/**
 * Collate policy by adopting branch, then by topic within each branch. A
 * registry with more than one branch cannot be a single alphabetical list:
 * authority, scope and topic are what a member is actually navigating.
 */
export function groupRegistryByBranch(
  policies: Array<Record<string, any>>,
  branches: Array<Record<string, any>>,
  options: { groupBy?: "topic" | "status" } = {},
): PolicyRegistrySection[] {
  const branchById = new Map(
    branches.map((branch: any) => [String(branch.branchId), branch]),
  );
  const byBranch = new Map<string, Array<Record<string, any>>>();
  for (const policy of policies) {
    const key = String(policy.jurisdictionBranchId ?? "unassigned");
    if (!byBranch.has(key)) byBranch.set(key, []);
    byBranch.get(key)!.push(policy);
  }
  const sections: PolicyRegistrySection[] = [...byBranch.entries()].map(
    ([branchId, items]) => {
      const branch = branchById.get(branchId);
      const branchSlug =
        typeof items[0]?.branchSlug === "string" && items[0].branchSlug
          ? String(items[0].branchSlug)
          : branchPublicSlug(branch);
      return {
        key: branchId,
        label: branch ? String(branch.name) : "Branch not recorded",
        ...(branchSlug ? { href: policyBranchPath(branchSlug) } : {}),
        groups: groupRegistryPolicies(items, options),
      };
    },
  );
  sections.sort((a, b) => {
    const branchA = branchById.get(a.key);
    const branchB = branchById.get(b.key);
    const orderA = BRANCH_KIND_ORDER[String(branchA?.kind ?? "")] ?? 9;
    const orderB = BRANCH_KIND_ORDER[String(branchB?.kind ?? "")] ?? 9;
    if (orderA !== orderB) return orderA - orderB;
    return String(a.label ?? "").localeCompare(String(b.label ?? ""), "en-AU");
  });
  return sections;
}

export function policyStatusLabel(status: string): string {
  switch (status) {
    case "published":
      return "Current policy";
    case "withdrawn":
      return "Withdrawn";
    case "superseded":
      return "Superseded";
    case "repealed":
      return "Repealed";
    default:
      return "Policy";
  }
}

export function policyStatusVariant(
  status: string,
): "success" | "warning" | "destructive" | "outline" {
  if (status === "published") return "success";
  if (status === "withdrawn") return "warning";
  if (status === "superseded" || status === "repealed") return "destructive";
  return "outline";
}

/**
 * Resolve a policy from /policies/<branch>/<slug>/. Falls back to the legacy
 * composite identifier so a link created before branch paths still resolves.
 */
export async function findPolicyByBranchPath(
  db: Db,
  branchSlug: string,
  policySlug: string,
): Promise<Record<string, any> | null> {
  const direct = await db.collection("policy_registry").findOne({
    branchSlug,
    policySlug,
    publicationStatus: { $in: [...POLICY_PUBLICATION_STATES] },
  });
  if (direct) return direct;
  return db.collection("policy_registry").findOne({
    policyId: `${branchSlug}-${policySlug}`,
    publicationStatus: { $in: [...POLICY_PUBLICATION_STATES] },
  });
}

export async function findBranchBySlug(
  db: Db,
  branchSlug: string,
): Promise<Record<string, any> | null> {
  const branches = await db
    .collection("branches")
    .find({ recognised: true })
    .toArray();
  return (
    branches.find((branch: any) => branchPublicSlug(branch) === branchSlug) ??
    null
  );
}

/** Cache a public policy page only in the anonymous visitor's browser. */
export function setPolicyPageCache(request: Request, headers: Headers, available = true): void {
  const anonymous = available && request.method === "GET"
    && !request.headers.has("Cookie")
    && !request.headers.has("Authorization")
    && !new URL(request.url).search;
  headers.append("Vary", "Cookie, Authorization");
  headers.set("Cache-Control", anonymous ? "private, max-age=30" : "private, no-store");
}
