// Verify the review-before-submit presentation against a disposable preview.
// No production database, real account or external integration is used.
// The real API paths below use only the process-local in-memory seed; they do
// not establish MongoDB uniqueness, transactional or production readiness.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const modulePath = process.env.ENGAGE_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error('Set ENGAGE_PLAYWRIGHT_MODULE to the isolated Playwright index.mjs.');
const { chromium } = await import(pathToFileURL(modulePath).href);
const port = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    probe.close(() => resolve(address.port));
  });
});
const origin = `http://127.0.0.1:${port}`;
const output = process.env.ENGAGE_SCREENSHOT_DIR
  ? path.resolve(process.env.ENGAGE_SCREENSHOT_DIR)
  : await mkdtemp(path.join(tmpdir(), 'engage-ballot-review-'));
await mkdir(output, { recursive: true });
// Intentionally do not spread process.env: preview must never inherit provider
// credentials, real MongoDB configuration, encryption keys or scheduled jobs.
const server = spawn(process.execPath, ['dist/server/entry.mjs'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    APP_MODE: 'preview', NODE_ENV: 'production', HOST: '127.0.0.1',
    PORT: String(port), MONGODB_URI: '', MONGODB_DB_NAME: '',
    PUBLIC_ORIGIN: origin, BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: 'isolated-ballot-review-test-secret-only',
    ASTRO_NODE_LOGGING: 'disabled', TZ: 'Australia/Sydney',
  },
});
let serverOutput = '';
server.stdout.on('data', (chunk) => { serverOutput = (serverOutput + chunk).slice(-12_000); });
server.stderr.on('data', (chunk) => { serverOutput = (serverOutput + chunk).slice(-12_000); });
let browser;
let activePage;
const results = [];
const deadline = setTimeout(() => {
  server.kill('SIGTERM');
  void browser?.close();
}, 180_000);
const memberHeaders = { Cookie: 'engage_dev_user=member' };
const json = async (url) => {
  const response = await fetch(origin + url, { headers: memberHeaders });
  assert.ok(response.ok, `Read failed (${response.status}): ${url}`);
  return response.json();
};

