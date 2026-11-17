import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import type { PlatformEnv } from "./types.ts";
import { SOCIAL_PLATFORMS, isPublicHttpUrl, isSiteLink } from "./url-validation.ts";

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

export type SiteConfigSection =
  | "visibility"
  | "features"
  | "social"
  | "directory"
  | "operations"
  | "restore"
  | "general";

export interface SiteConfigEvent {
  eventId: string;
  section: SiteConfigSection;
  summary: string;
  actorId: string;
  actorName: string;
  changedFields: string[];
  before: Partial<SiteConfig>;
  after: Partial<SiteConfig>;
  createdAt: Date;
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
  updatedByName?: string;
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
    websiteHref: "https://nsw.fusionparty.org.au",
    facebookHref: "https://www.facebook.com/FusionPartyNSW",
  },
  {
    code: "VIC",
    name: "Victoria",
    websiteHref: "https://vic.fusionparty.org.au",
    facebookHref: "https://www.facebook.com/FusionPartyVIC",
  },
  {
    code: "QLD",
    name: "Queensland",
    websiteHref: "https://qld.fusionparty.org.au",
    facebookHref: "https://www.facebook.com/FusionPartyQLD",
  },
  {
    code: "WA",
    name: "Western Australia",
    websiteHref: "https://wa.fusionparty.org.au",
    facebookHref: "https://www.facebook.com/FusionPartyWA",
  },
  {
    code: "SA",
    name: "South Australia",
    websiteHref: "https://sa.fusionparty.org.au",
    facebookHref: "https://www.facebook.com/FusionPartySA",
  },
  {
    code: "TAS",
    name: "Tasmania",
    websiteHref: "https://tas.fusionparty.org.au",
    facebookHref: "https://www.facebook.com/FusionPartyAus",
  },
  {
    code: "ACT",
    name: "Australian Capital Territory",
    websiteHref: "https://act.fusionparty.org.au",
    facebookHref: "https://www.facebook.com/FusionPartyAus",
  },
  {
    code: "NT",
    name: "Northern Territory",
    websiteHref: "https://nt.fusionparty.org.au",
    facebookHref: "https://www.facebook.com/FusionPartyAus",
  },
];

export function isSafeConfigUrl(url: unknown): boolean {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  return /^(https?:\/\/|\/)/i.test(trimmed);
}

/**
 * Code defaults for everything an administrator can change under Platform
 * settings. The deployment environment is not a fallback for these: only
 * `APP_MODE` still decides the indexing default, because it describes the
 * deployment itself.
 */
export function getDefaultSiteConfig(env: PlatformEnv = {}): SiteConfig {
  return {
    configId: "global",
    siteName: "Engage",
    organizationName: "Fusion Party Australia",
    tagline:
      "Explore ideas, join discussions, and vote on the decisions that shape Fusion.",
    defaultDescription:
      "Read what Fusion is discussing, help shape an idea and vote on the party’s decisions when eligible.",
    defaultOgImage: "/engage-og-card.png",
    allowPublicIndexing: env.APP_MODE === "production",
    publicPulsePollEnabled: false,
    primaryCtaLabel: "Suggest an idea",
    primaryCtaHref: "/proposals/new/",
    showPrimaryCtaInHeader: true,
    socialLinks: DEFAULT_SOCIAL_LINKS,
    stateSites: DEFAULT_STATE_SITES,
    repoUrl: "https://github.com/Fusion-Party-Aus/Engage",
    docsUrl: "/how-it-works/#operations",
    backupSummary:
      "Back up the database, uploaded files and security keys. Keep protected copies away from the application host and test recovery in an isolated environment. See the operating guide for deployment-specific procedures.",
    handoverSummary:
      "The repository contains deployment instructions and configuration examples. A handover also requires authorised access to hosting, backups and security keys, which are not stored in the repository.",
  };
}

export { SOCIAL_PLATFORMS, isPublicHttpUrl } from "./url-validation.ts";

/**
 * Validate an incoming settings payload and return human-readable problems
 * keyed by field (e.g. `socialLinks.2.href`). The sanitiser silently drops bad
 * values; this makes the API reject them so administrators get feedback.
 */
