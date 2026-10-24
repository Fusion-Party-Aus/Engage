import test from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { betterAuth } from 'better-auth';
import { createEngageAuth } from '../../src/lib/platform/better-auth.ts';
import { resolveIdentity } from '../../src/lib/platform/auth.ts';
import { membershipStatus } from '../../src/lib/platform/membership.ts';
import { ensureIndexes, closeDatabase } from '../../src/lib/platform/database.ts';
import { GET as sessionGET, DELETE as logout } from '../../src/pages/api/session.ts';
import { PATCH as verify, GET as members } from '../../src/pages/api/admin/members.ts';
import { GET as adminWork } from '../../src/pages/api/admin/work.ts';
import { adminPageDenial } from '../../src/lib/platform/admin-access.ts';
import { GET as discussion } from '../../src/pages/api/consultations/index.ts';
import { GET as moderation } from '../../src/pages/api/admin/consultations/index.ts';
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

test('taxonomy migration dry-run and repeat application preserve wording and relationships', async () => {
  const client = await MongoClient.connect(uri);
  const db = client.db('engage_taxonomy_test_' + Date.now());
  try {
    const legacy = { policyId: 'POL-010', revisionId: 'original-r1', version: 'v1', division: 'RECLAIM OUR ECONOMY', domain: 'Solve the Housing Crisis', url: '/reclaim-our-economy/solve-the-housing-crisis/#original', statement: 'Original policy wording.', provenance: { summary: 'Original provenance.' }, roundId: 'original-round', approvedByBallotId: 'original-ballot' };
    const explicit = { policyId: 'FUTURE-1', revisionId: 'future-r1', taxonomyVersion: 1, programme: 'Future programme', pillar: null, editorialHeading: null, domain: 'Transport', statement: 'Future wording.' };
    await db.collection('policy_revisions').insertMany([{ ...legacy }, { ...explicit }]);
    const migrate = (...args: string[]) => {
      const output = execFileSync(process.execPath, ['scripts/migrate-policy-taxonomy.mjs', ...args], { env: { ...process.env, MONGODB_URI: uri, MONGODB_DB_NAME: db.databaseName }, encoding: 'utf8' });
      return JSON.parse(output.trim().split('\n').at(-1)!);
    };
    assert.equal(migrate().changed, 1);
    assert.equal((await db.collection('policy_revisions').findOne({ policyId: 'POL-010' }))?.domain, legacy.domain);
    assert.equal(migrate('--apply').changed, 1);
    const migrated = await db.collection('policy_revisions').findOne({ policyId: 'POL-010' });
    assert.equal(migrated?.programme, 'Reclaim');
    assert.equal(migrated?.editorialHeading, legacy.domain);
    assert.equal(migrated?.domain, 'Housing');
    for (const key of ['policyId', 'revisionId', 'version', 'url', 'statement', 'provenance', 'roundId', 'approvedByBallotId'] as const) assert.deepEqual(migrated?.[key], legacy[key]);
    assert.equal(migrate('--apply').changed, 0);
    const { _id, ...unchanged } = (await db.collection('policy_revisions').findOne({ policyId: 'FUTURE-1' }))!;
    assert.deepEqual(unchanged, explicit);
  } finally { await db.dropDatabase(); await client.close(); }
});

