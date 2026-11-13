import type { PermissionKey } from "./rbac.ts";
import type { ProposalKind, ProposalStage } from "./types.ts";

export const MATTER_SCHEMA_VERSION = 2;

export type BuiltinMatterType = "policy" | "resolution";
export type MatterTypeId = BuiltinMatterType | (string & {});

export type MatterCapabilityKey =
  | "supportsDeliberation"
  | "supportsAmendments"
  | "supportsBallots"
  | "supportsRatification"
  | "supportsPolicyPublication"
  | "supportsSupersession";

export interface MatterCapabilities {
  supportsDeliberation: boolean;
  supportsAmendments: boolean;
  supportsBallots: boolean;
  supportsRatification: boolean;
  supportsPolicyPublication: boolean;
  supportsSupersession: boolean;
  allowedStages: readonly ProposalStage[];
  compatibleSupersessionTargets: readonly MatterTypeId[];
}

export interface MatterTransitionRule {
  from: ProposalStage;
  to: ProposalStage;
  requiredPermission: PermissionKey;
  authorityKind: "workflow" | "governance";
  description: string;
}

export interface MatterTypeDefinition {
  type: MatterTypeId;
  label: string;
  pluralLabel: string;
  description: string;
  capabilities: MatterCapabilities;
  transitions: readonly MatterTransitionRule[];
  validateTransition?: (ctx: {
    from: ProposalStage;
    to: ProposalStage;
    hasBallotRevision?: boolean;
  }) => void;
}

export class MatterValidationError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 400, code = "MATTER_VALIDATION_ERROR") {
    super(message);
    this.name = "MatterValidationError";
    this.status = status;
    this.code = code;
  }
}

export class MatterRegistry {
  private readonly definitions = new Map<string, MatterTypeDefinition>();

  register(definition: MatterTypeDefinition): this {
    const key = definition.type.trim().toLowerCase();
    if (!key) {
      throw new MatterValidationError("Matter type identifier cannot be empty.", 400);
    }
    if (this.definitions.has(key)) {
      throw new MatterValidationError(
        `Matter type '${key}' is already registered.`,
        409,
        "MATTER_TYPE_EXISTS",
      );
    }
    this.definitions.set(key, { ...definition, type: key });
    return this;
  }

  has(type: string): boolean {
    return this.definitions.has(type.trim().toLowerCase());
  }

  get(type: string): MatterTypeDefinition | undefined {
    return this.definitions.get(type.trim().toLowerCase());
  }

  list(): MatterTypeDefinition[] {
    return [...this.definitions.values()];
  }
}

const STANDARD_LIFECYCLE_TRANSITIONS: readonly MatterTransitionRule[] = [
  {
    from: "propose",
    to: "deliberate",
    requiredPermission: "proposals.edit",
    authorityKind: "workflow",
    description: "Advance draft matter to member deliberation.",
  },
  {
    from: "propose",
    to: "archived",
    requiredPermission: "proposals.edit",
    authorityKind: "workflow",
    description: "Archive draft matter without voting.",
  },
  {
    from: "deliberate",
    to: "propose",
    requiredPermission: "proposals.edit",
    authorityKind: "workflow",
    description: "Return matter from deliberation to draft.",
  },
  {
    from: "deliberate",
    to: "decide",
    requiredPermission: "proposals.edit",
    authorityKind: "governance",
    description: "Open formal decision ballot.",
  },
  {
    from: "deliberate",
    to: "archived",
    requiredPermission: "proposals.edit",
    authorityKind: "workflow",
    description: "Archive matter from deliberation.",
  },
  {
    from: "decide",
    to: "deliberate",
    requiredPermission: "proposals.edit",
    authorityKind: "workflow",
    description: "Return matter to deliberation.",
  },
  {
    from: "decide",
    to: "implement",
    requiredPermission: "proposals.edit",
    authorityKind: "governance",
    description: "Advance matter after ballot to implementation / outcome.",
  },
  {
    from: "decide",
    to: "archived",
    requiredPermission: "proposals.edit",
    authorityKind: "workflow",
    description: "Archive matter from Decide.",
  },
  {
    from: "implement",
    to: "deliberate",
    requiredPermission: "proposals.edit",
    authorityKind: "workflow",
    description: "Reopen deliberation from implementation.",
  },
  {
    from: "implement",
    to: "propose",
    requiredPermission: "proposals.edit",
    authorityKind: "workflow",
    description: "Return matter from implementation to draft.",
  },
  {
    from: "implement",
    to: "decide",
    requiredPermission: "proposals.edit",
    authorityKind: "governance",
    description: "Reopen decision stage from implementation.",
  },
  {
    from: "implement",
    to: "archived",
    requiredPermission: "proposals.edit",
    authorityKind: "workflow",
    description: "Archive completed matter.",
  },
  {
    from: "archived",
    to: "propose",
    requiredPermission: "proposals.edit",
    authorityKind: "workflow",
    description: "Restore archived matter to Propose.",
  },
  {
    from: "archived",
    to: "deliberate",
    requiredPermission: "proposals.edit",
    authorityKind: "workflow",
    description: "Restore archived matter to Deliberate.",
  },
  {
    from: "archived",
    to: "decide",
    requiredPermission: "proposals.edit",
    authorityKind: "governance",
    description: "Restore archived matter to Decide.",
  },
  {
    from: "archived",
    to: "implement",
    requiredPermission: "proposals.edit",
    authorityKind: "workflow",
    description: "Restore archived matter to Implement.",
  },
];

