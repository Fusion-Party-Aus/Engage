// Sense Box and inline amendment browser verification.
//
// Runs against an isolated preview server with an in-memory database. It
// exercises the contributor receipt, publication, public and internal
// discussion, stale administrator data, multiple amendment insertions, mobile
// layout and keyboard activation.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const modulePath = process.env.ENGAGE_PLAYWRIGHT_MODULE;
if (!modulePath) {
  throw new Error('Set ENGAGE_PLAYWRIGHT_MODULE to an isolated Playwright index.mjs.');
}
const { chromium } = await import(pathToFileURL(modulePath).href);
const origin = 'http://127.0.0.1:4397';
const output = path.resolve('docs/screenshots/sense-box-amendments');
await mkdir(output, { recursive: true });

const server = spawn(process.execPath, ['dist/server/entry.mjs'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    APP_MODE: 'preview',
    MONGODB_URI: '',
    HOST: '127.0.0.1',
    PORT: '4397',
    ASTRO_NODE_LOGGING: 'disabled',
    PUBLIC_ORIGIN: origin,
    BETTER_AUTH_URL: origin,
    RESEND_API_KEY: '',
    AUTH_EMAIL_FROM: '',
  },
});

const headers = (role) => ({
  Cookie: `engage_dev_user=${role}`,
  'Content-Type': 'application/json',
  Origin: origin,
  'Sec-Fetch-Site': 'same-origin',
});

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${origin}/sense-box/`)).ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Isolated preview server did not start.');
}

async function api(pathname, role, init = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    ...init,
    headers: { ...headers(role), ...(init.headers ?? {}) },
  });
  const json = await response.json().catch(() => ({}));
  return { response, json };
}

async function submitSense(requestId, title, detail) {
  const { response, json } = await api('/api/sense-box', 'administrator', {
    method: 'POST',
    body: JSON.stringify({
      requestId,
      branchId: 'branch-vic',
      title,
      detail,
      locality: 'Bendigo',
      topic: 'transport',
      consent: true,
    }),
  });
  assert.equal(response.status, 201, JSON.stringify(json));
  return json.receipt;
}

async function waitForIsland(page, component) {
  await page.waitForFunction(
    (name) => {
      const island = document.querySelector(`astro-island[component-url*="${name}"]`);
      return Boolean(island && !island.hasAttribute('ssr'));
    },
    component,
  );
}

let browser;
try {
  await waitForServer();

  browser = await chromium.launch({ headless: true });
  const results = [];
  const errors = [];

  const anonymous = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const anonPage = await anonymous.newPage();
  anonPage.setDefaultTimeout(20_000);
  anonPage.on('pageerror', (error) => errors.push(`${anonPage.url()}: ${error}`));
  anonPage.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) errors.push(`${anonPage.url()}: ${message.text()}`);
  });

  // 1. Guest submission with a failed attempt first. The input must survive.
  await anonPage.goto(`${origin}/sense-box/`);
  await anonPage.selectOption('#sense-branch', 'branch-vic');
  await anonPage.fill('#sense-title', 'Browser priority about regional trains');
  await anonPage.fill('#sense-detail', 'More evening services would let people get home after work without driving.');
  await anonPage.fill('#sense-locality', 'Bendigo');
  await anonPage.selectOption('#sense-topic', 'transport');
  await anonPage.check('input[name="consent"]');
  await anonPage.route('**/api/sense-box', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Could not send your priority. Try again.' }),
      });
      return;
    }
    await route.continue();
  }, { times: 1 });
  await anonPage.getByRole('button', { name: 'Share my priority' }).click();
  await anonPage.waitForSelector('[role="alert"]');
  assert.match(await anonPage.locator('[role="alert"]').innerText(), /Try again|Could not send/);
  assert.equal(await anonPage.inputValue('#sense-title'), 'Browser priority about regional trains');
  await anonPage.unroute('**/api/sense-box');

  await anonPage.getByRole('button', { name: 'Share my priority' }).click();
  await anonPage.waitForSelector('text=Keep this link to check what happens next.');
  const statusHref = await anonPage.getByRole('link', { name: /Check this priority/ }).getAttribute('href');
  assert.ok(statusHref && /^\/sense-box\/status\/.+\/$/.test(statusHref), 'status link is present');
  const submissionId = statusHref.split('/').filter(Boolean).at(-1);
  assert.ok(submissionId);
  await anonPage.screenshot({ path: path.join(output, 'sense-box-receipt-desktop.png'), fullPage: true });
  results.push('guest submission failure recovery and receipt');

  // 2. Contributor status page before and after publication.
  await anonPage.goto(`${origin}${statusHref}`);
  await anonPage.waitForSelector('text=Received');
  assert.match(await anonPage.title(), /Your Sense Box priority/);
  assert.match(await anonPage.locator('body').innerText(), /Keep this page’s link/);
  assert.match(await anonPage.locator('body').innerText(), /joining the public discussion requires a verified Engage account/);
  assert.ok((await anonPage.locator('body').innerText()).includes('Browser priority about regional trains'));

  const publish = await api('/api/sense-box', 'administrator', {
    method: 'PATCH',
    body: JSON.stringify({ submissionId, branchId: 'branch-vic', version: 0, action: 'publish' }),
  });
  assert.equal(publish.response.status, 200, JSON.stringify(publish.json));
  await anonPage.reload();
  await anonPage.waitForSelector('text=Published');
  await anonPage.screenshot({ path: path.join(output, 'sense-box-status-published.png'), fullPage: true });
  results.push('status page received → published');

  // 3. Published priority is readable anonymously and does not offer a form.
  await anonPage.getByRole('link', { name: /Open the published priority/ }).click();
  await anonPage.waitForSelector('text=This is informal community input');
  assert.equal(await anonPage.locator('#sense-comment-public').count(), 0);
  assert.equal(await anonPage.getByRole('link', { name: 'Sign in to discuss' }).count(), 1);
  results.push('public read grant without administrative powers');

  // 4. Verified member joins the public discussion.
  const member = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await member.addCookies([{ name: 'engage_dev_user', value: 'member', url: origin }]);
  const memberPage = await member.newPage();
  memberPage.setDefaultTimeout(20_000);
  memberPage.on('pageerror', (error) => errors.push(`${memberPage.url()}: ${error}`));
  memberPage.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) errors.push(`${memberPage.url()}: ${message.text()}`);
  });
  await memberPage.goto(`${origin}/sense-box/${submissionId}/`);
  await waitForIsland(memberPage, 'SenseDiscussion');
  await memberPage.fill('#sense-comment-public', 'A member browser comment about evening services.');
  await memberPage.getByRole('button', { name: 'Post comment' }).click();
  await memberPage.waitForSelector('text=A member browser comment about evening services.');
  const overflow = await memberPage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(overflow, false, 'mobile public priority has no horizontal overflow');
  await memberPage.screenshot({ path: path.join(output, 'sense-box-public-mobile.png'), fullPage: true });
  results.push('verified member discussion and mobile layout');

  // 5. Administrator workspace: internal note stays private.
  const admin = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await admin.addCookies([{ name: 'engage_dev_user', value: 'administrator', url: origin }]);
  const adminPage = await admin.newPage();
  adminPage.setDefaultTimeout(20_000);
  adminPage.on('pageerror', (error) => errors.push(`${adminPage.url()}: ${error}`));
  adminPage.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) errors.push(`${adminPage.url()}: ${message.text()}`);
  });
  await adminPage.goto(`${origin}/admin/sense-box/${submissionId}/`);
  await adminPage.waitForSelector('text=Withdraw from public view');
  await waitForIsland(adminPage, 'SenseDiscussion');
  await adminPage.fill('#sense-comment-internal', 'Internal browser note: check the timetable evidence.');
  await adminPage.locator('form', { has: adminPage.locator('#sense-comment-internal') }).getByRole('button', { name: 'Post comment' }).click();
  await adminPage.waitForSelector('text=Internal browser note: check the timetable evidence.');
  await adminPage.screenshot({ path: path.join(output, 'sense-box-admin-workspace.png'), fullPage: true });

  await anonPage.goto(`${origin}/sense-box/${submissionId}/`);
  assert.equal(
    (await anonPage.locator('body').innerText()).includes('Internal browser note'),
    false,
    'organiser notes are not public',
  );
  results.push('private organiser notes');

  await adminPage.setViewportSize({ width: 390, height: 844 });
  await adminPage.reload();
  await adminPage.waitForSelector('text=Withdraw from public view');
  const adminOverflow = await adminPage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(adminOverflow, false, 'mobile administrator workspace has no horizontal overflow');
  await adminPage.screenshot({ path: path.join(output, 'sense-box-admin-mobile.png'), fullPage: true });
  results.push('mobile administrator workspace');
  await adminPage.setViewportSize({ width: 1440, height: 1000 });

  // 6. Stale administrator action: publish externally, then submit the old form.
  const stale = await submitSense(crypto.randomUUID(), 'Stale browser priority', 'A second priority used to prove version conflict handling.');
  await adminPage.goto(`${origin}/admin/sense-box/${stale.submissionId}/`);
  await adminPage.waitForSelector('text=Publish priority');
  const externalPublish = await api('/api/sense-box', 'administrator', {
    method: 'PATCH',
    body: JSON.stringify({ submissionId: stale.submissionId, branchId: 'branch-vic', version: 0, action: 'publish' }),
  });
  assert.equal(externalPublish.response.status, 200);
  await adminPage.getByRole('button', { name: 'Publish priority' }).click();
  await adminPage.waitForFunction(() => {
    const status = document.querySelector('form[data-sense-action="publish"] [role="status"]');
    return Boolean(status && /changed|no longer|Refresh|Could not/.test(status.textContent ?? ''));
  });
  const staleStatus = adminPage.locator('form[data-sense-action="publish"] [role="status"]');
  assert.match(await staleStatus.innerText(), /changed|no longer|Refresh|Could not/);
  results.push('stale administrator action reports a recoverable conflict');

  // 7. Inline amendments: one replacement plus two additions, submitted together.
  const proposal = await api('/api/proposals', 'member', {
    method: 'POST',
    body: JSON.stringify({
      title: `Browser amendment ${Date.now()}`,
      space: 'Transport',
      summary: 'A browser proposal used to verify block-anchored amendment suggestions.',
      outcomes: ['Run more services', 'Improve connections'],
      details: 'First rationale paragraph.\n\nSecond rationale paragraph.',
      stage: 'propose',
    }),
  });
  assert.equal(proposal.response.status, 201, JSON.stringify(proposal.json));
  const slug = proposal.json.proposal.slug;

  await memberPage.setViewportSize({ width: 1440, height: 1000 });
  await memberPage.goto(`${origin}/proposals/${slug}/`);
  await memberPage.locator('summary', { hasText: 'Propose a formal wording amendment' }).click();
  await memberPage.evaluate(() => {
    const details = document.querySelector('details.amendment-compose');
    if (details) details.open = true;
  });
  await waitForIsland(memberPage, 'AmendmentComposer');
  await memberPage.waitForSelector('[data-amendment-block="outcomes:0"]');

  // Keyboard activation of the first suggestion control.
  const suggest = memberPage.locator('[data-amendment-block="outcomes:0"]').getByRole('button', { name: 'Suggest change' });
  await suggest.focus();
  await memberPage.keyboard.press('Enter');
  await memberPage.waitForSelector('textarea[id="suggestion-outcomes:0"]');
  await memberPage.fill('textarea[id="suggestion-outcomes:0"]', 'Run many more services');
  await memberPage.getByRole('button', { name: 'Save suggestion' }).click();
  await memberPage.waitForSelector('[data-suggestion-preview="outcomes:0"]');

  for (const text of ['Third commitment', 'Fourth commitment']) {
    await memberPage.getByRole('button', { name: 'Add commitment' }).click();
    await memberPage.waitForSelector('#suggestion-add');
    await memberPage.fill('#suggestion-add', text);
    await memberPage.getByRole('button', { name: 'Add suggestion' }).click();
    await memberPage.waitForSelector(`text=${text}`);
  }
  assert.equal(await memberPage.locator('[data-suggestion-preview]').count(), 3);
  await memberPage.screenshot({ path: path.join(output, 'amendment-composer-desktop.png'), fullPage: true });
  await memberPage.getByRole('button', { name: /Submit formal amendment \(3\)/ }).click();
  await memberPage.waitForLoadState('networkidle');
  await memberPage.waitForSelector('text=Run many more services');
  await memberPage.waitForSelector('text=Applies cleanly');
  assert.match(await memberPage.locator('body').innerText(), /Third commitment/);
  assert.match(await memberPage.locator('body').innerText(), /Fourth commitment/);
  results.push('multiple additions, replacement, keyboard activation and applied amendment');

  // 8. Administrator register shows the same suggestions.
  await adminPage.goto(`${origin}/admin/proposals/${slug}/`);
  await adminPage.locator('a.project-tab[href="#record-amendments"]').click();
  await adminPage.waitForSelector('text=Formal amendments register');
  assert.match(await adminPage.locator('body').innerText(), /Run many more services/);
  assert.match(await adminPage.locator('body').innerText(), /Applies cleanly/);
  results.push('administrator amendment reconciliation view');

  // 9. Mobile amendment composer has no horizontal overflow.
  await memberPage.setViewportSize({ width: 390, height: 844 });
  await memberPage.goto(`${origin}/proposals/${slug}/`);
  await memberPage.locator('summary', { hasText: 'Propose a formal wording amendment' }).click();
  await memberPage.evaluate(() => {
    const details = document.querySelector('details.amendment-compose');
    if (details) details.open = true;
  });
  await waitForIsland(memberPage, 'AmendmentComposer');
  await memberPage.waitForSelector('[data-amendment-block="outcomes:0"]');
  const mobileOverflow = await memberPage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(mobileOverflow, false, 'mobile amendment composer has no horizontal overflow');
  await memberPage.screenshot({ path: path.join(output, 'amendment-composer-mobile.png'), fullPage: true });
  results.push('mobile amendment layout');

  assert.deepEqual(errors, [], `browser console or page errors: ${errors.join(' | ')}`);
  console.log(JSON.stringify({ ok: true, origin, results, screenshots: output }, null, 2));
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
