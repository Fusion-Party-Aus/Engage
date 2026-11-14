#!/usr/bin/env node
/**
 * Rendering-performance harness for Engage.
 *
 * Measures server render cost and client experience for representative public,
 * member and administrator pages against an isolated, disposable MongoDB
 * database. It never touches production data or a production runtime.
 *
 * Usage:
 *   npm run build
 *   node scripts/rendering-performance.mjs --json docs/status/rendering-performance-baseline.json
 *   node scripts/rendering-performance.mjs --json docs/status/rendering-performance-after.json \
 *     --compare docs/status/rendering-performance-baseline.json
 *
 * Requirements:
 *   - a production build in ./dist (or pass --build)
 *   - MongoDB reachable at VOTING_TEST_MONGODB_URI (or --mongo-uri)
 *   - Playwright available through ENGAGE_PLAYWRIGHT_MODULE when set, otherwise
 *     a local `playwright` package.
 *
 * Database command counters require the server to run with
 * ENGAGE_DB_COMMAND_MONITOR=1. The harness sets this automatically and reads
 * the counters from the development-only /api/dev/render-metrics route.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MongoClient } from "mongodb";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_PORT = Number(process.env.ENGAGE_PERF_PORT || 4399);
const DEFAULT_RUNS = 3;
const SYNTHETIC_VOTES = 1200;
const SYNTHETIC_COMMENTS = 600;
const SYNTHETIC_BALLOTS = 10;

function parseArgs(argv) {
  const args = {
    runs: DEFAULT_RUNS,
    port: DEFAULT_PORT,
    json: null,
    baseline: null,
    compare: null,
    filter: null,
    baseUrl: null,
    build: false,
    seed: true,
    keepDb: false,
    mongoUri:
      process.env.VOTING_TEST_MONGODB_URI ||
      "mongodb://127.0.0.1:27017/?directConnection=true",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--json") args.json = next();
    else if (arg === "--baseline") args.baseline = next();
    else if (arg === "--compare") args.compare = next();
    else if (arg === "--filter") args.filter = next();
    else if (arg === "--base-url") args.baseUrl = next();
    else if (arg === "--mongo-uri") args.mongoUri = next();
    else if (arg === "--port") args.port = Number(next());
    else if (arg === "--runs") args.runs = Math.max(1, Number(next()));
    else if (arg === "--build") args.build = true;
    else if (arg === "--no-seed") args.seed = false;
    else if (arg === "--keep-db") args.keepDb = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/rendering-performance.mjs [--json file] [--baseline file] [--compare file] [--filter text] [--runs n] [--port n] [--build] [--base-url url] [--no-seed] [--keep-db]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

function median(values) {
  const clean = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (!clean.length) return null;
  const sorted = [...clean].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round(value, digits = 1) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value * 10 ** digits) / 10 ** digits
    : null;
}

async function loadPlaywright() {
  const modulePath = process.env.ENGAGE_PLAYWRIGHT_MODULE;
  const specifier = modulePath
    ? pathToFileURL(path.resolve(modulePath)).href
    : "playwright";
  try {
    return await import(specifier);
  } catch (error) {
    throw new Error(
      `Could not load Playwright from ${modulePath || "playwright"}. Set ENGAGE_PLAYWRIGHT_MODULE to an isolated playwright/index.mjs.\n${error}`,
    );
  }
}

function distExists() {
  return existsSync(path.join(ROOT, "dist/server/entry.mjs"));
}

async function buildIfRequested(args) {
  if (!args.build) return;
  log("Building production server…");
  const result = spawnSync("npm", ["run", "build"], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) throw new Error("Build failed.");
}

async function waitForHealth(origin, timeoutMs = 60_000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
      lastError = new Error(`health ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server did not become healthy: ${lastError}`);
}

async function startServer(args, dbName) {
  if (args.baseUrl) return { origin: args.baseUrl.replace(/\/$/, ""), process: null };
  const origin = `http://127.0.0.1:${args.port}`;
  const env = {
    ...process.env,
    APP_MODE: "development",
    MONGODB_URI: args.mongoUri,
    MONGODB_DB_NAME: dbName,
    BETTER_AUTH_URL: origin,
    PUBLIC_ORIGIN: origin,
    HOST: "127.0.0.1",
    PORT: String(args.port),
    ENGAGE_DB_COMMAND_MONITOR: "1",
    ENGAGE_ALLOW_INDEXING: "false",
    ENGAGE_DIGEST_ENABLED: "false",
    BALLOT_ENCRYPTION_MODE: "off",
  };
  const child = spawn(process.execPath, ["dist/server/entry.mjs"], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
    if (output.length > 20_000) output = output.slice(-20_000);
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
    if (output.length > 20_000) output = output.slice(-20_000);
  });
  const startup = new Promise((resolve, reject) => {
    child.once("exit", (code) =>
      reject(new Error(`Server exited during startup (${code}).\n${output}`)),
    );
    waitForHealth(origin).then(resolve, reject);
  });
  try {
    await startup;
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  return { origin, process: child, output: () => output };
}

async function seedSyntheticData(args, dbName) {
  if (!args.seed) return { votes: 0, comments: 0, ballots: 0 };
  const client = new MongoClient(args.mongoUri);
  await client.connect();
  try {
    const db = client.db(dbName);
    const proposals = await db
      .collection("proposals")
      .find({})
      .project({ proposalId: 1, slug: 1, stage: 1 })
      .sort({ proposalId: 1 })
      .toArray();
    if (!proposals.length) return { votes: 0, comments: 0, ballots: 0 };

    const decide = proposals.filter((proposal) => proposal.stage === "decide");
    const now = Date.now();
    let ballots = 0;
    // Bind synthetic open ballots to an immutable revision so member-facing
    // "outstanding ballots" journeys are exercised.
    for (const proposal of decide.slice(0, SYNTHETIC_BALLOTS)) {
      const revision = await db
        .collection("proposal_revisions")
        .find({ proposalId: proposal.proposalId })
        .sort({ createdAt: -1 })
        .limit(1)
        .next();
      if (!revision) continue;
      await db.collection("proposals").updateOne(
        { proposalId: proposal.proposalId },
        {
          $set: {
            ballotRevisionId: String(revision.revisionId),
            ballotClosesAt: new Date(now + 14 * 24 * 60 * 60 * 1000),
          },
        },
      );
      ballots += 1;
    }

    const voteDocs = [];
    for (let i = 0; i < SYNTHETIC_VOTES; i += 1) {
      const proposal = proposals[i % proposals.length];
      const choice = ["approve", "reject", "abstain"][i % 3];
      voteDocs.push({
        ballotId: `proposal:${proposal.proposalId}`,
        proposalId: proposal.proposalId,
        memberId: `synthetic-voter-${i}`,
        authorName: `Synthetic Voter ${i}`,
        choice,
        reason: "",
        updatedAt: new Date(now - i * 60_000),
      });
    }
    async function insertIgnoreDuplicates(collectionName, docs) {
      try {
        const res = await db.collection(collectionName).insertMany(docs, { ordered: false });
        return res.insertedCount ?? docs.length;
      } catch (error) {
        if (error?.code === 11000 || error?.writeErrors?.every((e) => e.code === 11000)) {
          return error?.result?.nInserted ?? error?.result?.insertedCount ?? 0;
        }
        throw error;
      }
    }

    const votes = await insertIgnoreDuplicates("proposal_votes", voteDocs);

    const commentDocs = [];
    for (let i = 0; i < SYNTHETIC_COMMENTS; i += 1) {
      const proposal = proposals[i % proposals.length];
      commentDocs.push({
        commentId: `synthetic-comment-${i}`,
        proposalId: proposal.proposalId,
        memberId: `synthetic-commenter-${i}`,
        authorName: `Synthetic Commenter ${i}`,
        body: `Synthetic deliberation contribution ${i} for rendering measurement.`,
        stance: ["support", "concern", "comment"][i % 3],
        upvotes: [],
        createdAt: new Date(now - i * 120_000),
      });
    }
    const comments = await insertIgnoreDuplicates("comments", commentDocs);

    // A small recognised branch directory keeps branch filters and admin
    // navigation representative without importing real branch data.
    await insertIgnoreDuplicates("branches", [
      { branchId: "national", name: "National", kind: "national", recognised: true },
      { branchId: "nsw", name: "New South Wales", kind: "state", recognised: true },
      { branchId: "vic", name: "Victoria", kind: "state", recognised: true },
    ]);

    return { votes, comments, ballots };
  } finally {
    await client.close();
  }
}

async function dropDatabase(args, dbName) {
  if (args.baseUrl || args.keepDb) return;
  const client = new MongoClient(args.mongoUri);
  await client.connect();
  try {
    await client.db(dbName).dropDatabase();
  } finally {
    await client.close();
  }
}

function initScript() {
  window.__engagePerf = { lcp: 0, cls: 0, longTasks: [], events: [] };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__engagePerf.lcp = Math.max(window.__engagePerf.lcp, entry.startTime);
      }
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) window.__engagePerf.cls += entry.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__engagePerf.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
      }
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__engagePerf.events.push({
          name: entry.name,
          startTime: entry.startTime,
          duration: entry.duration,
          interactionId: entry.interactionId || 0,
        });
      }
    }).observe({ type: "event", buffered: true, durationThreshold: 16 });
  } catch {}
}

async function resetDbMetrics(origin) {
  const response = await fetch(`${origin}/api/dev/render-metrics`, { method: "POST" });
  if (!response.ok) throw new Error("DB command monitoring is not enabled on the server.");
}

async function readDbMetrics(origin) {
  const response = await fetch(`${origin}/api/dev/render-metrics`);
  if (!response.ok) throw new Error("DB command monitoring is not enabled on the server.");
  return response.json();
}

async function measureDocumentPhase(origin, pathname, identity) {
  await resetDbMetrics(origin);
  const headers = identity === "anonymous" ? {} : { Cookie: `engage_dev_user=${identity}` };
  const started = performance.now();
  const response = await fetch(`${origin}${pathname}`, { headers, redirect: "manual" });
  const body = await response.arrayBuffer();
  const elapsed = performance.now() - started;
  const metrics = await readDbMetrics(origin);
  return {
    status: response.status,
    durationMs: round(elapsed),
    htmlBytes: body.byteLength,
    dbCommands: metrics.commands,
    dbDurationMs: metrics.durationMs,
    dbByCommand: metrics.byCommand,
  };
}

async function measureBrowserPhase({ chromium, origin, pathname, identity, interact }) {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    if (identity !== "anonymous") {
      await context.addCookies([{ name: "engage_dev_user", value: identity, url: origin }]);
    }
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(`console: ${message.text()}`);
    });
    const resources = [];
    const failedRequests = [];
    const bodyTasks = [];
    page.on("response", (response) => {
      const type = response.request().resourceType();
      if (response.status() >= 400) {
        failedRequests.push(`${response.status()} ${type} ${response.url()}`);
      }
      if (!["document", "script", "stylesheet", "font", "image"].includes(type)) return;
      bodyTasks.push(
        response.body().then((body) => {
          const declared = Number(response.headers()["content-length"] || 0);
          resources.push({ type, url: response.url(), bytes: declared || body.byteLength, status: response.status() });
        }).catch(() => {}),
      );
    });
    await page.addInitScript(initScript);
    await resetDbMetrics(origin);

    const wallStart = performance.now();
    const response = await page.goto(`${origin}${pathname}`, { waitUntil: "load", timeout: 60_000 });
    const navigationMs = performance.now() - wallStart;
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(300);
    const timing = await response?.request().timing();

    let interaction = null;
    if (interact) {
      try {
        await page.locator('#proposal-vote').scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
        await page
          .locator('astro-island[component-url*="ProposalBallot"]:not([ssr])')
          .waitFor({ timeout: 10_000 });
        const started = performance.now();
        await page.getByRole("radio", { name: "Approve", exact: true }).first().click({ timeout: 5_000 });
        await page.evaluate(
          () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        interaction = { clickToNextPaintMs: round(performance.now() - started) };
      } catch (error) {
        interaction = { error: String(error).slice(0, 240) };
      }
    }

    await Promise.all(bodyTasks);
    const perf = await page.evaluate(() => window.__engagePerf);
    const db = await readDbMetrics(origin);
    const sum = (type) => resources.filter((item) => item.type === type).reduce((total, item) => total + item.bytes, 0);
    const scriptCount = resources.filter((item) => item.type === "script").length;
    const longTaskDurations = perf.longTasks.map((entry) => entry.duration);
    const eventDurations = perf.events.map((entry) => entry.duration);
    return {
      status: response?.status() ?? null,
      ttfbMs: timing ? round(timing.responseStart) : null,
      navigationMs: round(navigationMs),
      lcpMs: perf.lcp ? round(perf.lcp) : null,
      cls: round(perf.cls, 3),
      longTaskMs: round(longTaskDurations.reduce((total, value) => total + value, 0)),
      longTaskCount: longTaskDurations.length,
      maxLongTaskMs: round(Math.max(0, ...longTaskDurations)) || null,
      maxEventDurationMs: round(Math.max(0, ...eventDurations)) || null,
      interaction,
      jsBytes: sum("script"),
      cssBytes: sum("stylesheet"),
      fontBytes: sum("font"),
      imageBytes: sum("image"),
      scriptCount,
      requestCount: resources.length,
      failedRequests: [...new Set(failedRequests)],
      dbCommands: db.commands,
      dbDurationMs: db.durationMs,
      dbByCommand: db.byCommand,
      consoleErrors,
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

function pageSpecs() {
  return [
    { id: "home", label: "/ (public home)", path: "/", identities: ["anonymous", "member"] },
    { id: "proposals", label: "/proposals/", path: "/proposals/", identities: ["anonymous", "member"] },
    { id: "proposal-detail", label: "/proposals/[slug]/", path: null, identities: ["anonymous", "member"], interact: true },
    { id: "policies", label: "/policies/", path: "/policies/", identities: ["anonymous"] },
    { id: "member", label: "/member/", path: "/member/", identities: ["member"] },
    { id: "admin", label: "/admin/", path: "/admin/", identities: ["administrator"] },
    { id: "admin-proposals", label: "/admin/proposals/", path: "/admin/proposals/", identities: ["administrator"] },
  ];
}

async function resolveDetailPath(mongoUri, dbName) {
  const client = new MongoClient(mongoUri);
  await client.connect();
  try {
    const proposal = await client
      .db(dbName)
      .collection("proposals")
      .find({ stage: "decide" })
      .project({ slug: 1 })
      .limit(1)
      .next();
    return proposal?.slug ? `/proposals/${proposal.slug}/` : null;
  } finally {
    await client.close();
  }
}

async function measurePage({ chromium, origin, spec, identity, pathname, runs }) {
  const documentRuns = [];
  const browserRuns = [];
  for (let i = 0; i < runs; i += 1) {
    log(`  ${spec.id}/${identity} run ${i + 1}/${runs}`);
    documentRuns.push(await measureDocumentPhase(origin, pathname, identity));
    browserRuns.push(
      await measureBrowserPhase({
        chromium,
        origin,
        pathname,
        identity,
        interact: Boolean(spec.interact) && i === 0,
      }),
    );
  }
  const metric = (key, source = browserRuns) => median(source.map((run) => run[key]));
  const document = {
    status: median(documentRuns.map((run) => run.status)),
    durationMs: metric("durationMs", documentRuns),
    htmlBytes: metric("htmlBytes", documentRuns),
    dbCommands: metric("dbCommands", documentRuns),
    dbDurationMs: metric("dbDurationMs", documentRuns),
    dbByCommand: documentRuns[documentRuns.length - 1]?.dbByCommand ?? {},
  };
  const browser = {
    status: metric("status"),
    ttfbMs: metric("ttfbMs"),
    navigationMs: metric("navigationMs"),
    lcpMs: metric("lcpMs"),
    cls: metric("cls"),
    longTaskMs: metric("longTaskMs"),
    longTaskCount: metric("longTaskCount"),
    maxLongTaskMs: metric("maxLongTaskMs"),
    maxEventDurationMs: metric("maxEventDurationMs"),
    jsBytes: metric("jsBytes"),
    cssBytes: metric("cssBytes"),
    fontBytes: metric("fontBytes"),
    imageBytes: metric("imageBytes"),
    scriptCount: metric("scriptCount"),
    requestCount: metric("requestCount"),
    failedRequests: [...new Set(browserRuns.flatMap((run) => run.failedRequests))],
    dbCommands: metric("dbCommands"),
    dbDurationMs: metric("dbDurationMs"),
    dbByCommand: browserRuns[browserRuns.length - 1]?.dbByCommand ?? {},
    interaction: browserRuns.find((run) => run.interaction)?.interaction ?? null,
    consoleErrors: [...new Set(browserRuns.flatMap((run) => run.consoleErrors))],
  };
  return { id: spec.id, label: spec.label, path: pathname, identity, document, browser };
}

function printComparison(current, baseline) {
  const rows = [];
  for (const page of current.pages) {
    const match = baseline.pages.find((row) => row.id === page.id && row.identity === page.identity);
    if (!match) continue;
    const delta = (after, before) => {
      if (typeof after !== "number" || typeof before !== "number" || before === 0) return "n/a";
      const pct = ((after - before) / before) * 100;
      return `${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%`;
    };
    rows.push({
      page: `${page.id} (${page.identity})`,
      ttfb: `${match.browser.ttfbMs} → ${page.browser.ttfbMs} (${delta(page.browser.ttfbMs, match.browser.ttfbMs)})`,
      html: `${match.document.htmlBytes} → ${page.document.htmlBytes} (${delta(page.document.htmlBytes, match.document.htmlBytes)})`,
      js: `${match.browser.jsBytes} → ${page.browser.jsBytes} (${delta(page.browser.jsBytes, match.browser.jsBytes)})`,
      lcp: `${match.browser.lcpMs} → ${page.browser.lcpMs} (${delta(page.browser.lcpMs, match.browser.lcpMs)})`,
      db: `${match.document.dbCommands} → ${page.document.dbCommands} (${delta(page.document.dbCommands, match.document.dbCommands)})`,
      dbMs: `${match.document.dbDurationMs} → ${page.document.dbDurationMs} (${delta(page.document.dbDurationMs, match.document.dbDurationMs)})`,
    });
  }

  const numeric = (key) => current.pages.reduce((total, page) => total + (page.document[key] || 0), 0);
  const baselineNumeric = (key) => baseline.pages.reduce((total, page) => total + (page.document[key] || 0), 0);
  log("\nComparison (baseline → current):");
  for (const row of rows) {
    log(
      `  ${row.page.padEnd(28)} ttfb ${row.ttfb.padEnd(22)} html ${row.html.padEnd(24)} js ${row.js.padEnd(22)} lcp ${row.lcp.padEnd(22)} db ${row.db.padEnd(16)} dbMs ${row.dbMs}`,
    );
  }
  log(
    `  TOTAL document DB commands ${baselineNumeric("dbCommands")} → ${numeric("dbCommands")}; ` +
      `total document DB time ${round(baselineNumeric("dbDurationMs"))}ms → ${round(numeric("dbDurationMs"))}ms`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await buildIfRequested(args);
  if (!args.baseUrl && !distExists()) {
    throw new Error("dist/server/entry.mjs not found. Run `npm run build` or pass --build.");
  }
  const { chromium } = await loadPlaywright();
  const dbName = `engage_renderperf_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  let server;
  let measurement;
  try {
    server = await startServer(args, dbName);
    log(`Server: ${server.origin} · database ${dbName}`);
    const seed = await seedSyntheticData(args, dbName);
    log(`Synthetic data: ${seed.votes} votes, ${seed.comments} comments, ${seed.ballots} bound ballots`);
    const detailPath = await resolveDetailPath(args.mongoUri, dbName);

    const specs = pageSpecs()
      .map((spec) => ({
        ...spec,
        path: spec.id === "proposal-detail" ? detailPath : spec.path,
      }))
      .filter((spec) => spec.path)
      .filter((spec) => !args.filter || `${spec.id} ${spec.label}`.toLowerCase().includes(args.filter.toLowerCase()));

    // Warm up the server (JIT, seeding, index creation) before measurement.
    log("Warming up…");
    for (const spec of specs) {
      for (const identity of spec.identities) {
        await fetch(`${server.origin}${spec.path}`, {
          headers: identity === "anonymous" ? {} : { Cookie: `engage_dev_user=${identity}` },
        }).then((response) => response.arrayBuffer());
      }
    }

    const pages = [];
    for (const spec of specs) {
      for (const identity of spec.identities) {
        log(`Measuring ${spec.id} as ${identity}…`);
        pages.push(
          await measurePage({
            chromium,
            origin: server.origin,
            spec,
            identity,
            pathname: spec.path,
            runs: args.runs,
          }),
        );
      }
    }

    const git = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT })
      .stdout?.toString().trim();
    const branch = spawnSync("git", ["branch", "--show-current"], { cwd: ROOT })
      .stdout?.toString().trim();
    measurement = {
      generatedAt: new Date().toISOString(),
      git: { commit: git || null, branch: branch || null },
      environment: {
        node: process.version,
        platform: process.platform,
        runs: args.runs,
        port: args.port,
        syntheticData: seed,
        note: "Local synthetic measurements. Indicative only; not production SLA evidence.",
      },
      pages,
    };

    const jsonPath = args.json || args.baseline;
    if (jsonPath) {
      await mkdir(path.dirname(path.resolve(ROOT, jsonPath)), { recursive: true });
      await writeFile(path.resolve(ROOT, jsonPath), `${JSON.stringify(measurement, null, 2)}\n`);
      log(`Wrote ${jsonPath}`);
    }

    if (args.compare) {
      const baseline = JSON.parse(await readFile(path.resolve(ROOT, args.compare), "utf8"));
      printComparison(measurement, baseline);
    } else {
      log("\nMeasurements:");
      for (const page of measurement.pages) {
        log(
          `  ${page.id}/${page.identity}: ttfb ${page.browser.ttfbMs}ms · html ${page.document.htmlBytes}B · js ${page.browser.jsBytes}B · lcp ${page.browser.lcpMs}ms · db ${page.document.dbCommands} commands/${page.document.dbDurationMs}ms`,
        );
      }
    }
  } finally {
    if (server?.process) {
      server.process.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3_000);
        server.process.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    await dropDatabase(args, dbName);
    if (!args.keepDb) log(`Dropped database ${dbName}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