export const POLICY_MATTER_DEFINITION: MatterTypeDefinition = {
  type: "policy",
  label: "Policy proposal",
  pluralLabel: "Policy proposals",
  description:
    "Substantive party policy platform proposals that can be deliberated, amended, voted on, ratified, and published.",
  capabilities: {
    supportsDeliberation: true,
    supportsAmendments: true,
    supportsBallots: true,
    supportsRatification: true,
    supportsPolicyPublication: true,
    supportsSupersession: true,
    allowedStages: ["propose", "deliberate", "decide", "implement", "archived"],
    compatibleSupersessionTargets: ["policy"],
  },
  transitions: STANDARD_LIFECYCLE_TRANSITIONS,
};

export const RESOLUTION_MATTER_DEFINITION: MatterTypeDefinition = {
  type: "resolution",
  label: "Governance resolution",
  pluralLabel: "Governance resolutions",
  description:
    "Organisational and procedural governance resolutions. Supports deliberation, amendments, and ballots, but never enters the Policy Registry or policy publication.",
  capabilities: {
    supportsDeliberation: true,
    supportsAmendments: true,
    supportsBallots: true,
    supportsRatification: false,
    supportsPolicyPublication: false,
    supportsSupersession: true,
    allowedStages: ["propose", "deliberate", "decide", "implement", "archived"],
    compatibleSupersessionTargets: ["resolution"],
  },
  transitions: STANDARD_LIFECYCLE_TRANSITIONS,
};

export function createMatterRegistry(
  extraDefinitions: MatterTypeDefinition[] = [],
): MatterRegistry {
  const registry = new MatterRegistry()
    .register(POLICY_MATTER_DEFINITION)
    .register(RESOLUTION_MATTER_DEFINITION);
  for (const def of extraDefinitions) {
    registry.register(def);
  }
  return registry;
}

export const DEFAULT_MATTER_REGISTRY = createMatterRegistry();

export function isRegisteredMatterType(
  value: unknown,
  registry: MatterRegistry = DEFAULT_MATTER_REGISTRY,
): value is MatterTypeId {
  return typeof value === "string" && registry.has(value);
}

/**
 * Normalise a matter's `kind` at trust boundaries.
 *
 * - Missing / empty `kind` falls back to legacy ID convention (`GOV-*` -> `resolution`, else `policy`).
 * - Legacy `"governance"` alias maps to `"resolution"`.
 * - Non-empty unknown types are rejected loudly at runtime so invalid matter
 *   types cannot accidentally enter policy workflows.
 */
