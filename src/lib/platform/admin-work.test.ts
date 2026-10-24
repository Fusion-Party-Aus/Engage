import test from 'node:test';
import assert from 'node:assert/strict';
import { getDatabase } from './database.ts';
import { createPreviewSessionCookie } from './auth.ts';
import { GET as work } from '../../pages/api/admin/work.ts';
import { GET as queue } from '../../pages/api/admin/consultations/index.ts';

const env = { APP_MODE: 'preview', SESSION_SECRET: 'admin-work-isolated-secret-0000000000000000' };
async function request(path: string, member = 'preview-admin-01') {
  const cookie = (await createPreviewSessionCookie(member, env)).split(';')[0];
  return new Request('http://localhost' + path, { headers: { cookie } });
}

test('Work is protected and is a read-only projection, including expired ballots', async () => {
  const locals = { env };
  assert.equal((await work({ request: new Request('http://localhost/api/admin/work'), locals })).status, 401);
  assert.equal((await work({ request: await request('/api/admin/work', 'preview-member-01'), locals })).status, 403);
  const db = await getDatabase(env);
  await db.collection('ballots').insertOne({ ballotId: 'work-expired', proposalId: 'WORK-1', policyRevisionId: 'r1', title: 'Synthetic expired decision', status: 'open', opensAt: new Date(0), closesAt: new Date(1), authorization: { evidence: 'PRIVATE_AUTHORIZATION_MARKER' } });
  await db.collection('consultation_submissions').insertOne({ submissionId: 'work-private', policyId: 'WORK-1', title: 'PRIVATE_PRODUCTION_MARKER', status: 'pending', identitySource: 'engage', createdAt: new Date() });
  const before = await db.collection('ballots').findOne({ ballotId: 'work-expired' });
  const auditBefore = await db.collection('operational_audit').countDocuments({});
  const response = await work({ request: await request('/api/admin/work'), locals });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control')!, /no-store/);
  const data = await response.json();
  assert.ok(data.expired.items.some((item: any) => item.ballotId === 'work-expired'));
  assert.equal(JSON.stringify(data).includes('PRIVATE_PRODUCTION_MARKER'), false);
  assert.equal(JSON.stringify(data).includes('PRIVATE_AUTHORIZATION_MARKER'), false);
  assert.ok(data.drafts.items.length <= 20);
  assert.equal(data.drafts.hasMore, true);
  assert.deepEqual(await db.collection('ballots').findOne({ ballotId: 'work-expired' }), before);
  assert.equal(await db.collection('operational_audit').countDocuments({}), auditBefore);
});

test('moderation scopes policy and round before pagination and reports more records', async () => {
  const db = await getDatabase(env);
  for (let index = 0; index < 103; index++) await db.collection('consultation_submissions').insertOne({ submissionId: 'queue-scope-' + index, policyId: index === 102 ? 'SCOPE-2' : 'SCOPE-1', roundId: index === 102 ? 'scope-round-two' : 'scope-round-one', status: 'pending', identitySource: 'synthetic', title: 'Synthetic submission ' + index, body: 'Synthetic test body', createdAt: new Date(index + 1) });
  const locals = { env };
  const response = await queue({ request: await request('/api/admin/consultations?policyId=SCOPE-2&roundId=scope-round-two'), locals });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.submissions.length, 1);
  assert.equal(data.submissions[0].policyId, 'SCOPE-2');
  const page = await queue({ request: await request('/api/admin/consultations?policyId=SCOPE-1'), locals });
  const first = await page.json();
  assert.equal(first.submissions.length, 100);
  assert.equal(first.hasMore, true);
  const second = await queue({ request: await request('/api/admin/consultations?policyId=SCOPE-1&offset=100'), locals });
  assert.equal((await second.json()).submissions.length, 2);
  assert.equal((await queue({ request: await request('/api/admin/consultations?policyId=bad%20id'), locals })).status, 400);
});
