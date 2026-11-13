import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { PlatformEnv, VoteChoice } from "./types.ts";

export const BALLOT_ENVELOPE_VERSION = 1 as const;
export const BALLOT_CIPHER_ALG = "aes-256-gcm" as const;

export type BallotEncryptionMode = "off" | "encrypt";

export interface VoteEnvelope {
  v: typeof BALLOT_ENVELOPE_VERSION;
  alg: typeof BALLOT_CIPHER_ALG;
  kid: string;
  iv: string;
  tag: string;
  ct: string;
}

export interface EncryptedVotePayload {
  choice: VoteChoice;
  reason: string;
}

export interface BallotBindingContext {
  ballotId: string;
  proposalId: string;
  revisionId: string;
  amendmentRevisionId?: string;
  voterBlindIndex: string;
}

export interface BallotCryptoConfig {
  mode: BallotEncryptionMode;
  activeEncryptionKeyId: string;
  encryptionKeys: Map<string, Buffer>;
  activeBlindIndexKeyId: string;
  blindIndexKeys: Map<string, Buffer>;
}

export class BallotCryptoError extends Error {
  code: string;
  constructor(message: string, code = "BALLOT_CRYPTO_ERROR") {
    super(message);
    this.name = "BallotCryptoError";
    this.code = code;
  }
}

function decodeKeyMaterial(raw: string, label: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    return Buffer.from(trimmed, "hex");
  }
  const base64 = Buffer.from(trimmed, "base64");
  if (base64.length >= 32) {
    return base64;
  }
  throw new BallotCryptoError(
    `${label} must be 64+ hex characters or base64-encoded 32+ bytes.`,
    "INVALID_KEY_MATERIAL",
  );
}

function parseKeyRing(
  raw: string | undefined,
  label: string,
  exactLength?: number,
): { keys: Map<string, Buffer>; firstId: string | null } {
  const keys = new Map<string, Buffer>();
  let firstId: string | null = null;
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { keys, firstId };

  if (trimmed.startsWith("{")) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      throw new BallotCryptoError(
        `${label} JSON is malformed.`,
        "INVALID_KEY_CONFIG",
      );
    }
    for (const [kid, val] of Object.entries(parsed)) {
      const cleanKid = kid.trim();
      if (!cleanKid || typeof val !== "string") {
        throw new BallotCryptoError(
          `${label} contains an invalid key entry.`,
          "INVALID_KEY_CONFIG",
        );
      }
      const buf = decodeKeyMaterial(val, `${label}[${cleanKid}]`);
      if (exactLength && buf.length !== exactLength) {
        throw new BallotCryptoError(
          `${label}[${cleanKid}] must be exactly ${exactLength} bytes.`,
          "INVALID_KEY_LENGTH",
        );
      }
      if (!exactLength && buf.length < 32) {
        throw new BallotCryptoError(
          `${label}[${cleanKid}] must be at least 32 bytes.`,
          "INVALID_KEY_LENGTH",
        );
      }
      keys.set(cleanKid, buf);
      if (!firstId) firstId = cleanKid;
    }
    return { keys, firstId };
  }

  for (const part of trimmed.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const colon = entry.indexOf(":");
    if (colon <= 0) {
      // Single unnamed key defaults to "v1"
      const buf = decodeKeyMaterial(entry, label);
      if (exactLength && buf.length !== exactLength) {
        throw new BallotCryptoError(
          `${label} must be exactly ${exactLength} bytes.`,
          "INVALID_KEY_LENGTH",
        );
      }
      if (!exactLength && buf.length < 32) {
        throw new BallotCryptoError(
          `${label} must be at least 32 bytes.`,
          "INVALID_KEY_LENGTH",
        );
      }
      keys.set("v1", buf);
      if (!firstId) firstId = "v1";
      continue;
    }
    const kid = entry.slice(0, colon).trim();
    const secret = entry.slice(colon + 1).trim();
    if (!kid || !secret) {
      throw new BallotCryptoError(
        `${label} contains an empty key id or secret.`,
        "INVALID_KEY_CONFIG",
      );
    }
    const buf = decodeKeyMaterial(secret, `${label}[${kid}]`);
    if (exactLength && buf.length !== exactLength) {
      throw new BallotCryptoError(
        `${label}[${kid}] must be exactly ${exactLength} bytes.`,
        "INVALID_KEY_LENGTH",
      );
    }
    if (!exactLength && buf.length < 32) {
      throw new BallotCryptoError(
        `${label}[${kid}] must be at least 32 bytes.`,
        "INVALID_KEY_LENGTH",
      );
    }
    keys.set(kid, buf);
    if (!firstId) firstId = kid;
  }

  return { keys, firstId };
}

