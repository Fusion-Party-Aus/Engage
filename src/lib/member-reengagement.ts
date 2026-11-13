import type { Db } from 'mongodb';
import { engageConsentState } from './digest-preferences.ts';
import { renderReengagementEmail } from './email-templates.ts';
import { emailOrigin, unsubscribeToken } from './engagement-email.ts';
import { listProposals, canViewProposal } from './store.ts';
import type { PlatformEnv, SessionUser } from './types.ts';
import { PROPOSAL_VOTES } from './vote-storage.ts';

/** Read-only Engage participation preview. Missing legacy preferences are not refusals. */
export async function previewMemberReengagement(db: Db, cutoff: Date, now = new Date(), includeMembers = false) {
  if (!Number.isFinite(+cutoff) || cutoff > now) throw new Error('Choose a valid historical verification cutoff.');
  const [memberships, accounts, preferences, messages, votes, sessions, events, rollout, assessments] = await Promise.all([
    db.collection('memberships').find({status:'verified'}).toArray(),
    db.collection('user').find({}).project({_id:1,disabled:1,emailVerified:1}).toArray(),
    db.collection('engagement_email_preferences').find({}).toArray(),
    db.collection('engagement_email_outbox').find({kind:'verification'}).project({memberId:1,status:1,providerId:1,bouncedAt:1,complainedAt:1}).toArray(),
    db.collection(PROPOSAL_VOTES).find({}).project({memberId:1}).toArray(),
    db.collection('session').find({}).project({userId:1,updatedAt:1,createdAt:1}).toArray(),
    db.collection('engagement_lifecycle_events').find({}).project({memberId:1,event:1,at:1}).toArray(),
    db.collection<any>('engagement_email_rollouts').findOne({_id:'ballot-reminders-v1'}),
    db.collection('engagement_consent_assessments').find({scope:'engage-participation',status:'approved'}).toArray(),
  ]);
  const legacyMembers=new Set<string>(rollout?.memberIds || []);
  const rows=memberships.map(m=>{
    const memberId=String(m.memberId), account=accounts.find(a=>String(a._id)===memberId);
    const preference=preferences.find(p=>p.memberId===memberId) ?? null;
    const date=m.verifiedAt || events.find(e=>e.memberId===memberId && e.event==='verification_approved')?.at;
    const deliverySuppressed=Boolean(preference?.suppressed || messages.some(x=>x.memberId===memberId && (x.bouncedAt || x.complainedAt)));
    const consent=engageConsentState(deliverySuppressed ? {...preference,suppressed:true} : preference,rollout ? legacyMembers.has(memberId) : null);
    const assessment=assessments.find(a=>
      (a.memberId===memberId || a.rolloutId==='ballot-reminders-v1' && !a.memberId && legacyMembers.has(memberId)) &&
      ['inferred-membership','non-commercial-participation','registered-party-exemption'].includes(String(a.basis)) &&
      typeof a.reviewedBy==='string' && Boolean(a.reviewedBy) &&
      Number.isFinite(+new Date(a.reviewedAt)) && +new Date(a.reviewedAt)<=+now &&
      +new Date(a.validUntil)>+now && Array.isArray(a.evidenceReferences) && a.evidenceReferences.length>0);
    let reason='eligible';
    if (deliverySuppressed) reason='suppressed';
    else if (!account || account.disabled || !account.emailVerified) reason='inactive-or-unconfirmed-email';
    else if (consent==='explicit-opt-out') reason='explicit-engage-opt-out';
    else if (consent==='new-unrecorded') reason='new-member-opt-in-required';
    else if (date && Number.isFinite(+new Date(date)) && new Date(date)>cutoff) reason='verified-after-cutoff';
    else if (messages.some(x=>x.memberId===memberId && (x.providerId || ['queued','sending','sent','held'].includes(String(x.status))))) reason='notification-sent-or-uncertain';
    else if (votes.some(v=>v.memberId===memberId)) reason='already-participated';
    else if (sessions.some(s=>String(s.userId)===memberId && +new Date(s.updatedAt || s.createdAt)>+now-30*86400000) || events.some(e=>e.memberId===memberId && ['my_engage_viewed','first_eligible_ballot_viewed'].includes(String(e.event)) && +new Date(e.at)>+now-30*86400000)) reason='recently-active';
    else if (!date || !Number.isFinite(+new Date(date))) reason='review-verification-date';
    else if (consent==='unclassified-unrecorded') reason='review-legacy-cohort';
    else if (consent==='legacy-unrecorded' && !assessment) reason='review-legacy-lawful-basis';
    return {memberId,consent,classification:reason==='eligible' ? 'eligible' : reason==='suppressed' ? 'suppressed' : reason.startsWith('review-') ? 'needs-review' : 'excluded',reason};
  });
  const reasons:Record<string,number>={};
  for (const row of rows) reasons[row.reason]=(reasons[row.reason] || 0)+1;
  const consentCounts:Record<string,number>={};
  for (const row of rows) consentCounts[row.consent]=(consentCounts[row.consent] || 0)+1;
  // Member detail is opt-in at the authenticated admin endpoint; never sent to analytics.
  return {dryRun:true,...(includeMembers ? {members:rows} : {}),scope:'engage-participation',campaignApprovalRequired:true,legacyCohortAvailable:Boolean(rollout),consentCounts,needsReview:rows.filter(r=>r.classification==='needs-review').length,generatedAt:now,cutoff,total:rows.length,eligible:rows.filter(r=>r.classification==='eligible').length,excluded:rows.filter(r=>r.classification==='excluded').length,suppressed:rows.filter(r=>r.classification==='suppressed').length,reasons};
}

