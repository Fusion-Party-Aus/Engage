import type { Db } from "mongodb";
import { DEFAULT_STATE_SITES } from "./site-config.ts";
import type { BranchKind, SessionUser } from "./types.ts";

/**
 * A proposal's geographic scope and its organisational branch identity are two
 * different facts.
 *
 *  - The geographic scope is what a proposal applies to: National, or one
 *    Australian state or territory. It has a stable key ("national", "vic")
 *    and a canonical display label.
 *  - The organisational branch is the branch record that owns the proposal. It
 *    has its own identifier (a branchId) and its own name ("Fusion Victoria").
 *
 * Display labels are never identifiers. Existing proposal records keep their
 * branch identifiers, and legacy label-shaped values are resolved for reading
 * only. New writes must use a canonical scope key or an exact branchId.
 */

export interface GeographicProposalScope {
  /** Stable identifier used by clients, APIs and stored proposals. */
  key: string;
  /** Canonical human label. Never used as an identifier. */
  label: string;
  kind: "national" | "state" | "territory";
  /** State/territory code, or NAT for the national scope. */
  stateCode: string;
  /** Standard organisational branch identifier for this geographic scope. */
  branchId: string;
  /** Standard organisational branch name for this geographic scope. */
  branchName: string;
}

export interface ProposalScopeOption {
  key: string;
  label: string;
  kind: BranchKind;
  /** Organisational branch identity, when one is recorded. */
  branchId: string | null;
  branchName?: string;
}

export interface ProposalScopeDescriptor {
  key: string;
  label: string;
  kind: BranchKind;
}

export interface SubmittedProposalScope {
  key: string;
  branchId: string | null;
  definition: GeographicProposalScope | null;
  /** True only when the request explicitly selected the national scope. */
  explicitNational: boolean;
}

interface BranchLike {
  [key: string]: unknown;
  branchId?: unknown;
  name?: unknown;
  kind?: unknown;
  stateCode?: unknown;
  recognised?: unknown;
}

const KIND_ORDER: Record<string, number> = {
  national: 0,
  state: 1,
  territory: 2,
  constituent: 3,
};

function scopeKindForCode(code: string): GeographicProposalScope["kind"] {
  if (code === "NAT") return "national";
  return code === "ACT" || code === "NT" ? "territory" : "state";
}

function scopeLabel(site: { code: string; name: string }): string {
  // Site configuration names the national site "National · Fusion Party
  // Australia". The geographic scope label is simply "National".
  return site.code === "NAT" ? "National" : site.name;
}

export const GEOGRAPHIC_PROPOSAL_SCOPES: readonly GeographicProposalScope[] =
  DEFAULT_STATE_SITES.map((site) => {
    const kind = scopeKindForCode(site.code);
    return {
      key: kind === "national" ? "national" : site.code.toLowerCase(),
      label: scopeLabel(site),
      kind,
      stateCode: site.code,
      branchId: `branch-${site.code.toLowerCase()}`,
      branchName:
        kind === "national" ? "Fusion National" : `Fusion ${site.name}`,
    };
  });

export const NATIONAL_PROPOSAL_SCOPE = GEOGRAPHIC_PROPOSAL_SCOPES.find(
  (scope) => scope.kind === "national",
)!;

export const PROPOSAL_SCOPE_KEYS = GEOGRAPHIC_PROPOSAL_SCOPES.map(
  (scope) => scope.key,
);

const SCOPE_ALIASES: Record<string, string[]> = {
  national: ["national", "federal", "australia"],
  nsw: ["nsw", "newsouthwales"],
  vic: ["vic", "victoria"],
  qld: ["qld", "queensland"],
  wa: ["wa", "westernaustralia"],
  sa: ["sa", "southaustralia"],
  tas: ["tas", "tasmania"],
  act: ["act", "australiancapitalterritory"],
  nt: ["nt", "northernterritory"],
};

function normaliseName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/^fusion/, "");
}

function matchesAlias(name: string, alias: string): boolean {
  if (!name || !alias) return false;
  if (name === alias) return true;
  // Long names may carry a legacy suffix ("Victoria — existing local name").
  return alias.length >= 5 && name.startsWith(alias);
}

