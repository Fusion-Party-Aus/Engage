import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPolicyCatalogue, publicPolicyCatalogue } from './catalogue.ts';

test('public catalogue excludes private wording and lifecycle records', async () => {
  const [policy] = await loadPolicyCatalogue({});
  assert.ok(policy);
  const secret = { ...policy.activeRevision, revisionId: 'private', statement: 'SECRET DRAFT', changeSummary: 'SECRET NOTE' };
  const internal = { ...policy, statement: secret.statement, activeRevision: secret, activeRevisionId: 'private', pendingSettledRevision: secret, revisions: [policy.activeRevision, secret] };
  const [visible] = publicPolicyCatalogue([internal]);
  assert.ok(visible);
  assert.equal(visible.statement, policy.statement);
  const serialized = JSON.stringify(visible);
  assert.ok(!serialized.includes('SECRET'));
  for (const field of ['activeRevision', 'pendingSettledRevision', 'submissions']) assert.ok(!(field in visible));
  assert.equal(publicPolicyCatalogue([{ ...internal, policyId: 'PRIVATE-NEW' }]).length, 0);
});

test('explicit publication releases only the selected public revision fields', async () => {
  const [policy] = await loadPolicyCatalogue({});
  assert.ok(policy);
  const published = { ...policy.activeRevision, revisionId: 'published', statement: 'Public wording', publishedAt: new Date(0), createdBy: 'PRIVATE ACTOR' };
  const future = { ...published, revisionId: 'scheduled', statement: 'SECRET FUTURE', publishedAt: new Date('2099-01-01') };
  const [visible] = publicPolicyCatalogue([{ ...policy, revisions: [policy.activeRevision, published, future] }]);
  assert.equal(visible?.statement, 'Public wording');
  assert.ok(!JSON.stringify(visible).includes('PRIVATE ACTOR'));
  assert.ok(!JSON.stringify(visible).includes('SECRET FUTURE'));
});
