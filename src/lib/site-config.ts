import type { Db } from "mongodb";
import type { PlatformEnv } from "./types.ts";

export interface NavLinkConfig {
  href: string;
  label: string;
  icon: string;
  primary?: boolean;
}

export interface SocialLinkConfig {
  label: string;
  href: string;
  platform?: string;
}

export interface StateSiteConfig {
  code: string;
  name: string;
  websiteHref: string;
  facebookHref?: string;
  branchId?: string;
}

export interface SiteConfig {
  configId: "global";
  siteName: string;
  organizationName: string;
  tagline: string;
  defaultDescription: string;
  defaultOgImage: string;
  allowPublicIndexing: boolean;
  publicPulsePollEnabled: boolean;
  primaryCtaLabel: string;
  primaryCtaHref: string;
  showPrimaryCtaInHeader: boolean;
  socialLinks: SocialLinkConfig[];
  stateSites: StateSiteConfig[];
  repoUrl: string;
  docsUrl: string;
  backupSummary: string;
  handoverSummary: string;
  updatedAt?: Date;
  updatedBy?: string;
}

export const DEFAULT_SOCIAL_LINKS: SocialLinkConfig[] = [
  {
    label: "Fusion Party on Facebook",
    href: "https://www.facebook.com/FusionPartyAus",
    platform: "facebook",
  },
  {
    label: "Fusion Party Website",
    href: "https://www.fusionparty.org.au",
    platform: "website",
  },
  {
    label: "Instagram",
    href: "https://www.instagram.com/fusionpartyaus/",
    platform: "instagram",
  },
  {
    label: "YouTube",
    href: "https://www.youtube.com/@FusionPartyAus",
    platform: "youtube",
  },
  {
    label: "Bluesky",
    href: "https://bsky.app/profile/fusionparty.org.au",
    platform: "bluesky",
  },
];

export const DEFAULT_STATE_SITES: StateSiteConfig[] = [
  {
    code: "NAT",
    name: "National · Fusion Party Australia",
    websiteHref: "https://www.fusionparty.org.au",
    facebookHref: "https://www.facebook.com/FusionPartyAus",
  },
  {
    code: "NSW",
    name: "New South Wales",
    websiteHref: "https://www.fusionparty.org.au/nsw",
    facebookHref: "https://www.facebook.com/FusionPartyNSW",
  },
  {
    code: "VIC",
    name: "Victoria",
    websiteHref: "https://www.fusionparty.org.au/vic",
    facebookHref: "https://www.facebook.com/FusionPartyVIC",
  },
  {
    code: "QLD",
    name: "Queensland",
    websiteHref: "https://www.fusionparty.org.au/qld",
    facebookHref: "https://www.facebook.com/FusionPartyQLD",
  },
  {
    code: "WA",
    name: "Western Australia",
    websiteHref: "https://www.fusionparty.org.au/wa",
    facebookHref: "https://www.facebook.com/FusionPartyWA",
  },
  {
    code: "SA",
    name: "South Australia",
    websiteHref: "https://www.fusionparty.org.au/sa",
    facebookHref: "https://www.facebook.com/FusionPartySA",
  },
  {
    code: "TAS",
    name: "Tasmania",
    websiteHref: "https://www.fusionparty.org.au/tas",
    facebookHref: "https://www.facebook.com/FusionPartyAus",
  },
  {
    code: "ACT",
    name: "Australian Capital Territory",
    websiteHref: "https://www.fusionparty.org.au/act",
    facebookHref: "https://www.facebook.com/FusionPartyAus",
  },
  {
    code: "NT",
    name: "Northern Territory",
    websiteHref: "https://www.fusionparty.org.au/nt",
    facebookHref: "https://www.facebook.com/FusionPartyAus",
  },
];

export function isSafeConfigUrl(url: unknown): boolean {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  return /^(https?:\/\/|\/)/i.test(trimmed);
}

