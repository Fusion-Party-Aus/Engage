// Threaded discussion browser verification.
//
// Runs against an isolated in-memory preview server, never production. It
// proves the renderer nests replies under their parents (including after
// sorting), that top-level sorting does not flatten the thread, that the
// thread survives the mobile viewport, and that reply/endorse/collapse/delete
// interactions work from the keyboard and pointer.
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
const origin = 'http://127.0.0.1:4398';
const output = path.resolve('docs/screenshots/discussion-thread');
await mkdir(output, { recursive: true });

const server = spawn(process.execPath, ['dist/server/entry.mjs'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    APP_MODE: 'preview',
    MONGODB_URI: '',
    HOST: '127.0.0.1',
    PORT: '4398',
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

function commentNode(page, commentId) {
  return page.locator(`[data-comment-id="${commentId}"]`);
}

function ownActions(node) {
  return node.locator(
    ':scope > article > .comment__row > .comment__main > .comment__actions',
  );
}

let browser;
try {
  await waitForServer();

  const proposalList = await fetch(`${origin}/api/proposals`, {
    headers: headers('administrator'),
  }).then((response) => response.json());
  const proposal = proposalList.proposals.find(
    (item) => item.stage !== 'archived' && item.publicationScope !== 'private',
  );
  assert.ok(proposal, 'a seed proposal is available for discussion');
  const proposalPath = `/proposals/${proposal.slug}/`;
  const proposalId = proposal.proposalId;

  // Parent-first fixture with deliberately out-of-order identifiers and
  // several generations of replies. Small gaps keep timestamps distinct.
  const pause = () => new Promise((resolve) => setTimeout(resolve, 25));
  const rootA = await postComment('member', {
    proposalId,
    stance: 'support',
    body: 'Browser fixture: parent contribution A.',
  });
  await pause();
  const replyA1 = await postComment('administrator', {
    proposalId,
    parentCommentId: rootA.commentId,
    stance: 'concern',
    body: 'Browser fixture: first reply to A.',
  });
  await pause();
  const replyA2 = await postComment('member', {
    proposalId,
    parentCommentId: replyA1.commentId,
    stance: 'amendment',
    body: 'Browser fixture: nested reply to the first reply.',
  });
  await pause();
  const replyA3 = await postComment('administrator', {
    proposalId,
    parentCommentId: replyA2.commentId,
    stance: 'comment',
    body: 'Browser fixture: fourth generation reply.',
  });
  await pause();
  const replyA4 = await postComment('member', {
    proposalId,
    parentCommentId: replyA3.commentId,
    stance: 'comment',
    body: 'Browser fixture: fifth generation reply.',
  });
  await pause();
  const replyA5 = await postComment('administrator', {
    proposalId,
    parentCommentId: replyA4.commentId,
    stance: 'comment',
    body: 'Browser fixture: sixth generation reply for the indentation cap.',
  });
  await pause();
  const rootB = await postComment('administrator', {
    proposalId,
    stance: 'comment',
    body: 'Browser fixture: top-level contribution B.',
  });
  await pause();
  const rootC = await postComment('member', {
    proposalId,
    stance: 'concern',
    body: 'Browser fixture: top-level contribution C.',
  });
  await voteComment('member', rootA.commentId, 'upvote');
  await voteComment('member', rootB.commentId, 'upvote');
  await voteComment('administrator', rootB.commentId, 'downvote');

  browser = await chromium.launch({ headless: true });
  const results = [];

  for (const [device, width, height] of [
    ['desktop', 1440, 1000],
    ['mobile', 390, 844],
  ]) {
    const context = await browser.newContext({ viewport: { width, height } });
    await context.addCookies([
      { name: 'engage_dev_user', value: 'member', url: origin },
    ]);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    await page.goto(origin + proposalPath, { waitUntil: 'networkidle' });
    await page.locator('.discussion-thread').waitFor();
    await page.waitForTimeout(700);

    const nodeA = commentNode(page, rootA.commentId);
    const nodeA1 = commentNode(page, replyA1.commentId);
    const nodeA2 = commentNode(page, replyA2.commentId);
    assert.equal(await nodeA.count(), 1);
    assert.equal(await nodeA1.count(), 1);
    assert.equal(await nodeA2.count(), 1);

    // Replies live inside their parent's own list, in chronological order.
    assert.equal(
      await nodeA
        .locator(`:scope > article > .comment__children > [data-comment-id="${replyA1.commentId}"]`)
        .count(),
      1,
      `${device}: first reply is nested under A`,
    );
    assert.equal(
      await nodeA1
        .locator(`:scope > article > .comment__children > [data-comment-id="${replyA2.commentId}"]`)
        .count(),
      1,
      `${device}: nested reply is nested under its own parent`,
    );
    assert.ok(
      (await nodeA.textContent()).indexOf('parent contribution A') <
        (await nodeA.textContent()).indexOf('first reply to A'),
      `${device}: the parent is rendered before its reply`,
    );
    assert.ok(
      (await nodeA1.textContent()).includes('replying to @Local Verified Member'),
      `${device}: a reply names the person it answers`,
    );

    // The visual indentation stops compounding after four generations.
    const cappedList = commentNode(page, replyA4.commentId).locator(
      ':scope > article > .comment__children',
    );
    assert.equal(
      await cappedList.getAttribute('data-capped'),
      'true',
      `${device}: deep thread lists are marked as visually capped`,
    );

    // No horizontal overflow at either viewport.
    const overflow = await page.evaluate(() => {
      const thread = document.querySelector('.discussion-thread');
      return {
        body: document.body.scrollWidth - window.innerWidth,
        thread: thread ? thread.scrollWidth - thread.clientWidth : -1,
      };
    });
    assert.ok(overflow.body <= 1, `${device}: page must not scroll horizontally`);
    assert.ok(overflow.thread <= 1, `${device}: thread must not overflow`);

    const state = { device, width, height, overflow, interactions: [] };

    if (device === 'desktop') {
      // Best is the default and orders siblings by confidence, not by a
      // single perfect upvote. A has 1 up / 0 down, B has 1 up / 1 down.
      const sortSelect = page.getByLabel('Sort top-level contributions');
      assert.equal(await sortSelect.inputValue(), 'best');
      const roots = page.locator('.comment-thread > .comment');
      const order = async () =>
        roots.evaluateAll((nodes) => nodes.map((node) => node.dataset.commentId));
      assert.deepEqual(await order(), [
        rootA.commentId,
        rootB.commentId,
        rootC.commentId,
      ]);

      await sortSelect.selectOption('newest');
      await page.waitForTimeout(120);
      assert.deepEqual(await order(), [rootC.commentId, rootB.commentId, rootA.commentId]);
      assert.equal(
        await nodeA
          .locator(`:scope > article > .comment__children > [data-comment-id="${replyA1.commentId}"]`)
          .count(),
        1,
        'newest sorting keeps replies under A',
      );

      await sortSelect.selectOption('top');
      await page.waitForTimeout(120);
      assert.deepEqual(await order(), [
        rootA.commentId,
        rootB.commentId,
        rootC.commentId,
      ]);

      await sortSelect.selectOption('oldest');
      await page.waitForTimeout(120);
      assert.deepEqual(await order(), [
        rootA.commentId,
        rootB.commentId,
        rootC.commentId,
      ]);
      state.interactions.push('sort keeps hierarchy');

      // Collapse and expand a thread.
      const collapse = ownActions(nodeA).getByRole('button', { name: /replies?/ }).first();
      await collapse.click();
      assert.equal(
        await nodeA.locator(':scope > article > .comment__children').isVisible(),
        false,
      );
      assert.equal(await collapse.getAttribute('aria-expanded'), 'false');
      await collapse.click();
      assert.equal(
        await nodeA.locator(':scope > article > .comment__children').isVisible(),
        true,
      );
      assert.equal(await collapse.getAttribute('aria-expanded'), 'true');
      state.interactions.push('collapse and expand');

      // Keyboard: Enter opens the reply composer, Escape closes it.
      const replyButton = ownActions(nodeA).getByRole('button', { name: 'Reply', exact: true });
      await replyButton.focus();
      await page.keyboard.press('Enter');
      await nodeA.locator('.reply-composer textarea').waitFor();
      assert.equal(
        await page.evaluate(() => document.activeElement?.tagName),
        'TEXTAREA',
      );
      await page.keyboard.press('Escape');
      await nodeA.locator('.reply-composer').waitFor({ state: 'detached' });
      state.interactions.push('keyboard reply composer');

      // Post a reply and prove it is appended under the correct parent.
      await replyButton.click();
      const composer = nodeA.locator('.reply-composer').last();
      await composer.locator('textarea').fill('Browser fixture: reply posted through the interface.');
      await composer.getByRole('button', { name: 'Reply', exact: true }).click();
      const posted = nodeA
        .locator(':scope > article > .comment__children > .comment')
        .filter({ hasText: 'reply posted through the interface' });
      await posted.first().waitFor();
      assert.ok((await posted.count()) >= 1, 'posted reply is a child of A');

      // Delete the reply through the overflow menu and confirmation dialog.
      const replyNode = nodeA
        .locator(':scope > article > .comment__children > .comment')
        .filter({ hasText: 'reply posted through the interface' })
        .first();
      await ownActions(replyNode)
        .getByRole('button', { name: /More actions/ })
        .click();
      await page
        .locator('.comment__menu')
        .getByRole('button', { name: 'Delete', exact: true })
        .click();
      await replyNode
        .locator('.comment__confirm')
        .getByRole('button', { name: 'Delete', exact: true })
        .click();
      await replyNode.waitFor({ state: 'detached' });
      state.interactions.push('delete reply');

      // Votes switch between up and down, and a repeat click clears the vote.
      const upvote = ownActions(nodeA).getByRole('button', { name: /^Upvote/ });
      const downvote = ownActions(nodeA).getByRole('button', { name: /^Downvote/ });
      const score = ownActions(nodeA).locator('.comment__score');
      assert.equal(await upvote.getAttribute('aria-pressed'), 'true');
      assert.equal(await score.textContent(), '1');

      await upvote.click();
      await page.waitForFunction(
        (id) =>
          document
            .querySelector(`[data-comment-id="${id}"] > article button[aria-label^="Upvote"]`)
            ?.getAttribute('aria-pressed') === 'false',
        rootA.commentId,
      );
      assert.equal(await score.textContent(), '0');

      await downvote.click();
      await page.waitForFunction(
        (id) =>
          document
            .querySelector(`[data-comment-id="${id}"] > article button[aria-label^="Downvote"]`)
            ?.getAttribute('aria-pressed') === 'true',
        rootA.commentId,
      );
      assert.equal(await score.textContent(), '-1');
      assert.equal(await upvote.getAttribute('aria-pressed'), 'false');

      await upvote.click();
      await page.waitForFunction(
        (id) =>
          document
            .querySelector(`[data-comment-id="${id}"] > article button[aria-label^="Downvote"]`)
            ?.getAttribute('aria-pressed') === 'false',
        rootA.commentId,
      );
      assert.equal(await score.textContent(), '1');
      state.interactions.push('upvote, downvote and switch');

      // The API exposes aggregate signal and the caller's own choice only.
      const detail = await fetch(`${origin}/api/proposals/${proposalId}`, {
        headers: { Cookie: 'engage_dev_user=member' },
      }).then((response) => response.json());
      const exposed = detail.comments.find((item) => item.commentId === rootA.commentId);
      assert.ok(exposed);
      assert.equal('upvotes' in exposed, false);
      assert.equal('downvotes' in exposed, false);
      assert.equal('memberId' in exposed, false);
      assert.equal(typeof exposed.upvoteCount, 'number');
      assert.equal(typeof exposed.downvoteCount, 'number');
      assert.equal(typeof exposed.score, 'number');
      assert.equal(exposed.upvotedByMe, true);
      assert.equal(exposed.downvotedByMe, false);
      state.interactions.push('aggregate-only vote API');
    }

    if (device === 'mobile') {
      const deepest = commentNode(page, replyA5.commentId);
      const box = await deepest.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1, 'deep reply stays in viewport');
      assert.equal(await page.locator('body').evaluate((body) => body.scrollWidth <= innerWidth + 1), true);
      state.interactions.push('deep reply fits mobile');
    }

    assert.deepEqual(errors, [], `${device}: no uncaught browser errors`);
    const sortControl = page.getByLabel('Sort top-level contributions');
    if (await sortControl.count()) await sortControl.selectOption('best');
    await page.locator('#deliberation').scrollIntoViewIfNeeded();
    await page.locator('.discussion-thread').screenshot({
      path: path.join(output, `thread-${device}.png`),
    });
    results.push(state);
    await context.close();
  }

  await writeFile(
    path.join(output, 'verification.json'),
    JSON.stringify({ syntheticAccountsOnly: true, productionAccess: false, results }, null, 2) + '\n',
  );
  console.log(JSON.stringify({ screenshots: 2, output, results }));
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}

