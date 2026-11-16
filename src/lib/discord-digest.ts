import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import type { PlatformEnv } from "./types.ts";
import { ballotExpired } from "./ballot-deadline.ts";
import {
  ballotTallyKey,
  readBallotTallyProjections,
} from "./ballot-tallies.ts";
import { emailOrigin } from "./engagement-email.ts";
import { canViewProposal, listProposals } from "./store.ts";
import { proposalBallotId } from "./vote-storage.ts";

const DAY = 86_400_000;
const MAX_ITEMS = 5;
const DISCORD_DIGEST_RUNS = "discord_digest_runs";

export type DigestStage = "deliberate" | "decide";
export interface DigestCandidate {
  proposalId: string;
  title: string;
  slug: string;
  stage: DigestStage;
  createdAt: Date;
  commentCount: number;
  /** Null means an authoritative, credible aggregate is unavailable. */
  participation: number | null;
  closesAt: Date | null;
  /** Weekly digests in which this item was previously featured. */
  exposures: number;
  lastFeaturedAt: Date | null;
}

export interface RankedCandidate extends DigestCandidate {
  attentionScore: number;
}

export interface DiscordDigestPreview {
  weekKey: string;
  candidates: RankedCandidate[];
  content: string;
}

export interface DiscordDigestResult {
  status: "disabled" | "already-attempted" | "empty" | "sent" | "held";
  featured: number;
}

function validDate(value: unknown): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : null;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** ISO Monday in Melbourne, even across DST. The same week always has one key. */
export function melbourneWeekKey(now: Date): string {
  const localDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const [year, month, day] = localDate.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day, 12));
  const sinceMonday = (utc.getUTCDay() + 6) % 7;
  utc.setUTCDate(utc.getUTCDate() - sinceMonday);
  return utc.toISOString().slice(0, 10);
}

/**
 * Attention Debt: rank by lack of participation, with a cost for repeated
 * exposure. All inaugural proposals opened together, so creation timestamps
 * must NOT distort their priority. A future age-based model would require
 * trustworthy stage-entry timestamps and a separately versioned rollout.
 *
 * No title, subject, author, branch, voting choice or policy position enters
 * the score. This distributes opportunities to take part, not voting outcomes.
 */
export function attentionScore(candidate: DigestCandidate, now: Date): number {
  // A missing/stale aggregate is *unknown*, not evidence of zero votes.
  // For such ballots, use a conservative fallback informed by discussion.
  const quiet = candidate.stage === "decide"
    ? candidate.participation === null
      ? 0.5 / Math.sqrt(1 + Math.max(0, candidate.commentCount))
      : 1 / Math.sqrt(1 + Math.max(0, candidate.participation))
    : 1 / Math.sqrt(1 + Math.max(0, candidate.commentCount));
  const exposureDebt = 1 / (1 + Math.max(0, candidate.exposures) * 1.5);
  const daysLeft = candidate.closesAt
    ? (candidate.closesAt.getTime() - now.getTime()) / DAY
    : Infinity;
  const urgency = candidate.stage === "decide" && daysLeft >= 0
    ? daysLeft <= 7 ? 1 : daysLeft <= 14 ? 0.5 : 0
    : 0;
  const daysSinceFeatured = candidate.lastFeaturedAt
    ? (now.getTime() - candidate.lastFeaturedAt.getTime()) / DAY
    : Infinity;
  const cooldown = daysSinceFeatured < 14 ? 0.15 : 1;
  return Math.round(
    (65 * quiet + 25 * exposureDebt + 10 * urgency) *
      cooldown * 100,
  ) / 100;
}

/** Stable pseudo-random exploration: reproducible for auditing and previews. */
function draw(seed: string, id: string): number {
  const hex = createHash("sha256").update(`${seed}:${id}`).digest("hex");
  return (parseInt(hex.slice(0, 12), 16) + 1) / (0x1_0000_0000_0000 + 1);
}

/**
 * Two deliberations, two ballots, then one exploratory wildcard where possible.
 * Weighted sampling among the high-attention-debt half provides rotation without
 * systematically promoting busy proposals. No proposal is shown twice.
 */
