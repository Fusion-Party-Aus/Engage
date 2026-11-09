import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyticsPath, sanitizePayload, resultBucket, trackEngage } from './analytics.ts';

test('URL privacy boundary removes nested return paths, choices, tokens, free text and fragments', () => {
  const payload = sanitizePayload({ n: 'pageview', d: 'engage.fusionparty.org.au',
    u: 'https://engage.fusionparty.org.au/member/?email=private@example.com&returnTo=%2Fproposals%2Ftest%3Fchoice%3Dreject&token=secret#private',
    r: 'https://engage.fusionparty.org.au/proposals/test/?choice=reject#proposal-vote' });
  assert.equal(payload?.u, 'https://engage.fusionparty.org.au/member/');
  assert.equal(payload?.r, 'https://engage.fusionparty.org.au/proposals/test/');
  assert.equal(sanitizePayload({ n: 'pageview', d: 'x', u: '/api/auth/magic-link/secret' }), null);
  assert.equal(sanitizePayload({ n: 'pageview', d: 'x', u: '/', r: 'https://mail.example.com/private?token=secret' })?.r, 'https://mail.example.com');
  assert.equal(analyticsPath('/admin/members/private-id?email=private'), '/admin/');
  assert.equal(analyticsPath('/unrecognised/private-id'), '/other/');
  assert.equal(analyticsPath('https://external.example/secret'), '/external/');
});

test('result counts are bounded and analytics imports/calls are safe during server rendering', () => {
  assert.deepEqual([0, 1, 5, 6, 20, 21, 500].map(resultBucket), ['0', '1-5', '1-5', '6-20', '6-20', '21+', '21+']);
  assert.doesNotThrow(() => trackEngage('share_copied'));
});
