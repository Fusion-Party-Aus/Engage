import test from 'node:test';
import assert from 'node:assert/strict';
import { GET as consultationGet } from '../../pages/api/consultations/index.ts';
import { loadPolicyCatalogue } from './catalogue.ts';
import { getDatabase } from './database.ts';
import type { PlatformEnv } from './types.ts';
import { canReadDiscussion } from './discussion-access.ts';
import { listMemberSubmissions, listOwnSubmissions } from './consultations.ts';

const env: PlatformEnv = { APP_MODE: 'preview', SESSION_SECRET: 'isolated-test-secret-000000000000000000' };
test('public filtered consultation reads require authentication', async () => {
  for (const query of ['', '?policyId=POL-010', '?roundId=first-priority-policy-round-2026']) {
    const response = await consultationGet({ request: new Request('http://localhost/api/consultations' + query), locals: { env } });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).submissions, undefined);
  }
});

test('discussion requires current verified membership even with privileged roles', async () => {
  const db = await getDatabase(env);
  const member = { memberId: 'privacy-account', source: 'engage' as const, roles: ['administrator' as const, 'moderator' as const] };
  const production = { APP_MODE: 'production' };
  for (const status of ['pending', 'verified', 'suspended']) {
    await db.collection('memberships').updateOne({ memberId: member.memberId }, { $set: { status } }, { upsert: true });
    assert.equal(await canReadDiscussion(db, member, production), status === 'verified');
    if (status !== 'verified') {
      await assert.rejects(() => listMemberSubmissions(db, member, production), /Verified membership/);
      await assert.rejects(() => listOwnSubmissions(db, member, production), /Verified membership/);
    }
  }
  const synthetic = { ...member, source: 'synthetic' as const };
  assert.equal(await canReadDiscussion(db, synthetic, production), false);
  assert.equal(await canReadDiscussion(db, synthetic, env), true);
  assert.equal(await canReadDiscussion(db, member, env), false);
});

test('public catalogue never contains member discussion or moderator responses', async () => {
  const db = await getDatabase(env);
  await db.collection('consultation_submissions').insertOne({
    submissionId: 'privacy-marker', policyId: 'POL-010', roundId: 'first-priority-policy-round-2026',
    status: 'accepted', body: 'PRIVATE_DISCUSSION_MARKER', moderatorResponse: 'PRIVATE_REVIEW_MARKER',
    identitySource: 'synthetic', createdAt: new Date(),
  });
  const catalogue = await loadPolicyCatalogue(env);
  assert.equal(JSON.stringify(catalogue).includes('PRIVATE_'), false);
  assert.ok(catalogue.every(policy => policy.submissions.length === 0));
});
