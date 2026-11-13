import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { logOperationalEvent } from "./resilience.ts";

/**
 * Underground CRM integration boundary.
 *
 * The CRM is authoritative for the person record, organisational membership and
 * electorate fields. Engage is authoritative for account identity, platform
 * membership status, branch participation, roles, ballots and votes.
 *
 * Nothing in this module writes to the CRM. The CRM API is read-only and the
 * durable link stored here uses the CRM person UUID, never the email address.
 */

export const CRM_IDENTITY_LINKS = "crm_identity_links";
export const CRM_APPLICATION = "underground-crm";
export const CRM_MEMBERSHIP_SOURCE = "underground-crm";
export const MINIMUM_CRM_TOKEN_LENGTH = 32;
export const DEFAULT_CRM_TIMEOUT_MS = 10_000;
export const MAXIMUM_CRM_TIMEOUT_MS = 60_000;

export type CrmMembershipStatus = "active" | "expired" | "suspended";

export interface CrmMembershipFact {
  id: string;
  type_id: string;
  type_name: string;
  started_at: string;
  expires_on: string | null;
  suspended_at: string | null;
  status: CrmMembershipStatus;
  is_active: boolean;
}

export interface CrmPerson {
  id: string;
  email: string;
  email_is_bad: boolean | null;
  first_name: string;
  last_name: string;
  preferred_name: string;
  full_name: string;
  record_type: "person" | "organisation";
  is_active: boolean;
  is_deceased: boolean;
  federal_district: string;
  state_upper_district: string;
  state_lower_district: string;
  council_district: string;
  ward: string;
  updated_at: string;
  memberships: CrmMembershipFact[];
}

export interface CrmIdentityLink {
  linkId: string;
  memberId: string;
  crmPersonId: string;
  application: string;
  linkMethod: "verified-email";
  emailAtLink: string;
  linkedAt: Date;
  lastCheckedAt: Date | null;
  lastOutcome: string;
  nextCheckAt: Date | null;
  status: "active" | "retired";
  crmUpdatedAt: string;
}

export interface UndergroundCrmConfig {
  baseUrl: string;
  token: string;
  fusionMembershipTypeIds: Set<string>;
  electorateBranchMap: Map<string, Map<string, string>>;
  timeoutMs: number;
}

export type ElectorateField =
  | "federal_district"
  | "state_upper_district"
  | "state_lower_district"
  | "council_district"
  | "ward";

const ELECTORATE_FIELDS: ElectorateField[] = [
  "federal_district",
  "state_upper_district",
  "state_lower_district",
  "council_district",
  "ward",
];

export class CrmConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrmConfigurationError";
  }
}

export class CrmUnavailableError extends Error {
  constructor(message = "Underground CRM is unavailable.") {
    super(message);
    this.name = "CrmUnavailableError";
  }
}

export class CrmAuthorizationError extends Error {
  constructor(message = "Underground CRM rejected the integration credential.") {
    super(message);
    this.name = "CrmAuthorizationError";
  }
}

export class CrmRequestError extends Error {
  constructor(message = "Underground CRM returned an invalid response.") {
    super(message);
    this.name = "CrmRequestError";
  }
}

function envValue(env: Record<string, string | undefined>, key: string): string {
  return String(env[key] ?? "").trim();
}

export function crmVerificationEnabled(
  env: Record<string, string | undefined>,
): boolean {
  return envValue(env, "ENGAGE_CRM_VERIFICATION_ENABLED").toLowerCase() === "true";
}

