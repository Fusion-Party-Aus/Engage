import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { getInMemoryPreviewDb } from './memory-db.ts';
import { finalizeBallot, getBallotResults, closeExpiredBallots, type BallotRecord } from './ballots.ts';
import type { PlatformIdentity } from './types.ts';
import { createPreviewSessionCookie, resolveIdentity } from './auth.ts';
import { loginConfigured } from './better-auth.ts';
import { getDatabase, ensureIndexes } from './database.ts';
import { changeMembership } from './membership.ts';

const uri = process.env.GOVERNANCE_TEST_MONGODB_URI;
const client = uri ? await MongoClient.connect(uri) : null;
const mongoDb = client?.db('engage_governance_test_' + Date.now());
if (mongoDb) await ensureIndexes(mongoDb);
test.after(async () => { if (mongoDb) await mongoDb.dropDatabase(); await client?.close(); });
const testDatabase = () => mongoDb ?? getInMemoryPreviewDb();

function failWrites(db: Db, collection: string): Db {
  return { collection(name: string) {
    const target = db.collection(name);
    if (name !== collection) return target;
    return new Proxy(target, { get(object, key) {
      if (key === 'updateOne' || key === 'insertOne') return async (...args: any[]) => {
        if (collection === 'memberships' && key === 'updateOne' && !args[1]?.$push) return (object.updateOne as Function).apply(object, args);
        throw new Error('injected write failure');
      };
      const value = Reflect.get(object, key); return typeof value === 'function' ? value.bind(object) : value;
    } });
  } } as Db;
}

test('concurrent finalisation freezes a result and retries publication and audit failures', async () => {
  const db = await testDatabase();
  const ballotId = 'regression-finalisation';
  const ballot: BallotRecord = { ballotId, proposalId: 'REGRESSION', policyRevisionId: 'regression-v1', title: 'Test', status: 'open', opensAt: new Date(0), closesAt: new Date(1) };
  await db.collection('ballots').insertOne(ballot);
  await db.collection('policy_revisions').insertOne({ policyId: ballot.proposalId, revisionId: ballot.policyRevisionId });
  await db.collection('votes').insertOne({ ballotId, memberId: 'test', choice: 'approve' });
  await assert.rejects(() => finalizeBallot(failWrites(db, 'policy_revisions'), ballotId), /injected write failure/);
  const pending = await db.collection<BallotRecord>('ballots').findOne({ ballotId });
  assert.equal(pending?.finalizedAt, undefined);
  assert.equal(pending?.publishedRevisionId, null);
  assert.equal(pending?.results?.approve, 1);
  await db.collection('votes').insertOne({ ballotId, memberId: 'late', choice: 'do-not-approve' });
  await assert.rejects(() => finalizeBallot(failWrites(db, 'operational_audit'), ballotId), /injected write failure/);
  await closeExpiredBallots(db); // retries a closed but incomplete ballot
  const calls = await Promise.all(Array.from({ length: 8 }, () => finalizeBallot(db, ballotId)));
  for (const result of calls) {
    assert.equal(result?.outcome, 'approved');
    assert.equal(result?.results.votesCast, 1);
    assert.equal(result?.publishedRevisionId, ballot.policyRevisionId);
  }
  const recorded = await db.collection<BallotRecord>('ballots').findOne({ ballotId });
  assert.deepEqual(await getBallotResults(db, recorded!), calls[0]?.results);
  assert.equal(await db.collection('operational_audit').countDocuments({ ballotId, action: 'approved_revision_published' }), 1);
  assert.equal(await db.collection('operational_audit').countDocuments({ targetId: ballotId, action: 'ballot_closed_at_deadline' }), 1);
});