export function resolveBallotEncryptionMode(
  env: Partial<PlatformEnv> | Record<string, string | undefined>,
): BallotEncryptionMode {
  const raw = String(env.BALLOT_ENCRYPTION_MODE ?? "")
    .trim()
    .toLowerCase();
  if (!raw || raw === "off" || raw === "plaintext" || raw === "false") {
    return "off";
  }
  if (raw === "encrypt" || raw === "enabled" || raw === "on") {
    return "encrypt";
  }
  throw new BallotCryptoError(
    `Unsupported BALLOT_ENCRYPTION_MODE: '${raw}'.`,
    "INVALID_ENCRYPTION_MODE",
  );
}

/**
 * Load and validate ballot encryption and blind-index keys from environment.
 * Returns `null` when mode is "off" and no keys are configured.
 * Throws `BallotCryptoError` on invalid configuration, key reuse, or missing keys when enabled.
 */
export function loadBallotCryptoConfig(
  env: Partial<PlatformEnv> | Record<string, string | undefined>,
): BallotCryptoConfig | null {
  const mode = resolveBallotEncryptionMode(env);
  const hasAnyKeys = Boolean(
    env.BALLOT_ENCRYPTION_KEYS || env.BALLOT_BLIND_INDEX_KEY,
  );
  if (mode === "off" && !hasAnyKeys) {
    return null;
  }

  const encRing = parseKeyRing(
    env.BALLOT_ENCRYPTION_KEYS,
    "BALLOT_ENCRYPTION_KEYS",
    32,
  );
  const biRing = parseKeyRing(
    env.BALLOT_BLIND_INDEX_KEY,
    "BALLOT_BLIND_INDEX_KEY",
  );

  if (mode === "encrypt" && (encRing.keys.size === 0 || biRing.keys.size === 0)) {
    throw new BallotCryptoError(
      "BALLOT_ENCRYPTION_KEYS and BALLOT_BLIND_INDEX_KEY are required when BALLOT_ENCRYPTION_MODE=encrypt.",
      "MISSING_KEYS",
    );
  }
  if (encRing.keys.size === 0 && biRing.keys.size === 0) {
    return null;
  }

  // Enforce strict key separation between encryption and blind-index keys
  for (const [encKid, encKey] of encRing.keys.entries()) {
    for (const [biKid, biKey] of biRing.keys.entries()) {
      if (encKey.length === biKey.length && timingSafeEqual(encKey, biKey)) {
        throw new BallotCryptoError(
          `Encryption key '${encKid}' and blind-index key '${biKid}' must be distinct.`,
          "KEY_REUSE_FORBIDDEN",
        );
      }
    }
  }

  const activeEncryptionKeyId =
    (env.BALLOT_ENCRYPTION_ACTIVE_KEY_ID ?? "").trim() || encRing.firstId || "";
  if (encRing.keys.size > 0 && !encRing.keys.has(activeEncryptionKeyId)) {
    throw new BallotCryptoError(
      `Active encryption key '${activeEncryptionKeyId}' is not in BALLOT_ENCRYPTION_KEYS.`,
      "MISSING_ACTIVE_KEY",
    );
  }

  const activeBlindIndexKeyId =
    (env.BALLOT_BLIND_INDEX_ACTIVE_KEY_ID ?? "").trim() || biRing.firstId || "";
  if (biRing.keys.size > 0 && !biRing.keys.has(activeBlindIndexKeyId)) {
    throw new BallotCryptoError(
      `Active blind-index key '${activeBlindIndexKeyId}' is not in BALLOT_BLIND_INDEX_KEY.`,
      "MISSING_ACTIVE_KEY",
    );
  }

  return {
    mode,
    activeEncryptionKeyId,
    encryptionKeys: encRing.keys,
    activeBlindIndexKeyId,
    blindIndexKeys: biRing.keys,
  };
}

/**
 * Derive a deterministic, domain-separated HMAC-SHA-256 blind index for `(ballotId, memberId)`.
 * Including `ballotId` prevents cross-ballot correlation from a database-only snapshot.
 */
