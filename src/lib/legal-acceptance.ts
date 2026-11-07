import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import {
  privacyPolicy,
  termsOfUse,
  type LegalDocument,
} from "../data/legal-documents.ts";
import type { PlatformEnv, SessionUser } from "./types.ts";

export const LEGAL_ACCEPTANCE_COLLECTION = "legal_acceptances";
export const LEGAL_ACCEPTANCE_FLAG = "LEGAL_ACCEPTANCE_ENABLED";

export type LegalAcceptanceEnv = PlatformEnv & {
  LEGAL_ACCEPTANCE_ENABLED?: string;
};

export interface LegalAcceptanceManifest {
  enabled: boolean;
  termsVersion: string;
  termsHash: string;
  termsEffectiveDate: string;
  privacyVersion: string;
  privacyHash: string;
  privacyEffectiveDate: string;
}

export interface LegalAcceptanceRecord {
  acceptanceId: string;
  memberId: string;
  termsVersion: string;
  termsHash: string;
  privacyVersion: string;
  privacyHash: string;
  termsAccepted: true;
  privacyAcknowledged: true;
  acceptedAt: Date;
}

export interface LegalAcceptanceStatus {
  enabled: boolean;
  accepted: boolean;
  required: boolean;
  terms: {
    version: string;
    effectiveDate: string;
    href: string;
  };
  privacy: {
    version: string;
    effectiveDate: string;
    href: string;
  };
}

export class LegalAcceptanceError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "LegalAcceptanceError";
    this.status = status;
    this.code = code;
  }
}

/** Stable hash of the operative wording and version metadata. */
export function legalDocumentHash(document: LegalDocument): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        slug: document.slug,
        title: document.title,
        description: document.description,
        version: document.version,
        effectiveDate: document.effectiveDate,
        sections: document.sections,
      }),
    )
    .digest("hex");
}

function hasPublishedDate(value: string): boolean {
  return !/^(to be set|not yet set|pending)/i.test(value.trim());
}

function isPublished(document: LegalDocument): boolean {
  return (
    document.publicationStatus === "published" &&
    hasPublishedDate(document.effectiveDate)
  );
}

/**
 * Build the manifest that the server will accept. The gate remains disabled
 * until both documents are marked published, have a real effective date, and
 * LEGAL_ACCEPTANCE_ENABLED is explicitly true.
 */
export function buildLegalAcceptanceManifest(
  env: LegalAcceptanceEnv = {},
  terms: LegalDocument = termsOfUse,
  privacy: LegalDocument = privacyPolicy,
): LegalAcceptanceManifest {
  return {
    enabled:
      String(env.LEGAL_ACCEPTANCE_ENABLED ?? "")
        .trim()
        .toLowerCase() === "true" &&
      isPublished(terms) &&
      isPublished(privacy),
    termsVersion: terms.version,
    termsHash: legalDocumentHash(terms),
    termsEffectiveDate: terms.effectiveDate,
    privacyVersion: privacy.version,
    privacyHash: legalDocumentHash(privacy),
    privacyEffectiveDate: privacy.effectiveDate,
  };
}

function acceptanceId(memberId: string, manifest: LegalAcceptanceManifest) {
  return `legal:${memberId}:${manifest.termsHash}:${manifest.privacyHash}`;
}

export async function ensureLegalAcceptanceIndex(db: Db): Promise<void> {
  await db
    .collection(LEGAL_ACCEPTANCE_COLLECTION)
    .createIndex(
      { acceptanceId: 1 },
      { unique: true, name: "legal_acceptance_unique" },
    )
    .catch(() => {});
  await db
    .collection(LEGAL_ACCEPTANCE_COLLECTION)
    .createIndex({ memberId: 1, acceptedAt: -1 })
    .catch(() => {});
}