try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (server.exitCode !== null) throw new Error(`Preview exited: ${serverOutput}`);
    try { if ((await fetch(origin + '/member/')).ok) { ready = true; break; } } catch { /* Starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(ready, `Isolated preview did not start: ${serverOutput}`);
  const { proposals } = await json('/api/proposals?stage=decide&limit=100');
  assert.ok(proposals.length >= 4, 'Synthetic seed needs at least four open ballots.');
  // Give the two synthetic ballots a known future closing time via the same
  // authorised administration contract. This process-local fixture is discarded
  // with the preview server; no production or persistent database is involved.
  for (const proposal of proposals.slice(0, 2)) {
    const fixture = await fetch(origin + `/api/proposals/${proposal.proposalId}`, {
      method: 'PATCH',
      headers: { Cookie: 'engage_dev_user=administrator', 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ ballotClosesAt: new Date(Date.now() + 14 * 86400_000).toISOString() }),
    });
    assert.ok(fixture.ok, `Could not configure synthetic deadline: ${await fixture.text()}`);
  }
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });

  for (const [index, device, width, height] of [[0, 'desktop', 1440, 1000], [1, 'mobile', 390, 844]]) {
    const context = await browser.newContext({ viewport: { width, height }, timezoneId: 'Australia/Sydney', permissions: ['clipboard-read', 'clipboard-write'] });
    const errors = [];
    const externalRequests = [];
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin || url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
      externalRequests.push(url.origin + url.pathname);
      return route.abort();
    });
    const page = await context.newPage();
    activePage = page;
    await page.clock.install({ time: new Date() });
    page.setDefaultTimeout(15_000);
    page.on('pageerror', (error) => errors.push(error.message));
    const proposal = proposals[index];
    const ballotPath = `/proposals/${proposal.slug}/`;
    let posts = 0;
    const bodies = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/votes') {
        posts++;
        bodies.push(request.postDataJSON());
      }
    });
    const goto = async (target) => {
      await page.goto(origin + target, { waitUntil: 'networkidle' });
      if (target.startsWith('/proposals/')) await page.locator('astro-island[component-url*="ProposalBallot"]:not([ssr])').waitFor();
    };
    const shot = async (name) => {
      assert.ok(await page.locator('body').evaluate((element) => element.scrollWidth <= innerWidth + 1), `${device} horizontal overflow at ${name}`);
      await page.screenshot({ path: path.join(output, `${device}-${name}.png`), fullPage: false });
    };
    const storedVote = async () => (await json(`/api/proposals/${proposal.proposalId}`)).myVote;

    await goto(ballotPath);
    assert.equal(await page.locator('[data-choice][aria-checked="true"]').count(), 0, 'No system-chosen default.');
    await goto(ballotPath + '?choice=abstain');
    await page.getByText('Your earlier selection has been restored. It has not been submitted.', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-choice="abstain"]').getAttribute('aria-checked'), 'true');
    assert.equal(posts, 0, 'Restoring guest intent must not submit.');
    const signIn = new URL(await page.getByRole('link', { name: 'Sign in to save vote', exact: true }).getAttribute('href'), origin);
    assert.ok(signIn.searchParams.get('returnTo').includes('choice=abstain'), 'Preserve explicit guest intent through sign-in.');

    await context.addCookies([{ name: 'engage_dev_user', value: 'member', url: origin }]);
    await goto(ballotPath);
    await page.locator('[data-choice="approve"]').click();
    await page.getByLabel('Why? (optional)').fill('Synthetic review test reason');
    await page.getByRole('button', { name: 'Review vote', exact: true }).click();
    await page.getByRole('heading', { name: 'Review your vote', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Review your vote', 'Review receives keyboard focus.');
    assert.equal(posts, 0, 'Review is not submission.');
    assert.equal(await storedVote(), null);
    await shot('review');
    await page.getByRole('button', { name: 'Edit choice', exact: true }).click();
    assert.equal(await page.getByLabel('Why? (optional)').inputValue(), 'Synthetic review test reason');
    assert.equal(await page.locator('[data-choice="approve"]').getAttribute('aria-checked'), 'true');
    await page.locator('[data-choice="reject"]').click();
    await page.getByRole('button', { name: 'Review vote', exact: true }).click();
    await page.route('**/api/votes', (route) => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic permission refusal.' }) }), { times: 1 });
    await page.getByRole('button', { name: 'Record vote', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Synthetic permission refusal.' }).waitFor();
    assert.equal(await storedVote(), null, 'Rejected request is not reported or persisted as recorded.');
    await page.getByRole('button', { name: 'Record vote', exact: true }).click();
    await page.getByText('Vote saved: Reject', { exact: true }).waitFor();
    assert.equal(await storedVote(), 'reject');
    assert.deepEqual(bodies.at(-1), { proposalId: proposal.proposalId, choice: 'reject', reason: 'Synthetic review test reason' }, 'Preserve POST contract.');
    await shot('recorded');

    await page.locator('[data-choice="abstain"]').click();
    await page.getByRole('button', { name: 'Review update', exact: true }).click();
    const beforeDoubleClick = posts;
    await page.route('**/api/votes', async (route) => { await new Promise((resolve) => setTimeout(resolve, 250)); await route.continue(); }, { times: 1 });
    await page.getByRole('button', { name: 'Update vote', exact: true }).evaluate((button) => { button.click(); button.click(); });
    await page.getByText('Vote saved: Abstain', { exact: true }).waitFor();
    assert.equal(posts, beforeDoubleClick + 1, 'Synchronous duplicate clicks send only one request.');
    assert.equal(await storedVote(), 'abstain');

    await page.getByLabel('Why? (optional)').fill('Synthetic updated reason, same choice');
    await page.getByRole('button', { name: 'Review update', exact: true }).click();
    await page.getByRole('button', { name: 'Update vote', exact: true }).click();
    await page.getByText('Vote saved: Abstain', { exact: true }).waitFor();
    const reasonOnlyUpdate = await json(`/api/proposals/${proposal.proposalId}`);
    assert.equal(reasonOnlyUpdate.myVote, 'abstain', 'A reason-only update keeps the choice.');
    assert.equal(reasonOnlyUpdate.myReason, 'Synthetic updated reason, same choice');

    await goto(ballotPath + '?choice=approve&private=synthetic#proposal-vote');
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    await page.getByText('Link copied.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), origin + ballotPath, 'Share omits choice and all query parameters.');

    await page.locator('[data-choice="approve"]').click();
    await page.getByRole('button', { name: 'Review update', exact: true }).click();
    await page.route('**/api/votes', (route) => route.abort('connectionfailed'), { times: 1 });
    await page.getByRole('button', { name: 'Update vote', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Your vote may have been recorded.' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Update vote', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Your vote may have been recorded.' }).waitFor();
    await page.getByRole('button', { name: 'Reload and check recorded vote', exact: true }).click();
    await page.locator('astro-island[component-url*="ProposalBallot"]:not([ssr])').waitFor();
    await page.getByText('Recorded: Abstain', { exact: true }).waitFor();

    // Advance only this browser's display clock. The server and its seed data
    // remain unchanged: this checks the convenience expiry state, not closure
    // certification or enforcement of a real deadline in MongoDB.
    const closesAt = reasonOnlyUpdate.proposal.ballotClosesAt;
    assert.ok(closesAt && Number.isFinite(new Date(closesAt).getTime()), 'Synthetic ballot needs a deadline.');
    await page.locator('[data-choice="approve"]').click();
    await page.getByRole('button', { name: 'Review update', exact: true }).click();
    const beforeExpiry = posts;
    await page.clock.setSystemTime(new Date(new Date(closesAt).getTime() + 1000));
    await page.clock.runFor(30_001);
    await page.getByText('Voting is closed for this ballot.', { exact: true }).waitFor();
    await page.locator('[data-ballot-experience]').getByText('Synthetic updated reason, same choice', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-choice]').count(), 0, 'Expired display removes editable choices.');
    assert.equal(await page.getByRole('button', { name: 'Update vote', exact: true }).count(), 0, 'Expiry during review removes the confirm action.');
    assert.equal(posts, beforeExpiry, 'Display expiry sends no vote or lifecycle mutation.');
    await shot('closed');
    await page.clock.setSystemTime(new Date());
    await page.clock.runFor(30_001);

    // A membership change between page load and submission can turn a later
    // save into a pending preference. It must not relabel the earlier formal
    // vote or attach the pending reason to that vote when the display closes.
    await goto(ballotPath);
    await page.locator('[data-choice="reject"]').click();
    await page.getByLabel('Why? (optional)').fill('Synthetic pending reason after membership change');
    await page.getByRole('button', { name: 'Review update', exact: true }).click();
    await page.route('**/api/votes', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choice: 'reject', pendingVerification: true, revisionId: 'synthetic-response-only' }) }), { times: 1 });
    await page.getByRole('button', { name: 'Update vote', exact: true }).click();
    await page.getByText('Saved pending verification (Reject).', { exact: true }).waitFor();
    await page.getByText('Recorded: Abstain', { exact: true }).waitFor();
    await page.clock.setSystemTime(new Date(new Date(closesAt).getTime() + 1000));
    await page.clock.runFor(30_001);
    await page.getByText('Voting is closed for this ballot.', { exact: true }).waitFor();
    await page.locator('[data-ballot-experience]').getByText('Synthetic updated reason, same choice', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-ballot-experience]').getByText('Synthetic pending reason after membership change', { exact: true }).count(), 0, 'A pending reason is not displayed as the recorded formal reason.');
    const afterPendingResponse = await json(`/api/proposals/${proposal.proposalId}`);
    assert.equal(afterPendingResponse.myVote, 'abstain');
    assert.equal(afterPendingResponse.myReason, 'Synthetic updated reason, same choice');
    await page.clock.setSystemTime(new Date());

    // Contract-specific mocked response, not a claim to have exercised a real
    // pending-member login, verification or promotion against MongoDB.
    const pendingProposal = proposals[index + 2];
    await goto(`/proposals/${pendingProposal.slug}/`);
    await page.locator('[data-choice="approve"]').click();
    await page.getByRole('button', { name: 'Review vote', exact: true }).click();
    await page.route('**/api/votes', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choice: 'reject', pendingVerification: true, revisionId: 'synthetic-response-only' }) }), { times: 1 });
    await page.getByRole('button', { name: 'Record vote', exact: true }).click();
    await page.getByText('Saved pending verification (Reject).', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-ballot-experience]').getByText(/^Vote saved:/).count(), 0, 'Pending is not a confirmed formal vote.');
    assert.equal(await page.locator('[data-choice="reject"]').getAttribute('aria-checked'), 'true', 'Receipt follows the actual server response.');
    assert.equal((await json(`/api/proposals/${pendingProposal.proposalId}`)).myVote, null);

    await goto('/member/');
    await page.locator('.member-welcome').waitFor();
    await shot('dashboard');
    await goto('/member/?view=account');
    assert.equal(await page.locator('.member-welcome').count(), 0, 'Account does not download the dashboard hero.');
    await shot('account');
    assert.deepEqual(errors, [], 'No uncaught browser errors.');
    assert.deepEqual(externalRequests, [], 'No external integrations contacted.');
    results.push({ device, reviewWithoutSubmission: true, focusManaged: true, editPreserved: true, rejectedThenRecorded: true, updated: true, reasonOnlyUpdate: true, duplicateClickGuard: true, privateShareParametersRemoved: true, uncertainResponseRecovered: true, clientExpiryDisplay: true, pendingResponseMocked: true, pendingReasonCannotReplaceRecordedReason: true, serverResponseChoiceHonoured: true, overflow: false, pageErrors: errors });
    await context.close();
  }
  await writeFile(path.join(output, 'verification.json'), JSON.stringify({ environment: 'isolated in-memory preview', productionAccess: false, realMongoDBVerified: false, results }, null, 2) + '\n');
  console.log(JSON.stringify({ output, results }, null, 2));
} catch (error) {
  await activePage?.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }).catch(() => {});
  throw error;
} finally {
  clearTimeout(deadline);
  await browser?.close();
  server.kill('SIGTERM');
}
