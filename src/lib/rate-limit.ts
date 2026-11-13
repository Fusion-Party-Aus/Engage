import { createHash, createHmac } from "node:crypto";
import type { Db } from "mongodb";
import type { PlatformEnv } from "./types.ts";
import { logOperationalEvent } from "./resilience.ts";

/**
 * Durable fixed-window rate limiting for abuse-prone unauthenticated actions.
 *
 * The counter lives in MongoDB so every application instance shares the same
 * budget. A per-process memory limiter would let an attacker multiply their
 * allowance by the number of instances and would reset on deploy.
 *
 * Only a keyed hash of the client address is stored. The raw address is never
 * written, logged or returned.
 */

export const RATE_LIMIT_COLLECTION = "rate_limits";

/**
 * Every protected action gets one rule here. Tune in one place; do not scatter
 * limits through route handlers.
 *
 * - `sense-box-submit`: public concern intake; matches the previous 10 per
 *   10 minutes behaviour.
 * - `auth-magic-link`: sign-in link and first-time registration in one step.
 *   The limit bounds outbound email abuse, not ordinary returning members.
 * - `auth-sign-up`: account creation, protected defensively in case password
 *   or email sign-up is enabled later.
 */
export const RATE_LIMITS = {
  "sense-box-submit": { limit: 10, windowMs: 10 * 60_000 },
  "auth-magic-link": { limit: 10, windowMs: 10 * 60_000 },
  "auth-sign-up": { limit: 5, windowMs: 60 * 60_000 },
} as const satisfies Record<string, { limit: number; windowMs: number }>;

export type RateLimitAction = keyof typeof RATE_LIMITS;

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  action: RateLimitAction;
  limit: number;
  remaining: number;
  /** Seconds until the current window closes. Never less than 1. */
  retryAfterSeconds: number;
  windowStart: Date;
  resetAt: Date;
}

export interface ConsumeRateLimitInput {
  action: RateLimitAction;
  /** Raw client address or other stable subject. Hashed before storage. */
  identifier: string;
  now?: number;
  rule?: RateLimitRule;
  env?: Pick<PlatformEnv, "RATE_LIMIT_SECRET" | "BETTER_AUTH_SECRET" | "SESSION_SECRET">;
}

const indexPromises = new WeakMap<object, Promise<unknown>>();

/**
 * TTL cleanup is best effort. The window index is part of the document key, so
 * a late deletion can never grant extra requests in a later window.
 */
function ensureExpiryIndex(db: Db): Promise<unknown> {
  let pending = indexPromises.get(db);
  if (!pending) {
    pending = db
      .collection(RATE_LIMIT_COLLECTION)
      .createIndex(
        { expiresAt: 1 },
        { expireAfterSeconds: 0, name: "rate_limit_expiry" },
      )
      .catch((error) => {
        logOperationalEvent("warn", "rate_limit_index_unavailable", {
          code: error instanceof Error ? error.name : "unknown",
        });
      });
    indexPromises.set(db, pending);
  }
  return pending;
}

export function rateLimitSecret(
  env: Pick<
    PlatformEnv,
    "RATE_LIMIT_SECRET" | "BETTER_AUTH_SECRET" | "SESSION_SECRET"
  > = {},
): string {
  return (
    env.RATE_LIMIT_SECRET ||
    env.BETTER_AUTH_SECRET ||
    env.SESSION_SECRET ||
    "engage-rate-limit-local"
  );
}

let warnedAboutLocalSecret = false;

function warnIfProductionWithoutSecret(
  env: Pick<PlatformEnv, "APP_MODE" | "RATE_LIMIT_SECRET" | "BETTER_AUTH_SECRET" | "SESSION_SECRET"> | undefined,
): void {
  if (warnedAboutLocalSecret || env?.APP_MODE !== "production") return;
  if (env.RATE_LIMIT_SECRET || env.BETTER_AUTH_SECRET || env.SESSION_SECRET) {
    return;
  }
  warnedAboutLocalSecret = true;
  logOperationalEvent("warn", "rate_limit_secret_missing", {
    reason: "configure RATE_LIMIT_SECRET or BETTER_AUTH_SECRET",
  });
}