export function normaliseElectorate(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function readUndergroundCrmConfig(
  env: Record<string, string | undefined>,
): UndergroundCrmConfig {
  const rawBaseUrl = envValue(env, "ENGAGE_CRM_BASE_URL");
  const token = envValue(env, "ENGAGE_CRM_TOKEN");
  const rawFusionTypeIds = envValue(
    env,
    "ENGAGE_CRM_FUSION_MEMBERSHIP_TYPE_IDS",
  );
  const singleFusionTypeId = envValue(
    env,
    "ENGAGE_CRM_FUSION_MEMBERSHIP_TYPE_ID",
  );
  const fusionMembershipTypeIds = new Set<string>();
  if (rawFusionTypeIds) {
    let parsed: unknown;
    try {
      parsed = rawFusionTypeIds.startsWith("[")
        ? JSON.parse(rawFusionTypeIds)
        : rawFusionTypeIds.split(",").map((item) => item.trim());
    } catch {
      throw new CrmConfigurationError(
        "ENGAGE_CRM_FUSION_MEMBERSHIP_TYPE_IDS must be a JSON array or comma-separated list.",
      );
    }
    if (!Array.isArray(parsed)) {
      throw new CrmConfigurationError(
        "ENGAGE_CRM_FUSION_MEMBERSHIP_TYPE_IDS must be a JSON array or comma-separated list.",
      );
    }
    for (const value of parsed) {
      if (typeof value === "string" && value.trim()) {
        fusionMembershipTypeIds.add(value.trim());
      }
    }
  } else if (singleFusionTypeId) {
    fusionMembershipTypeIds.add(singleFusionTypeId);
  }
  if (!rawBaseUrl) {
    throw new CrmConfigurationError(
      "ENGAGE_CRM_BASE_URL is required for membership verification.",
    );
  }
  if (!token) {
    throw new CrmConfigurationError(
      "ENGAGE_CRM_TOKEN is required for membership verification.",
    );
  }
  if (token.length < MINIMUM_CRM_TOKEN_LENGTH) {
    throw new CrmConfigurationError(
      `ENGAGE_CRM_TOKEN must be at least ${MINIMUM_CRM_TOKEN_LENGTH} characters.`,
    );
  }
  if (fusionMembershipTypeIds.size === 0) {
    throw new CrmConfigurationError(
      "ENGAGE_CRM_FUSION_MEMBERSHIP_TYPE_ID or ENGAGE_CRM_FUSION_MEMBERSHIP_TYPE_IDS is required for automatic verification.",
    );
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(rawBaseUrl);
  } catch {
    throw new CrmConfigurationError("ENGAGE_CRM_BASE_URL is not a valid URL.");
  }
  if (!["http:", "https:"].includes(baseUrl.protocol)) {
    throw new CrmConfigurationError(
      "ENGAGE_CRM_BASE_URL must use http or https.",
    );
  }

  const rawMap = envValue(env, "ENGAGE_CRM_ELECTORATE_BRANCH_MAP");
  let mappingPayload: unknown = {};
  if (rawMap) {
    try {
      mappingPayload = JSON.parse(rawMap);
    } catch {
      throw new CrmConfigurationError(
        "ENGAGE_CRM_ELECTORATE_BRANCH_MAP must be valid JSON.",
      );
    }
  }
  if (
    mappingPayload === null ||
    typeof mappingPayload !== "object" ||
    Array.isArray(mappingPayload)
  ) {
    throw new CrmConfigurationError(
      "ENGAGE_CRM_ELECTORATE_BRANCH_MAP must be a JSON object.",
    );
  }
  const electorateBranchMap = new Map<string, Map<string, string>>();
  for (const [rawField, rawValues] of Object.entries(
    mappingPayload as Record<string, unknown>,
  )) {
    if (!ELECTORATE_FIELDS.includes(rawField as ElectorateField)) {
      throw new CrmConfigurationError(
        `ENGAGE_CRM_ELECTORATE_BRANCH_MAP contains unknown field ${rawField}.`,
      );
    }
    if (
      rawValues === null ||
      typeof rawValues !== "object" ||
      Array.isArray(rawValues)
    ) {
      throw new CrmConfigurationError(
        `ENGAGE_CRM_ELECTORATE_BRANCH_MAP.${rawField} must be an object.`,
      );
    }
    const values = new Map<string, string>();
    for (const [rawValue, rawBranchId] of Object.entries(
      rawValues as Record<string, unknown>,
    )) {
      const branchId = typeof rawBranchId === "string" ? rawBranchId.trim() : "";
      if (!branchId) {
        throw new CrmConfigurationError(
          `ENGAGE_CRM_ELECTORATE_BRANCH_MAP.${rawField} has an empty branch.`,
        );
      }
      values.set(normaliseElectorate(rawValue), branchId);
    }
    electorateBranchMap.set(rawField, values);
  }

  const rawTimeout = envValue(env, "ENGAGE_CRM_TIMEOUT_MS");
  const timeoutMs = rawTimeout ? Number(rawTimeout) : DEFAULT_CRM_TIMEOUT_MS;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    timeoutMs > MAXIMUM_CRM_TIMEOUT_MS
  ) {
    throw new CrmConfigurationError(
      `ENGAGE_CRM_TIMEOUT_MS must be an integer from 1000 to ${MAXIMUM_CRM_TIMEOUT_MS}.`,
    );
  }

  return {
    baseUrl: `${baseUrl.origin}${baseUrl.pathname.replace(/\/+$/, "")}`,
    token,
    fusionMembershipTypeIds,
    electorateBranchMap,
    timeoutMs,
  };
}

