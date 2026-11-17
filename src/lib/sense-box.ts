import { createHash, randomUUID } from 'node:crypto';
import { ObjectId, type Db } from 'mongodb';
import { STANDARD_BRANCHES } from './migrations.ts';
import { canViewProposal, normalizeProposalDoc } from './proposal-helpers.ts';
import type { SessionUser } from './types.ts';
import { branchesWithPermission } from './rbac.ts';
import {
  SENSE_TOPICS,
  SENSE_STATUSES,
  type SenseItem,
  type SenseInbox,
  type SenseComment,
  type SensePublicItem,
  type SenseReceipt,
  type SenseSubmissionDetail,
} from './sense-box-options.ts';

/** Publication consent wording introduced with review-then-publication. */
export const SENSE_PUBLICATION_CONSENT_VERSION = 'sense-box-2026-11-17';

export class SenseError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SUBMISSION_PROJECTION = {
  _id: 0, submissionId: 1, branchId: 1, title: 1, detail: 1, locality: 1,
  topic: 1, status: 1, createdAt: 1, version: 1, visibility: 1,
  publishedAt: 1, linkedProposalId: 1, publicationConsent: 1,
} as const;

function text(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max)
    throw new SenseError(`${label} must be ${min}–${max} characters.`);
  return value.trim();
}
function choice(value: unknown, options: object, label: string): string {
  if (typeof value !== 'string' || !Object.hasOwn(options, value)) throw new SenseError(`Choose a valid ${label}.`);
  return value;
}

/**
 * Review authority for Sense Box is the union of legacy branch administration
 * and the explicit `sense_box.review` permission. National reviewers may see
 * every branch; branch reviewers see only the branches they are authorised for.
 */
export function senseReviewScope(user: SessionUser) {
  const access = branchesWithPermission(user, 'sense_box.review');
  return {
    national: Boolean(user.isAdmin || access.national),
    branchIds: Array.from(new Set([...(user.branchAdminIds ?? []), ...access.branchIds])),
  };
}
export function canReviewSense(user: SessionUser, branchId: string) {
  const scope = senseReviewScope(user);
  return scope.national || scope.branchIds.includes(branchId);
}
function requireReviewScope(user: SessionUser) {
  const scope = senseReviewScope(user);
  if (scope.national) return {};
  if (!scope.branchIds.length) throw new SenseError('Branch organiser access required.', 403);
  return { branchId: { $in: scope.branchIds } };
}
function requireBranch(user: SessionUser, branchId: string) {
  if (!canReviewSense(user, branchId)) throw new SenseError('You do not have access to that branch.', 403);
}

// Sense Box submissions are protected by the shared MongoDB fixed-window
// limiter in `rate-limit.ts`; see `docs/security/turnstile.md`.

export async function submitSense(db: Db, body: Record<string, unknown>): Promise<string> {
  if (body.consent !== true) throw new SenseError('Please agree to how Fusion will use your input.');
  if (typeof body.requestId !== 'string' || !uuid.test(body.requestId)) throw new SenseError('Please reload the form and try again.');
  let branchId = text(body.branchId,'Branch',1,100);
  const destinations = await senseDestinations(db);
  const destination = destinations.find(b=>b.branchId===branchId);
  if(!destination) {
    const standard=STANDARD_BRANCHES.find(b=>b.branchId===branchId);
    const mapped=standard && destinations.find(b=>b.name===standard.name);
    if(mapped) branchId=mapped.branchId;
  }
  const content = {
    branchId,
    title:text(body.title,'Your priority',5,120),
    detail:text(body.detail,'Details',10,3000),
    locality:text(body.locality ?? '', 'Suburb or town',0,100),
    topic:choice(body.topic,SENSE_TOPICS,'topic'),
  };
  const branch = await db.collection('branches').findOne({branchId});
  const standard = STANDARD_BRANCHES.find(b => b.branchId === branchId && ['national','state','territory'].includes(b.kind));
  if (branch ? branch.recognised !== true || !['national','state','territory'].includes(branch.kind) : !standard) throw new SenseError('That state or territory is not available. Please choose another.',409);
  const _id = new ObjectId(createHash('sha256').update(body.requestId).digest('hex').slice(0,24));
  const fingerprint = createHash('sha256').update(JSON.stringify(content)).digest('hex');
  const existing = await db.collection('sense_submissions').findOne({_id});
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw new SenseError('This form has already used its submission reference. Reload to share another priority.',409);
    return String(existing.submissionId);
  }
  try {
    await db.collection('sense_submissions').insertOne({
      _id, submissionId:body.requestId, ...content, fingerprint,
      status:'new', version:0, visibility:'private', publicationConsent:true, createdAt:new Date(),
      consentVersion: SENSE_PUBLICATION_CONSENT_VERSION,
    });
  } catch (error) {
    if ((error as {code?:number}).code !== 11000) throw error;
    const saved = await db.collection('sense_submissions').findOne({_id});
    if (saved?.fingerprint !== fingerprint) throw new SenseError('This form has already used its submission reference. Reload to share another priority.',409);
  }
  return body.requestId;
}