/** Strictly maps a canonical scope key. Display labels are not accepted. */
export function normalizeProposalScopeKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  return PROPOSAL_SCOPE_KEYS.includes(key) ? key : null;
}

export function geographicScopeByKey(
  key: string,
): GeographicProposalScope | undefined {
  return GEOGRAPHIC_PROPOSAL_SCOPES.find((scope) => scope.key === key);
}

/**
 * Maps an organisational branch record to its geographic scope. Constituent
 * branches have no geographic scope: they remain organisational identities.
 */
export function geographicScopeForBranch(
  branch: BranchLike | null | undefined,
): GeographicProposalScope | undefined {
  if (!branch) return undefined;
  const branchId =
    typeof branch.branchId === "string" ? branch.branchId.trim() : "";
  const direct = GEOGRAPHIC_PROPOSAL_SCOPES.find(
    (scope) => scope.branchId === branchId,
  );
  if (direct) return direct;

  const kind = String(branch.kind ?? "");
  const stateCode =
    typeof branch.stateCode === "string"
      ? branch.stateCode.trim().toUpperCase()
      : "";
  if (stateCode) {
    const matched = GEOGRAPHIC_PROPOSAL_SCOPES.find(
      (scope) => scope.stateCode === stateCode,
    );
    if (matched && matched.kind === kind) return matched;
  }

  if (kind === "national") return NATIONAL_PROPOSAL_SCOPE;
  if (kind !== "state" && kind !== "territory") return undefined;

  const name = normaliseName(branch.name);
  if (!name) return undefined;
  return GEOGRAPHIC_PROPOSAL_SCOPES.find(
    (scope) =>
      scope.kind === kind &&
      (SCOPE_ALIASES[scope.key] ?? []).some((alias) =>
        matchesAlias(name, alias),
      ),
  );
}

/**
 * Derives the geographic scope key for a stored proposal. Legacy records may
 * hold a branchId, a label ("National"), a standard branch id or no branch at
 * all. All of them resolve without rewriting the stored record.
 */
export function storedProposalScopeKey(proposal: {
  scope?: unknown;
  originatingBranchId?: unknown;
}): string {
  const explicit = normalizeProposalScopeKey(proposal.scope);
  if (explicit) return explicit;

  const candidate =
    typeof proposal.originatingBranchId === "string"
      ? proposal.originatingBranchId.trim()
      : "";
  if (!candidate) return NATIONAL_PROPOSAL_SCOPE.key;

  const direct = GEOGRAPHIC_PROPOSAL_SCOPES.find(
    (scope) => scope.branchId === candidate,
  );
  if (direct) return direct.key;

  const name = normaliseName(candidate);
  const labelMatch = GEOGRAPHIC_PROPOSAL_SCOPES.find((scope) =>
    (SCOPE_ALIASES[scope.key] ?? []).some((alias) =>
      matchesAlias(name, alias),
    ),
  );
  if (labelMatch) return labelMatch.key;

  // A non-geographic (constituent) branch keeps its own identity as the key.
  return candidate;
}

export function proposalScopeLabelFor(
  key: string,
  branches: BranchLike[] = [],
): string {
  const definition = geographicScopeByKey(key);
  if (definition) return definition.label;
  const branch = branches.find(
    (item) => String(item.branchId ?? "") === String(key),
  );
  if (branch) {
    return geographicScopeForBranch(branch)?.label ?? String(branch.name ?? key);
  }
  return key === NATIONAL_PROPOSAL_SCOPE.key ? "National" : key;
}

/** Read-side scope description for an existing proposal record. */
export async function describeProposalScope(
  db: Db,
  proposal: { scope?: unknown; originatingBranchId?: unknown },
): Promise<ProposalScopeDescriptor> {
  const key = storedProposalScopeKey(proposal);
  const definition = geographicScopeByKey(key);
  if (definition) {
    return { key: definition.key, label: definition.label, kind: definition.kind };
  }
  const branch = await db.collection("branches").findOne({ branchId: key });
  const mapped = branch ? geographicScopeForBranch(branch) : undefined;
  if (mapped) {
    return { key: mapped.key, label: mapped.label, kind: mapped.kind };
  }
  return {
    key,
    label: branch ? String(branch.name ?? key) : key,
    kind: (branch?.kind as BranchKind) ?? "constituent",
  };
}

