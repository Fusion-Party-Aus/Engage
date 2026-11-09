import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getDatabase } from "./db.ts";
import {
  getSiteConfig,
  listSiteConfigEvents,
  updateSiteConfig,
  validateSiteConfigInput,
} from "./site-config.ts";
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
      socialLinks: [
        { label: "FB", href: "https://www.facebook.com/x", platform: "facebook" },
        { label: "Dup", href: "https://www.facebook.com/x", platform: "facebook" },
        { label: "", href: "not a url", platform: "myspace" },
      ],
      stateSites: [{ code: "V1C", name: "", websiteHref: "ftp://x.org" }],
    });
    assert.ok(errors.primaryCtaHref);
    assert.ok(errors.defaultOgImage);
    assert.ok(errors["socialLinks.1.href"]);
    assert.ok(errors["socialLinks.2.label"]);
    assert.ok(errors["socialLinks.2.href"]);
    assert.ok(errors["socialLinks.2.platform"]);
    assert.ok(errors["stateSites.0.code"]);
    assert.ok(errors["stateSites.0.name"]);
    assert.ok(errors["stateSites.0.websiteHref"]);
    assert.deepEqual(validateSiteConfigInput({ primaryCtaHref: "/proposals/new/", allowPublicIndexing: true }), {});
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
