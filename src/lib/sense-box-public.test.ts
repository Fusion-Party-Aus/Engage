import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMemoryDb } from './db.ts';
import { saveProposal } from './proposals-store.ts';
import {
  addSenseComment,
  deleteSenseComment,
  getPublicSense,
  getSenseReceipt,
  getSenseSubmission,
  listPublicSense,
  listSense,
  listSenseComments,
  reviewSense,
  senseReviewScope,
  submitSense,
} from './sense-box.ts';
import type { SessionUser } from './types.ts';

const organiser = {
  memberId: 'organiser',
  name: 'Branch Organiser',
  email: 'organiser@example.test',
  role: 'member',
  isAdmin: false,
  isStaff: false,
  branchAdminIds: ['branch-vic'],
  canParticipate: true,
  status: 'verified',
} as SessionUser;
const member = {
  memberId: 'member',
  name: 'Verified Member',
  email: 'member@example.test',
  role: 'member',
  isAdmin: false,
  isStaff: false,
  branchAdminIds: [],
  canParticipate: true,
  status: 'verified',
} as SessionUser;
const admin = {
  memberId: 'admin',
  name: 'National Admin',
  email: 'admin@example.test',
  role: 'administrator',
  isAdmin: true,
  branchAdminIds: [],
  canParticipate: true,
  isStaff: true,
  status: 'verified',
} as SessionUser;
const input = {
  requestId: '12345678-1234-4234-8234-123456789abc',
  branchId: 'branch-vic',
  title: 'Better regional transport',
  detail: 'More frequent trains would help our community.',
  locality: 'Bendigo',
  topic: 'transport',
  consent: true,
};

async function setup() {
  const db = createMemoryDb();
  await db.collection('branches').insertOne({ branchId: 'branch-vic', name: 'Fusion Victoria', kind: 'state', recognised: true });
  await db.collection('branches').insertOne({ branchId: 'branch-nsw', name: 'Fusion NSW', kind: 'state', recognised: true });
  return db;
}

async function published(db: Awaited<ReturnType<typeof setup>>) {
  const submissionId = await submitSense(db, input);
  await reviewSense(db, organiser, { submissionId, branchId: 'branch-vic', version: 0, action: 'publish' });
  return submissionId;
}

test('publication is an explicit reviewer action and legacy submissions stay private', async () => {
  const db = await setup();
  const submissionId = await submitSense(db, input);
  await db.collection('sense_submissions').insertOne({
    submissionId: '22345678-1234-4234-8234-123456789abc',
    branchId: 'branch-vic',
    title: 'Legacy private concern',
    detail: 'Collected under the private review promise.',
    locality: '',
    topic: 'housing',
    status: 'new',
    version: 0,
    fingerprint: 'legacy',
    createdAt: new Date(),
  });

  assert.equal((await listPublicSense(db, {})).total, 0, 'legacy submissions must never publish automatically');
  assert.equal((await getPublicSense(db, submissionId)), null);
  await assert.rejects(
    reviewSense(db, organiser, { submissionId: '22345678-1234-4234-8234-123456789abc', branchId: 'branch-vic', version: 0, action: 'publish' }),
    /without consent/,
    'legacy private submissions cannot be published',
  );

  await reviewSense(db, organiser, { submissionId, branchId: 'branch-vic', version: 0, action: 'publish' });
  const list = await listPublicSense(db, {});
  assert.equal(list.total, 1);
  assert.equal(list.items[0]?.submissionId, submissionId);
  assert.equal(list.items[0]?.locality, 'Bendigo');
  assert.equal('status' in (list.items[0] ?? {}), false);
  assert.equal('fingerprint' in (list.items[0] ?? {}), false);
  assert.equal('reviewedBy' in (list.items[0] ?? {}), false);

  const detail = await getPublicSense(db, submissionId);
  assert.equal(detail?.title, 'Better regional transport');
  assert.deepEqual(detail?.comments, []);

  await reviewSense(db, organiser, { submissionId, branchId: 'branch-vic', version: 1, action: 'unpublish' });
  assert.equal((await listPublicSense(db, {})).total, 0);
  await assert.rejects(
    reviewSense(db, organiser, { submissionId, branchId: 'branch-vic', version: 1, action: 'unpublish' }),
    /changed|no longer/,
  );
});