function peopleUrl(config: UndergroundCrmConfig, suffix = ""): URL {
  const base = config.baseUrl.endsWith("/")
    ? config.baseUrl
    : `${config.baseUrl}/`;
  return new URL(`api/integrations/v1/people/${suffix}`, base);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseMembership(raw: unknown): CrmMembershipFact {
  if (
    !isRecord(raw) ||
    typeof raw.id !== "string" ||
    typeof raw.type_id !== "string" ||
    typeof raw.is_active !== "boolean" ||
    typeof raw.status !== "string"
  ) {
    throw new CrmRequestError("Underground CRM returned an invalid membership.");
  }
  return {
    id: raw.id,
    type_id: raw.type_id,
    type_name: typeof raw.type_name === "string" ? raw.type_name : "",
    started_at: typeof raw.started_at === "string" ? raw.started_at : "",
    expires_on: typeof raw.expires_on === "string" ? raw.expires_on : null,
    suspended_at:
      typeof raw.suspended_at === "string" ? raw.suspended_at : null,
    status: raw.status as CrmMembershipStatus,
    is_active: raw.is_active,
  };
}

function parsePerson(raw: unknown): CrmPerson {
  if (
    !isRecord(raw) ||
    typeof raw.id !== "string" ||
    typeof raw.email !== "string" ||
    !Array.isArray(raw.memberships)
  ) {
    throw new CrmRequestError("Underground CRM returned an invalid person.");
  }
  return {
    id: raw.id,
    email: raw.email,
    email_is_bad:
      typeof raw.email_is_bad === "boolean" ? raw.email_is_bad : null,
    first_name: typeof raw.first_name === "string" ? raw.first_name : "",
    last_name: typeof raw.last_name === "string" ? raw.last_name : "",
    preferred_name:
      typeof raw.preferred_name === "string" ? raw.preferred_name : "",
    full_name: typeof raw.full_name === "string" ? raw.full_name : "",
    record_type: raw.record_type === "organisation" ? "organisation" : "person",
    is_active: raw.is_active !== false,
    is_deceased: raw.is_deceased === true,
    federal_district:
      typeof raw.federal_district === "string" ? raw.federal_district : "",
    state_upper_district:
      typeof raw.state_upper_district === "string"
        ? raw.state_upper_district
        : "",
    state_lower_district:
      typeof raw.state_lower_district === "string"
        ? raw.state_lower_district
        : "",
    council_district:
      typeof raw.council_district === "string" ? raw.council_district : "",
    ward: typeof raw.ward === "string" ? raw.ward : "",
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : "",
    memberships: raw.memberships.map(parseMembership),
  };
}

async function requestJson(
  url: URL,
  config: UndergroundCrmConfig,
  fetchImpl: typeof fetch,
): Promise<unknown | null> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${config.token}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch {
    throw new CrmUnavailableError();
  }

  if (response.status === 404) return null;
  if (response.status === 401 || response.status === 403) {
    throw new CrmAuthorizationError();
  }
  if (response.status === 429 || response.status >= 500) {
    throw new CrmUnavailableError();
  }
  if (!response.ok) {
    throw new CrmRequestError(
      `Underground CRM returned HTTP ${response.status}.`,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new CrmRequestError("Underground CRM did not return valid JSON.");
  }
}

function parsePersonList(payload: unknown): CrmPerson[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new CrmRequestError("Underground CRM returned an invalid people list.");
  }
  return payload.data.map(parsePerson);
}

export function isActiveFusionMembership(
  person: CrmPerson,
  membershipTypeIds: ReadonlySet<string>,
): CrmMembershipFact | null {
  const facts = person.memberships
    .filter((membership) => membershipTypeIds.has(membership.type_id))
    .sort(
      (left, right) =>
        Date.parse(right.started_at) - Date.parse(left.started_at),
    );
  return facts.find((membership) => membership.is_active) ?? null;
}

export function fusionMembershipState(
  person: CrmPerson,
  membershipTypeIds: ReadonlySet<string>,
): "active" | "inactive" | "missing" {
  const facts = person.memberships.filter((membership) =>
    membershipTypeIds.has(membership.type_id),
  );
  if (facts.length === 0) return "missing";
  return facts.some((membership) => membership.is_active)
    ? "active"
    : "inactive";
}

