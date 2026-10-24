import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient, type Db } from 'mongodb';
import { castVote, finalizeBallot, type BallotRecord } from '../../src/lib/platform/ballots.ts';
import { ensureIndexes } from '../../src/lib/platform/database.ts';
import { ballotSafeguards } from '../../src/lib/platform/ballot-authorization.ts';

const uri = process.env.GOVERNANCE_TEST_MONGODB_URI;
if (!uri) throw new Error('Set GOVERNANCE_TEST_MONGODB_URI to an isolated MongoDB replica set.');
const client = await MongoClient.connect(uri);
const db = client.db('engage_cutoff_test_' + Date.now());
await ensureIndexes(db);
test.after(async () => { await db.dropDatabase(); await client.close(); });
const env = { APP_MODE: 'production', FORMAL_BALLOTS_ENABLED: 'true' };
const member = { memberId: 'cutoff-member', source: 'engage' as const, roles: ['member' as const] };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function intercept(collectionName: string, method: string, before: () => Promise<void>): Db {
  return new Proxy(db, { get(target, key) {
    if (key !== 'collection') { const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; }
    return (name: string) => {
      const collection = target.collection(name);
      if (name !== collectionName) return collection;
      return new Proxy(collection, { get(target, key) {
        const value = Reflect.get(target, key);
        if (key === method) return async (...args: unknown[]) => { await before(); return value.apply(target, args); };
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    };
  } });
}
async function fixture(id: string, overrides: Partial<BallotRecord> = {}) {
  const ballot: BallotRecord = {
    ballotId: id, proposalId: id, policyRevisionId: id + ':v1', title: 'Cutoff regression',
    status: 'open', opensAt: new Date(Date.now() - 60_000), closesAt: new Date(Date.now() + 60_000),
    bindingBallotsEnabled: true,
    authorization: { approvedBy: 'test', approvedAt: new Date(), evidence: Object.fromEntries(ballotSafeguards.map((key) => [key, 'Synthetic test evidence for ' + key])) },
    ...overrides,
  };
  await db.collection('ballots').insertOne({ ...ballot });
  await db.collection('policy_revisions').insertOne({ policyId: id, revisionId: ballot.policyRevisionId, version: 'v1' });
  await db.collection('memberships').updateOne({ memberId: member.memberId }, { $set: { status: 'verified' } }, { upsert: true });
  return ballot;
}

test('a request stalled during eligibility cannot vote after administrative closure', { timeout: 15000 }, async () => {
  const ballot = await fixture('stalled-eligibility');
  const reached = deferred(); const resume = deferred();
  const delayed = intercept('memberships', 'findOne', async () => { reached.resolve(); await resume.promise; });
  const pending = castVote(delayed, member, ballot, 'approve', env);
  const rejected = assert.rejects(pending, /not open/);
  await reached.promise;
  try {
    const result = await finalizeBallot(db, ballot.ballotId);
    assert.equal(result?.results.votesCast, 0);
  } finally { resume.resolve(); }
  await rejected;
  assert.equal(await db.collection('votes').countDocuments({ ballotId: ballot.ballotId }), 0);
});

test('concurrent selection write and closure record exactly the admitted selection', { timeout: 15000 }, async () => {
  const ballot = await fixture('concurrent-write');
  const reached = deferred(); const resume = deferred(); const closing = deferred();
  const delayed = intercept('votes', 'updateOne', async () => { reached.resolve(); await resume.promise; });
  const pending = castVote(delayed, member, ballot, 'approve', env);
  await reached.promise;
  const closingDb = intercept('ballots', 'updateOne', async () => { closing.resolve(); });
  const resultPromise = finalizeBallot(closingDb, ballot.ballotId);
  await closing.promise;
  resume.resolve();
  await pending;
  const result = await resultPromise;
  assert.equal(result?.results.votesCast, 1);
  assert.equal(result?.outcome, 'approved');
  const storedVote = await db.collection('votes').findOne({ ballotId: ballot.ballotId });
  assert.ok(result!.closedAt >= storedVote!.updatedAt, 'recorded closure cannot precede the admitted vote');
  const repeated = await Promise.all(Array.from({ length: 5 }, () => finalizeBallot(db, ballot.ballotId)));
  for (const item of repeated) assert.deepEqual(item?.results, result?.results);
});

test('stale schedules cannot admit a vote at or beyond the current deadline', async () => {
  for (const offset of [0, -1]) {
    const ballot = await fixture('deadline-' + offset);
    await db.collection('ballots').updateOne({ ballotId: ballot.ballotId }, { $set: { closesAt: new Date(Date.now() + offset) } });
    await assert.rejects(() => castVote(db, member, ballot, 'approve', env), /not open/);
    assert.equal(await db.collection('votes').countDocuments({ ballotId: ballot.ballotId }), 0);
  }
});

test('revotes before cutoff count once and suspension preserves the last valid selection', async () => {
  const ballot = await fixture('revote-suspend');
  await Promise.all(Array.from({ length: 4 }, () => castVote(db, member, ballot, 'do-not-approve', env)));
  await castVote(db, member, ballot, 'approve', env);
  assert.equal(await db.collection('votes').countDocuments({ ballotId: ballot.ballotId }), 1);
  await db.collection('memberships').updateOne({ memberId: member.memberId }, { $set: { status: 'suspended' } });
  await assert.rejects(() => castVote(db, member, ballot, 'do-not-approve', env), /eligibility/);
  const result = await finalizeBallot(db, ballot.ballotId);
  assert.equal(result?.results.approve, 1);
  await assert.rejects(() => castVote(db, member, ballot, 'do-not-approve', env));
});

test('a vote audit failure rolls back admission and selection together', async () => {
  const ballot = await fixture('rollback-audit');
  const failed = intercept('operational_audit', 'insertOne', async () => { throw new Error('injected audit failure'); });
  await assert.rejects(() => castVote(failed, member, ballot, 'approve', env), /injected audit failure/);
  assert.equal(await db.collection('votes').countDocuments({ ballotId: ballot.ballotId }), 0);
  assert.equal((await finalizeBallot(db, ballot.ballotId))?.outcome, 'no-valid-votes');
});

test('admission includes opening and excludes the closing instant', async () => {
  const opensAt = new Date('2026-10-26T00:00:00+11:00');
  const closesAt = new Date('2026-11-27T00:00:00+11:00');
  for (const [label, instant, accepted] of [
    ['before-opening', new Date(opensAt.getTime() - 1), false],
    ['at-opening', opensAt, true],
    ['before-close', new Date(closesAt.getTime() - 1), true],
    ['at-close', closesAt, false],
  ] as const) {
    const ballot = await fixture(label, { opensAt, closesAt, bindingBallotsEnabled: false });
    const vote = castVote(db, { ...member, source: 'synthetic' }, ballot, 'approve', { APP_MODE: 'preview' }, instant);
    if (accepted) await vote;
    else await assert.rejects(vote, /not open/);
    assert.equal(await db.collection('votes').countDocuments({ ballotId: ballot.ballotId }), accepted ? 1 : 0);
  }
});

test('a request delayed before admission uses the current database deadline', { timeout: 15000 }, async () => {
  const ballot = await fixture('deadline-in-flight');
  const reached = deferred(); const resume = deferred();
  const delayed = intercept('ballots', 'findOneAndUpdate', async () => { reached.resolve(); await resume.promise; });
  const pending = castVote(delayed, member, ballot, 'approve', env, new Date(0));
  const rejected = assert.rejects(pending, /not open/);
  await reached.promise;
  try {
    await db.collection('ballots').updateOne({ ballotId: ballot.ballotId }, { $set: { closesAt: new Date() } });
  } finally { resume.resolve(); }
  await rejected;
  assert.equal((await finalizeBallot(db, ballot.ballotId))?.results.votesCast, 0);
});