export async function findCurrentLegalAcceptance(
  db: Db,
  memberId: string,
  manifest: LegalAcceptanceManifest,
): Promise<LegalAcceptanceRecord | null> {
  const record = await db
    .collection(LEGAL_ACCEPTANCE_COLLECTION)
    .findOne({ acceptanceId: acceptanceId(memberId, manifest) });
  return (record as LegalAcceptanceRecord | null) ?? null;
}

export async function hasCurrentLegalAcceptance(
  db: Db,
  memberId: string,
  manifest: LegalAcceptanceManifest,
): Promise<boolean> {
  return Boolean(await findCurrentLegalAcceptance(db, memberId, manifest));
}

export async function recordLegalAcceptance(
  db: Db,
  input: {
    memberId: string;
    termsAccepted: boolean;
    privacyAcknowledged: boolean;
    manifest: LegalAcceptanceManifest;
    acceptedAt?: Date;
  },
): Promise<LegalAcceptanceRecord> {
  if (!input.manifest.enabled) {
    throw new LegalAcceptanceError(
      "Legal acceptance is not active for the current documents.",
      409,
      "LEGAL_ACCEPTANCE_NOT_ACTIVE",
    );
  }
  if (!input.termsAccepted || !input.privacyAcknowledged) {
    throw new LegalAcceptanceError(
      "Agreement to the Terms of Use and acknowledgement of the Privacy Policy are both required.",
      400,
      "LEGAL_ACCEPTANCE_INCOMPLETE",
    );
  }

  const record: LegalAcceptanceRecord = {
    acceptanceId: acceptanceId(input.memberId, input.manifest),
    memberId: input.memberId,
    termsVersion: input.manifest.termsVersion,
    termsHash: input.manifest.termsHash,
    privacyVersion: input.manifest.privacyVersion,
    privacyHash: input.manifest.privacyHash,
    termsAccepted: true,
    privacyAcknowledged: true,
    acceptedAt: input.acceptedAt ?? new Date(),
  };

  await ensureLegalAcceptanceIndex(db);
  try {
    await db
      .collection(LEGAL_ACCEPTANCE_COLLECTION)
      .updateOne(
        { acceptanceId: record.acceptanceId },
        { $setOnInsert: record },
        { upsert: true },
      );
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
  }

  return (
    (await findCurrentLegalAcceptance(db, input.memberId, input.manifest)) ??
    record
  );
}

export async function legalAcceptanceStatus(
  db: Db,
  memberId: string,
  manifest: LegalAcceptanceManifest,
): Promise<LegalAcceptanceStatus> {
  const accepted =
    manifest.enabled &&
    (await hasCurrentLegalAcceptance(db, memberId, manifest));
  return {
    enabled: manifest.enabled,
    accepted,
    required: manifest.enabled && !accepted,
    terms: {
      version: manifest.termsVersion,
      effectiveDate: manifest.termsEffectiveDate,
      href: "/terms/",
    },
    privacy: {
      version: manifest.privacyVersion,
      effectiveDate: manifest.privacyEffectiveDate,
      href: "/privacy/",
    },
  };
}

/**
 * Use this in participation endpoints after authenticating the member and
 * before writing a vote, comment, proposal, amendment or endorsement.
 * Returns null when the gate is inactive or the member has accepted the
 * current versions; otherwise returns a ready-to-return 403 response.
 */
export async function requireLegalAcceptance(
  db: Db,
  user: Pick<SessionUser, "memberId">,
  env: LegalAcceptanceEnv,
  manifest: LegalAcceptanceManifest = buildLegalAcceptanceManifest(env),
): Promise<Response | null> {
  if (!manifest.enabled) return null;
  if (await hasCurrentLegalAcceptance(db, user.memberId, manifest)) return null;

  return Response.json(
    {
      error:
        "You must accept the current Terms of Use and acknowledge the Privacy Policy before participating.",
      code: "LEGAL_ACCEPTANCE_REQUIRED",
      termsVersion: manifest.termsVersion,
      privacyVersion: manifest.privacyVersion,
    },
    {
      status: 403,
      headers: { "cache-control": "private, no-store" },
    },
  );
}
