// Public member profile browser verification.
//
// Runs against an isolated in-memory preview server, never production. It
// proves that author links from a discussion reach a public profile, that the
// profile history deep-links to the exact comment, that empty tabs and an
// unknown profile behave correctly, and that the layout works on desktop and
// mobile.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const modulePath = process.env.ENGAGE_PLAYWRIGHT_MODULE;
if (!modulePath) {
  throw new Error('Set ENGAGE_PLAYWRIGHT_MODULE to an isolated Playwright index.mjs.');
}
const { chromium } = await import(pathToFileURL(modulePath).href);
const origin = 'http://127.0.0.1:4399';
const output = path.resolve('docs/screenshots/member-profile');
await mkdir(output, { recursive: true });

const server = spawn(process.execPath, ['dist/server/entry.mjs'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    APP_MODE: 'preview',
    MONGODB_URI: '',
    HOST: '127.0.0.1',
    PORT: '4399',
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
      if ((await fetch(`${origin}/proposals/`)).ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Isolated preview server did not start.');
}

async function postComment(role, body) {
  const response = await fetch(`${origin}/api/comments`, {
    method: 'POST',
    headers: headers(role),
    body: JSON.stringify(body),
  });
  const data = await response.json();
  assert.ok(response.ok, `POST /api/comments: ${JSON.stringify(data)}`);
  return data.comment;
}

async function voteComment(role, commentId, action) {
  const response = await fetch(`${origin}/api/comments`, {
    method: 'PATCH',
    headers: headers(role),
    body: JSON.stringify({ commentId, action }),
  });
  const data = await response.json();
  assert.ok(response.ok, `PATCH /api/comments: ${JSON.stringify(data)}`);
  return data;
}

let browser;
try {
  await waitForServer();

  const proposalList = await fetch(`${origin}/api/proposals`, {
    headers: headers('administrator'),
  }).then((response) => response.json());
  const proposal = proposalList.proposals.find(
    (item) =>
      item.stage !== 'archived' &&
      item.publicationScope !== 'private' &&
      item.publicationScope !== 'branch',
  );
  assert.ok(proposal, 'a public seed proposal is available');
  const proposalPath = `/proposals/${proposal.slug}/`;

  const memberComment = await postComment('member', {
    proposalId: proposal.proposalId,
    stance: 'support',
    body: 'Profile fixture: a public contribution from a member.',
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const adminComment = await postComment('administrator', {
    proposalId: proposal.proposalId,
    stance: 'comment',
    body: 'Profile fixture: an administrator contribution in the same discussion.',
  });
  await voteComment('administrator', memberComment.commentId, 'upvote');

  const results = [];
  browser = await chromium.launch({ headless: true });

  for (const [device, width, height] of [
    ['desktop', 1440, 1000],
    ['mobile', 390, 844],
  ]) {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    // A visitor with no session can follow an author link from the discussion.
    await page.goto(origin + proposalPath, { waitUntil: 'networkidle' });
    const memberNode = page.locator(
      `[data-comment-id="${memberComment.commentId}"]`,
    );
    await memberNode.waitFor();
    const authorLink = memberNode.locator('.comment__author-link').first();
    const avatarLink = memberNode.locator('.comment__avatar-link').first();
    assert.equal(await authorLink.count(), 1, `${device}: author name links to a profile`);
    assert.equal(await avatarLink.count(), 1, `${device}: author avatar links to a profile`);
    const profilePath = await authorLink.getAttribute('href');
    assert.equal(profilePath, '/members/dev-member-01/');

    await page.goto(origin + profilePath, { waitUntil: 'networkidle' });
    await page.locator('.profile-page').waitFor();
    assert.equal(
      (await page.locator('.profile-identity h1').textContent())?.trim(),
      'Local Verified Member',
    );
    assert.match(
      (await page.locator('.profile-affiliation').textContent()) ?? '',
      /Engage member/,
    );
    const commentCount = Number(
      (await page.locator('.profile-stat').first().locator('.profile-stat__value').textContent()) ?? '0',
    );
    assert.ok(commentCount >= 1, `${device}: comment stat is populated`);
    assert.equal(
      await page.locator('.profile-tab[aria-current="page"]').textContent().then((text) => text?.includes('Comments')),
      true,
    );
    assert.equal(await page.locator('.profile-item').count(), commentCount);
    const deepLink = await page
      .locator('.profile-item__link')
      .first()
      .getAttribute('href');
    assert.ok(deepLink?.includes(`#comment-${memberComment.commentId}`), 'history links to the exact comment');

    // Follow the deep link back to the discussion anchor.
    await page.goto(origin + deepLink, { waitUntil: 'networkidle' });
    assert.equal(new URL(page.url()).hash, `#comment-${memberComment.commentId}`);
    await page.locator(`#comment-${memberComment.commentId}`).waitFor();
    assert.equal(
      await page.locator(`#comment-${memberComment.commentId}`).count(),
      1,
      `${device}: deep link resolves to one comment`,
    );

    // The administrator's profile resolves independently.
    await page.goto(origin + proposalPath, { waitUntil: 'networkidle' });
    const adminNode = page.locator(
      `[data-comment-id="${adminComment.commentId}"]`,
    );
    const adminHref = await adminNode
      .locator('.comment__author-link')
      .first()
      .getAttribute('href');
    assert.equal(adminHref, '/members/dev-admin-01/');
    await page.goto(origin + adminHref, { waitUntil: 'networkidle' });
    assert.equal(
      (await page.locator('.profile-identity h1').textContent())?.trim(),
      'Local Administrator',
    );

    // Empty tabs state what is missing rather than inventing content.
    await page.goto(`${origin}${profilePath}?tab=proposals`, {
      waitUntil: 'networkidle',
    });
    assert.match(
      (await page.locator('.profile-empty').textContent()) ?? '',
      /No public proposals yet|You have not suggested a proposal yet/,
    );
    await page.goto(`${origin}${profilePath}?tab=amendments`, {
      waitUntil: 'networkidle',
    });
    assert.match(
      (await page.locator('.profile-empty').textContent()) ?? '',
      /No public amendments yet|You have not proposed an amendment yet/,
    );

    const overflow = await page.evaluate(() => ({
      body: document.body.scrollWidth - window.innerWidth,
    }));
    assert.ok(overflow.body <= 1, `${device}: profile must not scroll horizontally`);

    assert.deepEqual(errors, [], `${device}: no uncaught browser errors`);

    const missing = await page.goto(`${origin}/members/no-such-member/`, {
      waitUntil: 'networkidle',
    });
    assert.equal(missing?.status(), 404);
    assert.match(
      (await page.locator('.error-page__code').textContent()) ?? '',
      /404/,
    );

    await page.goto(origin + profilePath, { waitUntil: 'networkidle' });
    await page.locator('.profile-page').screenshot({
      path: path.join(output, `profile-${device}.png`),
      fullPage: true,
    });
    results.push({ device, width, height, overflow, commentCount, profilePath });
    await context.close();
  }

  // The account owner edits the biography from My Engage. The development
  // session has no persisted account document, so this check verifies the
  // control and profile entry point rather than a successful write.
  const memberContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await memberContext.addCookies([
    { name: 'engage_dev_user', value: 'member', url: origin },
  ]);
  const memberPage = await memberContext.newPage();
  memberPage.setDefaultTimeout(20_000);
  await memberPage.goto(`${origin}/member/?view=account`, {
    waitUntil: 'networkidle',
  });
  const bioInput = memberPage.locator('#member-bio');
  await bioInput.waitFor();
  assert.equal(await bioInput.count(), 1, 'owner sees the biography field');
  const visibleSwitch = memberPage.locator('#member-profile-visible');
  assert.equal(await visibleSwitch.count(), 1, 'owner sees the profile visibility control');
  assert.equal(await visibleSwitch.getAttribute('data-state'), 'checked');
  const profileLink = memberPage.getByRole('link', {
    name: 'View public profile',
  });
  assert.equal(await profileLink.count(), 1);
  assert.equal(await profileLink.getAttribute('href'), '/members/dev-member-01/');
  await memberPage
    .locator('form:has(#member-bio)')
    .screenshot({ path: path.join(output, 'profile-settings-desktop.png') });
  await memberContext.close();

  await writeFile(
    path.join(output, 'verification.json'),
    JSON.stringify(
      {
        syntheticAccountsOnly: true,
        productionAccess: false,
        results,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify({ screenshots: 2, output, results }));
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