test('review, publication and linking stay inside the reviewer branch', async () => {
  const db = await setup();
  const submissionId = await submitSense(db, input);
  await assert.rejects(
    reviewSense(db, { ...organiser, branchAdminIds: [] }, { submissionId, branchId: 'branch-vic', version: 0, action: 'publish' }),
    /access/,
  );
  await assert.rejects(
    reviewSense(db, organiser, { submissionId, branchId: 'branch-nsw', version: 0, action: 'publish' }),
    /access/,
  );
  assert.deepEqual(senseReviewScope(organiser).branchIds, ['branch-vic']);
  assert.equal(senseReviewScope(admin).national, true);

  const inbox = await listSense(db, organiser, {});
  assert.equal(inbox.items[0]?.visibility, 'private');
  await assert.rejects(listSense(db, member, {}), /access/);
});

test('public discussion is readable without an account and internal notes stay private', async () => {
  const db = await setup();
  const submissionId = await published(db);

  const publicComment = await addSenseComment(db, member, { submissionId, body: 'This affects my commute too.', visibility: 'public' });
  const internalNote = await addSenseComment(db, organiser, { submissionId, body: 'Check the timetable evidence.', visibility: 'internal' });
  assert.equal(publicComment.visibility, 'public');
  assert.equal(internalNote.visibility, 'internal');

  const publicView = await getPublicSense(db, submissionId);
  assert.equal(publicView?.comments.length, 1);
  assert.equal(publicView?.comments[0]?.body, 'This affects my commute too.');

  const all = await listSenseComments(db, submissionId, 'all', organiser);
  assert.equal(all.length, 2);
  assert.equal((await listSenseComments(db, submissionId, 'public')).length, 1);

  await assert.rejects(
    addSenseComment(db, member, { submissionId, body: 'A private note attempt.', visibility: 'internal' }),
    /access/,
  );

  await deleteSenseComment(db, member, publicComment.commentId);
  const after = await getPublicSense(db, submissionId);
  assert.equal(after?.comments[0]?.deleted, true);
  assert.equal(after?.comments[0]?.body, '');
});

test('public comments require publication and verified participation', async () => {
  const db = await setup();
  const submissionId = await submitSense(db, input);
  await assert.rejects(
    addSenseComment(db, member, { submissionId, body: 'Not yet public.', visibility: 'public' }),
    /not open/,
  );
  await reviewSense(db, organiser, { submissionId, branchId: 'branch-vic', version: 0, action: 'publish' });
  await assert.rejects(
    addSenseComment(db, { ...member, canParticipate: false }, { submissionId, body: 'Unverified.', visibility: 'public' }),
    /Verified membership/,
  );
});

test('a submission receipt is minimal, capability-based and tracks publication', async () => {
  const db = await setup();
  const submissionId = await submitSense(db, input);
  const receipt = await getSenseReceipt(db, submissionId);
  assert.equal(receipt?.stage, 'received');
  assert.equal(receipt?.publicationConsent, true);
  assert.equal('detail' in (receipt ?? {}), false);
  assert.equal('reviewedBy' in (receipt ?? {}), false);
  assert.equal('fingerprint' in (receipt ?? {}), false);

  await reviewSense(db, organiser, { submissionId, branchId: 'branch-vic', version: 0, action: 'publish' });
  assert.equal((await getSenseReceipt(db, submissionId))?.stage, 'published');
  assert.equal(await getSenseReceipt(db, '../../etc/passwd'), null);
});

test('a review can link a published priority to an existing proposal without changing the proposal', async () => {
  const db = await setup();
  const submissionId = await published(db);
  const proposal = await saveProposal(db, admin, {
    title: 'Fund more regional services',
    space: 'Transport',
    summary: 'A public proposal that addresses the priority.',
    outcomes: ['More services'],
    details: 'Proposal detail.',
  });

  await reviewSense(db, organiser, {
    submissionId,
    branchId: 'branch-vic',
    version: 1,
    action: 'link',
    proposalId: proposal.proposalId,
  });

  const detail = await getSenseSubmission(db, organiser, submissionId);
  assert.equal(detail?.linkedProposal?.proposalId, proposal.proposalId);
  const publicView = await getPublicSense(db, submissionId);
  assert.equal(publicView?.linkedProposal?.slug, proposal.slug);

  await reviewSense(db, organiser, { submissionId, branchId: 'branch-vic', version: 2, action: 'link' });
  assert.equal((await getSenseSubmission(db, organiser, submissionId))?.linkedProposal, undefined);
});