export function computeVoterBlindIndex(
  key: Buffer,
  ballotId: string,
  memberId: string,
): string {
  const canonicalBallot = ballotId.trim();
  const canonicalMember = memberId.trim();
  if (!canonicalBallot || !canonicalMember) {
    throw new BallotCryptoError(
      "ballotId and memberId are required to compute a blind index.",
      "INVALID_BLIND_INDEX_INPUT",
    );
  }
  return createHmac("sha256", key)
    .update(`engage-vote-blind-index-v1\0${canonicalBallot}\0${canonicalMember}`)
    .digest("hex");
}

export function buildVoteAad(
  kid: string,
  ctx: BallotBindingContext,
): Buffer {
  return Buffer.from(
    [
      `v${BALLOT_ENVELOPE_VERSION}`,
      kid,
      ctx.ballotId,
      ctx.proposalId,
      ctx.revisionId,
      ctx.amendmentRevisionId ?? "",
      ctx.voterBlindIndex,
    ].join("\0"),
    "utf8",
  );
}

export function encryptVotePayload(
  config: BallotCryptoConfig,
  payload: EncryptedVotePayload,
  ctx: BallotBindingContext,
): VoteEnvelope {
  const kid = config.activeEncryptionKeyId;
  const key = config.encryptionKeys.get(kid);
  if (!key) {
    throw new BallotCryptoError(
      `Encryption key '${kid}' is unavailable.`,
      "MISSING_ENCRYPTION_KEY",
    );
  }
  if (!["approve", "abstain", "reject"].includes(payload.choice)) {
    throw new BallotCryptoError("Invalid vote choice.", "INVALID_PAYLOAD");
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv(BALLOT_CIPHER_ALG, key, iv);
  cipher.setAAD(buildVoteAad(kid, ctx));

  const plaintext = Buffer.from(
    JSON.stringify({
      choice: payload.choice,
      reason: typeof payload.reason === "string" ? payload.reason : "",
    }),
    "utf8",
  );
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    v: BALLOT_ENVELOPE_VERSION,
    alg: BALLOT_CIPHER_ALG,
    kid,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ct.toString("base64"),
  };
}

export function decryptVotePayload(
  config: BallotCryptoConfig,
  envelope: VoteEnvelope,
  ctx: BallotBindingContext,
): EncryptedVotePayload {
  if (
    !envelope ||
    envelope.v !== BALLOT_ENVELOPE_VERSION ||
    envelope.alg !== BALLOT_CIPHER_ALG ||
    typeof envelope.kid !== "string" ||
    typeof envelope.iv !== "string" ||
    typeof envelope.tag !== "string" ||
    typeof envelope.ct !== "string"
  ) {
    throw new BallotCryptoError(
      "Malformed vote ciphertext envelope.",
      "MALFORMED_ENVELOPE",
    );
  }

  const key = config.encryptionKeys.get(envelope.kid);
  if (!key) {
    throw new BallotCryptoError(
      `Decryption key '${envelope.kid}' is not configured.`,
      "UNKNOWN_KEY_ID",
    );
  }

  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const ct = Buffer.from(envelope.ct, "base64");
  if (iv.length !== 12 || tag.length !== 16) {
    throw new BallotCryptoError(
      "Invalid AES-GCM IV or authentication tag length.",
      "MALFORMED_ENVELOPE",
    );
  }

  try {
    const decipher = createDecipheriv(BALLOT_CIPHER_ALG, key, iv);
    decipher.setAAD(buildVoteAad(envelope.kid, ctx));
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ct), decipher.final()]);
    const parsed = JSON.parse(decrypted.toString("utf8")) as Record<
      string,
      unknown
    >;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !["approve", "abstain", "reject"].includes(String(parsed.choice))
    ) {
      throw new BallotCryptoError(
        "Decrypted vote payload is invalid.",
        "INVALID_PAYLOAD",
      );
    }
    return {
      choice: parsed.choice as VoteChoice,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
  } catch (err) {
    if (err instanceof BallotCryptoError) throw err;
    throw new BallotCryptoError(
      "Vote ciphertext failed authentication or context binding check.",
      "DECRYPTION_FAILED",
    );
  }
}

export function generateBallotKeyHex(): string {
  return randomBytes(32).toString("hex");
}