test('membership status and completed transition audit are atomic', async () => {
  const db = await testDatabase();
  const memberId = new ObjectId().toHexString();
  const actor: PlatformIdentity = { memberId: new ObjectId().toHexString(), source: 'engage' as const, roles: ['administrator'] };
  await db.collection('user').insertOne({ _id: new ObjectId(memberId) });
  await db.collection('application_roles').insertOne({ memberId: actor.memberId, role: 'administrator' });
  await assert.rejects(() => changeMembership(failWrites(db, 'memberships'), actor, memberId, 'verified'), /injected write failure/);
  assert.equal(await db.collection('operational_audit').countDocuments({ targetId: memberId }), 0);
  await changeMembership(db, actor, memberId, 'verified');
  await assert.rejects(() => changeMembership(failWrites(db, 'memberships'), actor, memberId, 'suspended'), /injected write failure/);
  const unchanged = await db.collection('memberships').findOne({ memberId });
  assert.equal(unchanged?.status, 'verified');
  assert.equal(unchanged?.auditHistory.length, 1);
  await changeMembership(db, actor, memberId, 'suspended');
  await changeMembership(db, actor, memberId, 'suspended');
  const member = await db.collection('memberships').findOne({ memberId });
  assert.equal(member?.status, 'suspended');
  assert.equal(member?.auditHistory.length, 2);
  assert.equal(member?.auditHistory[0].fromStatus, 'pending');
  assert.equal(member?.auditHistory[0].status, 'verified');
  assert.equal(member?.auditHistory[1].fromStatus, 'verified');
  assert.equal(member?.auditHistory[1].actorId, actor.memberId);
  assert.ok(member?.auditHistory[1].createdAt instanceof Date);
});

test('simultaneous first finalisers publish once and preserve timestamps and provenance', async () => {
  const db = await testDatabase();
  const ballotId = 'regression-concurrent-first';
  await db.collection('ballots').insertOne({ ballotId, proposalId: 'CONCURRENT', policyRevisionId: 'v1', title: 'Test', status: 'open', opensAt: new Date(0), closesAt: new Date(1) });
  await db.collection('policy_revisions').insertOne({ policyId: 'CONCURRENT', revisionId: 'v1' });
  await db.collection('votes').insertOne({ ballotId, memberId: 'test', choice: 'approve' });
  const calls = await Promise.all(Array.from({ length: 8 }, (_, i) => finalizeBallot(db, ballotId, {
    actorId: 'admin-' + i, actorSource: 'synthetic', closeReason: 'administrative', now: new Date(1000 + i),
  })));
  for (const result of calls) {
    assert.deepEqual(result?.results, calls[0]?.results);
    assert.deepEqual(result?.closedAt, calls[0]?.closedAt);
    assert.deepEqual(result?.finalizedAt, calls[0]?.finalizedAt);
  }
  assert.equal(await db.collection('operational_audit').countDocuments({ ballotId }), 2);
});

test('missing approved revision is recoverable; zero-vote and rejected results remain authoritative', async () => {
  const db = await testDatabase();
  for (const choice of ['approve', 'do-not-approve', 'none']) {
    const ballotId = 'regression-outcome-' + choice;
    await db.collection('ballots').insertOne({ ballotId, proposalId: ballotId, policyRevisionId: 'v1', title: 'Test', status: 'open', opensAt: new Date(0), closesAt: new Date(1) });
    if (choice !== 'none') await db.collection('votes').insertOne({ ballotId, memberId: 'test', choice });
    if (choice === 'approve') {
      await assert.rejects(() => finalizeBallot(db, ballotId), /Approved revision is missing/);
      await db.collection('policy_revisions').insertOne({ policyId: ballotId, revisionId: 'v1' });
    }
    const result = await finalizeBallot(db, ballotId);
    assert.equal(result?.outcome, choice === 'approve' ? 'approved' : choice === 'none' ? 'no-valid-votes' : 'not-approved');
    await db.collection('votes').insertOne({ ballotId, memberId: 'late', choice: 'approve' });
    assert.deepEqual((await finalizeBallot(db, ballotId))?.results, result?.results);
  }
});


test('preview identities and database fallback cannot authenticate production requests', async () => {
  const preview = { APP_MODE: 'preview', SESSION_SECRET: 'controlled-preview-secret-at-least-32-characters' };
  const cookie = (await createPreviewSessionCookie('preview-member-01', preview)).split(';')[0]!;
  const request = new Request('http://localhost/api/session', { headers: { cookie } });
  assert.equal((await resolveIdentity(request, preview)).identity?.source, 'synthetic');
  assert.equal((await resolveIdentity(request, { ...preview, APP_MODE: 'production' })).identity, null);
  assert.equal(loginConfigured({ ...preview, GOOGLE_CLIENT_ID: 'controlled', GOOGLE_CLIENT_SECRET: 'controlled' }), false);
  await assert.rejects(() => createPreviewSessionCookie('preview-member-01', { ...preview, APP_MODE: 'production' }), /disabled outside preview/);
  await assert.rejects(() => getDatabase({ APP_MODE: 'production' }), /not configured/);
});
