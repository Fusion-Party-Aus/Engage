import type { Db } from 'mongodb';
import { engageConsentState } from './digest-preferences.ts';
import { PROPOSAL_VOTES } from './vote-storage.ts';

/** Read-only Engage participation preview. Missing legacy preferences are not refusals. */
export async function previewMemberReengagement(db: Db, cutoff: Date, now = new Date()) {
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
  // API exposes aggregate counts only; private identifiers remain inside this function.
  return {dryRun:true,scope:'engage-participation',campaignApprovalRequired:true,legacyCohortAvailable:Boolean(rollout),consentCounts,needsReview:rows.filter(r=>r.classification==='needs-review').length,generatedAt:now,cutoff,total:rows.length,eligible:rows.filter(r=>r.classification==='eligible').length,excluded:rows.filter(r=>r.classification==='excluded').length,suppressed:rows.filter(r=>r.classification==='suppressed').length,reasons};
}
