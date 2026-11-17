import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDb, getDatabase } from "./db.ts";
import {
  DEFAULT_SOCIAL_LINKS,
  DEFAULT_STATE_SITES,
  getDefaultSiteConfig,
  getSiteConfig,
  getSiteConfigState,
  listSiteConfigEvents,
  updateSiteConfig,
  validateSiteConfigInput,
} from "./site-config.ts";
import type { PlatformEnv } from "./types.ts";
import {
  GET as getSettings,
  PATCH as patchSettings,
  POST as restoreSettings,
} from "../pages/api/admin/settings/index.ts";
import { GET as listMemberships } from "../pages/api/admin/branches/memberships.ts";
import { GET as searchBranches } from "../pages/api/admin/branches/search.ts";
import { POST as createBranch } from "../pages/api/admin/branches.ts";

const env = { APP_MODE: "development" };
const admin = { Cookie: "engage_dev_user=administrator", "Content-Type": "application/json" };
const member = { Cookie: "engage_dev_user=member", "Content-Type": "application/json" };
const call = (handler: any, method: string, body?: unknown, headers: HeadersInit = admin, path = "/api/admin/settings") =>
  handler({
    request: new Request(`http://localhost${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }),
    url: new URL(`http://localhost${path}`),
    locals: { runtime: { env } },
  } as never);

describe("platform settings", () => {
  it("rejects bad URLs, javascript: links and duplicate or unknown social entries with field errors", () => {
    const errors = validateSiteConfigInput({
      primaryCtaHref: "javascript:alert(1)",
      defaultOgImage: "//evil.example/x.png",
      repoUrl: "javascript:alert(1)",
      socialLinks: [
        { label: "FB", href: "https://www.facebook.com/x", platform: "facebook" },
        { label: "Dup", href: "https://www.facebook.com/x", platform: "facebook" },
        { label: "", href: "not a url", platform: "myspace" },
      ],
      stateSites: [{ code: "V1C", name: "", websiteHref: "ftp://x.org" }],
    });
    assert.ok(errors.primaryCtaHref);
    assert.ok(errors.defaultOgImage);
    assert.ok(errors.repoUrl);
    assert.ok(errors["socialLinks.1.href"]);
    assert.ok(errors["socialLinks.2.label"]);
    assert.ok(errors["socialLinks.2.href"]);
    assert.ok(errors["socialLinks.2.platform"]);
    assert.ok(errors["stateSites.0.code"]);
    assert.ok(errors["stateSites.0.name"]);
    assert.ok(errors["stateSites.0.websiteHref"]);
    assert.deepEqual(
      validateSiteConfigInput({
        primaryCtaHref: "/proposals/new/",
        repoUrl: "https://github.com/Fusion-Party-Aus/Engage",
        allowPublicIndexing: true,
      }),
      {},
    );
  });

  it("requires an administrator and rejects invalid input over the API", async () => {
    assert.equal((await call(patchSettings, "PATCH", {}, { "Content-Type": "application/json" })).status, 401);
    assert.equal((await call(patchSettings, "PATCH", {}, member)).status, 403);
    assert.equal((await call(getSettings, "GET", undefined, member)).status, 403);
    const bad = await call(patchSettings, "PATCH", { section: "social", socialLinks: [{ label: "x", href: "javascript:1" }] });
    assert.equal(bad.status, 422);
    assert.ok(((await bad.json()) as any).fieldErrors["socialLinks.0.href"]);
  });

  it("records who changed what, ignores infrastructure text, and can restore earlier values", async () => {
    const db = await getDatabase(env);
    const before = await getSiteConfig(db, env);
    const res = await call(patchSettings, "PATCH", {
      section: "visibility",
      primaryCtaLabel: "Have your say",
      backupSummary: "Edited claim that must be ignored",
    });
    assert.equal(res.status, 200);
    const payload = (await res.json()) as any;
    assert.equal(payload.config.primaryCtaLabel, "Have your say");
    assert.notEqual(payload.config.backupSummary, "Edited claim that must be ignored");
    const events = await listSiteConfigEvents(db);
    const event = events[0]!;
    assert.equal(event.section, "visibility");
    assert.equal(event.actorName, "Local Administrator");
    assert.deepEqual(event.changedFields, ["primaryCtaLabel"]);
    assert.equal(event.before.primaryCtaLabel, before.primaryCtaLabel);
    assert.equal(event.after.primaryCtaLabel, "Have your say");

    const restored = await call(restoreSettings, "POST", { eventId: event.eventId });
    assert.equal(restored.status, 200);
    assert.equal((await getSiteConfig(db, env)).primaryCtaLabel, before.primaryCtaLabel);
    assert.equal((await listSiteConfigEvents(db))[0]!.section, "restore");
    assert.equal((await call(restoreSettings, "POST", { eventId: "missing" })).status, 404);
  });

  it("does not log a change when nothing differs", async () => {
    const db = await getDatabase(env);
    const current = await getSiteConfig(db, env);
    const count = (await listSiteConfigEvents(db, 200)).length;
    await updateSiteConfig(db, env, "x", { primaryCtaLabel: current.primaryCtaLabel }, "X");
    assert.equal((await listSiteConfigEvents(db, 200)).length, count);
  });

  it("accepts every public site setting over the API and audits the change", async () => {
    const db = await getDatabase(env);
    const socialLinks = [
      { label: "Test Facebook", href: "https://www.facebook.com/EngageTest", platform: "facebook" },
    ];
    const stateSites = [
      { code: "NAT", name: "National test site", websiteHref: "https://national.example.org" },
    ];
    const res = await call(patchSettings, "PATCH", {
      allowPublicIndexing: true,
      publicPulsePollEnabled: true,
      defaultOgImage: "https://cdn.example.org/social.png",
      primaryCtaLabel: "Get involved",
      primaryCtaHref: "https://example.org/join",
      socialLinks,
      stateSites,
      repoUrl: "https://github.com/example/engage",
    });
    assert.equal(res.status, 200);
    const payload = (await res.json()) as any;
    assert.equal(payload.config.allowPublicIndexing, true);
    assert.equal(payload.config.publicPulsePollEnabled, true);
    assert.equal(payload.config.defaultOgImage, "https://cdn.example.org/social.png");
    assert.equal(payload.config.primaryCtaLabel, "Get involved");
    assert.equal(payload.config.primaryCtaHref, "https://example.org/join");
    assert.deepEqual(payload.config.socialLinks, socialLinks);
    assert.deepEqual(payload.config.stateSites, stateSites);
    assert.equal(payload.config.repoUrl, "https://github.com/example/engage");
    assert.deepEqual(payload.invalidFields, []);

    const event = (await listSiteConfigEvents(db))[0]!;
    assert.equal(event.actorName, "Local Administrator");
    for (const field of [
      "allowPublicIndexing",
      "publicPulsePollEnabled",
      "defaultOgImage",
      "primaryCtaLabel",
      "primaryCtaHref",
      "socialLinks",
      "stateSites",
      "repoUrl",
    ]) {
      assert.ok(event.changedFields.includes(field), `${field} should be audited`);
    }
    assert.equal((await getSiteConfig(db, env)).repoUrl, "https://github.com/example/engage");
  });

  it("accepts the operations section for the repository link", async () => {
    const db = await getDatabase(env);
    const res = await call(patchSettings, "PATCH", {
      section: "operations",
      repoUrl: "https://github.com/example/operations",
    });
    assert.equal(res.status, 200);
    const payload = (await res.json()) as any;
    assert.equal(payload.config.repoUrl, "https://github.com/example/operations");
    const event = (await listSiteConfigEvents(db))[0]!;
    assert.equal(event.section, "operations");
    assert.deepEqual(event.changedFields, ["repoUrl"]);
  });
});

describe("public site settings", () => {
  const devEnv = { APP_MODE: "development" } as const;

  it("ignores every removed environment fallback", () => {
    const cases: Array<{
      key: string;
      value: string;
      read: (config: ReturnType<typeof getDefaultSiteConfig>) => unknown;
      expected: unknown;
    }> = [
      {
        key: "ENGAGE_ALLOW_INDEXING",
        value: "true",
        read: (config) => config.allowPublicIndexing,
        expected: false,
      },
      {
        key: "ENGAGE_PUBLIC_PULSE_POLL",
        value: "true",
        read: (config) => config.publicPulsePollEnabled,
        expected: false,
      },
      {
        key: "ENGAGE_DEFAULT_OG_IMAGE",
        value: "https://env.example/og.png",
        read: (config) => config.defaultOgImage,
        expected: "/engage-og-card.png",
      },
      {
        key: "ENGAGE_PRIMARY_CTA_LABEL",
        value: "From the environment",
        read: (config) => config.primaryCtaLabel,
        expected: "Suggest an idea",
      },
      {
        key: "ENGAGE_PRIMARY_CTA_HREF",
        value: "https://env.example/cta",
        read: (config) => config.primaryCtaHref,
        expected: "/proposals/new/",
      },
      {
        key: "ENGAGE_SOCIAL_LINKS_JSON",
        value: JSON.stringify([{ label: "Env channel", href: "https://env.example/social" }]),
        read: (config) => config.socialLinks,
        expected: DEFAULT_SOCIAL_LINKS,
      },
      {
        key: "ENGAGE_STATE_SITES_JSON",
        value: JSON.stringify([{ code: "ENV", name: "Env branch", websiteHref: "https://env.example" }]),
        read: (config) => config.stateSites,
        expected: DEFAULT_STATE_SITES,
      },
      {
        key: "ENGAGE_REPO_URL",
        value: "https://gitlab.example/engage",
        read: (config) => config.repoUrl,
        expected: "https://github.com/Fusion-Party-Aus/Engage",
      },
    ];
    for (const { key, value, read, expected } of cases) {
      const config = getDefaultSiteConfig({ ...devEnv, [key]: value } as unknown as PlatformEnv);
      assert.deepEqual(read(config), expected, `${key} must have no effect`);
    }
  });

  it("still derives the indexing default from APP_MODE only", () => {
    const production = getDefaultSiteConfig({
      APP_MODE: "production",
      ENGAGE_ALLOW_INDEXING: "false",
    } as unknown as PlatformEnv);
    assert.equal(production.allowPublicIndexing, true);
    const development = getDefaultSiteConfig({
      APP_MODE: "development",
      ENGAGE_ALLOW_INDEXING: "true",
    } as unknown as PlatformEnv);
    assert.equal(development.allowPublicIndexing, false);
  });

  it("uses saved values for every setting", async () => {
    const db = createMemoryDb();
    const socialLinks = [
      { label: "Saved channel", href: "https://saved.example/social", platform: "website" },
    ];
    const stateSites = [
      { code: "NAT", name: "Saved branch", websiteHref: "https://saved.example" },
    ];
    await updateSiteConfig(
      db,
      devEnv,
      "admin-1",
      {
        allowPublicIndexing: true,
        publicPulsePollEnabled: true,
        defaultOgImage: "https://saved.example/og.png",
        primaryCtaLabel: "Saved action",
        primaryCtaHref: "https://saved.example/join",
        socialLinks,
        stateSites,
        repoUrl: "https://github.com/saved/engage",
      },
      "Saved Admin",
    );
    const config = await getSiteConfig(db, devEnv);
    assert.equal(config.allowPublicIndexing, true);
    assert.equal(config.publicPulsePollEnabled, true);
    assert.equal(config.defaultOgImage, "https://saved.example/og.png");
    assert.equal(config.primaryCtaLabel, "Saved action");
    assert.equal(config.primaryCtaHref, "https://saved.example/join");
    assert.deepEqual(config.socialLinks, socialLinks);
    assert.deepEqual(config.stateSites, stateSites);
    assert.equal(config.repoUrl, "https://github.com/saved/engage");
  });

  it("uses the code defaults when nothing has been saved", async () => {
    const config = await getSiteConfig(createMemoryDb(), devEnv);
    const defaults = getDefaultSiteConfig(devEnv);
    assert.deepEqual(config, defaults);
  });

  it("falls back to defaults and names invalid saved values instead of crashing", async () => {
    const db = createMemoryDb();
    await db.collection("site_settings").insertOne({
      configId: "global",
      allowPublicIndexing: "yes",
      publicPulsePollEnabled: "yes",
      defaultOgImage: "javascript:alert(1)",
      primaryCtaLabel: "x".repeat(60),
      primaryCtaHref: "javascript:alert(1)",
      socialLinks: [{ label: "", href: "javascript:alert(1)" }],
      stateSites: [{ code: "!", name: "", websiteHref: "ftp://invalid.example" }],
      repoUrl: "javascript:alert(1)",
    });
    const state = await getSiteConfigState(db, devEnv);
    const defaults = getDefaultSiteConfig(devEnv);
    assert.equal(state.readFailed, false);
    assert.equal(state.config.allowPublicIndexing, defaults.allowPublicIndexing);
    assert.equal(state.config.publicPulsePollEnabled, defaults.publicPulsePollEnabled);
    assert.equal(state.config.defaultOgImage, defaults.defaultOgImage);
    assert.equal(state.config.primaryCtaLabel, defaults.primaryCtaLabel);
    assert.equal(state.config.primaryCtaHref, defaults.primaryCtaHref);
    assert.deepEqual(state.config.socialLinks, defaults.socialLinks);
    assert.deepEqual(state.config.stateSites, defaults.stateSites);
    assert.equal(state.config.repoUrl, defaults.repoUrl);
    for (const field of [
      "allowPublicIndexing",
      "publicPulsePollEnabled",
      "defaultOgImage",
      "primaryCtaLabel",
      "primaryCtaHref",
      "socialLinks",
      "stateSites",
      "repoUrl",
    ]) {
      assert.ok(
        state.invalidFields.some((invalid) => invalid === field || invalid.startsWith(`${field}.`)),
        `${field} should be reported as invalid`,
      );
    }
  });
});

describe("branch workspace APIs", () => {
  it("scopes membership lists and typeahead to the caller's authority", async () => {
    assert.equal((await call(listMemberships, "GET", undefined, { "Content-Type": "application/json" }, "/api/admin/branches/memberships")).status, 401);
    assert.equal((await call(listMemberships, "GET", undefined, member, "/api/admin/branches/memberships")).status, 403);
    assert.equal((await call(searchBranches, "GET", undefined, member, "/api/admin/branches/search?type=member&q=ab")).status, 403);
    assert.equal((await call(searchBranches, "GET", undefined, admin, "/api/admin/branches/search?type=other")).status, 400);
    const ok = await call(listMemberships, "GET", undefined, admin, "/api/admin/branches/memberships");
    assert.equal(ok.status, 200);
  });

  it("enforces branch hierarchy kinds on the server", async () => {
    const post = (body: unknown) => call(createBranch, "POST", body, admin, "/api/admin/branches");
    const national = await post({ branchId: `n-${crypto.randomUUID()}`, name: "N", kind: "national" });
    assert.equal(national.status, 201);
    const nationalId = ((await national.json()) as any).branch.branchId;
    const state = await post({ branchId: `s-${crypto.randomUUID()}`, name: "S", kind: "state", parentBranchId: nationalId });
    assert.equal(state.status, 201);
    const stateId = ((await state.json()) as any).branch.branchId;
    assert.equal((await post({ name: "Bad", kind: "constituent", parentBranchId: nationalId })).status, 400);
    assert.equal((await post({ name: "Bad", kind: "state", parentBranchId: stateId })).status, 400);
    assert.equal((await post({ name: "Local", kind: "constituent", parentBranchId: stateId })).status, 201);
  });
});
