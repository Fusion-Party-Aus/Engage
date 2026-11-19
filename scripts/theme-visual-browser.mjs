/**
 * Read-only visual smoke checks against a disposable, in-memory preview.
 * Build first. Then run `node scripts/theme-visual-browser.mjs`.
 * Optional: --suite public|admin|all, --root PATH, --out PATH, --port NUMBER,
 * --label NAME, --only comma-separated-case-names, --viewports mobile,tablet,desktop.
 * --previews PATH exports four desktop JPEG views; --preview-mobile adds two mobile views.
 * ENGAGE_PLAYWRIGHT_MODULE may point to an externally installed Playwright module,
 * matching the existing browser harnesses. No database or provider secrets are inherited.
 * Missing seeded detail records are reported as unavailable, never as passes.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const appRoot = path.resolve(argument("root", process.cwd()));
const output = path.resolve(argument("out", path.join(appRoot, "docs/screenshots/theme")));
const previewDirectory = argument("previews", "") ? path.resolve(argument("previews", "")) : null;
const previewMobile = process.argv.includes("--preview-mobile");
const label = argument("label", "current");
const suite = argument("suite", "public");
if (!["public", "admin", "all"].includes(suite)) throw new Error("Invalid suite");
const only = argument("only", "").split(",").filter(Boolean);
const viewportNames = argument("viewports", "").split(",").filter(Boolean);
const port = Number(argument("port", "4408"));
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid test port");
const origin = `http://127.0.0.1:${port}`;
const normalisePath = (value) => new URL(value, origin).pathname.replace(/\/+$/, "");
const modulePath = process.env.ENGAGE_PLAYWRIGHT_MODULE;
const { chromium } = await import(modulePath ? pathToFileURL(path.resolve(modulePath)).href : "playwright");
await readFile(path.join(appRoot, "dist/server/entry.mjs"));
await mkdir(output, { recursive: true });
if (previewDirectory) await mkdir(previewDirectory, { recursive: true });

async function clientBundleSizes(directory) {
  const result = { files: 0, rawBytes: 0, gzipBytes: 0 };
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await clientBundleSizes(name);
      for (const key of Object.keys(result)) result[key] += nested[key];
    } else if (entry.name.endsWith(".js")) {
      const bytes = await readFile(name);
      result.files += 1;
      result.rawBytes += bytes.byteLength;
      result.gzipBytes += gzipSync(bytes).byteLength;
    }
  }
  return result;
}

// Explicit allowlist: no inherited database, provider, CRM or production secrets.
const env = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]
    .filter((key) => process.env[key])
    .map((key) => [key, process.env[key]]),
);
Object.assign(env, {
  NODE_ENV: "production",
  APP_MODE: "preview",
  MONGODB_URI: "",
  MONGODB_DB_NAME: "",
  HOST: "127.0.0.1",
  PORT: String(port),
  ASTRO_NODE_LOGGING: "disabled",
  PUBLIC_ORIGIN: origin,
  BETTER_AUTH_URL: origin,
  BETTER_AUTH_SECRET: "isolated-visual-check-secret-no-production-use",
  SESSION_SECRET: "isolated-visual-check-session-no-production-use",
  LEGAL_ACCEPTANCE_ENABLED: "false",
  TURNSTILE_ENFORCEMENT: "off",
});
const server = spawn(process.execPath, ["dist/server/entry.mjs"], {
  cwd: appRoot,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (chunk) => { serverLog += chunk; });
server.stderr.on("data", (chunk) => { serverLog += chunk; });
let browser;
let report;
const results = [];
const unavailable = [];
const deadline = setTimeout(() => {
  console.error("Visual check exceeded 10 minutes");
  server.kill("SIGTERM");
  void browser?.close();
  process.exitCode = 1;
}, 600_000);

try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Synthetic preview exited ${server.exitCode}: ${serverLog}`);
    try {
      if ((await fetch(`${origin}/member/`)).ok) { ready = true; break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error(`Synthetic preview did not start: ${serverLog}`);
  browser = await chromium.launch({ headless: true });
  const pages = [];
  if (suite !== "admin") pages.push(
    { name: "home", route: "/", actor: "guest" },
    { name: "proposals", route: "/proposals/", actor: "guest" },
    { name: "sense-box", route: "/sense-box/", actor: "guest" },
    { name: "collaborate", route: "/collaborate/", actor: "guest" },
    { name: "policies", route: "/policies/", actor: "guest" },
    { name: "branches", route: "/branches/", actor: "guest" },
    { name: "how-it-works", route: "/how-it-works/", actor: "guest" },
    { name: "sign-in", route: "/member/", actor: "guest" },
    { name: "member-dashboard", route: "/member/", actor: "member" },
    { name: "member-home", route: "/", actor: "member" },
  );
  // Use the existing API contract, never infer ballot state from styling.
  const response = await fetch(`${origin}/api/proposals?stage=decide&limit=100`, {
    headers: { Cookie: "engage_dev_user=member" },
  });
  if (!response.ok) throw new Error(`Seeded proposal list returned ${response.status}`);
  const list = await response.json();
  const proposal = list.proposals?.find((item) => item.stage === "decide" && item.slug);
  const ballotRoute = proposal ? `/proposals/${encodeURIComponent(proposal.slug)}/` : null;
  if (suite !== "admin") {
    pages.push({ name: "admin-overview", route: "/admin/", actor: "administrator", admin: true });
    if (ballotRoute) pages.push({ name: "ballot", route: ballotRoute, actor: "member" });
    else unavailable.push({ name: "ballot", reason: "No seeded Decide proposal is available" });
  }

  if (suite !== "public") {
    for (const [name, route] of [
      ["admin-overview", "/admin/"],
      ["admin-ballots", "/admin/ballots/"],
      ["admin-branches", "/admin/branches/"],
      ["admin-collaboration", "/admin/collaboration/"],
      ["admin-collaboration-operations", "/admin/collaboration/operations/"],
      ["admin-invitations", "/admin/collaboration/invitation/"],
      ["admin-new-invitation", "/admin/collaboration/invitation/new/"],
      ["admin-engagement", "/admin/engagement/"],
      ["admin-members", "/admin/members/"],
      ["admin-migrations", "/admin/migrations/"],
      ["admin-policies", "/admin/policies/"],
      ["admin-proposals", "/admin/proposals/"],
      ["admin-reports", "/admin/reports/"],
      ["admin-responsibilities", "/admin/responsibilities/"],
      ["admin-roles", "/admin/roles/"],
      ["admin-sense-box", "/admin/sense-box/"],
      ["admin-settings", "/admin/settings/"],
    ]) {
      if (!pages.some((item) => item.name === name)) pages.push({ name, route, actor: "administrator", admin: true });
    }
    if (proposal) pages.push({ name: "admin-proposal-detail", route: `/admin/proposals/${encodeURIComponent(proposal.slug)}/`, actor: "administrator", admin: true });
    else unavailable.push({ name: "admin-proposal-detail", reason: "No seeded proposal is available" });

    // Discover real seeded detail URLs from list markup; do not create records.
    for (const item of [
      { name: "admin-invitation-detail", route: "/admin/collaboration/invitation/", prefix: "/admin/collaboration/invitation/" },
      { name: "admin-sense-detail", route: "/admin/sense-box/", prefix: "/admin/sense-box/" },
    ]) {
      const discovery = await fetch(`${origin}${item.route}`, { headers: { Cookie: "engage_dev_user=administrator" } });
      const html = await discovery.text();
      const route = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]).find((href) => (
        href.startsWith(item.prefix)
        && normalisePath(href) !== normalisePath(item.prefix)
        && normalisePath(href) !== normalisePath(`${item.prefix}new/`)
      ));
      if (discovery.ok && route) pages.push({ name: item.name, route, actor: "administrator", admin: true });
      else unavailable.push({ name: item.name, reason: discovery.ok ? "No existing seeded detail record; read-only run does not create one" : `List route returned ${discovery.status}` });
    }
    pages.push(
      { name: "admin-guest-denied", route: "/admin/", expectedRoute: "/member/", actor: "guest", denial: "sign-in" },
      { name: "admin-member-denied", route: "/admin/", actor: "member", denial: "forbidden" },
      { name: "admin-settings-member-denied", route: "/admin/settings/", expectedRoute: "/admin/", actor: "member", denial: "forbidden" },
    );
  }

  const viewports = [
    { name: "mobile", width: 390, height: 844 },
    { name: "tablet", width: 820, height: 1180 },
    { name: "desktop", width: 1440, height: 1000 },
  ];
  for (const viewport of viewports) {
    if (viewportNames.length && !viewportNames.includes(viewport.name)) continue;
    for (const item of pages) {
      if (only.length && !only.includes(item.name)) continue;
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1, reducedMotion: "reduce" });
      const externalRequests = [];
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) {
          externalRequests.push({ url: url.href, type: route.request().resourceType() });
          await route.fulfill({ status: 204, body: "" });
        } else await route.continue();
      });
      if (item.actor !== "guest") await context.addCookies([{ name: "engage_dev_user", value: item.actor, url: origin }]);
      const page = await context.newPage();
      const errors = [], consoleErrors = [], failedRequests = [], badResponses = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
      page.on("requestfailed", (request) => failedRequests.push({ url: request.url(), reason: request.failure()?.errorText }));
      page.on("response", (entry) => {
        if (entry.status() >= 400 && new URL(entry.url()).origin === origin) badResponses.push({ url: entry.url(), status: entry.status(), document: entry.request().resourceType() === "document" });
      });
      let status = null, navigationError = null, inspection = {};
      try {
        const navigation = await page.goto(`${origin}${item.route}`, { waitUntil: "networkidle", timeout: 30_000 });
        status = navigation?.status() ?? null;
        await page.evaluate(async () => {
          await document.fonts.ready;
          for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight) {
            scrollTo(0, y);
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          await Promise.all([...document.images].map((image) => image.decode().catch(() => {})));
          scrollTo(0, 0);
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        inspection = await page.evaluate(() => ({
          title: document.title,
          h1: [...document.querySelectorAll("h1")].map((element) => element.textContent.trim()),
          adminShell: document.querySelectorAll("[data-admin-shell]").length === 1,
          adminNavigation: document.querySelectorAll('nav[aria-label="Administration"]').length === 1,
          alerts: [...document.querySelectorAll('[role="alert"]')].map((element) => element.textContent.trim()),
          viewportWidth: innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
          brokenImages: [...document.images].filter((image) => !image.complete || image.naturalWidth === 0).map((image) => ({ src: image.currentSrc || image.src, alt: image.alt })),
          renderedImages: [...document.images].map((image) => {
            const box = image.getBoundingClientRect(), style = getComputedStyle(image);
            const resource = performance.getEntriesByName(image.currentSrc).find((entry) => entry.entryType === "resource");
            return { src: image.currentSrc || image.src, alt: image.alt, naturalWidth: image.naturalWidth, width: box.width, height: box.height, opacity: style.opacity, visibility: style.visibility, transferSize: resource?.transferSize ?? null, encodedBodySize: resource?.encodedBodySize ?? null, decodedBodySize: resource?.decodedBodySize ?? null };
          }),
          resources: performance.getEntriesByType("resource").filter((entry) => ["script", "css", "img"].includes(entry.initiatorType)).map((entry) => ({ url: entry.name, type: entry.initiatorType, transferSize: entry.transferSize, encodedBodySize: entry.encodedBodySize, decodedBodySize: entry.decodedBodySize })),
        }));
        // Retain an actual viewport image as well as full-page context. Some
        // headless builds omit composited image layers in full-page captures.
        const basename = `${item.name}-${viewport.name}`;
        await page.screenshot({ path: path.join(output, `${basename}-viewport.png`) });
        if (previewDirectory && (
          (viewport.name === "desktop" && ["home", "member-dashboard", "ballot", "admin-overview"].includes(item.name))
          || (previewMobile && viewport.name === "mobile" && ["home", "ballot"].includes(item.name))
        )) await page.screenshot({ path: path.join(previewDirectory, `${label}-${basename}.jpg`), type: "jpeg", quality: 88 });
        await page.screenshot({ path: path.join(output, `${basename}.png`), fullPage: true });
      } catch (error) { navigationError = error.message; }
      const record = { ...item, viewport, status, finalUrl: page.url(), ...inspection, navigationError, errors, consoleErrors, failedRequests, badResponses, externalRequests };
      record.expectedRouteReached = normalisePath(record.finalUrl) === normalisePath(item.expectedRoute || item.route);
      const expectedStatus = item.denial === "forbidden" ? 403 : 200;
      const unexpectedResponses = badResponses.filter((entry) => !(item.denial === "forbidden" && entry.document && entry.status === 403));
      // The browser's generic console line for an intentional 403 remains in
      // evidence, but is not a regression in the explicit permission-denial case.
      const unexpectedConsole = consoleErrors.filter((message) => !(item.denial === "forbidden" && /Failed to load resource.*403/.test(message)));
      // The existing member-denial contract is a 403 overview with an access
      // alert inside AdminLayout; settings redirects there before rendering.
      const shellCorrect = item.admin ? inspection.adminShell && inspection.adminNavigation
        : item.denial === "sign-in" ? !inspection.adminShell
        : item.denial === "forbidden" ? inspection.adminShell && (inspection.alerts || []).some((alert) => /don.t have access to this administration area/i.test(alert))
        : true;
      record.passed = status === expectedStatus && record.expectedRouteReached && shellCorrect && !navigationError && !inspection.horizontalOverflow && !(inspection.brokenImages || []).length && !errors.length && !unexpectedConsole.length && !failedRequests.length && !unexpectedResponses.length;
      results.push(record);
      console.log(JSON.stringify({ label, page: item.name, viewport: viewport.name, status, passed: record.passed, expectedRouteReached: record.expectedRouteReached, adminShell: inspection.adminShell, overflow: inspection.horizontalOverflow, brokenImages: (inspection.brokenImages || []).length, errors: errors.length + consoleErrors.length, responseFailures: badResponses.length }));
      await context.close();
    }
  }
  report = {
    label, suite, syntheticAccountsOnly: true, productionAccess: false, mongoMode: "in-memory",
    browserVersion: browser.version(), deviceScaleFactor: 1, ballotDiscovered: ballotRoute, unavailable,
    cases: results.length, passed: results.filter((item) => item.passed).length,
    clientJavascript: await clientBundleSizes(path.join(appRoot, "dist/client")),
    payloadNote: "Built client asset totals and local browser resource sizes; not a network-performance benchmark or real-database test.",
    results,
  };
  if (!report.cases || report.passed !== report.cases || unavailable.length) process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await browser?.close();
  server.kill("SIGTERM");
  const suffix = only.length ? `-${only.join("-")}` : `-${suite}`;
  await writeFile(path.join(output, `server${suffix}.log`), serverLog);
  await writeFile(path.join(output, `report${suffix}.json`), JSON.stringify(report || { label, incomplete: true, results, unavailable }, null, 2) + "\n");
}
