// Perimeter security browser verification.
//
// Runs the production build with a disposable in-memory database and checks,
// with a real Chromium:
//
//   1. No CSP violations, console errors or blocked resources on the home,
//      proposal, sign-in and Sense Box pages.
//   2. The Turnstile script and frame and the Plausible script and endpoint are
//      allowed by the policy (requests reach the network layer).
//   3. Same-origin fetches and native form posts succeed, and cross-origin
//      state-changing requests are refused.
//
// This script never contacts production: Cloudflare and Plausible requests are
// intercepted and answered locally. Playwright is supplied through
// ENGAGE_PLAYWRIGHT_MODULE, as in CI.
//
// It is safe to run in CI: an overall deadline fails the step instead of
// hanging the job, and Chromium and the preview server are always stopped, on
// success and on every failure. Any assertion, console error, page error,
// failed request or CSP violation exits non-zero.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const modulePath = process.env.ENGAGE_PLAYWRIGHT_MODULE;
if (!modulePath) {
  throw new Error(
    "Set ENGAGE_PLAYWRIGHT_MODULE to an isolated Playwright index.mjs.",
  );
}

const { chromium } = await import(pathToFileURL(modulePath).href);

const port = Number(process.env.ENGAGE_PREVIEW_PORT || 4399);
// `localhost` is used so the Astro adapter's request origin matches the page
// origin. 127.0.0.1 is the cross-origin target for the rejection check.
const origin = `http://localhost:${port}`;
const foreignOrigin = `http://127.0.0.1:${port}`;
const cronSecret = "perimeter-browser-cron-secret";
const turnstileSiteKey = "1x00000000000000000000AA";

// A hung page, browser or server must fail the step rather than occupy the
// runner. 180 s is several times the observed runtime of a healthy run.
const timeoutMs = Number(process.env.ENGAGE_PERIMETER_TIMEOUT_MS ?? 180_000);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  throw new Error("ENGAGE_PERIMETER_TIMEOUT_MS must be a positive number.");
}
const cleanupBudgetMs = 10_000;

