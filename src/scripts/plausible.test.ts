import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Exercise the real tracker in a fresh browser-like process for each hostname.
const runTracker = (hostname: string) => {
  const code = `
    const calls = [];
    const location = { hostname: ${JSON.stringify(hostname)}, pathname: '/', href: 'https://${hostname}/', protocol: 'https:' };
    const listeners = {};
    const document = { visibilityState: 'visible', referrer: '', body: {}, documentElement: {},
      hasFocus: () => true, addEventListener: (name, fn) => { listeners[name] = fn; } };
    const history = { pushState(_state, _title, path) { const url = new URL(path, location.href); location.pathname = url.pathname; location.href = url.href; } };
    const fetch = async (url, options) => { calls.push({ url, ...JSON.parse(options.body) }); return { status: 202 }; };
    Object.assign(globalThis, { location, document, history, fetch,
      ResizeObserver: class { observe() {} },
      window: { location, history, fetch, navigator: {}, localStorage: {}, addEventListener() {} } });
    await import('./src/scripts/plausible.ts');
    history.pushState({}, '', '/proposals/');
    history.pushState({}, '', '/proposals/?stage=decide');
    process.stdout.write(JSON.stringify(calls));
  `;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Array<{ url: string; n: string; d: string; u: string }>;
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
