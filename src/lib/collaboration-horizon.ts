import { createHash, timingSafeEqual } from "node:crypto";
import type { Db } from "mongodb";
import { PUBLISHED_CONTRIBUTION_FILTER } from "./collaboration.ts";
import type { PlatformEnv } from "./types.ts";

/**
 * Read-only hand-off for Horizon.
 *
 * The feed serves exactly what the public gallery serves: an approved story
 * whose contributor allowed the website channel, which a reviewer published and
 * has not hidden, and whose material still exists. A credential is required so
 * Horizon can poll it without scraping, and so the endpoint is not a second
 * public surface. The payload carries consent metadata but never a reply
 * address, internal note, member identifier or management token.
 */

export type HorizonFeedAuth =
  | { ok: true }
  | { ok: false; status: 401 | 503; error: string };

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Fail closed when unconfigured, and compare without leaking length or timing. */
export function authoriseHorizonFeed(
  authorization: string | null,
  env: Pick<PlatformEnv, "HORIZON_FEED_TOKEN">,
): HorizonFeedAuth {
  const expected = String(env.HORIZON_FEED_TOKEN ?? "").trim();
  if (!expected) {
    return { ok: false, status: 503, error: "The Horizon feed is not configured." };
  }
  const match = /^Bearer\s+(.+)$/i.exec(String(authorization ?? "").trim());
  if (!match) {
    return { ok: false, status: 401, error: "A bearer token is required." };
  }
  const provided = match[1]!.trim();
  if (!provided || !timingSafeEqual(digest(provided), digest(expected))) {
    return { ok: false, status: 401, error: "That token is not valid." };
  }
  return { ok: true };
}

export interface HorizonStory {
  id: string;
  initiative: { slug: string; title: string };
  publishedAt: string;
  name: string;
  attribution: "named" | "anonymous";
  answers: Array<{ label: string; text: string }>;
  caption: string;
  media: Array<{ url: string; mimeType: string; alt: string }>;
  channels: string[];
  editorial: {
    consentVersion: string;
    allowEdits: boolean;
    allowAiEdits: boolean;
  };
}

export interface HorizonFeed {
  generatedAt: string;
  since: string | null;
  nextSince: string | null;
  /** Present when the request was scoped to one invitation. */
  initiative?: { slug: string; title: string; purpose: string };
  stories: HorizonStory[];
}

export function parseSince(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function buildHorizonFeed(
  db: Db,
  input: { initiativeSlug?: string | null; baseUrl: string; since?: Date | null; now?: Date },
): Promise<HorizonFeed | null> {
  const initiative = input.initiativeSlug
    ? await db.collection("collaboration_initiatives").findOne({ slug: input.initiativeSlug })
    : null;
  if (input.initiativeSlug && !initiative) return null;
  const filter: Record<string, unknown> = { ...PUBLISHED_CONTRIBUTION_FILTER };
  if (input.initiativeSlug) filter.initiativeSlug = input.initiativeSlug;
  if (input.since) filter.galleryPublishedAt = { $gt: input.since };
  const rows = await db
    .collection("collaboration_contributions")
    .find(filter)
    .sort({ galleryPublishedAt: 1, _id: 1 })
    .limit(200)
    .toArray();

  const stories: HorizonStory[] = rows.map((row) => {
    const questions = Array.isArray(row.questions) ? row.questions : [];
    const name = row.attribution === "named" ? String(row.displayName ?? "") : "";
    const answers = Object.entries((row.answers ?? {}) as Record<string, string>)
      .filter(([, text]) => String(text).trim())
      .map(([key, text]) => ({
        label: String(questions.find((question: any) => question.key === key)?.label ?? ""),
        text: String(text),
      }))
      .filter((answer) => answer.label);
    const media = (Array.isArray(row.media) ? row.media : []).map((entry: any, index: number, all: any[]) => ({
      url: `${input.baseUrl.replace(/\/$/, "")}/api/collaboration/media/${encodeURIComponent(String(entry.mediaId))}`,
      mimeType: String(entry.mimeType),
      alt: `Photograph ${index + 1} of ${all.length} shared by ${
        name || "an anonymous contributor"
      }${row.caption ? `: ${String(row.caption)}` : ""}`,
    }));
    return {
      id: String(row.contributionId),
      initiative: {
        slug: String(row.initiativeSlug),
        title: String(row.initiativeTitle ?? row.initiativeSlug),
      },
      publishedAt: new Date(row.galleryPublishedAt).toISOString(),
      name,
      attribution: name ? "named" : "anonymous",
      answers,
      caption: String(row.caption ?? ""),
      media,
      channels: Array.isArray(row.channels) ? row.channels.map(String) : [],
      editorial: {
        consentVersion: String(row.consentVersion ?? ""),
        allowEdits: row.allowEdits === true,
        allowAiEdits: row.allowAiEdits === true,
      },
    };
  });

  const latest = stories.reduce<string | null>(
    (current, story) => (!current || story.publishedAt > current ? story.publishedAt : current),
    input.since ? input.since.toISOString() : null,
  );
  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    since: input.since ? input.since.toISOString() : null,
    nextSince: latest,
    ...(initiative
      ? {
          initiative: {
            slug: String(initiative.slug),
            title: String(initiative.title),
            purpose: String(initiative.purpose ?? ""),
          },
        }
      : {}),
    stories,
  };
}

/** A weak ETag over story identity and publication time, for cheap polling. */
export function horizonFeedEtag(feed: HorizonFeed): string {
  const material = feed.stories.map((story) => `${story.id}:${story.publishedAt}`).join("|");
  return `W/"${createHash("sha256").update(material).digest("hex").slice(0, 20)}"`;
}