test('controlled Google provider flow, Mongo sessions, manual verification, API access and vote preservation', async () => {
  const client = await MongoClient.connect(uri);
  const db = client.db(env.MONGODB_DB_NAME);
  let server: ReturnType<typeof spawn> | undefined;
  try {
    await ensureIndexes(db);
    if (process.env.AUTH_TEST_SSR === 'true') {
      server = spawn(process.execPath, ['dist/server/entry.mjs'], { env: { ...process.env, ...env, HOST: '127.0.0.1', PORT: '4339' }, stdio: ['ignore', 'pipe', 'pipe'] });
      for (let attempt = 0; ; attempt++) {
        try { await fetch('http://127.0.0.1:4339/member/'); break; }
        catch (error) { if (attempt >= 40) throw error; await new Promise(resolve => setTimeout(resolve, 250)); }
      }
    }
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
    await db.collection('policy_revisions').insertOne({ policyId: 'POL-001', revisionId: 'r1', version: 'v1', createdAt: new Date(0), importedAt: new Date(0), title: 'Synthetic policy for operator verification', statement: 'Synthetic policy wording for operator verification only.', outcomes: ['A synthetic test outcome.'], details: 'Synthetic detail used only in disposable test records.' });
    const ballot: BallotRecord = { ballotId, proposalId: 'POL-001', policyRevisionId: 'r1', title: 'Test ballot', status: 'open', opensAt: new Date(now.getTime() - 10000), closesAt: new Date(now.getTime() + 3600000), bindingBallotsEnabled: true, authorization: { approvedBy: 'governance-test', approvedAt: now, evidence: Object.fromEntries(ballotSafeguards.map((key) => [key, 'Controlled evidence reference for ' + key])) } };
    await db.collection('ballots').insertOne(ballot);
    const contribution = { roundId, policyId: 'POL-001', policyRevisionId: 'r1', kind: 'comment', body: 'A meaningful policy comment.' };
    const privateMarker = 'MEMBER_ONLY_DELIBERATION_MARKER';
    await db.collection('consultation_submissions').insertOne({ submissionId: 'privacy-check', memberId: first.user.id, identitySource: 'engage', roundId, policyId: 'POL-001', policyRevisionId: 'r1', status: 'accepted', kind: 'comment', body: privateMarker, moderatorResponse: privateMarker + '_REVIEW', createdAt: now });
    await db.collection('consultation_submissions').insertOne({ submissionId: 'synthetic-private-check', memberId: first.user.id, identitySource: 'synthetic', roundId, policyId: 'POL-001', status: 'accepted', body: 'SYNTHETIC_DISCUSSION_MARKER', createdAt: now });
    async function checkDiscussion(cookie: string, expected: number) {
      for (const query of ['', '?policyId=POL-001', '?roundId=' + roundId]) {
        const response = await discussion({ request: request('/api/consultations' + query, cookie), locals });
        assert.equal(response.status, expected);
        const data = await response.text();
        assert.equal(data.includes(privateMarker), expected === 200);
        assert.equal(data.includes('SYNTHETIC_DISCUSSION_MARKER'), false);
      }
      if (server) {
        for (const path of ['/consultations/?roundId=' + roundId, '/reclaim-our-economy/restore-the-fair-go/']) {
          const response = await fetch('http://127.0.0.1:4339' + path, { headers: { cookie } });
          assert.equal(response.status, 200);
          assert.match(response.headers.get('cache-control') ?? '', /no-store/);
          const html = await response.text();
          assert.equal(html.includes(privateMarker), expected === 200, path);
          assert.equal(html.includes('SYNTHETIC_DISCUSSION_MARKER'), false);
        }
        const catalogue = await fetch('http://127.0.0.1:4339/api/policies', { headers: { cookie } });
        assert.equal(catalogue.status, 200);
        assert.equal((await catalogue.text()).includes(privateMarker), false);
      }
    }
    async function checkAdminPages(cookie: string, expected: number) {
      const response = await adminWork({ request: request('/api/admin/work', cookie), locals });
      assert.equal(response.status, expected, 'Work API authorisation');
      if (!server) return;
      for (const path of ['/admin/', '/admin/policies/', '/admin/policies/POL-001/', '/admin/consultations/', '/admin/decisions/']) {
        const page = await fetch('http://127.0.0.1:4339' + path, { headers: { cookie } });
        assert.equal(page.status, expected, path);
        assert.match(page.headers.get('cache-control') ?? '', /no-store/);
        const html = await page.text();
        if (expected !== 200) assert.doesNotMatch(html, /Synthetic policy for operator verification|MEMBER_ONLY_DELIBERATION_MARKER|name="policyRevisionId"|data-admin-api/);
        else assert.match(html, /Administration navigation/);
      }
    }
    await checkAdminPages('', 401);
    await checkAdminPages(first.cookie, 403);
    await checkDiscussion('', 401);
    await checkDiscussion(first.cookie, 403);
    assert.equal((await submit({ request: request('/api/consultations', first.cookie, 'POST', contribution), locals })).status, 403);
    assert.notEqual((await vote({ request: request('/api/votes', first.cookie, 'POST', { ballotId, choice: 'approve', membershipStatus: 'verified' }), locals })).status, 200);
    assert.equal((await verify({ request: request('/api/admin/members', first.cookie, 'PATCH', { memberId: first.user.id, status: 'verified' }), locals })).status, 403);
    assert.equal((await members({ request: request('/api/admin/members', first.cookie), locals })).status, 403);
    const admin = await signIn('admin');
    await db.collection('application_roles').insertOne({ memberId: admin.user.id, role: 'administrator' });
    assert.equal((await adminPageDenial(request('/admin/', admin.cookie), env))?.status, 403);
    await checkAdminPages(admin.cookie, 403);
    assert.equal(await adminPageDenial(request('/admin/members/', admin.cookie), env, true), null);
    assert.equal((await moderation({ request: request('/api/admin/consultations', admin.cookie), locals })).status, 403);
    if (server) {
      assert.equal((await fetch('http://127.0.0.1:4339/admin/')).status, 401);
      const denied = await fetch('http://127.0.0.1:4339/admin/', { headers: { cookie: admin.cookie } });
      assert.equal(denied.status, 403);
      assert.doesNotMatch(await denied.text(), /revision-policy-select|MEMBER_ONLY_DELIBERATION_MARKER/);
      assert.equal((await fetch('http://127.0.0.1:4339/admin/members/')).status, 401);
      assert.equal((await fetch('http://127.0.0.1:4339/admin/members/', { headers: { cookie: admin.cookie } })).status, 200);
    }
    assert.equal((await verify({ request: request('/api/admin/members', admin.cookie, 'PATCH', { memberId: first.user.id, status: 'verified' }), locals })).status, 200);
    await checkDiscussion(first.cookie, 200);
    assert.equal((await adminPageDenial(request('/admin/', first.cookie), env))?.status, 403);
    await checkAdminPages(first.cookie, 403);
    await db.collection('application_roles').insertOne({ memberId: first.user.id, role: 'moderator' });
    await checkAdminPages(first.cookie, 200);
    assert.equal((await members({ request: request('/api/admin/members', first.cookie), locals })).status, 403);
    await db.collection('application_roles').deleteOne({ memberId: first.user.id, role: 'moderator' });
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
    await checkDiscussion(first.cookie, 403);
    await db.collection('memberships').updateOne({ memberId: admin.user.id }, { $set: { status: 'verified' } }, { upsert: true });
    assert.equal(await adminPageDenial(request('/admin/', admin.cookie), env), null);
    await db.collection('policy_revisions').insertOne({ policyId: 'POL-001', revisionId: 'r2', version: 'v2', createdAt: new Date(), title: 'Synthetic latest working revision', statement: 'Latest synthetic wording for operator verification.', outcomes: ['Latest synthetic outcome.'], details: 'Latest synthetic detail for the operator workspace.' });
    await checkAdminPages(admin.cookie, 200);
    if (server) {
      const workspace = await fetch('http://127.0.0.1:4339/admin/policies/POL-001/', { headers: { cookie: admin.cookie } });
      const html = await workspace.text();
      assert.match(html, /value="Synthetic latest working revision"/);
      assert.match(html, /Latest synthetic wording for operator verification/);
      const administration = await fetch('http://127.0.0.1:4339/admin/administration/', { headers: { cookie: admin.cookie } });
      assert.equal(administration.status, 200);
    }
    assert.equal((await moderation({ request: request('/api/admin/consultations', admin.cookie), locals })).status, 200);
    await db.collection('memberships').updateOne({ memberId: admin.user.id }, { $set: { status: 'suspended' } });
    assert.equal((await moderation({ request: request('/api/admin/consultations', admin.cookie), locals })).status, 403);
    await checkAdminPages(admin.cookie, 403);
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
  } finally { if (server) { server.kill(); await new Promise<void>(resolve => server!.once("exit", () => resolve())); } await db.dropDatabase(); await client.close(); await closeDatabase(); }
});