export function selectDiscordDigest(
  candidates: DigestCandidate[],
  now: Date,
  weekKey: string = melbourneWeekKey(now),
): RankedCandidate[] {
  const ranked = candidates
    .filter((candidate) =>
      candidate.stage === "deliberate" ||
      (candidate.stage === "decide" &&
        (!candidate.closesAt || candidate.closesAt > now)),
    )
    .map((candidate) => ({
      ...candidate,
      attentionScore: attentionScore(candidate, now),
    }));
  const used = new Set<string>();
  const selected: RankedCandidate[] = [];

  function pick(pool: RankedCandidate[], slot: string): void {
    const available = pool
      .filter((c) => !used.has(c.proposalId))
      .sort((a, b) => b.attentionScore - a.attentionScore ||
        a.proposalId.localeCompare(b.proposalId));
    if (!available.length) return;
    // Keep the lottery in the upper half by *attention debt*, not popularity.
    const eligible = available.slice(0, Math.max(1, Math.ceil(available.length / 2)));
    const winner = eligible
      .map((c) => ({
        c,
        // Exponential race: greater debt makes selection more likely.
        ticket: -Math.log(draw(`${weekKey}:${slot}`, c.proposalId)) /
          Math.max(1, c.attentionScore),
      }))
      .sort((a, b) => a.ticket - b.ticket ||
        a.c.proposalId.localeCompare(b.c.proposalId))[0].c;
    used.add(winner.proposalId);
    selected.push(winner);
  }
  for (let i = 0; i < 2; i++) pick(ranked.filter((c) => c.stage === "deliberate"), `discussion-${i}`);
  for (let i = 0; i < 2; i++) pick(ranked.filter((c) => c.stage === "decide"), `ballot-${i}`);
  // Wildcard can come from any topic or stage that needs exposure.
  pick(ranked, "wildcard");
  // Fill unused slots if one stage has fewer than two candidates.
  for (let i = selected.length; i < MAX_ITEMS; i++) pick(ranked, `fill-${i}`);
  return selected;
}