function authorisedBranches(
  user: SessionUser,
  branches: BranchLike[],
): BranchLike[] {
  const branchAdminIds = user.branchAdminIds ?? [];
  return branches.filter(
    (branch) =>
      user.isAdmin || branchAdminIds.includes(String(branch.branchId ?? "")),
  );
}

/**
 * Geographic scopes a person may submit into. National is always available to
 * an eligible member; branch scopes are strictly limited to delegated branch
 * administration. National is represented exactly once.
 */
export function listAuthorisedProposalScopes(
  user: SessionUser,
  branches: BranchLike[],
): ProposalScopeOption[] {
  const nationalBranch = branches.find(
    (branch) => String(branch.kind ?? "") === "national",
  );
  const options: ProposalScopeOption[] = [
    {
      key: NATIONAL_PROPOSAL_SCOPE.key,
      label: NATIONAL_PROPOSAL_SCOPE.label,
      kind: "national",
      branchId: nationalBranch
        ? String(nationalBranch.branchId ?? "") || null
        : null,
      ...(nationalBranch
        ? { branchName: String(nationalBranch.name ?? "") }
        : {}),
    },
  ];
  const seen = new Set<string>([NATIONAL_PROPOSAL_SCOPE.key]);

  const rows = authorisedBranches(user, branches).slice().sort((left, right) => {
    const leftKind = String(left.kind ?? "");
    const rightKind = String(right.kind ?? "");
    return (
      (KIND_ORDER[leftKind] ?? 9) - (KIND_ORDER[rightKind] ?? 9) ||
      String(left.name ?? "").localeCompare(String(right.name ?? ""))
    );
  });

  for (const branch of rows) {
    const definition = geographicScopeForBranch(branch);
    if (definition?.key === NATIONAL_PROPOSAL_SCOPE.key) continue;
    // A national record may be misclassified as another kind in legacy data.
    // It is still National, and National must appear exactly once.
    if (
      String(branch.kind ?? "") !== "national" &&
      normaliseName(branch.name) === "national"
    )
      continue;
    const branchId = String(branch.branchId ?? "");
    if (!branchId) continue;
    const key = definition?.key ?? branchId;
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({
      key,
      label: definition?.label ?? String(branch.name ?? branchId),
      kind:
        definition?.kind ??
        (["national", "state", "territory", "constituent"].includes(
          String(branch.kind),
        )
          ? (String(branch.kind) as BranchKind)
          : "constituent"),
      branchId,
      ...(branch.name ? { branchName: String(branch.name) } : {}),
    });
  }

  return options;
}

/**
 * Prefer the member's own verified/active branch, but only when that branch is
 * one they are authorised to submit into. Otherwise National is the safe
 * default. Interstate scopes remain explicitly selectable.
 */
export function defaultProposalScopeKey(
  user: SessionUser,
  options: ProposalScopeOption[],
): string {
  const preferred = [
    ...(user.verifiedBranchIds ?? []),
    ...(user.activeBranchIds ?? []),
    ...(user.branchAdminIds ?? []),
  ];
  for (const branchId of preferred) {
    const option = options.find((item) => item.branchId === branchId);
    if (option) return option.key;
  }
  return (
    options.find((item) => item.kind === "national")?.key ??
    options[0]?.key ??
    NATIONAL_PROPOSAL_SCOPE.key
  );
}

/**
 * Resolves a canonical scope key to its organisational branch. Branches are
 * matched by stable identity first. Ambiguous duplicate geography fails closed
 * rather than attaching a proposal to an arbitrary branch.
 */