export const REENGAGEMENT_CAMPAIGNS = 'engagement_reengagement_campaigns';

export class ReengagementError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ReengagementError';
    this.status = status;
  }
}

export async function approveReengagementCampaign(
  db: Db,
  actor: SessionUser,
  input: { campaignId: string; cutoff: Date; note: string },
  now = new Date(),
) {
  const campaignId = input.campaignId.trim();
  const note = input.note.trim();
  if (!campaignId || !note || !Number.isFinite(+input.cutoff) || input.cutoff > now) {
    throw new ReengagementError('Valid campaignId, historical cutoff, and approval note are required.', 400);
  }
  const record = {
    campaignId,
    cutoff: input.cutoff,
    note,
    status: 'approved' as const,
    approvedBy: actor.memberId,
    approvedByName: actor.name,
    approvedAt: now,
  };
  await db.collection(REENGAGEMENT_CAMPAIGNS).updateOne(
    { campaignId },
    { $setOnInsert: record },
    { upsert: true },
  );
  return (await db.collection(REENGAGEMENT_CAMPAIGNS).findOne({ campaignId })) ?? record;
}

export async function runApprovedReengagementBatch(
  db: Db,
  env: PlatformEnv,
  _actor: SessionUser,
  input: { campaignId: string; batchSize?: number; send?: typeof fetch; now?: Date },
) {
  const now = input.now ?? new Date();
  const send = input.send ?? fetch;
  const campaign = await db.collection(REENGAGEMENT_CAMPAIGNS).findOne({
    campaignId: input.campaignId.trim(),
    status: 'approved',
  });
  if (!campaign) {
    throw new ReengagementError('Re-engagement campaign requires explicit administrative approval before sending.', 409);
  }
  if (!env.RESEND_API_KEY || !env.AUTH_EMAIL_FROM || !env.ENGAGE_EMAIL_SECRET) {
    throw new ReengagementError('Email provider credentials, sender address, and signing secret must be configured.', 503);
  }
  const origin = emailOrigin(env);
  const preview = await previewMemberReengagement(db, new Date(campaign.cutoff), now, true);
  const eligible = (preview.members ?? []).filter((m) => m.classification === 'eligible');
  const limit = Math.min(Math.max(1, Number(input.batchSize ?? 25)), 25);

  const [accounts, proposals] = await Promise.all([
    db.collection('user').find({}).project({ _id: 1, name: 1, email: 1 }).toArray(),
    listProposals(db, { includeArchived: false }),
  ]);
  const accountMap = new Map(accounts.map((a: any) => [String(a._id), a]));
  const outbox = db.collection<any>('engagement_email_outbox');

  let sent = 0;
  let held = 0;
  let skipped = 0;

  for (const row of eligible) {
    if (sent + held >= limit) break;
    const account = accountMap.get(row.memberId);
    if (!account?.email) {
      skipped++;
      continue;
    }

    const outboxId = `reengagement:${campaign.campaignId}:${row.memberId}`;
    try {
      await outbox.insertOne({
        _id: outboxId,
        kind: 'reengagement',
        campaignId: campaign.campaignId,
        memberId: row.memberId,
        status: 'sending',
        createdAt: now,
      });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        skipped++;
        continue;
      }
      throw error;
    }

    // Re-check suppression/opt-out immediately before handoff
    const pref = await db.collection('engagement_email_preferences').findOne({ memberId: row.memberId });
    if (pref?.suppressed || pref?.digestEnabled === false || (pref?.unsubscribedAt && pref?.digestEnabled !== true)) {
      await outbox.updateOne({ _id: outboxId }, { $set: { status: 'cancelled' } });
      skipped++;
      continue;
    }

    const memberViewer: SessionUser = {
      memberId: row.memberId,
      name: String(account.name ?? ''),
      email: String(account.email),
      role: 'member',
      status: 'verified',
      canParticipate: true,
      isStaff: false,
      isAdmin: false,
    };
    const opportunities = proposals
      .filter((p) => (p.stage === 'decide' || p.stage === 'deliberate') && canViewProposal(p, memberViewer))
      .slice(0, 3)
      .map((p) => ({
        title: p.title,
        summary: p.summary,
        href: `/proposals/${encodeURIComponent(p.slug)}/`,
        closesAt: p.ballotClosesAt ?? null,
      }));

    if (!opportunities.length) {
      await outbox.updateOne({ _id: outboxId }, { $set: { status: 'cancelled' } });
      skipped++;
      continue;
    }

    const unsubUrl = `${origin}/api/email/unsubscribe?token=${unsubscribeToken(row.memberId, env.ENGAGE_EMAIL_SECRET)}`;
    const content = renderReengagementEmail(String(account.name ?? ''), opportunities, origin, unsubUrl);

    try {
      const response = await send('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.RESEND_API_KEY}`,
          'content-type': 'application/json',
          'Idempotency-Key': outboxId,
        },
        body: JSON.stringify({
          from: env.AUTH_EMAIL_FROM,
          to: [account.email],
          subject: content.subject,
          text: content.text,
          html: content.html,
          headers: {
            'List-Unsubscribe': `<${unsubUrl}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        }),
        signal: AbortSignal.timeout(10000),
      });
      const result = (await response.json()) as { id?: string };
      if (!response.ok || !result.id) throw new Error('Provider did not confirm acceptance');
      await outbox.updateOne({ _id: outboxId }, { $set: { status: 'sent', providerId: result.id, acceptedAt: new Date() } });
      sent++;
    } catch {
      await outbox.updateOne({ _id: outboxId }, { $set: { status: 'held', heldAt: new Date() } });
      held++;
    }
  }

  return { campaignId: campaign.campaignId, sent, held, skipped };
}