function publicVisibility(row: Record<string, any>) {
  return row.visibility === 'published' && row.publishedAt ? 'published' : 'private';
}

async function commentCounts(db: Db, submissionIds: string[]) {
  if (!submissionIds.length) return new Map<string, number>();
  const rows = await db.collection('sense_comments')
    .find({ submissionId: { $in: submissionIds }, visibility: 'public', deletedAt: { $exists: false } })
    .project({ _id: 0, submissionId: 1 })
    .toArray();
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(String(row.submissionId), (counts.get(String(row.submissionId)) ?? 0) + 1);
  return counts;
}

async function publicProposalLinks(db: Db, proposalIds: string[]) {
  const ids = Array.from(new Set(proposalIds.filter(Boolean)));
  if (!ids.length) return new Map<string, { slug: string; title: string; stage: string }>();
  const rows = await db.collection('proposals')
    .find({ proposalId: { $in: ids } })
    .project({ _id: 0, proposalId: 1, slug: 1, title: 1, stage: 1, publicationScope: 1, originatingBranchId: 1, jurisdictionBranchId: 1, authorId: 1 })
    .toArray();
  const links = new Map<string, { slug: string; title: string; stage: string }>();
  for (const row of rows) {
    // A linked proposal is only shown publicly when an anonymous visitor could open it.
    if (!canViewProposal(normalizeProposalDoc(row), null)) continue;
    links.set(String(row.proposalId), {
      slug: String(row.slug),
      title: String(row.title),
      stage: String(row.stage),
    });
  }
  return links;
}

function toSenseItem(row: Record<string, any>, commentCount = 0): SenseItem {
  return {
    submissionId: String(row.submissionId),
    branchId: String(row.branchId),
    title: String(row.title),
    detail: String(row.detail),
    locality: String(row.locality ?? ''),
    topic: row.topic,
    status: row.status,
    createdAt: new Date(row.createdAt).toISOString(),
    version: Number(row.version),
    visibility: publicVisibility(row),
    ...(row.publishedAt ? { publishedAt: new Date(row.publishedAt).toISOString() } : {}),
    ...(row.linkedProposalId ? { linkedProposalId: String(row.linkedProposalId) } : {}),
    commentCount,
    publicationConsent: row.publicationConsent === true,
  };
}

