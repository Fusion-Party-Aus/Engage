import { createHash, createHmac } from 'node:crypto';
import { ObjectId, type Db } from 'mongodb';
import { STANDARD_BRANCHES } from './migrations.ts';
import type { SessionUser } from './types.ts';
import { branchesWithPermission, hasPermission } from './rbac.ts';
import { SENSE_TOPICS, SENSE_STATUSES, type SenseItem, type SenseInbox } from './sense-box-options.ts';

export class SenseError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function text(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max)
    throw new SenseError(`${label} must be ${min}–${max} characters.`);
  return value.trim();
}
function choice(value: unknown, options: object, label: string): string {
  if (typeof value !== 'string' || !Object.hasOwn(options, value)) throw new SenseError(`Choose a valid ${label}.`);
  return value;
}
function scope(user: SessionUser) {
  const access = branchesWithPermission(user, 'sense_box.review');
  if (user.isAdmin || access.national) return {};
  const allowed = Array.from(new Set([...(user.branchAdminIds ?? []), ...access.branchIds]));
  if (!allowed.length) throw new SenseError('Branch organiser access required.',403);
  return {branchId:{$in:allowed}};
}

// Atomic _id claims work across application instances; TTL removes the hashed network keys.
export async function claimSenseSlot(db: Db, address: string, secret: string, now = Date.now()) {
  const bucket = Math.floor(now / 600_000);
  const key = createHmac('sha256',secret).update(`${bucket}:${address}`).digest('hex');
  for (let slot = 0; slot < 10; slot++) {
    try {
      await db.collection('sense_limits').insertOne({ _id: new ObjectId(createHash('sha256').update(`${key}:${slot}`).digest('hex').slice(0,24)), expiresAt:new Date((bucket+2)*600_000) });
      return;
    } catch (error) { if ((error as {code?:number}).code !== 11000) throw error; }
  }
  throw new SenseError('Too many submissions from this connection. Please try again in 10 minutes.',429);
}

export async function submitSense(db: Db, body: Record<string, unknown>, rate?: {address:string; secret:string}): Promise<string> {
  if (body.consent !== true) throw new SenseError('Please agree to how Fusion will use your input.');
  if (typeof body.requestId !== 'string' || !uuid.test(body.requestId)) throw new SenseError('Please reload the form and try again.');
  let branchId = text(body.branchId,'Branch',1,100);
  const destination=(await senseDestinations(db)).find(b=>b.branchId===branchId);
  if(!destination) {
    const standard=STANDARD_BRANCHES.find(b=>b.branchId===branchId);
    const mapped=standard && (await senseDestinations(db)).find(b=>b.name===standard.name);
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
  if (rate) await claimSenseSlot(db,rate.address,rate.secret);
  try {
    await db.collection('sense_submissions').insertOne({
      _id, submissionId:body.requestId, ...content, fingerprint,
      status:'new', version:0, createdAt:new Date(), consentVersion:'sense-box-2026-11-13',
    });
  } catch (error) {
    if ((error as {code?:number}).code !== 11000) throw error;
    const saved = await db.collection('sense_submissions').findOne({_id});
    if (saved?.fingerprint !== fingerprint) throw new SenseError('This form has already used its submission reference. Reload to share another priority.',409);
  }
  return body.requestId;
}

export async function listSense(db: Db, user: SessionUser, filters: Record<string, unknown>): Promise<SenseInbox> {
  const base: Record<string, any> = scope(user);
  if (filters.branchId) {
    const branchId = text(filters.branchId,'Branch',1,100);
    if (!user.isAdmin && !user.branchAdminIds?.includes(branchId) && !hasPermission(user, 'sense_box.review', branchId)) throw new SenseError('You do not have access to that branch.',403);
    base.branchId = branchId;
  }
  const filter = {...base};
  if (filters.status) filter.status = choice(filters.status,SENSE_STATUSES,'status');
  if (filters.topic) filter.topic = choice(filters.topic,SENSE_TOPICS,'topic');
  const page = Number(filters.page ?? 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw new SenseError('Choose a valid page.');
  const [total, rows, topicCounts] = await Promise.all([
    db.collection('sense_submissions').countDocuments(filter),
    db.collection('sense_submissions').find(filter).project({_id:0,submissionId:1,branchId:1,title:1,detail:1,locality:1,topic:1,status:1,createdAt:1,version:1}).sort({createdAt:-1,_id:-1}).limit(page*30).toArray(),
    Promise.all(Object.keys(SENSE_TOPICS).map(async topic => [topic,await db.collection('sense_submissions').countDocuments({...base,topic})] as const)),
  ]);
  // Limit before slicing keeps the in-memory preview compatible with the production cursor.
  const items = rows.slice((page-1)*30).map(row => ({
    submissionId:String(row.submissionId),branchId:String(row.branchId),title:String(row.title),detail:String(row.detail),locality:String(row.locality ?? ''),
    topic:row.topic,status:row.status,createdAt:new Date(row.createdAt).toISOString(),version:Number(row.version),
  })) as SenseItem[];
  return {items,total,page,topics:Object.fromEntries(topicCounts)};
}

export async function reviewSense(db: Db, user: SessionUser, body: Record<string, unknown>) {
  scope(user);
  const branchId = text(body.branchId,'Branch',1,100);
  if (!user.isAdmin && !user.branchAdminIds?.includes(branchId) && !hasPermission(user, 'sense_box.review', branchId)) throw new SenseError('You do not have access to that branch.',403);
  const submissionId = text(body.submissionId,'Submission',36,36);
  const status = choice(body.status,SENSE_STATUSES,'status');
  if (!Number.isSafeInteger(body.version) || Number(body.version) < 0) throw new SenseError('Reload this submission and try again.');
  const result = await db.collection('sense_submissions').updateOne({submissionId,branchId,version:body.version},{$set:{status,version:Number(body.version)+1,reviewedBy:user.memberId,reviewedAt:new Date()}});
  if (!result.matchedCount) throw new SenseError('This submission changed or is no longer available. Refresh the inbox and try again.',409);
}

/** Listening destinations do not create branch membership or governance authority. */
export async function senseDestinations(db: Db) {
  const rows = await db.collection('branches').find({}).project({branchId:1,name:1,kind:1,recognised:1}).toArray();
  return STANDARD_BRANCHES.flatMap(standard => {
    // Standard IDs define destinations; names are only a legacy identity lookup.
    const candidates=rows.filter(row=>row.branchId===standard.branchId || row.stateCode===standard.branchId.slice(7).toUpperCase() || (row.kind===standard.kind && String(row.name).trim().toLowerCase()===standard.name.toLowerCase()));
    const existing=candidates.find(row=>row.branchId!==standard.branchId) ?? candidates[0];
    if(existing && (existing.recognised!==true || !['national','state','territory'].includes(existing.kind))) return [];
    return [{branchId:String(existing?.branchId ?? standard.branchId),name:String(existing?.name ?? standard.name),code:standard.branchId,label:standard.kind==='national'?'National':standard.name.replace(/^Fusion /,'')}];
  });
}
