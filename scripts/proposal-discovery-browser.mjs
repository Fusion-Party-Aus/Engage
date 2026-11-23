// Build Engage first, then set ENGAGE_PLAYWRIGHT_MODULE to Playwright's index.mjs.
// Set ENGAGE_BASELINE_ENTRY to a pre-fix build to also reproduce the original bug.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const modulePath = process.env.ENGAGE_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error('Set ENGAGE_PLAYWRIGHT_MODULE to Playwright’s index.mjs.');
const { chromium, firefox } = await import(pathToFileURL(modulePath).href);

async function withPreview(entry, port, run) {
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [entry], {
    stdio: 'inherit',
    env: {
      ...process.env,
      APP_MODE: 'preview',
      MONGODB_URI: '',
      HOST: '127.0.0.1',
      PORT: String(port),
      ASTRO_NODE_LOGGING: 'disabled',
      PUBLIC_ORIGIN: origin,
      BETTER_AUTH_URL: origin,
      RESEND_API_KEY: '',
      AUTH_EMAIL_FROM: '',
    },
  });
  try {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (server.exitCode !== null) break;
      const ready = await fetch(`${origin}/proposals/`).then((res) => res.ok, () => false);
      if (ready) return await run(origin);
      await delay(250);
    }
    throw new Error('Isolated preview server did not start.');
  } finally {
    server.kill();
  }
}

const heading = '.proposal-item__title';
const resultStatus = '[data-discovery-status]';

async function waitForResult(page, query, status) {
  await page.waitForFunction(({ query, status, resultStatus }) =>
    (new URL(location.href).searchParams.get('q') ?? '') === query &&
    document.querySelector(resultStatus)?.textContent?.includes(status),
  { query, status, resultStatus });
}