/**
 * Hash the subject with a deployment secret. A plain digest of an IPv4 address
 * is trivially reversible, so keyed hashing is required wherever practical.
 */
export function hashRateLimitIdentifier(
  identifier: string,
  secret: string,
): string {
  return createHmac("sha256", secret).update(identifier).digest("hex");
}

export function rateLimitDocumentId(
  action: RateLimitAction,
  windowIndex: number,
  identifierHash: string,
): string {
  return createHash("sha256")
    .update(`${action}:${windowIndex}:${identifierHash}`)
    .digest("hex")
    .slice(0, 32);
}

export interface RateLimitDocument {
  _id: string;
  action: RateLimitAction;
  identifierHash: string;
  windowStart: Date;
  expiresAt: Date;
  count: number;
}

/**
 * Consume one slot in the current window.
 *
 * `$inc` is atomic in MongoDB, so concurrent requests on different instances
 * cannot lose a count. A duplicate-key race on first insert is retried once.
 */
export async function consumeRateLimit(
  db: Db,
  input: ConsumeRateLimitInput,
): Promise<RateLimitDecision> {
  const action = input.action;
  const rule = input.rule ?? RATE_LIMITS[action];
  const now = input.now ?? Date.now();
  const windowIndex = Math.floor(now / rule.windowMs);
  const windowStartMs = windowIndex * rule.windowMs;
  const resetAtMs = windowStartMs + rule.windowMs;
  const identifierHash = hashRateLimitIdentifier(
    `${action}:${input.identifier || "unknown"}`,
    rateLimitSecret(input.env),
  );
  const _id = rateLimitDocumentId(action, windowIndex, identifierHash);
  const collection = db.collection<RateLimitDocument>(RATE_LIMIT_COLLECTION);

  warnIfProductionWithoutSecret(input.env);
  await ensureExpiryIndex(db);

  const increment = {
    $inc: { count: 1 },
    $setOnInsert: {
      action,
      identifierHash,
      windowStart: new Date(windowStartMs),
      expiresAt: new Date(resetAtMs),
    },
  };
  let stored: Record<string, any> | null;
  try {
    stored = (await collection.findOneAndUpdate({ _id }, increment, {
      upsert: true,
      returnDocument: "after",
    })) as Record<string, any> | null;
  } catch (error) {
    // Two first requests in the same window can both attempt an upsert.
    if ((error as { code?: number }).code === 11000) {
      stored = (await collection.findOneAndUpdate(
        { _id },
        { $inc: { count: 1 } },
        { returnDocument: "after" },
      )) as Record<string, any> | null;
    } else {
      throw error;
    }
  }

  const count = Number(stored?.count ?? 0) || 1;

  return {
    allowed: count <= rule.limit,
    action,
    limit: rule.limit,
    remaining: Math.max(0, rule.limit - count),
    retryAfterSeconds: Math.max(1, Math.ceil((resetAtMs - now) / 1000)),
    windowStart: new Date(windowStartMs),
    resetAt: new Date(resetAtMs),
  };
}

/**
 * Resolve the client address in the same order the authentication stack trusts:
 * Cloudflare's header, then the reverse proxy's, then the adapter's socket
 * address. Forwarded headers are trusted only because the deployment terminates
 * at Cloudflare and a single reverse proxy.
 */
export function clientAddress(
  request: Request,
  fallback?: string,
): string {
  const headers = request.headers;
  const candidates = [
    headers.get("cf-connecting-ip"),
    headers.get("x-real-ip"),
    headers.get("x-forwarded-for")?.split(",")[0],
    fallback,
  ];
  for (const candidate of candidates) {
    const value = typeof candidate === "string" ? candidate.trim() : "";
    if (value) return value.slice(0, 200);
  }
  return "unknown";
}

/** A 429 response with a plain-language message and a Retry-After header. */
export function rateLimitResponse(
  decision: RateLimitDecision,
  message = "Too many attempts. Please wait a few minutes and try again.",
): Response {
  return Response.json(
    { error: message, code: "RATE_LIMITED" },
    {
      status: 429,
      headers: {
        "cache-control": "private, no-store",
        "retry-after": String(decision.retryAfterSeconds),
      },
    },
  );
}