export async function listSense(db: Db, user: SessionUser, filters: Record<string, unknown>): Promise<SenseInbox> {
  const base: Record<string, any> = requireReviewScope(user);
  if (filters.branchId) {
    const branchId = text(filters.branchId,'Branch',1,100);
    requireBranch(user, branchId);
    base.branchId = branchId;
  }
  const filter = {...base};
  if (filters.status) filter.status = choice(filters.status,SENSE_STATUSES,'status');
  if (filters.topic) filter.topic = choice(filters.topic,SENSE_TOPICS,'topic');
  if (filters.visibility === 'published' || filters.visibility === 'private') filter.visibility = filters.visibility;
  const page = Number(filters.page ?? 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw new SenseError('Choose a valid page.');
  const [total, rows, topicCounts] = await Promise.all([
    db.collection('sense_submissions').countDocuments(filter),
    db.collection('sense_submissions').find(filter).project(SUBMISSION_PROJECTION).sort({createdAt:-1,_id:-1}).skip((page-1)*30).limit(30).toArray(),
    Promise.all(Object.keys(SENSE_TOPICS).map(async topic => [topic,await db.collection('sense_submissions').countDocuments({...base,topic})] as const)),
  ]);
  const counts = await commentCounts(db, rows.map((row) => String(row.submissionId)));
  const items = rows.map(row => toSenseItem(row, counts.get(String(row.submissionId)) ?? 0));
  return {items,total,page,topics:Object.fromEntries(topicCounts)};
}

/**
 * Public, minimally-projected Sense Box read. Only records an organiser has
 * explicitly published are returned. Legacy submissions have no visibility
 * field and therefore remain private.
 */
export async function listPublicSense(
  db: Db,
  filters: Record<string, unknown>,
): Promise<{ items: SensePublicItem[]; total: number; page: number; topics: Record<string, number> }> {
  const filter: Record<string, any> = { visibility: 'published', publishedAt: { $exists: true } };
  if (filters.branchId) filter.branchId = text(filters.branchId,'Branch',1,100);
  if (filters.topic) filter.topic = choice(filters.topic,SENSE_TOPICS,'topic');
  const page = Number(filters.page ?? 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000) throw new SenseError('Choose a valid page.');
  const limit = 12;
  const [total, rows, topicCounts] = await Promise.all([
    db.collection('sense_submissions').countDocuments(filter),
    db.collection('sense_submissions').find(filter).project(SUBMISSION_PROJECTION)
      .sort({ publishedAt: -1, createdAt: -1, _id: -1 }).skip((page-1)*limit).limit(limit).toArray(),
    Promise.all(Object.keys(SENSE_TOPICS).map(async topic => [
      topic,
      await db.collection('sense_submissions').countDocuments({ visibility: 'published', publishedAt: { $exists: true }, ...(filters.branchId ? { branchId: filter.branchId } : {}), topic }),
    ] as const)),
  ]);
  const [counts, links] = await Promise.all([
    commentCounts(db, rows.map((row) => String(row.submissionId))),
    publicProposalLinks(db, rows.map((row) => String(row.linkedProposalId ?? ''))),
  ]);
  const items: SensePublicItem[] = rows.map((row) => {
    const link = row.linkedProposalId ? links.get(String(row.linkedProposalId)) : undefined;
    return {
      submissionId: String(row.submissionId),
      branchId: String(row.branchId),
      title: String(row.title),
      detail: String(row.detail),
      locality: String(row.locality ?? ''),
      topic: row.topic,
      publishedAt: new Date(row.publishedAt).toISOString(),
      commentCount: counts.get(String(row.submissionId)) ?? 0,
      ...(link ? { linkedProposal: link } : {}),
    };
  });
  return { items, total, page, topics: Object.fromEntries(topicCounts) };
}

function toComment(row: Record<string, any>, viewer?: SessionUser | null): SenseComment {
  const createdAt = new Date(row.createdAt);
  return {
    commentId: String(row.commentId),
    authorName: String(row.authorName || 'Engage member'),
    body: row.deletedAt ? '' : String(row.body ?? ''),
    visibility: row.visibility === 'internal' ? 'internal' : 'public',
    createdAt: createdAt.toISOString(),
    createdAtLabel: new Intl.DateTimeFormat('en-AU', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Australia/Melbourne',
    }).format(createdAt),
    deleted: Boolean(row.deletedAt),
    isMine: Boolean(viewer && row.memberId === viewer.memberId),
  };
}

export async function listSenseComments(
  db: Db,
  submissionId: string,
  visibility: 'public' | 'internal' | 'all',
  viewer?: SessionUser | null,
): Promise<SenseComment[]> {
  const filter: Record<string, any> = { submissionId };
  if (visibility !== 'all') filter.visibility = visibility;
  const rows = await db.collection('sense_comments')
    .find(filter)
    .project({ _id: 0, commentId: 1, memberId: 1, authorName: 1, body: 1, visibility: 1, createdAt: 1, deletedAt: 1 })
    .sort({ createdAt: 1, _id: 1 })
    .limit(500)
    .toArray();
  return rows.map((row) => toComment(row, viewer));
}

export async function getPublicSense(db: Db, submissionId: string, viewer?: SessionUser | null): Promise<SenseSubmissionDetail | null> {
  const row = await db.collection('sense_submissions').findOne({ submissionId, visibility: 'published', publishedAt: { $exists: true } });
  if (!row) return null;
  const [links, comments] = await Promise.all([
    publicProposalLinks(db, [String(row.linkedProposalId ?? '')]),
    listSenseComments(db, submissionId, 'public', viewer),
  ]);
  const link = row.linkedProposalId ? links.get(String(row.linkedProposalId)) : undefined;
  return {
    ...toSenseItem(row, comments.filter((comment) => !comment.deleted).length),
    publishedAt: new Date(row.publishedAt).toISOString(),
    ...(link ? { linkedProposal: link } : {}),
    comments,
  };
}