export function isEligibleCrmPerson(person: CrmPerson): boolean {
  return (
    person.record_type === "person" &&
    person.is_active &&
    !person.is_deceased &&
    person.email_is_bad !== true
  );
}

export interface ElectorateResolution {
  branchId: string | null;
  reason: "resolved" | "unmapped" | "ambiguous";
  candidates: string[];
}

/**
 * Resolve a geographic branch from the CRM's existing electorate fields using
 * the deployment's Engage-owned mapping. MembershipType is never used here.
 */
export function resolveElectorateBranch(
  config: UndergroundCrmConfig,
  person: CrmPerson,
): ElectorateResolution {
  const candidates = new Set<string>();
  for (const field of ELECTORATE_FIELDS) {
    const rawValue = person[field];
    if (!rawValue) continue;
    const mapped = config.electorateBranchMap
      .get(field)
      ?.get(normaliseElectorate(rawValue));
    if (mapped) candidates.add(mapped);
  }
  const branchIds = [...candidates];
  if (branchIds.length === 0) {
    return { branchId: null, reason: "unmapped", candidates: [] };
  }
  if (branchIds.length > 1) {
    return { branchId: null, reason: "ambiguous", candidates: branchIds };
  }
  return { branchId: branchIds[0]!, reason: "resolved", candidates: branchIds };
}

export async function fetchCrmPersonByEmail(
  config: UndergroundCrmConfig,
  email: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CrmPerson[]> {
  const url = peopleUrl(config);
  url.searchParams.set("email", email.trim());
  const payload = await requestJson(url, config, fetchImpl);
  return payload === null ? [] : parsePersonList(payload);
}

export async function fetchCrmPersonById(
  config: UndergroundCrmConfig,
  crmPersonId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CrmPerson | null> {
  const payload = await requestJson(
    peopleUrl(config, `${encodeURIComponent(crmPersonId)}/`),
    config,
    fetchImpl,
  );
  if (payload === null) return null;
  if (!isRecord(payload) || !isRecord(payload.data)) {
    throw new CrmRequestError("Underground CRM returned an invalid person.");
  }
  return parsePerson(payload.data);
}

export async function findIdentityLink(
  db: Db,
  memberId: string,
): Promise<CrmIdentityLink | null> {
  return db
    .collection<CrmIdentityLink>(CRM_IDENTITY_LINKS)
    .findOne({ memberId, application: CRM_APPLICATION });
}

export async function createIdentityLink(
  db: Db,
  input: {
    memberId: string;
    person: CrmPerson;
    now: Date;
  },
): Promise<CrmIdentityLink> {
  const link: CrmIdentityLink = {
    linkId: randomUUID(),
    memberId: input.memberId,
    crmPersonId: input.person.id,
    application: CRM_APPLICATION,
    linkMethod: "verified-email",
    emailAtLink: input.person.email.trim().toLowerCase(),
    linkedAt: input.now,
    lastCheckedAt: null,
    lastOutcome: "linked",
    nextCheckAt: null,
    status: "active",
    crmUpdatedAt: input.person.updated_at,
  };
  try {
    await db
      .collection<CrmIdentityLink>(CRM_IDENTITY_LINKS)
      .updateOne(
        { memberId: input.memberId, application: CRM_APPLICATION },
        { $setOnInsert: link },
        { upsert: true },
      );
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    logOperationalEvent("warn", "crm_identity_link_conflict", {
      reason: "concurrent-link",
    });
  }
  const stored = await findIdentityLink(db, input.memberId);
  if (!stored) {
    throw new CrmRequestError("The CRM identity link could not be stored.");
  }
  return stored;
}

export async function touchIdentityLink(
  db: Db,
  memberId: string,
  input: {
    now: Date;
    outcome: string;
    crmUpdatedAt?: string;
    nextCheckAt?: Date | null;
  },
): Promise<void> {
  await db.collection<CrmIdentityLink>(CRM_IDENTITY_LINKS).updateOne(
    { memberId, application: CRM_APPLICATION },
    {
      $set: {
        lastCheckedAt: input.now,
        lastOutcome: input.outcome,
        ...(input.nextCheckAt !== undefined
          ? { nextCheckAt: input.nextCheckAt }
          : {}),
        ...(input.crmUpdatedAt ? { crmUpdatedAt: input.crmUpdatedAt } : {}),
      },
    },
  );
}
