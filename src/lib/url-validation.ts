/** Client-safe URL helpers shared by the settings UI and the server. */

export const SOCIAL_PLATFORMS = [
  "facebook",
  "instagram",
  "youtube",
  "bluesky",
  "x",
  "tiktok",
  "linkedin",
  "mastodon",
  "threads",
  "website",
] as const;

export const PLATFORM_LABELS: Record<string, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  youtube: "YouTube",
  bluesky: "Bluesky",
  x: "X",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
  mastodon: "Mastodon",
  threads: "Threads",
  website: "Website",
};

/** Strict absolute http(s) URL check with a host; no credentials. */
export function isPublicHttpUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value.trim());
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.hostname.includes(".") &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

/** A path on this site (not protocol-relative) or a full web address. */
export function isSiteLink(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim();
  return (v.startsWith("/") && !v.startsWith("//")) || isPublicHttpUrl(v);
}