export function validateSiteConfigInput(
  raw: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const text = (key: string, label: string, max: number) => {
    if (raw[key] === undefined) return;
    const v = typeof raw[key] === "string" ? (raw[key] as string).trim() : "";
    if (!v) errors[key] = `${label} cannot be empty.`;
    else if (v.length > max) errors[key] = `${label} must be ${max} characters or fewer.`;
  };
  text("primaryCtaLabel", "Button label", 48);
  text("tagline", "Tagline", 240);
  text("defaultDescription", "Description", 320);
  if (raw.primaryCtaHref !== undefined && !isSiteLink(raw.primaryCtaHref))
    errors.primaryCtaHref = "Enter a page on this site (starting with /) or a full https:// address.";
  if (raw.defaultOgImage !== undefined && !isSiteLink(raw.defaultOgImage))
    errors.defaultOgImage = "Enter an image path (starting with /) or a full https:// address.";
  text("repoUrl", "Repository address", 300);
  if (raw.repoUrl !== undefined && !isPublicHttpUrl(raw.repoUrl))
    errors.repoUrl = "Enter the repository's full web address, like https://github.com/YourOrg/Engage.";
  for (const key of ["allowPublicIndexing", "publicPulsePollEnabled", "showPrimaryCtaInHeader"]) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean")
      errors[key] = "Choose on or off.";
  }
  if (raw.socialLinks !== undefined) {
    if (!Array.isArray(raw.socialLinks)) errors.socialLinks = "Social channels must be a list.";
    else if (raw.socialLinks.length > 20) errors.socialLinks = "Add at most 20 social channels.";
    else {
      const seen = new Set<string>();
      raw.socialLinks.forEach((item, i) => {
        const row = (item ?? {}) as Record<string, unknown>;
        const label = String(row.label ?? "").trim();
        if (!label) errors[`socialLinks.${i}.label`] = "Enter a name for this channel.";
        else if (label.length > 80) errors[`socialLinks.${i}.label`] = "Keep the name under 80 characters.";
        if (!isPublicHttpUrl(row.href))
          errors[`socialLinks.${i}.href`] = "Enter a full web address, like https://www.facebook.com/YourPage.";
        else if (seen.has(String(row.href).trim().toLowerCase()))
          errors[`socialLinks.${i}.href`] = "This address is already listed.";
        else seen.add(String(row.href).trim().toLowerCase());
        if (
          row.platform !== undefined &&
          row.platform !== "" &&
          !(SOCIAL_PLATFORMS as readonly string[]).includes(String(row.platform))
        )
          errors[`socialLinks.${i}.platform`] = "Choose a platform from the list.";
      });
    }
  }
  if (raw.stateSites !== undefined) {
    if (!Array.isArray(raw.stateSites)) errors.stateSites = "The branch directory must be a list.";
    else {
      const codes = new Set<string>();
      raw.stateSites.forEach((item, i) => {
        const row = (item ?? {}) as Record<string, unknown>;
        const code = String(row.code ?? "").trim().toUpperCase();
        if (!/^[A-Z]{2,10}$/.test(code)) errors[`stateSites.${i}.code`] = "Use 2–10 letters, like VIC.";
        else if (codes.has(code)) errors[`stateSites.${i}.code`] = "This abbreviation is already used.";
        else codes.add(code);
        if (!String(row.name ?? "").trim()) errors[`stateSites.${i}.name`] = "Enter a name.";
        if (!isPublicHttpUrl(row.websiteHref))
          errors[`stateSites.${i}.websiteHref`] = "Enter a full web address, like https://vic.example.org.";
        const fb = row.facebookHref;
        if (fb !== undefined && fb !== "" && !isPublicHttpUrl(fb))
          errors[`stateSites.${i}.facebookHref`] = "Enter a full web address or leave blank.";
      });
    }
  }
  return errors;
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
  if (typeof raw.tagline === "string") {
    const tagline = raw.tagline.trim();
    if (tagline && tagline.length <= 240) patch.tagline = tagline;
  }
  if (typeof raw.defaultDescription === "string") {
    const description = raw.defaultDescription.trim();
    if (description && description.length <= 320) patch.defaultDescription = description;
  }
  if (typeof raw.defaultOgImage === "string" && isSiteLink(raw.defaultOgImage)) {
    patch.defaultOgImage = raw.defaultOgImage.trim();
  }
  if (typeof raw.allowPublicIndexing === "boolean") {
    patch.allowPublicIndexing = raw.allowPublicIndexing;
  }
  if (typeof raw.publicPulsePollEnabled === "boolean") {
    patch.publicPulsePollEnabled = raw.publicPulsePollEnabled;
  }
  if (typeof raw.primaryCtaLabel === "string") {
    const label = raw.primaryCtaLabel.trim();
    if (label && label.length <= 48) patch.primaryCtaLabel = label;
  }
  if (typeof raw.primaryCtaHref === "string" && isSiteLink(raw.primaryCtaHref)) {
    patch.primaryCtaHref = raw.primaryCtaHref.trim();
  }
  if (typeof raw.showPrimaryCtaInHeader === "boolean") {
    patch.showPrimaryCtaInHeader = raw.showPrimaryCtaInHeader;
  }
  if (typeof raw.repoUrl === "string" && isPublicHttpUrl(raw.repoUrl)) {
    const url = raw.repoUrl.trim();
    if (url.length <= 300) patch.repoUrl = url;
  }
  if (typeof raw.backupSummary === "string" && raw.backupSummary.trim()) {
    patch.backupSummary = raw.backupSummary.trim().slice(0, 1200);
  }
  if (typeof raw.handoverSummary === "string" && raw.handoverSummary.trim()) {
    patch.handoverSummary = raw.handoverSummary.trim().slice(0, 1200);
  }

  if (Array.isArray(raw.socialLinks) && raw.socialLinks.length <= 20) {
    const cleaned = raw.socialLinks
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
      .map((item) => ({
        label: String(item.label ?? "").trim(),
        href: String(item.href ?? "").trim(),
        ...(typeof item.platform === "string" &&
        (SOCIAL_PLATFORMS as readonly string[]).includes(item.platform.trim())
          ? { platform: item.platform.trim() }
          : {}),
      }))
      .filter((item) => item.label && item.label.length <= 80 && isPublicHttpUrl(item.href));
    if (cleaned.length > 0) patch.socialLinks = cleaned;
  }

  if (Array.isArray(raw.stateSites)) {
    const cleaned = raw.stateSites
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
      .map((item) => ({
        code: String(item.code ?? "").trim().toUpperCase(),
        name: String(item.name ?? "").trim(),
        websiteHref: String(item.websiteHref ?? "").trim(),
        ...(typeof item.facebookHref === "string" && isPublicHttpUrl(item.facebookHref)
          ? { facebookHref: item.facebookHref.trim() }
          : {}),
        ...(typeof item.branchId === "string" && item.branchId.trim()
          ? { branchId: item.branchId.trim() }
          : {}),
      }))
      .filter(
        (item) =>
          /^[A-Z]{2,10}$/.test(item.code) &&
          item.name.length > 0 &&
          item.name.length <= 80 &&
          isPublicHttpUrl(item.websiteHref),
      );
    if (cleaned.length > 0) patch.stateSites = cleaned;
  }

  return { ...base, ...patch };
}