function parseJsonEnv<T>(raw: string | undefined, fallback: T): T {
  if (!raw || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function getDefaultSiteConfig(env: PlatformEnv = {}): SiteConfig {
  const envSocialLinks = parseJsonEnv<SocialLinkConfig[]>(
    env.ENGAGE_SOCIAL_LINKS_JSON,
    DEFAULT_SOCIAL_LINKS,
  ).filter(
    (item) =>
      item &&
      typeof item.label === "string" &&
      item.label.trim() &&
      isSafeConfigUrl(item.href),
  );

  const envStateSites = parseJsonEnv<StateSiteConfig[]>(
    env.ENGAGE_STATE_SITES_JSON,
    DEFAULT_STATE_SITES,
  ).filter(
    (item) =>
      item &&
      typeof item.code === "string" &&
      typeof item.name === "string" &&
      isSafeConfigUrl(item.websiteHref),
  );

  const allowIndexingEnv = (env.ENGAGE_ALLOW_INDEXING ?? "").trim().toLowerCase();
  const allowPublicIndexing =
    allowIndexingEnv === "true" || allowIndexingEnv === "1"
      ? true
      : allowIndexingEnv === "false" || allowIndexingEnv === "0"
        ? false
        : env.APP_MODE === "production";

  const pulsePollEnv = (env.ENGAGE_PUBLIC_PULSE_POLL ?? "").trim().toLowerCase();
  const publicPulsePollEnabled =
    pulsePollEnv === "true" || pulsePollEnv === "1";

  const ogImage =
    env.ENGAGE_DEFAULT_OG_IMAGE && isSafeConfigUrl(env.ENGAGE_DEFAULT_OG_IMAGE)
      ? env.ENGAGE_DEFAULT_OG_IMAGE.trim()
      : "/engage-og-card.png";

  const primaryCtaLabel =
    (env.ENGAGE_PRIMARY_CTA_LABEL ?? "").trim() || "Suggest an idea";
  const primaryCtaHref =
    env.ENGAGE_PRIMARY_CTA_HREF && isSafeConfigUrl(env.ENGAGE_PRIMARY_CTA_HREF)
      ? env.ENGAGE_PRIMARY_CTA_HREF.trim()
      : "/proposals/new/";

  return {
    configId: "global",
    siteName: "Engage",
    organizationName: "Fusion Party Australia",
    tagline:
      "Explore ideas, join discussions, and vote on the decisions that shape Fusion.",
    defaultDescription:
      "Browse proposals, join discussions, vote when eligible, and explore the policy registry from Fusion Party Australia.",
    defaultOgImage: ogImage,
    allowPublicIndexing,
    publicPulsePollEnabled,
    primaryCtaLabel,
    primaryCtaHref,
    showPrimaryCtaInHeader: true,
    socialLinks: envSocialLinks.length ? envSocialLinks : DEFAULT_SOCIAL_LINKS,
    stateSites: envStateSites.length ? envStateSites : DEFAULT_STATE_SITES,
    repoUrl:
      (env.ENGAGE_REPO_URL && isSafeConfigUrl(env.ENGAGE_REPO_URL)
        ? env.ENGAGE_REPO_URL.trim()
        : "https://github.com/Fusion-Party-Aus/Engage"),
    docsUrl: "/how-it-works/#operations",
    backupSummary:
      "Engage runs as a self-contained Docker Compose stack (Astro Node server + single-node MongoDB 8 replica set with a persistent mongo_data volume). Routine encrypted mongodump archives can be exported to off-host storage and verified into an isolated restore-drill database without downtime.",
    handoverSummary:
      "Everything required to run or transfer Engage is version-controlled in the repository: Dockerfiles, Compose stacks, .env.example configuration template, deterministic ballot-migration scripts, and operational runbooks in /docs.",
  };
}

export function sanitizeSiteConfigPatch(
  raw: Record<string, unknown>,
  base: SiteConfig,
): Partial<SiteConfig> {
  const patch: Partial<SiteConfig> = {};

  if (typeof raw.siteName === "string" && raw.siteName.trim()) {
    patch.siteName = raw.siteName.trim().slice(0, 80);
  }
  if (typeof raw.organizationName === "string" && raw.organizationName.trim()) {
    patch.organizationName = raw.organizationName.trim().slice(0, 120);
  }
  if (typeof raw.tagline === "string" && raw.tagline.trim()) {
    patch.tagline = raw.tagline.trim().slice(0, 240);
  }
  if (
    typeof raw.defaultDescription === "string" &&
    raw.defaultDescription.trim()
  ) {
    patch.defaultDescription = raw.defaultDescription.trim().slice(0, 320);
  }
  if (typeof raw.defaultOgImage === "string" && isSafeConfigUrl(raw.defaultOgImage)) {
    patch.defaultOgImage = raw.defaultOgImage.trim();
  }
  if (typeof raw.allowPublicIndexing === "boolean") {
    patch.allowPublicIndexing = raw.allowPublicIndexing;
  }
  if (typeof raw.publicPulsePollEnabled === "boolean") {
    patch.publicPulsePollEnabled = raw.publicPulsePollEnabled;
  }
  if (typeof raw.primaryCtaLabel === "string" && raw.primaryCtaLabel.trim()) {
    patch.primaryCtaLabel = raw.primaryCtaLabel.trim().slice(0, 48);
  }
  if (typeof raw.primaryCtaHref === "string" && isSafeConfigUrl(raw.primaryCtaHref)) {
    patch.primaryCtaHref = raw.primaryCtaHref.trim();
  }
  if (typeof raw.showPrimaryCtaInHeader === "boolean") {
    patch.showPrimaryCtaInHeader = raw.showPrimaryCtaInHeader;
  }
  if (typeof raw.repoUrl === "string" && isSafeConfigUrl(raw.repoUrl)) {
    patch.repoUrl = raw.repoUrl.trim();
  }
  if (typeof raw.backupSummary === "string" && raw.backupSummary.trim()) {
    patch.backupSummary = raw.backupSummary.trim().slice(0, 1200);
  }
  if (typeof raw.handoverSummary === "string" && raw.handoverSummary.trim()) {
    patch.handoverSummary = raw.handoverSummary.trim().slice(0, 1200);
  }

  if (Array.isArray(raw.socialLinks)) {
    const cleaned = raw.socialLinks
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
      .map((item) => ({
        label: String(item.label ?? "").trim().slice(0, 80),
        href: String(item.href ?? "").trim(),
        ...(typeof item.platform === "string" && item.platform.trim()
          ? { platform: item.platform.trim().slice(0, 32) }
          : {}),
      }))
      .filter((item) => item.label && isSafeConfigUrl(item.href));
    if (cleaned.length > 0) patch.socialLinks = cleaned;
  }

  if (Array.isArray(raw.stateSites)) {
    const cleaned = raw.stateSites
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
      .map((item) => ({
        code: String(item.code ?? "").trim().toUpperCase().slice(0, 10),
        name: String(item.name ?? "").trim().slice(0, 80),
        websiteHref: String(item.websiteHref ?? "").trim(),
        ...(typeof item.facebookHref === "string" && isSafeConfigUrl(item.facebookHref)
          ? { facebookHref: item.facebookHref.trim() }
          : {}),
        ...(typeof item.branchId === "string" && item.branchId.trim()
          ? { branchId: item.branchId.trim() }
          : {}),
      }))
      .filter((item) => item.code && item.name && isSafeConfigUrl(item.websiteHref));
    if (cleaned.length > 0) patch.stateSites = cleaned;
  }

  return { ...base, ...patch };
}

const siteConfigCache = new WeakMap<
  object,
  { expiresAt: number; value: SiteConfig }
>();

export async function getSiteConfig(
  db: Db,
  env: PlatformEnv = {},
): Promise<SiteConfig> {
  const cached = siteConfigCache.get(db);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const defaults = getDefaultSiteConfig(env);
  try {
    const stored = await db
      .collection<Partial<SiteConfig>>("site_settings")
      .findOne({ configId: "global" });
    const value: SiteConfig = !stored
      ? defaults
      : {
          ...defaults,
          ...sanitizeSiteConfigPatch(stored as Record<string, unknown>, defaults),
          updatedAt: stored.updatedAt ? new Date(stored.updatedAt) : undefined,
          updatedBy: stored.updatedBy,
        };
    siteConfigCache.set(db, { expiresAt: Date.now() + 30_000, value });
    return value;
  } catch {
    return defaults;
  }
}

export async function updateSiteConfig(
  db: Db,
  env: PlatformEnv,
  actorId: string,
  updates: Record<string, unknown>,
): Promise<SiteConfig> {
  siteConfigCache.delete(db);
  const current = await getSiteConfig(db, env);
  const merged = sanitizeSiteConfigPatch(updates, current) as SiteConfig;
  const now = new Date();
  const next: SiteConfig = {
    ...current,
    ...merged,
    configId: "global",
    updatedAt: now,
    updatedBy: actorId,
  };
  await db.collection("site_settings").updateOne(
    { configId: "global" },
    { $set: next },
    { upsert: true },
  );
  siteConfigCache.set(db, { expiresAt: Date.now() + 30_000, value: next });
  return next;
}