/**
 * Contributor receipt. The submission ID is the capability: it is a random
 * UUID shown only to the person who submitted, and it reveals no contact,
 * review, audit or account fields.
 */
export async function getSenseReceipt(db: Db, submissionId: string): Promise<SenseReceipt | null> {
  if (!uuid.test(submissionId)) return null;
  const row = await db.collection('sense_submissions').findOne(
    { submissionId },
    { projection: { _id: 0, submissionId: 1, branchId: 1, title: 1, topic: 1, createdAt: 1, status: 1, visibility: 1, publishedAt: 1, publicationConsent: 1 } },
  );
  if (!row) return null;
  const stage = row.visibility === 'published' && row.publishedAt
    ? 'published'
    : row.status === 'archived'
      ? 'closed'
      : row.status === 'new'
        ? 'received'
        : 'reviewing';
  return {
    submissionId: String(row.submissionId),
    branchId: String(row.branchId),
    title: String(row.title),
    topic: row.topic,
    createdAt: new Date(row.createdAt).toISOString(),
    stage,
    publicationConsent: row.publicationConsent === true,
    ...(row.publishedAt ? { publishedAt: new Date(row.publishedAt).toISOString() } : {}),
  };
}

export async function getSenseSubmission(db: Db, user: SessionUser, submissionId: string): Promise<SenseSubmissionDetail | null> {  const row = await db.collection('sense_submissions').findOne({ submissionId });
  if (!row) return null;
  requireBranch(user, String(row.branchId));
  const comments = await listSenseComments(db, submissionId, 'all', user);
  let linkedProposal: { proposalId: string; slug: string; title: string; stage: string } | undefined;
  if (row.linkedProposalId) {
    const proposal = await db.collection('proposals').findOne(
      { proposalId: String(row.linkedProposalId) },
      { projection: { _id: 0, proposalId: 1, slug: 1, title: 1, stage: 1 } },
    );
    if (proposal) linkedProposal = {
      proposalId: String(proposal.proposalId),
      slug: String(proposal.slug),
      title: String(proposal.title),
      stage: String(proposal.stage),
    };
  }
  return {
    ...toSenseItem(row, comments.filter((comment) => comment.visibility === 'public' && !comment.deleted).length),
    ...(row.publishedAt ? { publishedAt: new Date(row.publishedAt).toISOString() } : {}),
    ...(row.linkedProposalId ? { linkedProposalId: String(row.linkedProposalId) } : {}),
    ...(linkedProposal ? { linkedProposal } : {}),
    comments,
  };
}

async function loadForReview(db: Db, user: SessionUser, body: Record<string, unknown>) {
  const submissionId = text(body.submissionId,'Submission',36,36);
  const raw = await db.collection('sense_submissions').findOne({ submissionId });
  if (!raw) throw new SenseError('This submission is no longer available.', 404);
  const branchId = String(raw.branchId);
  // A mismatched branch is a scope error even if the caller can review the
  // submission's real branch. This keeps the API's branch boundary explicit.
  if (body.branchId !== undefined && text(body.branchId,'Branch',1,100) !== branchId)
    throw new SenseError('You do not have access to that branch.', 403);
  requireBranch(user, branchId);
  if (!Number.isSafeInteger(body.version) || Number(body.version) < 0) throw new SenseError('Reload this submission and try again.');
  return { submissionId, raw, version: Number(body.version), branchId };
}

/**
 * Reviewer actions: triage status, explicit publication, withdrawal from public
 * view, and linking to an existing proposal. Submission never publishes an
 * entry. Every action uses the submission version for optimistic concurrency.
 */