const EDITABLE_CONFIG_KEYS: Array<keyof SiteConfig> = [
  "siteName",
  "organizationName",
  "tagline",
  "defaultDescription",
  "defaultOgImage",
  "allowPublicIndexing",
  "publicPulsePollEnabled",
  "primaryCtaLabel",
  "primaryCtaHref",
  "showPrimaryCtaInHeader",
  "socialLinks",
  "stateSites",
  "repoUrl",
  "docsUrl",
  "backupSummary",
  "handoverSummary",
];

function inferSection(changedFields: string[], requested?: unknown): SiteConfigSection {
  if (
    typeof requested === "string" &&
    ["visibility", "features", "social", "directory", "operations", "restore", "general"].includes(requested)
  ) {
    return requested as SiteConfigSection;
  }
  if (changedFields.every((f) => f === "socialLinks")) return "social";
  if (changedFields.every((f) => f === "stateSites")) return "directory";
  if (changedFields.every((f) => f === "publicPulsePollEnabled")) return "features";
  if (
    changedFields.every((f) =>
      ["repoUrl", "docsUrl", "backupSummary", "handoverSummary"].includes(f),
    )
  ) {
    return "operations";
  }
  if (
    changedFields.every((f) =>
      [
        "allowPublicIndexing",
        "defaultOgImage",
        "primaryCtaLabel",
        "primaryCtaHref",
        "showPrimaryCtaInHeader",
        "tagline",
        "defaultDescription",
      ].includes(f),
    )
  ) {
    return "visibility";
  }
  return "general";
}