async function reproduce(browser, origin) {
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}/proposals/`);
    const navigation = page.waitForRequest((request) =>
      request.resourceType() === 'document' && new URL(request.url()).searchParams.get('q') === 'transport',
    );
    await page.locator('#proposal-search').fill('transport');
    await navigation;
    await page.waitForLoadState();
  } finally {
    await page.close();
  }
}

async function verifyListing(browser, origin) {
  const branch = 'discovery-test-branch';
  const created = await fetch(`${origin}/api/admin/branches`, {
    method: 'POST',
    headers: {
      Cookie: 'engage_dev_user=administrator',
      'Content-Type': 'application/json',
      Origin: origin,
      'Sec-Fetch-Site': 'same-origin',
    },
    body: JSON.stringify({ branchId: branch, name: 'Discovery test branch', kind: 'state', recognised: true }),
  });
  assert.equal(created.status, 201, await created.text());

  const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const search = page.locator('#proposal-search');
  const partial = (request) => request.headers()['x-engage-proposal-list'] === '1';

  try {
    await page.goto(`${origin}/proposals/?page=2`);
    const laterPageTitle = await page.locator(heading).first().innerText();
    await page.goto(`${origin}/proposals/`);
    assert.ok(!(await page.locator(heading).allTextContents()).includes(laterPageTitle));
    await page.evaluate(() => {
      document.querySelector('h1').dataset.originalShell = 'yes';
      window.scrollTo({ top: 80, behavior: 'instant' });
    });
    await search.evaluate((input) => input.focus({ preventScroll: true }));
    const scroll = await page.evaluate(() => window.scrollY);
    const documents = [];
    page.on('request', (request) => {
      if (request.resourceType() === 'document') documents.push(request.url());
    });

    await search.fill(laterPageTitle.slice(0, 3));
    await waitForResult(page, laterPageTitle.slice(0, 3), 'Showing');
    await delay(600);
    assert.equal(await search.evaluate((input) => input === document.activeElement), true);
    assert.equal(await page.evaluate(() => window.scrollY), scroll);
    assert.equal(await page.locator('h1').getAttribute('data-original-shell'), 'yes');

    await search.fill(laterPageTitle);
    await waitForResult(page, laterPageTitle, 'Showing');
    assert.ok((await page.locator(heading).allTextContents()).includes(laterPageTitle));
    await page.getByRole('link', { name: 'Clear search', exact: true }).click();
    await waitForResult(page, '', 'Page 1 of');
    await page.getByRole('link', { name: 'Next page' }).click();
    await waitForResult(page, '', 'Page 2 of');
    await page.locator('#proposal-sort').selectOption('recent');
    await waitForResult(page, '', 'Page 1 of');
    assert.equal(new URL(page.url()).searchParams.get('sort'), 'recent');
    await page.goBack();
    await waitForResult(page, '', 'Page 2 of');
    assert.equal(await page.locator('#proposal-sort').inputValue(), 'priority');
    await page.goForward();
    await waitForResult(page, '', 'Page 1 of');
    assert.equal(await page.locator('#proposal-sort').inputValue(), 'recent');

    await page.getByRole('link', { name: /^Ideas/ }).click();
    await page.waitForFunction(() => new URLSearchParams(location.search).get('stage') === 'propose');
    assert.equal(await page.getByRole('link', { name: /^Ideas/ }).getAttribute('aria-current'), 'page');
    const topicSelect = page.locator('#proposal-space');
    const topic = await topicSelect.locator('option').nth(1).getAttribute('value');
    await topicSelect.selectOption(topic);
    await page.waitForFunction((topic) => new URLSearchParams(location.search).get('space') === topic, topic);
    const branchSelect = page.locator('#proposal-branch');
    await branchSelect.selectOption(branch);
    await page.waitForFunction((branch) => new URLSearchParams(location.search).get('branch') === branch, branch);
    assert.equal(await topicSelect.inputValue(), topic);
    assert.equal(await branchSelect.inputValue(), branch);
    await page.locator('[data-discovery-link="clear-filters"]').click();
    await waitForResult(page, '', 'Showing');

    // Let the old request start, then hold it while the newer query wins.
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const slowQuery = 'very-slow-proposal-query';
    await page.route((url) => url.searchParams.get('q') === slowQuery, async (route) => {
      await held;
      await route.continue().catch(() => {});
    });
    const slowRequest = page.waitForRequest((request) => partial(request) && request.url().includes(slowQuery));
    await search.fill(slowQuery);
    await slowRequest;
    assert.ok(await page.locator(heading).count(), 'Keep the former results visible during a slow request');
    const sent = [];
    page.on('request', (request) => { if (partial(request)) sent.push(request.url()); });
    await search.fill('');
    await search.pressSequentially(laterPageTitle, { delay: 5 });
    await waitForResult(page, laterPageTitle, 'Showing');
    release();
    await delay(600);
    assert.equal(sent.length, 1);
    assert.ok((await page.locator(heading).allTextContents()).includes(laterPageTitle));

    await search.fill('unlikely-proposal-169');
    await waitForResult(page, 'unlikely-proposal-169', 'No proposals match');
    assert.equal(await page.getByRole('heading', { name: 'No matching proposals' }).count(), 1);
    assert.equal(await page.getByRole('navigation', { name: 'Proposal pages' }).count(), 0);

    const retryQuery = 'retry-proposal-169';
    await page.route((url) => url.searchParams.get('q') === retryQuery, (route) => route.abort(), { times: 1 });
    await search.fill(retryQuery);
    await page.getByRole('button', { name: 'Try again' }).waitFor();
    assert.equal(await search.inputValue(), retryQuery);
    await page.getByRole('button', { name: 'Try again' }).click();
    await waitForResult(page, retryQuery, 'No proposals match');
    assert.deepEqual(documents, []);
    assert.deepEqual(errors, []);

    return laterPageTitle;
  } finally {
    await page.close();
  }
}

async function verifyFallback(browser, origin, title) {
  const page = await browser.newPage({ javaScriptEnabled: false });
  try {
    await page.goto(`${origin}/proposals/?q=${encodeURIComponent(title)}`);
    assert.ok((await page.locator(heading).allTextContents()).includes(title));
    await page.locator('#proposal-search').fill('unlikely-proposal-169');
    await page.getByRole('button', { name: 'Apply' }).click();
    assert.equal(new URL(page.url()).searchParams.get('q'), 'unlikely-proposal-169');
    assert.equal(await page.getByRole('heading', { name: 'No matching proposals' }).count(), 1);
  } finally {
    await page.close();
  }
}

async function withBrowser(engine, run) {
  const executablePath = engine === chromium ? process.env.ENGAGE_CHROMIUM_EXECUTABLE : undefined;
  const browser = await engine.launch({ executablePath });
  try {
    return await run(browser);
  } finally {
    await browser.close();
  }
}

for (const engine of [chromium, firefox]) {
  if (process.argv[2] && process.argv[2] !== engine.name()) continue;
  if (process.env.ENGAGE_BASELINE_ENTRY) {
    await withPreview(process.env.ENGAGE_BASELINE_ENTRY, 4396, (origin) =>
      withBrowser(engine, (browser) => reproduce(browser, origin)));
    console.log(`${engine.name()}: reproduced document navigation after the original debounce`);
  }
  await withPreview('dist/server/entry.mjs', 4397, async (origin) => {
    const title = await withBrowser(engine, (browser) => verifyListing(browser, origin));
    await withBrowser(engine, (browser) => verifyFallback(browser, origin, title));
  });
  console.log(`${engine.name()}: inline proposal discovery passed`);
}
