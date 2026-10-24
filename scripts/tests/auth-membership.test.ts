import test from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { betterAuth } from 'better-auth';
import { createEngageAuth } from '../../src/lib/platform/better-auth.ts';
import { resolveIdentity } from '../../src/lib/platform/auth.ts';
import { membershipStatus } from '../../src/lib/platform/membership.ts';
import { ensureIndexes, closeDatabase } from '../../src/lib/platform/database.ts';
import { GET as sessionGET, DELETE as logout } from '../../src/pages/api/session.ts';
import { PATCH as verify, GET as members } from '../../src/pages/api/admin/members.ts';
import { POST as submit } from '../../src/pages/api/consultations/index.ts';
import { PATCH as openBallot } from '../../src/pages/api/admin/ballots/[ballotId].ts';
import { POST as vote } from '../../src/pages/api/votes.ts';
import { ballotSafeguards } from '../../src/lib/platform/ballot-authorization.ts';
import { castVote, finalizeBallot, getBallotResults, type BallotRecord } from '../../src/lib/platform/ballots.ts';
import type { PlatformEnv } from '../../src/lib/platform/types.ts';

const uri = process.env.AUTH_TEST_MONGODB_URI;
if (!uri) throw new Error('Set AUTH_TEST_MONGODB_URI to an isolated test MongoDB server.');
const env: PlatformEnv = { APP_MODE: 'production', MONGODB_URI: uri, MONGODB_DB_NAME: 'engage_auth_test_' + Date.now(), BETTER_AUTH_URL: 'http://localhost:4321', BETTER_AUTH_SECRET: 'controlled-test-secret-0000000000000000000000000000', GOOGLE_CLIENT_ID: 'controlled-google-client', GOOGLE_CLIENT_SECRET: 'controlled-google-secret', FORMAL_BALLOTS_ENABLED: 'true' };
const locals = { env };
const origin = 'http://localhost:4321';
function request(path: string, cookie: string, method = 'GET', body?: unknown) { return new Request(origin + path, { method, headers: { cookie, origin, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); }

test('controlled Google provider flow, Mongo sessions, manual verification, API access and vote preservation', async () => {
  const client = await MongoClient.connect(uri);
  const db = client.db(env.MONGODB_DB_NAME);
  try {
    await ensureIndexes(db);
    const base = createEngageAuth(db, env);
    // Controlled provider boundary only: no live Google authentication is claimed.
    const auth = betterAuth({ ...base.options, socialProviders: { google: { clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET!, verifyIdToken: async (token) => token.startsWith('controlled:'), getUserInfo: async (token) => {
      const sub = token.idToken!.split(':')[1]!;
      const email = sub === 'different-provider-subject' ? 'member@example.test' : sub + '@example.test';
      return { user: { name: sub, email, emailVerified: true }, data: { sub, email, email_verified: true, aud: env.GOOGLE_CLIENT_ID!, azp: env.GOOGLE_CLIENT_ID!, exp: 2000000000, iat: 1000000000, iss: "https://accounts.google.com", family_name: "Test", given_name: sub, name: sub, picture: "https://example.test/avatar" } };
    } } } });
    async function signIn(subject: string) {
      const response = await auth.api.signInSocial({ body: { provider: 'google', idToken: { token: 'controlled:' + subject } }, headers: new Headers({ origin }), asResponse: true });
      const data = await response.json();
      assert.equal(response.status, 200, JSON.stringify(data));
      const cookie = response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
      return { cookie, user: data.user };
    }
    const redirect = await auth.api.signInSocial({ body: { provider: 'google', callbackURL: '/member/' }, headers: new Headers({ origin }), asResponse: true });
    assert.equal(redirect.status, 200);
    const authorizationURL = new URL((await redirect.json()).url);
    assert.equal(authorizationURL.origin, 'https://accounts.google.com');
    assert.ok(authorizationURL.searchParams.get('state'));
    assert.ok(authorizationURL.searchParams.get('code_challenge'));
    const first = await signIn('member');
    const returning = await signIn('member');
    assert.equal(first.user.id, returning.user.id);
    assert.equal(await db.collection('user').countDocuments({}), 1);
    assert.equal(await membershipStatus(db, first.user.id), 'pending');
    const restored = await resolveIdentity(request('/api/session', first.cookie), env);
    assert.equal(restored.identity?.memberId, first.user.id);
    const roundId = 'auth-test-round'; const ballotId = 'auth-test-ballot'; const now = new Date();
    await db.collection('consultation_rounds').insertOne({ roundId, status: 'open', opensAt: new Date(now.getTime() - 10000), closesAt: new Date(now.getTime() + 3600000), policyIds: ['POL-001'] });
    await db.collection('policy_revisions').insertOne({ policyId: 'POL-001', revisionId: 'r1', version: 'v1' });
    const ballot: BallotRecord = { ballotId, proposalId: 'POL-001', policyRevisionId: 'r1', title: 'Test ballot', status: 'open', opensAt: new Date(now.getTime() - 10000), closesAt: new Date(now.getTime() + 3600000), bindingBallotsEnabled: true, authorization: { approvedBy: 'governance-test', approvedAt: now, evidence: Object.fromEntries(ballotSafeguards.map((key) => [key, 'Controlled evidence reference for ' + key])) } };
    await db.collection('ballots').insertOne(ballot);
    const contribution = { roundId, policyId: 'POL-001', policyRevisionId: 'r1', kind: 'comment', body: 'A meaningful policy comment.' };
    assert.equal((await submit({ request: request('/api/consultations', first.cookie, 'POST', contribution), locals })).status, 403);
    assert.notEqual((await vote({ request: request('/api/votes', first.cookie, 'POST', { ballotId, choice: 'approve', membershipStatus: 'verified' }), locals })).status, 200);
    assert.equal((await verify({ request: request('/api/admin/members', first.cookie, 'PATCH', { memberId: first.user.id, status: 'verified' }), locals })).status, 403);
    assert.equal((await members({ request: request('/api/admin/members', first.cookie), locals })).status, 403);
    const admin = await signIn('admin');
    await db.collection('application_roles').insertOne({ memberId: admin.user.id, role: 'administrator' });
    assert.equal((await verify({ request: request('/api/admin/members', admin.cookie, 'PATCH', { memberId: first.user.id, status: 'verified' }), locals })).status, 200);
    await db.collection('ballots').updateOne({ ballotId }, { $set: { status: 'draft', bindingBallotsEnabled: false }, $unset: { authorization: '' } });
    const transition = (body: unknown) => ({ request: request('/api/admin/ballots/' + ballotId, admin.cookie, 'PATCH', body), params: { ballotId }, locals });
    assert.equal((await openBallot(transition({ status: 'open' }))).status, 423, 'login and configuration alone cannot open binding voting');
    assert.equal((await openBallot(transition({ status: 'open', authorizationEvidence: ballot.authorization!.evidence }))).status, 200);
    assert.equal((await submit({ request: request('/api/consultations', first.cookie, 'POST', contribution), locals })).status, 201);
    for (const choice of ['approve', 'do-not-approve', 'approve']) assert.equal((await vote({ request: request('/api/votes', first.cookie, 'POST', { ballotId, choice }), locals })).status, 200);
    assert.equal(await db.collection('votes').countDocuments({ ballotId }), 1);
    assert.equal((await verify({ request: request('/api/admin/members', admin.cookie, 'PATCH', { memberId: first.user.id, status: 'suspended' }), locals })).status, 200);
    assert.equal((await submit({ request: request('/api/consultations', first.cookie, 'POST', contribution), locals })).status, 403);
    assert.notEqual((await vote({ request: request('/api/votes', first.cookie, 'POST', { ballotId, choice: 'do-not-approve' }), locals })).status, 200);
    await db.collection('votes').insertOne({ ballotId, memberId: 'synthetic-contamination', identitySource: 'synthetic', choice: 'approve' });
    await finalizeBallot(db, ballotId);
    assert.equal((await getBallotResults(db, (await db.collection<BallotRecord>('ballots').findOne({ ballotId }))!))?.approve, 1, 'synthetic activity never contributes to a binding tally');
    await assert.rejects(() => castVote(db, { memberId: 'preview-member-01', source: 'synthetic', roles: ['member'] }, ballot, 'approve', env), /Engage member identity/);
    const audit = (await db.collection('memberships').findOne({ memberId: first.user.id }))?.auditHistory[0];
    assert.equal(audit?.actorId, admin.user.id);
    const foreignSubject = await auth.api.signInSocial({ body: { provider: 'google', idToken: { token: 'controlled:different-provider-subject' } }, headers: new Headers({ origin }), asResponse: true });
    assert.notEqual(foreignSubject.status, 200, 'same email cannot link a new subject');
    assert.equal(await db.collection('user').countDocuments({ email: 'member@example.test' }), 1);
    // A fresh Better Auth instance restores the database session, with no process-local state.
    assert.equal((await createEngageAuth(db, env).api.getSession({ headers: new Headers({ cookie: first.cookie }) }))?.user.id, first.user.id);
    if (process.env.AUTH_TEST_DOCKER_IMAGE) {
      const container = env.MONGODB_DB_NAME!;
      const appOrigin = 'http://127.0.0.1:4329';
      try {
        execFileSync('docker', ['run', '-d', '--name', container, '-p', '127.0.0.1:4329:4321',
          ...Object.entries({ ...env, BETTER_AUTH_URL: appOrigin, MONGODB_URI: 'mongodb://host.docker.internal:27029/?directConnection=true' }).flatMap(([key, value]) => ['-e', key + '=' + value]), process.env.AUTH_TEST_DOCKER_IMAGE], { stdio: 'pipe' });
        async function restoredContainerSession() {
          let lastError: unknown;
          for (let attempt = 0; attempt < 40; attempt++) {
            try {
              const response = await fetch(appOrigin + '/api/session', { headers: { cookie: first.cookie } });
              assert.equal(response.status, 200); const session = await response.json();
              assert.equal(session.identity.memberId, first.user.id); assert.equal(session.membershipStatus, 'suspended');
              return;
            } catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 500)); }
          }
          throw lastError;
        }
        await restoredContainerSession();
        const memberPage = await fetch(appOrigin + '/member/');
        assert.equal(memberPage.status, 200);
        const markup = await memberPage.text();
        assert.match(markup, /Sign in with Google/);
        assert.doesNotMatch(markup, /name="memberId"/);
        const mountedSignIn = await fetch(appOrigin + '/api/auth/sign-in/social', { method: 'POST', headers: { origin: appOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'google', callbackURL: '/member/' }) });
        assert.equal(mountedSignIn.status, 200);
        assert.equal(new URL((await mountedSignIn.json()).url).origin, 'https://accounts.google.com');
        execFileSync('docker', ['restart', container], { stdio: 'pipe' });
        await restoredContainerSession();
      } finally { execFileSync('docker', ['rm', '-f', container], { stdio: 'pipe' }); }
    }
    const own = await (await sessionGET({ request: request('/api/session', first.cookie), locals })).json();
    assert.equal(own.membershipStatus, 'suspended'); assert.equal('accounts' in own, false);
    await logout({ request: request('/api/session', first.cookie, 'DELETE'), locals });
    assert.equal((await resolveIdentity(request('/api/session', first.cookie), env)).identity, null);
  } finally { await db.dropDatabase(); await client.close(); await closeDatabase(); }
});
