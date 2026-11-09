import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoveryFocus } from './proposal-discovery.ts';

test('voting defaults to outstanding ballots only for participating members', () => {
  assert.equal(discoveryFocus(new URLSearchParams('stage=decide'), true), 'needs-vote');
  assert.equal(discoveryFocus(new URLSearchParams('status=voting'), true), 'needs-vote');
  assert.equal(discoveryFocus(new URLSearchParams('stage=decide'), false), 'all');
  assert.equal(discoveryFocus(new URLSearchParams('stage=deliberate'), true), 'all');
});
test('shared URLs and explicit opt-outs override voting defaults', () => {
  for (const focus of ['all', 'discussion', 'recent', 'needs-vote']) {
    const params = new URLSearchParams({ stage: 'decide', focus });
    assert.equal(discoveryFocus(params, true), focus);
    params.set('stage', 'all');
    params.set('stage', 'decide');
    assert.equal(discoveryFocus(params, true), focus);
  }
});
test('restoration is scoped to Voting and yields to explicit URLs', () => {
  assert.equal(discoveryFocus(new URLSearchParams('stage=decide'), true, 'all'), 'all');
  assert.equal(discoveryFocus(new URLSearchParams('stage=decide&focus=needs-vote'), true, 'all'), 'needs-vote');
  assert.equal(discoveryFocus(new URLSearchParams('stage=propose'), true, 'needs-vote'), 'all');
  assert.equal(discoveryFocus(new URLSearchParams('stage=deliberate&focus=needs-vote'), true), 'all');
  assert.equal(discoveryFocus(new URLSearchParams('stage=decide&focus=all&needsVote=1'), true, 'all'), 'needs-vote');
});