test('developing a proposal records the source and links the priority atomically', async () => {
  const db = await setup();
  const submissionId = await published(db);
  const proposal = await saveProposal(db, organiser, {
    title: 'Frequent regional trains',
    space: 'Transport',
    summary: 'A proposal developed from the community priority.',
    outcomes: ['Hourly services'],
    details: 'Developed from a Sense Box priority.',
    sourceSenseSubmissionId: submissionId,
  });
  assert.equal(proposal.sourceSenseSubmissionId, submissionId);
  assert.equal(proposal.sourceSensePrivacyBasis, 'published-source');
  const row = await db.collection('sense_submissions').findOne({ submissionId });
  assert.equal(row?.linkedProposalId, proposal.proposalId);
  assert.equal(row?.status, 'developing');

  const another = await submitSense(db, { ...input, requestId: '32345678-1234-4234-8234-123456789abc' });
  await reviewSense(db, organiser, { submissionId: another, branchId: 'branch-vic', version: 0, action: 'publish' });
  await assert.rejects(
    saveProposal(db, member, {
      title: 'Unauthorised source',
      space: 'Transport',
      summary: 'A member cannot claim a Sense Box source.',
      details: 'No.',
      sourceSenseSubmissionId: another,
    }),
    /not authorised/,
  );
});

test('a private priority cannot be copied into a public proposal without an independent-writing review', async () => {
  const db = await setup();
  const submissionId = await submitSense(db, input);

  await assert.rejects(
    saveProposal(db, organiser, {
      title: 'A different transport proposal',
      space: 'Transport',
      summary: 'An independently written proposal about transport.',
      details: 'Independent rationale.',
      sourceSenseSubmissionId: submissionId,
    }),
    /independently written/,
    'a private source requires the acknowledgement',
  );

  await assert.rejects(
    saveProposal(db, organiser, {
      title: 'A different transport proposal',
      space: 'Transport',
      summary: 'An independently written proposal about transport.',
      details: 'More frequent trains would help our community.',
      sourceSenseSubmissionId: submissionId,
      privateSourceAcknowledgement: true,
    }),
    /reproduces text/,
    'copied source text is refused even with the acknowledgement',
  );

  await assert.rejects(
    saveProposal(db, organiser, {
      title: 'A different transport proposal',
      space: 'Transport',
      summary: 'An independently written proposal about transport.',
      details: 'Independent rationale.',
      outcomes: ['More frequent trains would help our community.'],
      sourceSenseSubmissionId: submissionId,
      privateSourceAcknowledgement: true,
    }),
    /reproduces text/,
    'copied source text in a commitment is refused',
  );

  const independent = await saveProposal(db, organiser, {
    title: 'A different transport proposal',
    space: 'Transport',
    summary: 'An independently written proposal about regional services.',
    details: 'Independent rationale.',
    sourceSenseSubmissionId: submissionId,
    privateSourceAcknowledgement: true,
  });
  assert.equal(independent.sourceSensePrivacyBasis, 'independent-wording');
  assert.ok(independent.sourceSensePrivacyReviewedAt);
  assert.equal(independent.sourceSensePrivacyReviewedBy, organiser.memberId);
});

test('concurrent proposal creation cannot both claim one priority', async () => {
  const db = await setup();
  const submissionId = await published(db);
  const payload = {
    space: 'Transport',
    summary: 'A proposal developed from the same community priority.',
    outcomes: ['Hourly services'],
    details: 'Developed from a Sense Box priority.',
    sourceSenseSubmissionId: submissionId,
  };
  const results = await Promise.allSettled([
    saveProposal(db, organiser, { ...payload, title: 'First concurrent proposal' }),
    saveProposal(db, organiser, { ...payload, title: 'Second concurrent proposal' }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.match(String(rejected?.status === 'rejected' ? rejected.reason : ''), /already linked/);
  assert.equal(await db.collection('proposals').countDocuments({ sourceSenseSubmissionId: submissionId }), 1);
});