export async function reviewSense(db: Db, user: SessionUser, body: Record<string, unknown>) {
  const action = typeof body.action === 'string' ? body.action : 'status';
  const { submissionId, raw, version, branchId } = await loadForReview(db, user, body);
  const filter = { submissionId, branchId, version };
  let update: Record<string, any>;
  if (action === 'publish') {
    if (raw.status === 'archived') throw new SenseError('Restore this submission before publishing it.', 409);
    // Legacy submissions were collected under a private-review promise. They
    // cannot be published until an explicit republishing process exists.
    if (raw.publicationConsent !== true)
      throw new SenseError('This priority was collected without consent to publish. It can only be used as a private lead.', 409);
    update = {
      $set: {
        visibility: 'published', publishedAt: new Date(), publishedBy: user.memberId,
        status: raw.status === 'new' ? 'reviewed' : raw.status,
        version: version + 1, reviewedBy: user.memberId, reviewedAt: new Date(),
      },
      $unset: { unpublishedAt: '', unpublishedBy: '' },
    };
  } else if (action === 'unpublish') {
    update = {
      $set: {
        visibility: 'private', unpublishedAt: new Date(), unpublishedBy: user.memberId,
        version: version + 1, reviewedBy: user.memberId, reviewedAt: new Date(),
      },
      $unset: { publishedAt: '', publishedBy: '' },
    };
  } else if (action === 'link') {
    const proposalId = typeof body.proposalId === 'string' ? body.proposalId.trim() : '';
    if (proposalId) {
      const proposal = await db.collection('proposals').findOne({ proposalId });
      if (!proposal) throw new SenseError('That proposal was not found.', 404);
      if (!canViewProposal(normalizeProposalDoc(proposal), user)) throw new SenseError('That proposal was not found.', 404);
    }
    update = proposalId
      ? { $set: { linkedProposalId: proposalId, version: version + 1, reviewedBy: user.memberId, reviewedAt: new Date() } }
      : { $set: { version: version + 1, reviewedBy: user.memberId, reviewedAt: new Date() }, $unset: { linkedProposalId: '' } };
  } else if (action === 'status') {
    const status = choice(body.status,SENSE_STATUSES,'status');
    update = { $set: { status, version: version + 1, reviewedBy: user.memberId, reviewedAt: new Date() } };
  } else {
    throw new SenseError('Choose a valid action.');
  }
  const result = await db.collection('sense_submissions').updateOne(filter, update);
  if (!result.matchedCount) throw new SenseError('This submission changed or is no longer available. Refresh the inbox and try again.', 409);
}

export async function addSenseComment(db: Db, user: SessionUser, body: Record<string, unknown>) {
  const submissionId = text(body.submissionId,'Submission',36,36);
  const raw = await db.collection('sense_submissions').findOne({ submissionId });
  if (!raw) throw new SenseError('This priority is no longer available.', 404);
  const visibility = body.visibility === 'internal' ? 'internal' : 'public';
  if (visibility === 'internal') {
    requireBranch(user, String(raw.branchId));
  } else {
    if (raw.visibility !== 'published' || !raw.publishedAt) throw new SenseError('This priority is not open for public discussion.', 409);
    if (!user.canParticipate && !user.isStaff) throw new SenseError('Verified membership is required to join the discussion.', 403);
  }
  const content = text(body.body,'Comment',2,2000);
  const record = {
    commentId: `sense-${randomUUID()}`,
    submissionId,
    branchId: String(raw.branchId),
    memberId: user.memberId,
    authorName: user.name || 'Engage member',
    body: content,
    visibility,
    createdAt: new Date(),
  };
  await db.collection('sense_comments').insertOne(record);
  return toComment(record, user);
}

export async function deleteSenseComment(db: Db, user: SessionUser, commentId: string) {
  const comment = await db.collection('sense_comments').findOne({ commentId });
  if (!comment) throw new SenseError('That comment is no longer available.', 404);
  const isAuthor = comment.memberId === user.memberId;
  if (!isAuthor && !canReviewSense(user, String(comment.branchId))) throw new SenseError('You cannot remove that comment.', 403);
  await db.collection('sense_comments').updateOne(
    { commentId, deletedAt: { $exists: false } },
    { $set: { deletedAt: new Date(), deletedBy: user.memberId, body: '' } },
  );
}

/** Listening destinations do not create branch membership or governance authority. */
export async function senseDestinations(db: Db) {
  const rows = await db.collection('branches').find({}).project({branchId:1,name:1,kind:1,recognised:1,stateCode:1}).toArray();
  return STANDARD_BRANCHES.flatMap(standard => {
    // Standard IDs define destinations; names are only a legacy identity lookup.
    const candidates=rows.filter(row=>row.branchId===standard.branchId || row.stateCode===standard.branchId.slice(7).toUpperCase() || (row.kind===standard.kind && String(row.name).trim().toLowerCase()===standard.name.toLowerCase()));
    const existing=candidates.find(row=>row.branchId!==standard.branchId) ?? candidates[0];
    if(existing && (existing.recognised!==true || !['national','state','territory'].includes(existing.kind))) return [];
    return [{branchId:String(existing?.branchId ?? standard.branchId),name:String(existing?.name ?? standard.name),code:standard.branchId,label:standard.kind==='national'?'National':standard.name.replace(/^Fusion /,'')}];
  });
}