function buildChangeSummary(section: SiteConfigSection, changedFields: string[]): string {
  const labels: Record<string, string> = {
    allowPublicIndexing: "search engine indexing",
    defaultOgImage: "sharing preview image",
    primaryCtaLabel: "header action label",
    primaryCtaHref: "header action link",
    showPrimaryCtaInHeader: "header action visibility",
    publicPulsePollEnabled: "public sentiment poll trial",
    socialLinks: "national social channels",
    stateSites: "branch website directory",
    repoUrl: "source repository link",
    docsUrl: "operational reference link",
    backupSummary: "backup overview note",
    handoverSummary: "maintainer handover note",
    tagline: "site tagline",
    defaultDescription: "default page description",
  };
  const named = changedFields.map((f) => labels[f] || f);
  if (section === "restore") {
    return `Restored ${named.join(", ")} from change history`;
  }
  if (named.length === 1) {
    return `Updated ${named[0]}`;
  }
  if (named.length <= 3) {
    return `Updated ${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
  }
  return `Updated ${named.slice(0, 2).join(", ")} and ${named.length - 2} other settings`;
}

export interface SiteConfigState {
  config: SiteConfig;
  /** Saved fields that failed validation and were replaced with code defaults. */
  invalidFields: string[];
  /** True when the saved document could not be read at all. */
  readFailed: boolean;
}

const siteConfigCache = new WeakMap<
  object,
  { expiresAt: number; state: SiteConfigState }
>();

async function readSiteConfigState(
  db: Db,
  env: PlatformEnv,
): Promise<SiteConfigState> {
  const defaults = getDefaultSiteConfig(env);
  try {
    const stored = await db
      .collection<Partial<SiteConfig>>("site_settings")
      .findOne({ configId: "global" });
    if (!stored) {
      return { config: defaults, invalidFields: [], readFailed: false };
    }
    const raw = stored as Record<string, unknown>;
    return {
      config: {
        ...defaults,
        ...sanitizeSiteConfigPatch(raw, defaults),
        updatedAt: stored.updatedAt ? new Date(stored.updatedAt) : undefined,
        updatedBy: stored.updatedBy,
        updatedByName: stored.updatedByName,
      },
      invalidFields: Object.keys(validateSiteConfigInput(raw)),
      readFailed: false,
    };
  } catch {
    return { config: defaults, invalidFields: [], readFailed: true };
  }
}

export async function getSiteConfigState(
  db: Db,
  env: PlatformEnv = {},
): Promise<SiteConfigState> {
  const cached = siteConfigCache.get(db);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.state;
  }
  const state = await readSiteConfigState(db, env);
  // Do not cache a read failure: the next request should try the database again.
  if (!state.readFailed) {
    siteConfigCache.set(db, { expiresAt: Date.now() + 30_000, state });
  }
  return state;
}

export async function getSiteConfig(
  db: Db,
  env: PlatformEnv = {},
): Promise<SiteConfig> {
  return (await getSiteConfigState(db, env)).config;
}

export async function listSiteConfigEvents(
  db: Db,
  limit = 40,
): Promise<SiteConfigEvent[]> {
  try {
    const rows = await db
      .collection<SiteConfigEvent>("site_settings_events")
      .find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    return rows.map(({ _id, ...rest }: any) => ({
      ...rest,
      createdAt: rest.createdAt ? new Date(rest.createdAt) : new Date(),
    }));
  } catch {
    return [];
  }
}

export async function updateSiteConfig(
  db: Db,
  env: PlatformEnv,
  actorId: string,
  updates: Record<string, unknown>,
  actorName = "Administrator",
): Promise<SiteConfig> {
  siteConfigCache.delete(db);
  const current = await getSiteConfig(db, env);
  const merged = sanitizeSiteConfigPatch(updates, current) as SiteConfig;
  const now = new Date();

  const changedFields: string[] = [];
  const beforeSnap: Partial<SiteConfig> = {};
  const afterSnap: Partial<SiteConfig> = {};

  for (const key of EDITABLE_CONFIG_KEYS) {
    const prevVal = current[key];
    const nextVal = merged[key];
    if (JSON.stringify(prevVal) !== JSON.stringify(nextVal)) {
      changedFields.push(key);
      (beforeSnap as Record<string, unknown>)[key] = prevVal;
      (afterSnap as Record<string, unknown>)[key] = nextVal;
    }
  }

  const next: SiteConfig = {
    ...current,
    ...merged,
    configId: "global",
    updatedAt: now,
    updatedBy: actorId,
    updatedByName: actorName,
  };
  await db.collection("site_settings").updateOne(
    { configId: "global" },
    { $set: next },
    { upsert: true },
  );

  if (changedFields.length > 0) {
    const section = inferSection(changedFields, updates.section);
    const summary =
      typeof updates.changeSummary === "string" && updates.changeSummary.trim()
        ? updates.changeSummary.trim().slice(0, 200)
        : buildChangeSummary(section, changedFields);
    const event: SiteConfigEvent = {
      eventId: randomUUID(),
      section,
      summary,
      actorId,
      actorName,
      changedFields,
      before: beforeSnap,
      after: afterSnap,
      createdAt: now,
    };
    await db
      .collection("site_settings_events")
      .insertOne(event as unknown as Record<string, unknown>)
      .catch(() => {});
  }

  siteConfigCache.set(db, {
    expiresAt: Date.now() + 30_000,
    state: { config: next, invalidFields: [], readFailed: false },
  });
  return next;
}