async function withDeadline(label, ms, work) {
  let timer;
  try {
    return await Promise.race([
      work(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not finish within ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const server = spawn(process.execPath, ["dist/server/entry.mjs"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    APP_MODE: "preview",
    MONGODB_URI: "",
    MONGODB_DB_NAME: "",
    HOST: "0.0.0.0",
    PORT: String(port),
    ASTRO_NODE_LOGGING: "disabled",
    PUBLIC_ORIGIN: origin,
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: "perimeter-browser-secret-not-used-in-production",
    ENGAGE_CRM_VERIFICATION_CRON_SECRET: cronSecret,
    LEGAL_ACCEPTANCE_ENABLED: "false",
    PUBLIC_TURNSTILE_SITE_KEY: turnstileSiteKey,
    // Render the widget in the preview. No protected form is submitted, and
    // Cloudflare itself is intercepted, so this never contacts the real
    // service or weakens production behaviour.
    TURNSTILE_ENFORCEMENT: "on",
    TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
  },
});
let serverOutput = "";
server.stdout.on("data", (chunk) => (serverOutput += chunk));
server.stderr.on("data", (chunk) => (serverOutput += chunk));

const results = [];
const openedPages = [];
let browser;
let shuttingDown = false;
let timedOut = false;

const deadline = setTimeout(() => {
  timedOut = true;
  // Set immediately so no exit path can report success after the deadline.
  process.exitCode = 1;
  console.error(
    `Perimeter verification exceeded ${timeoutMs} ms; stopping and failing.`,
  );
  void cleanup().finally(() => process.exit(1));
}, timeoutMs);

// Last-resort guard: pages closed by the deadline can reject an in-flight
// browser call, and that exception can unwind before the async cleanup reaches
// the server. A synchronous kill on exit always stops the child.
process.on("exit", () => {
  if (server.exitCode === null && server.signalCode === null) {
    server.kill("SIGKILL");
  }
});

async function stopServer() {
  if (server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise((resolve) => server.once("exit", resolve));
  server.kill("SIGTERM");
  try {
    await withDeadline("Preview server shutdown", 5_000, () => exited);
  } catch {
    server.kill("SIGKILL");
    await withDeadline("Preview server kill", 5_000, () => exited).catch(() => {});
  }
}

// Idempotent so the deadline and the `finally` cannot fight over the same
// process handles. Every await is bounded.
async function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(deadline);
  // Signal the server before any await, so no exit path leaves it running.
  if (server.exitCode === null && server.signalCode === null) {
    server.kill("SIGTERM");
  }
  if (browser) {
    await withDeadline("Chromium shutdown", cleanupBudgetMs, () => browser.close())
      .catch((error) => console.error(`Chromium did not close cleanly: ${error.message}`));
  }
  await stopServer().catch((error) =>
    console.error(`Preview server did not stop cleanly: ${error.message}`),
  );
}

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(`${origin}/`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Preview server did not start:\n${serverOutput}`);
}

const CSP_HOSTS = ["challenges.cloudflare.com", "analytics.fusionparty.org.au"];

function assertPerimeterHeaders(headers, label) {
  assert.equal(headers["x-content-type-options"], "nosniff", label);
  assert.equal(
    headers["referrer-policy"],
    "strict-origin-when-cross-origin",
    label,
  );
  assert.equal(headers["x-frame-options"], "DENY", label);
  assert.equal(
    headers["permissions-policy"],
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    label,
  );
  assert.equal(
    headers["strict-transport-security"],
    undefined,
    `${label}: HSTS must be absent outside production HTTPS`,
  );
}

function assertDocumentPolicy(headers, label) {
  const policy = headers["content-security-policy"];
  assert.ok(policy, `${label}: missing content-security-policy`);
  for (const directive of [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "style-src-attr 'unsafe-inline'",
  ]) {
    assert.ok(policy.includes(directive), `${label}: missing ${directive}`);
  }
  for (const host of CSP_HOSTS) {
    assert.ok(policy.includes(host), `${label}: missing host ${host}`);
  }
  assert.match(policy, /script-src [^;]*challenges\.cloudflare\.com/);
  assert.match(policy, /script-src [^;]*analytics\.fusionparty\.org\.au/);
  assert.match(policy, /connect-src [^;]*challenges\.cloudflare\.com/);
  assert.match(policy, /connect-src [^;]*analytics\.fusionparty\.org\.au/);
  assert.match(policy, /frame-src [^;]*challenges\.cloudflare\.com/);
  assert.equal(/unsafe-eval/.test(policy), false, `${label}: unsafe-eval`);
  assert.equal(
    /script-src[^;]*unsafe-inline/.test(policy),
    false,
    `${label}: script-src must not allow unsafe-inline`,
  );
}

try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });

  // The interception records prove the policy allowed the request to leave the
  // renderer; a CSP-blocked request never reaches Playwright's route handler.
  const intercepted = { turnstile: [], plausible: [], frames: [] };
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route("https://challenges.cloudflare.com/**", async (route) => {
    const url = route.request().url();
    intercepted.turnstile.push(url);
    if (url.includes("/turnstile/v0/api.js")) {
      await route.fulfill({
        status: 200,
        contentType: "text/javascript",
        body: `window.turnstile = { render: function (element) { element.innerHTML = '<div data-test-turnstile="ready">Verified</div>'; return 'test-widget'; }, remove: function () {} };`,
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>Turnstile test frame</title><p>frame</p>",
    });
  });
  await context.route("https://analytics.fusionparty.org.au/**", async (route) => {
    const url = route.request().url();
    intercepted.plausible.push(url);
    if (url.includes("/api/event")) {
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        headers: { "access-control-allow-origin": origin },
        body: "{}",
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: "window.__plausibleScriptLoaded = true;",
    });
  });

  async function openPage(path) {
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const consoleErrors = [];
    const pageErrors = [];
    const failedRequests = [];
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      if (/Content Security Policy|Refused to/i.test(text)) {
        consoleErrors.push(text);
      }
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("requestfailed", (request) => {
      const failure = request.failure()?.errorText ?? "";
      if (!failure.includes("ERR_ABORTED")) {
        failedRequests.push(`${request.url()} ${failure}`);
      }
    });
    await page.addInitScript(() => {
      window.__cspViolations = [];
      document.addEventListener("securitypolicyviolation", (event) => {
        window.__cspViolations.push({
          directive: event.effectiveDirective,
          blocked: event.blockedURI,
        });
      });
    });
    const response = await page.goto(origin + path, {
      waitUntil: "networkidle",
    });
    assert.ok(response, `${path}: no document response`);
    const opened = { page, response, consoleErrors, pageErrors, failedRequests };
    openedPages.push({
      label: path,
      page,
      consoleErrors,
      pageErrors,
      failedRequests,
    });
    return opened;
  }

  async function violations(page) {
    return page.evaluate(() => window.__cspViolations ?? []);
  }

  async function assertClean(label, opened) {
    assert.deepEqual(opened.consoleErrors, [], `${label}: CSP console errors`);
    assert.deepEqual(opened.pageErrors, [], `${label}: page errors`);
    assert.deepEqual(opened.failedRequests, [], `${label}: failed requests`);
    assert.deepEqual(await violations(opened.page), [], `${label}: CSP violations`);
  }

  // 1. Public pages render under the policy.
  const listResponse = await fetch(`${origin}/api/proposals`);
  const { proposals } = await listResponse.json();
  const slug = proposals?.[0]?.slug;
  assert.ok(slug, "seeded proposal slug missing");

  const home = await openPage("/");
  assertPerimeterHeaders(home.response.headers(), "home");
  assertDocumentPolicy(home.response.headers(), "home");
  await assertClean("home", home);
  results.push({ page: "/", violations: 0 });

  const proposal = await openPage(`/proposals/${slug}/`);
  assertDocumentPolicy(proposal.response.headers(), "proposal");
  await assertClean("proposal", proposal);
  results.push({ page: `/proposals/${slug}/`, violations: 0 });

  const signin = await openPage("/member/");
  assertDocumentPolicy(signin.response.headers(), "sign-in");
  await assertClean("sign-in", signin);
  results.push({ page: "/member/", violations: 0 });

  const senseBox = await openPage("/sense-box/");
  assertDocumentPolicy(senseBox.response.headers(), "sense-box");
  await assertClean("sense-box", senseBox);
  results.push({ page: "/sense-box/", violations: 0 });

  // 2. Turnstile: the widget script is loaded by the island (site key set) and
  // a widget frame is allowed. Both are answered locally.
  await senseBox.page.waitForFunction(
    () =>
      document.querySelector("[data-turnstile-action] [data-test-turnstile]") !==
      null,
    undefined,
    { timeout: 20_000 },
  );
  assert.ok(
    intercepted.turnstile.some((url) => url.includes("/turnstile/v0/api.js")),
    "Turnstile script was not requested (CSP-blocked?)",
  );
  await senseBox.page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const frame = document.createElement("iframe");
        frame.src =
          "https://challenges.cloudflare.com/turnstile/v0/test-perimeter-frame";
        frame.onload = () => resolve();
        frame.onerror = () => reject(new Error("Turnstile frame failed"));
        document.body.appendChild(frame);
      }),
  );
  await senseBox.page.waitForTimeout(250);
  assert.ok(
    intercepted.turnstile.some((url) => url.includes("test-perimeter-frame")),
    "Turnstile frame was not requested (CSP-blocked?)",
  );
  await assertClean("turnstile", senseBox);
  results.push({
    turnstileScriptRequests: intercepted.turnstile.filter((url) =>
      url.includes("api.js"),
    ).length,
    turnstileFrameRequests: intercepted.turnstile.filter((url) =>
      url.includes("test-perimeter-frame"),
    ).length,
  });

  // 3. Plausible: the hosted tracker script and the event endpoint.
  const plausible = await home.page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://analytics.fusionparty.org.au/js/script.js";
      script.onload = resolve;
      script.onerror = () => reject(new Error("analytics script blocked"));
      document.head.appendChild(script);
    });
    const response = await fetch(
      "https://analytics.fusionparty.org.au/api/event",
      {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ n: "pageview", u: location.href }),
      },
    );
    return {
      scriptLoaded: window.__plausibleScriptLoaded === true,
      eventStatus: response.status,
      eventOk: response.ok,
    };
  });
  assert.equal(plausible.scriptLoaded, true, "Plausible script did not execute");
  assert.equal(plausible.eventOk, true, "Plausible event fetch failed");
  await assertClean("plausible", home);
  assert.ok(
    intercepted.plausible.some((url) => url.includes("/js/script.js")),
    "Plausible script was not requested (CSP-blocked?)",
  );
  assert.ok(
    intercepted.plausible.some((url) => url.includes("/api/event")),
    "Plausible event endpoint was not requested (CSP-blocked?)",
  );
  results.push({
    plausibleScriptRequests: intercepted.plausible.filter((url) =>
      url.includes("/js/script.js"),
    ).length,
    plausibleEventRequests: intercepted.plausible.filter((url) =>
      url.includes("/api/event"),
    ).length,
    plausibleEventStatus: plausible.eventStatus,
  });

  // 4. Headers on a JSON API response.
  const api = await context.request.get(`${origin}/api/proposals`);
  assert.equal(api.status(), 200);
  const apiHeaders = api.headers();
  assertPerimeterHeaders(apiHeaders, "api");
  assert.equal(
    apiHeaders["content-security-policy"],
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
  results.push({ api: "/api/proposals", headers: true });

  // 5. Same-origin fetch succeeds.
  const sameOriginStatus = await home.page.evaluate(async () => {
    const response = await fetch("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(sameOriginStatus.status, 200);
  assert.equal(sameOriginStatus.body.ok, true);
  results.push({ sameOriginFetchPost: sameOriginStatus.status });

  // 6. A native same-origin form post is still accepted (Astro's check plus
  // this middleware). The member preference form is the only native POST.
  const memberContext = await browser.newContext();
  await memberContext.addCookies([
    { name: "engage_dev_user", value: "member", url: origin },
  ]);
  const memberPage = await memberContext.newPage();
  await memberPage.goto(`${origin}/member/`, { waitUntil: "networkidle" });
  const formResponse = memberPage.waitForResponse(
    (response) =>
      response.url().includes("/api/email/preferences") &&
      response.request().method() === "POST",
    { timeout: 20_000 },
  );
  await memberPage.evaluate(() => {
    const form = document.createElement("form");
    form.method = "post";
    form.action = "/api/email/preferences";
    form.innerHTML =
      '<input type="hidden" name="category" value="engage">' +
      '<input type="hidden" name="digestEnabled" value="true">';
    document.body.appendChild(form);
    form.submit();
  });
  const saved = await formResponse;
  assert.notEqual(saved.status(), 403, "same-origin native form post was refused");
  assert.equal(saved.status(), 303);
  await memberContext.close();
  results.push({ sameOriginNativeFormPost: saved.status() });

  // 7. Cross-origin state-changing requests are refused. The browser request
  // comes from a page with no CSP of its own, so it reaches the server and the
  // server's 403 is observable. The remaining cases exercise the middleware
  // rule directly so the 403 body and missing-Origin cases are observable.
  const probeOrigin = `http://127.0.0.1:${port + 1}`;
  const probeServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><body>cross-origin probe</body></html>");
  });
  await new Promise((resolve) => probeServer.listen(port + 1, "127.0.0.1", resolve));
  const probeContext = await browser.newContext();
  const probePage = await probeContext.newPage();
  await probePage.goto(`${probeOrigin}/`, { waitUntil: "domcontentloaded" });
  const crossOriginResponse = probePage.waitForResponse(
    (response) =>
      response.url().startsWith(`${foreignOrigin}/api/sense-box`) &&
      response.request().method() === "POST",
    { timeout: 20_000 },
  );
  await probePage.evaluate((target) => {
    void fetch(`${target}/api/sense-box`, {
      method: "POST",
      mode: "no-cors",
      headers: { "content-type": "text/plain" },
      body: "cross-site",
    }).catch(() => {});
  }, foreignOrigin);
  const crossOrigin = await crossOriginResponse;
  assert.equal(crossOrigin.status(), 403);
  await probeContext.close();
  await new Promise((resolve) => probeServer.close(resolve));
  results.push({
    browserCrossOriginFetchPost: crossOrigin.status(),
    crossOriginFrom: probeOrigin,
  });

  const jsonCrossOrigin = await fetch(`${origin}/api/sense-box`, {
    method: "POST",
    headers: {
      origin: "https://attacker.example",
      "content-type": "application/json",
      "sec-fetch-site": "cross-site",
    },
    body: "{}",
  });
  assert.equal(jsonCrossOrigin.status, 403);
  assert.equal(await jsonCrossOrigin.text(), "Cross-site request blocked.");
  results.push({ jsonCrossOriginPost: jsonCrossOrigin.status });

  const cookieWithoutOrigin = await fetch(`${origin}/api/session`, {
    method: "POST",
    headers: {
      cookie: "engage_dev_user=member",
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
    },
    body: "{}",
  });
  assert.equal(cookieWithoutOrigin.status, 403);
  results.push({ sessionCookieWithoutOrigin: cookieWithoutOrigin.status });

  const serverToServer = await fetch(`${origin}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(serverToServer.status, 200);
  results.push({ serverToServerWithoutOrigin: serverToServer.status });

  const cron = await fetch(`${origin}/api/cron/membership-verification`, {
    method: "POST",
    headers: { authorization: `Bearer ${cronSecret}` },
  });
  assert.notEqual(cron.status, 403, "Bearer cron call was blocked as cross-site");
  results.push({ bearerCronWithoutOrigin: cron.status });

  // A console error, page error, failed request or CSP violation that appeared
  // after a page's own check still fails the run.
  for (const record of openedPages) {
    assert.deepEqual(record.consoleErrors, [], `${record.label}: CSP console errors`);
    assert.deepEqual(record.pageErrors, [], `${record.label}: page errors`);
    assert.deepEqual(record.failedRequests, [], `${record.label}: failed requests`);
    assert.deepEqual(await violations(record.page), [], `${record.label}: CSP violations`);
  }

  console.log(JSON.stringify({ origin, results }, null, 2));
} catch (error) {
  // After the deadline the browser is closed under the run, so a browser error
  // is expected; the deadline already set the failing exit code.
  if (!timedOut) throw error;
  console.error(
    `Perimeter verification stopped after the deadline: ${error instanceof Error ? error.message : String(error)}`,
  );
} finally {
  await cleanup();
}