export function normalizeMatterType(
  value: unknown,
  matterId = "",
  registry: MatterRegistry = DEFAULT_MATTER_REGISTRY,
): MatterTypeId {
  if (value === undefined || value === null || String(value).trim() === "") {
    return matterId.toUpperCase().startsWith("GOV-") ? "resolution" : "policy";
  }
  if (typeof value !== "string") {
    throw new MatterValidationError(
      "Matter type must be a valid string identifier.",
      400,
      "INVALID_MATTER_TYPE",
    );
  }
  const raw = value.trim().toLowerCase();
  if (raw === "proposal") {
    return matterId.toUpperCase().startsWith("GOV-") ? "resolution" : "policy";
  }
  const mapped = raw === "governance" ? "resolution" : raw;
  if (!registry.has(mapped)) {
    throw new MatterValidationError(
      `Unsupported matter type '${value.trim()}'.`,
      400,
      "UNSUPPORTED_MATTER_TYPE",
    );
  }
  return mapped as ProposalKind | MatterTypeId;
}

export function getMatterDefinition(
  matterType: MatterTypeId,
  registry: MatterRegistry = DEFAULT_MATTER_REGISTRY,
): MatterTypeDefinition {
  const normalized = matterType.trim().toLowerCase();
  const def = registry.get(normalized);
  if (!def) {
    throw new MatterValidationError(
      `Unknown matter type '${matterType}'.`,
      400,
      "UNKNOWN_MATTER_TYPE",
    );
  }
  return def;
}

export function matterHasCapability(
  matter: { kind?: string; proposalId?: string; policyId?: string },
  capability: MatterCapabilityKey,
  registry: MatterRegistry = DEFAULT_MATTER_REGISTRY,
): boolean {
  const id = String(matter.proposalId ?? matter.policyId ?? "");
  const matterType = normalizeMatterType(matter.kind, id, registry);
  const def = getMatterDefinition(matterType, registry);
  return Boolean(def.capabilities[capability]);
}

export function assertMatterCapability(
  matter: { kind?: string; proposalId?: string; policyId?: string },
  capability: MatterCapabilityKey,
  actionDescription: string,
  registry: MatterRegistry = DEFAULT_MATTER_REGISTRY,
): MatterTypeDefinition {
  const id = String(matter.proposalId ?? matter.policyId ?? "");
  const matterType = normalizeMatterType(matter.kind, id, registry);
  const def = getMatterDefinition(matterType, registry);
  if (!def.capabilities[capability]) {
    throw new MatterValidationError(
      `${def.label} records do not support ${actionDescription}.`,
      409,
      "UNSUPPORTED_MATTER_CAPABILITY",
    );
  }
  return def;
}

export function validateMatterTransition(
  matterType: MatterTypeId,
  fromStage: ProposalStage,
  toStage: ProposalStage,
  options: {
    registry?: MatterRegistry;
    hasBallotRevision?: boolean;
  } = {},
): MatterTransitionRule | null {
  const registry = options.registry ?? DEFAULT_MATTER_REGISTRY;
  const def = getMatterDefinition(matterType, registry);

  if (!def.capabilities.allowedStages.includes(toStage)) {
    throw new MatterValidationError(
      `${def.label} matters cannot enter lifecycle stage '${toStage}'.`,
      409,
      "STAGE_NOT_ALLOWED_FOR_MATTER_TYPE",
    );
  }
  if (fromStage === toStage) return null;

  if (
    fromStage === "propose" &&
    (toStage === "decide" || toStage === "implement")
  ) {
    throw new MatterValidationError(
      "Proposals in Stage 1 (Propose) must undergo member deliberation before entering Decide or Implement.",
      400,
      "INVALID_STAGE_TRANSITION",
    );
  }
  if (fromStage === "deliberate" && toStage === "implement") {
    throw new MatterValidationError(
      "Proposals in Stage 2 (Deliberate) must be voted on in the Decide stage before entering Implement.",
      400,
      "INVALID_STAGE_TRANSITION",
    );
  }

  const rule = def.transitions.find(
    (entry) => entry.from === fromStage && entry.to === toStage,
  );
  if (!rule) {
    throw new MatterValidationError(
      `Transition from '${fromStage}' to '${toStage}' is not permitted for ${def.label} matters.`,
      409,
      "INVALID_STAGE_TRANSITION",
    );
  }

  def.validateTransition?.({
    from: fromStage,
    to: toStage,
    hasBallotRevision: options.hasBallotRevision,
  });

  return rule;
}