export async function resolveProposalScopeBranchId(
  db: Db,
  key: string,
): Promise<Omit<GeographicProposalScope, "branchId"> & { branchId: string | null }> {
  const definition = geographicScopeByKey(key);
  if (!definition) throw new Error("Choose a valid proposal scope.");

  const rows = await db
    .collection("branches")
    .find({
      $or: [
        { branchId: definition.branchId },
        { kind: definition.kind, stateCode: definition.stateCode },
        { kind: definition.kind, name: definition.branchName },
        { kind: definition.kind, name: definition.label },
      ],
    } as any)
    .toArray();

  const standard = rows.find(
    (branch) => String(branch.branchId) === definition.branchId,
  );
  if (standard) {
    return { ...definition, branchId: String(standard.branchId) };
  }

  const candidates = rows.filter(
    (branch) => geographicScopeForBranch(branch)?.key === definition.key,
  );
  const uniqueIds = [
    ...new Set(candidates.map((branch) => String(branch.branchId))),
  ];
  if (uniqueIds.length > 1) {
    throw new Error(
      `More than one ${definition.label} branch exists. A national administrator must reconcile them before this scope can be used.`,
    );
  }
  if (!uniqueIds.length) {
    if (definition.kind === "national") {
      // Fresh installs may not have created the national branch yet. National
      // scope remains valid; proposal defaults supply the branch when present.
      return { ...definition, branchId: null };
    }
    throw new Error(
      `No ${definition.label} branch exists yet. Choose another scope.`,
    );
  }
  return { ...definition, branchId: uniqueIds[0]! };
}

async function resolveSubmittedScopeKey(
  db: Db,
  raw: string,
): Promise<{ key: string; branchId: string | null; definition: GeographicProposalScope | null }> {
  const canonical = normalizeProposalScopeKey(raw);
  if (canonical) {
    const resolved = await resolveProposalScopeBranchId(db, canonical);
    return {
      key: resolved.key,
      branchId: resolved.branchId,
      definition: geographicScopeByKey(resolved.key) ?? null,
    };
  }

  // An exact organisational branch identifier is deliberately allowed. A
  // display label ("Victoria", "Fusion National") is not, because labels must
  // never select organisational identity.
  const branch = await db.collection("branches").findOne({ branchId: raw });
  if (!branch) throw new Error("Choose a valid proposal scope.");
  const definition = geographicScopeForBranch(branch) ?? null;
  return {
    key: definition?.key ?? String(branch.branchId),
    branchId: String(branch.branchId),
    definition,
  };
}

/**
 * Server-side validation for a submitted proposal scope.
 *
 * - Exactly one scope may be selected.
 * - Invalid keys and display labels are rejected.
 * - A scope and a conflicting originating branch are rejected.
 * - Canonical keys are translated to organisational branch identifiers here,
 *   never in the browser.
 */
export async function parseProposalScopeInput(
  db: Db,
  body: Record<string, unknown>,
): Promise<SubmittedProposalScope | null> {
  if (body.scope !== undefined && typeof body.scope !== "string")
    throw new Error("Choose a single valid proposal scope.");
  if (
    body.originatingBranchId !== undefined &&
    typeof body.originatingBranchId !== "string"
  )
    throw new Error("Choose a single valid proposal scope.");

  const rawScope =
    typeof body.scope === "string" ? body.scope.trim() : "";
  const rawOrigin =
    typeof body.originatingBranchId === "string"
      ? body.originatingBranchId.trim()
      : "";
  if (!rawScope && !rawOrigin) return null;

  if (!rawScope) {
    // Legacy clients submit only an originating branch identifier. Preserve
    // that path while deriving the canonical scope for new records.
    const branch = await db
      .collection("branches")
      .findOne({ branchId: rawOrigin });
    const definition = branch ? geographicScopeForBranch(branch) ?? null : null;
    return {
      key: definition?.key ?? rawOrigin,
      branchId: rawOrigin,
      definition,
      explicitNational: definition?.key === NATIONAL_PROPOSAL_SCOPE.key,
    };
  }

  const submitted = await resolveSubmittedScopeKey(db, rawScope);
  if (rawOrigin) {
    const originBranch = await db
      .collection("branches")
      .findOne({ branchId: rawOrigin });
    const originKey = originBranch
      ? geographicScopeForBranch(originBranch)?.key ??
        String(originBranch.branchId)
      : rawOrigin;
    const requestedKey = submitted.definition?.key ?? submitted.branchId;
    if (originKey !== requestedKey) {
      throw new Error(
        "Choose one proposal scope. National and branch scope cannot both apply.",
      );
    }
  }

  return {
    ...submitted,
    explicitNational: submitted.definition?.key === NATIONAL_PROPOSAL_SCOPE.key,
  };
}
