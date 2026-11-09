import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Exercise the real tracker in a fresh browser-like process for each hostname.
const runTracker = (hostname: string, actions = '') => {
  const code = `
    const calls = [];
    const location = { hostname: ${JSON.stringify(hostname)}, pathname: '/', href: 'https://${hostname}/', search: '', protocol: 'https:' };
    const listeners = {};
    const document = { visibilityState: 'visible', referrer: '', body: { dataset: {} }, documentElement: {},
      querySelector: () => null, querySelectorAll: () => [],
      hasFocus: () => true, addEventListener: (name, fn) => { listeners[name] = fn; } };
    const history = { pushState(_state, _title, path) { const url = new URL(path, location.href); location.pathname = url.pathname; location.href = url.href; } };
    const fetch = async (url, options) => { calls.push({ url, ...JSON.parse(options.body) }); return { status: 202 }; };
    Object.assign(globalThis, { location, document, history, fetch,
      ResizeObserver: class { observe() {} },
      window: { location, history, fetch, navigator: {}, localStorage: {}, addEventListener() {} } });
    await import('./src/scripts/plausible.ts');
    history.pushState({}, '', '/proposals/');
    history.pushState({}, '', '/proposals/?stage=decide');
    ${actions}
    process.stdout.write(JSON.stringify(calls));
  `;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Array<{ url: string; n: string; d: string; u: string; p?: Record<string, string> }>;
};

test('production sends one pageview on load and per path navigation', () => {
  const calls = runTracker('engage.fusionparty.org.au');
  assert.deepEqual(calls.map(({ url, n, d, u }) => ({ url, n, d, u })), [
    { url: 'https://analytics.fusionparty.org.au/api/event', n: 'pageview', d: 'engage.fusionparty.org.au', u: 'https://engage.fusionparty.org.au/' },
    { url: 'https://analytics.fusionparty.org.au/api/event', n: 'pageview', d: 'engage.fusionparty.org.au', u: 'https://engage.fusionparty.org.au/proposals/' },
  ]);
});

test('staging does not report to production analytics', () => {
  assert.deepEqual(runTracker('staging.fusionparty.org.au'), []);
});

test('custom events drop identities, free text and ballot preferences at the boundary', () => {
  const calls = runTracker('engage.fusionparty.org.au', `
    const { trackEngage } = await import('./src/lib/analytics.ts');
    trackEngage('contribution_result', { action: 'ballot', outcome: 'success', choice: 'reject', reason: 'private', email: 'member@example.com' });
    trackEngage('signin_result', { method: 'email', outcome: 'link_sent' });
    trackEngage('unexpected_event', { email: 'member@example.com' });
  `);
  assert.deepEqual(calls.filter(c => !['pageview', 'engagement'].includes(c.n)).map(c => ({ n: c.n, p: c.p })), [
    { n: 'contribution_result', p: { action: 'ballot', outcome: 'success' } },
    { n: 'signin_result', p: { method: 'email', outcome: 'link_sent' } },
  ]);
  assert.ok(!JSON.stringify(calls).includes('member@example.com'));
});

test('custom events on staging remain disabled even when called directly', () => {
  assert.deepEqual(runTracker('staging.fusionparty.org.au', `
    const { trackEngage } = await import('./src/lib/analytics.ts');
    trackEngage('contribution_result', { action: 'ballot', outcome: 'success' });
  `), []);
});


test('lifecycle interaction events never carry identity or ballot choices', () => {
 const calls=runTracker('engage.fusionparty.org.au', `
   const { trackEngage } = await import('./src/lib/analytics.ts');
   for (const name of ['my_engage_viewed','verification_cta_clicked','digest_cta_clicked']) trackEngage(name,{memberId:'private-id',email:'member@example.test',choice:'reject',token:'secret'});
 `);
 for (const name of ['my_engage_viewed','verification_cta_clicked','digest_cta_clicked']) {
   const event=calls.find(c=>c.n===name); assert.ok(event); assert.deepEqual(event.p,{});
 }
 assert.ok(!JSON.stringify(calls).includes('member@example.test'));
});