function safeTitle(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 115)
    .replace(/@/g, "@\u200b")
    .replace(/([\\*_`~|>\[\]()/])/g, "\\$1");
}

export function validateDiscordWebhook(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !["discord.com", "discordapp.com"].includes(url.hostname) ||
    url.port || url.username || url.password || url.search || url.hash ||
    !/^\/api\/webhooks\/\d{15,25}\/[A-Za-z0-9._-]+$/.test(url.pathname)
  ) {
    throw new Error("Discord webhook configuration is invalid.");
  }
  url.searchParams.set("wait", "true");
  return url;
}

function roleMention(roleId: string | undefined): string {
  return roleId && /^\d{15,25}$/.test(roleId)
    ? `<@&${roleId}>`
    : "";
}

export function renderDiscordDigest(
  items: RankedCandidate[],
  origin: string,
  roleId?: string,
  test = false,
): string {
  const lines = [
    test ? "**TEST — Engage weekly digest (test server)**" : "**Engage this week**",
    roleMention(roleId),
    "",
    "A few proposals could use more voices. Take a look, share your thoughts or cast your vote.",
  ].filter(Boolean);
  if (!items.length) {
    lines.push("", "Nothing currently needs a spotlight. Check Engage for the latest updates.");
  } else {
    for (const item of items) {
      const label = item.stage === "decide" ? "Open vote" : "Discussion";
      const description = item.stage === "decide"
        ? item.participation === null
          ? "Participation figures updating"
          : `${item.participation} ${item.participation === 1 ? "participant" : "participants"} so far`
        : `${item.commentCount} ${item.commentCount === 1 ? "contribution" : "contributions"} so far`;
      const link = new URL(
        `/proposals/${encodeURIComponent(item.slug)}/`,
        origin,
      );
      link.searchParams.set("source", "discord-weekly");
      lines.push("", `**${safeTitle(item.title)}** · ${label}`, description, link.toString());
    }
  }
  lines.push("", "All views are welcome. Please read the proposal before taking part.");
  return lines.join("\n").slice(0, 2000);
}

function assertRole(value: string | undefined, optional = false): string | undefined {
  if (!value && optional) return undefined;
  if (!value || !/^\d{15,25}$/.test(value)) {
    throw new Error("Discord role configuration is incomplete.");
  }
  return value;
}

async function historicalExposures(db: Db, now: Date): Promise<Map<string, {
  count: number;
  last: Date | null;
}>> {
  const history = await db.collection(DISCORD_DIGEST_RUNS)
    .find({
      kind: "weekly",
      status: { $in: ["sent", "held", "sending"] },
      createdAt: { $gte: new Date(now.getTime() - 84 * DAY) },
    })
    .project({ featuredIds: 1, createdAt: 1 })
    .sort({ createdAt: -1 })
    .limit(20)
    .toArray();
  const exposure = new Map<string, { count: number; last: Date | null }>();
  for (const row of history) {
    for (const id of (Array.isArray(row.featuredIds) ? row.featuredIds : [])) {
      if (typeof id !== "string") continue;
      const previous = exposure.get(id);
      exposure.set(id, {
        count: (previous?.count ?? 0) + 1,
        last: previous?.last ?? validDate(row.createdAt),
      });
    }
  }
  return exposure;
}

/**
 * Only public proposals are candidates. Never inspect an individual vote,
 * member identity, private branch proposal, Sense Box inbox or comment body.
 */
export async function previewWeeklyDiscordDigest(
  db: Db,
  env: PlatformEnv,
  now: Date = new Date(),
  test = false,
): Promise<DiscordDigestPreview> {
  const origin = emailOrigin(env);
  const proposals = (await listProposals(db, {
    includeArchived: false,
    includeDetails: false,
    includeVoteTallies: false,
    user: null,
  })).filter((p) =>
    canViewProposal(p, null) &&
    (p.publicationScope === "national" || !p.publicationScope) &&
    (p.stage === "deliberate" || (p.stage === "decide" && !ballotExpired(p, now))),
  );
  const [exposures, tallies] = await Promise.all([
    historicalExposures(db, now),
    readBallotTallyProjections(
      db,
      proposals
        .filter((p) => p.stage === "decide" && p.ballotRevisionId)
        .map((p) => ({
          ballotId: proposalBallotId(p.proposalId),
          revisionId: p.ballotRevisionId!,
        })),
      { now },
    ),
  ]);
  const candidates: DigestCandidate[] = proposals.map((p) => {
    const key = p.ballotRevisionId
      ? ballotTallyKey(proposalBallotId(p.proposalId), p.ballotRevisionId)
      : "";
    const tally = tallies.get(key);
    const history = exposures.get(p.proposalId);
    return {
      proposalId: p.proposalId,
      title: p.title,
      slug: p.slug,
      stage: p.stage as DigestStage,
      createdAt: validDate(p.secondedAt ?? p.createdAt) ?? now,
      commentCount: p.commentCount,
      participation:
        p.stage === "decide" && tally?.fresh ? tally.tally.total : null,
      closesAt: validDate(p.ballotClosesAt),
      exposures: history?.count ?? 0,
      lastFeaturedAt: history?.last ?? null,
    };
  });
  const weekKey = melbourneWeekKey(now);
  const selected = selectDiscordDigest(candidates, now, weekKey);
  const role = test
    ? assertRole(env.ENGAGE_DISCORD_TEST_ROLE_ID, true)
    : assertRole(env.ENGAGE_DISCORD_ROLE_ID);
  return {
    weekKey,
    candidates: selected,
    content: renderDiscordDigest(selected, origin, role, test),
  };
}

async function sendWebhook(
  url: string,
  content: string,
  roleId: string | undefined,
  send: typeof fetch,
): Promise<string> {
  const webhook = validateDiscordWebhook(url);
  const roles = roleId ? [assertRole(roleId)!] : [];
  const response = await send(webhook.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content,
      allowed_mentions: { parse: [], roles },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  // The wait=true response carries a Discord message ID. 204 is not evidence
  // enough for this delivery ledger.
  if (!response.ok) throw new Error("Discord did not confirm delivery.");
  const data = await response.json().catch(() => null) as { id?: unknown } | null;
  if (!data || typeof data.id !== "string") {
    throw new Error("Discord delivery confirmation was unavailable.");
  }
  return data.id;
}

/** An ambiguous HTTP outcome is held for inspection, never auto-retried. */
export async function runWeeklyDiscordDigest(
  db: Db,
  env: PlatformEnv,
  send: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<DiscordDigestResult> {
  if (env.ENGAGE_DISCORD_DIGEST_ENABLED !== "true") {
    return { status: "disabled", featured: 0 };
  }
  if (!env.ENGAGE_DISCORD_WEBHOOK_URL) {
    throw new Error("Discord weekly digest is enabled but not configured.");
  }
  validateDiscordWebhook(env.ENGAGE_DISCORD_WEBHOOK_URL);
  assertRole(env.ENGAGE_DISCORD_ROLE_ID);
  if (env.ENGAGE_DISCORD_WEBHOOK_URL === env.ENGAGE_DISCORD_TEST_WEBHOOK_URL) {
    throw new Error("Test and live Discord webhooks must differ.");
  }
  const preview = await previewWeeklyDiscordDigest(db, env, now);
  const outbox = db.collection(DISCORD_DIGEST_RUNS);
  const id = `discord:weekly:${preview.weekKey}`;
  if (!preview.candidates.length) {
    return { status: "empty", featured: 0 };
  }
  try {
    await outbox.insertOne({
      _id: id as never,
      kind: "weekly",
      status: "sending",
      createdAt: now,
      featuredIds: preview.candidates.map((c) => c.proposalId),
    });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      return { status: "already-attempted", featured: 0 };
    }
    throw error;
  }
  try {
    const messageId = await sendWebhook(
      env.ENGAGE_DISCORD_WEBHOOK_URL,
      preview.content,
      env.ENGAGE_DISCORD_ROLE_ID,
      send,
    );
    await outbox.updateOne({ _id: id }, {
      $set: { status: "sent", messageId, acceptedAt: new Date() },
    });
    return { status: "sent", featured: preview.candidates.length };
  } catch {
    await outbox.updateOne({ _id: id }, {
      $set: { status: "held", heldAt: new Date() },
    });
    return { status: "held", featured: preview.candidates.length };
  }
}

/** Only the explicitly configured test webhook is ever called. */
export async function sendTestDiscordDigest(
  db: Db,
  env: PlatformEnv,
  actorId: string,
  send: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<DiscordDigestResult> {
  if (!env.ENGAGE_DISCORD_TEST_WEBHOOK_URL) {
    throw new Error("Configure a separate test Discord webhook first.");
  }
  validateDiscordWebhook(env.ENGAGE_DISCORD_TEST_WEBHOOK_URL);
  if (env.ENGAGE_DISCORD_TEST_WEBHOOK_URL === env.ENGAGE_DISCORD_WEBHOOK_URL) {
    throw new Error("The test webhook must differ from the live webhook.");
  }
  const preview = await previewWeeklyDiscordDigest(db, env, now, true);
  const minute = Math.floor(now.getTime() / 60_000);
  const id = `discord:test:${actorId}:${minute}`;
  const outbox = db.collection(DISCORD_DIGEST_RUNS);
  try {
    await outbox.insertOne({
      _id: id as never,
      kind: "test",
      status: "sending",
      createdAt: now,
      featuredIds: preview.candidates.map((c) => c.proposalId),
    });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      return { status: "already-attempted", featured: 0 };
    }
    throw error;
  }
  try {
    const messageId = await sendWebhook(
      env.ENGAGE_DISCORD_TEST_WEBHOOK_URL,
      preview.content,
      env.ENGAGE_DISCORD_TEST_ROLE_ID,
      send,
    );
    await outbox.updateOne({ _id: id }, {
      $set: { status: "sent", messageId, acceptedAt: new Date() },
    });
    return { status: "sent", featured: preview.candidates.length };
  } catch {
    await outbox.updateOne({ _id: id }, {
      $set: { status: "held", heldAt: new Date() },
    });
    return { status: "held", featured: preview.candidates.length };
  }
}
