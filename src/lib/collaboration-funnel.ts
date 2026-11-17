import type { Db } from "mongodb";

/**
 * Aggregate funnel counts for a collaboration invitation.
 *
 * Four stages, counted as events, never as people:
 *
 * - `view`: the invitation page was rendered in a browser that runs scripts;
 * - `start`: the first interaction with a form field;
 * - `submitted`: a contribution was accepted (recorded by the server, not the
 *   browser, so a failed request is never counted);
 * - `account_intent`: the optional account step was opened from the success screen.
 *
 * Store nothing that could identify a visitor. No cookie, no session, no IP, no
 * typed content. A day bucket and a count are the whole record. The counts are
 * therefore useful for drop-off, not for attribution.
 */

export const FUNNEL_STAGES = ["view", "start", "submitted", "account_intent"] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

/** Client-reported stages. `submitted` is written by the server only. */
export const CLIENT_FUNNEL_STAGES: readonly FunnelStage[] = ["view", "start", "account_intent"];

export const FUNNEL_COLLECTION = "collaboration_funnel";
export const FUNNEL_WINDOW_DAYS = 30;
const RETENTION_DAYS = 400;

export function isClientFunnelStage(value: unknown): value is FunnelStage {
  return typeof value === "string" && CLIENT_FUNNEL_STAGES.includes(value as FunnelStage);
}

/** UTC day bucket. A local day would make counts depend on server timezone. */
export function funnelDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export async function recordFunnelEvent(
  db: Db,
  initiativeSlug: string,
  stage: FunnelStage,
  now: Date = new Date(),
): Promise<void> {
  const day = funnelDay(now);
  const expiresAt = new Date(now.getTime() + RETENTION_DAYS * 86_400_000);
  await db.collection(FUNNEL_COLLECTION).updateOne(
    { initiativeSlug, day, stage },
    { $inc: { count: 1 }, $set: { expiresAt } },
    { upsert: true },
  );
}

export interface FunnelSummary {
  windowDays: number;
  stages: Record<FunnelStage, number>;
  /** Percentages rounded to whole numbers, zero where the denominator is zero. */
  rates: {
    startedOfViewed: number;
    submittedOfStarted: number;
    accountIntentOfSubmitted: number;
  };
}

function percent(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

export async function readFunnelSummary(
  db: Db,
  initiativeSlug: string,
  options: { now?: Date; days?: number } = {},
): Promise<FunnelSummary> {
  const days = options.days ?? FUNNEL_WINDOW_DAYS;
  const now = options.now ?? new Date();
  const from = funnelDay(new Date(now.getTime() - (days - 1) * 86_400_000));
  const to = funnelDay(now);
  const rows = await db
    .collection(FUNNEL_COLLECTION)
    .find({ initiativeSlug, day: { $gte: from, $lte: to } })
    .project({ _id: 0, stage: 1, count: 1 })
    .toArray();
  const stages: Record<FunnelStage, number> = {
    view: 0,
    start: 0,
    submitted: 0,
    account_intent: 0,
  };
  for (const row of rows) {
    if (Object.hasOwn(stages, row.stage)) {
      stages[row.stage as FunnelStage] += Number(row.count ?? 0);
    }
  }
  return {
    windowDays: days,
    stages,
    rates: {
      startedOfViewed: percent(stages.start, stages.view),
      submittedOfStarted: percent(stages.submitted, stages.start),
      accountIntentOfSubmitted: percent(stages.account_intent, stages.submitted),
    },
  };
}

/** Validation for the public event endpoint. Pure, so it can be unit tested. */
export function parseFunnelEvent(
  body: unknown,
): { initiativeSlug: string; stage: FunnelStage } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Could not read the event." };
  }
  const record = body as Record<string, unknown>;
  const initiativeSlug = record.initiativeSlug;
  const stage = record.stage;
  if (typeof initiativeSlug !== "string" || !/^[a-z0-9-]{1,120}$/.test(initiativeSlug)) {
    return { error: "Could not read the event." };
  }
  if (!isClientFunnelStage(stage)) {
    return { error: "Could not read the event." };
  }
  // Only the two fields above are read. Anything else is ignored, never stored.
  return { initiativeSlug, stage };
}
