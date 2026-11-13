import { ObjectId, type Db } from 'mongodb';
import type { PlatformEnv } from './types.ts';
import { emailOrigin, escapeEmailHtml } from './engagement-email.ts';
import { notificationEnabled } from './digest-preferences.ts';
import { recordLifecycle } from './member-lifecycle.ts';

export function renderVerification(name: string, origin: string, approved = true) {
  const title = approved ? 'Your membership is verified.' : 'Your membership status has changed.';
  const detail = approved ? 'You can now participate in ballots where you meet the eligibility requirements. My Engage shows your eligible open ballots and next steps.' : 'Your participation is currently suspended. Contact a party administrator to discuss your membership status and next steps.';
  const cta = approved ? 'Start voting' : 'View membership status';
  // Fixed destination: no identity, bearer token, or user-controlled redirect in email.
  const href = approved ? `${origin}/member/?intent=vote&source=verification#outstanding-ballots` : `${origin}/member/?view=account`;
  const e=escapeEmailHtml;
  return {subject:approved ? 'Your Engage membership is verified' : 'Your Engage membership status',
    text:`Hello ${name || 'member'},\n\n${title}\n${detail}\n\n${cta}: ${href}\n\nKeep Engage handy: ${origin}/member/\nNotification preferences: ${origin}/member/?view=notifications\nThis is an account notification, separate from optional Engage digests.`,
    html:`<!doctype html><html lang="en-AU"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="margin:0;background:#f2eef9;color:#271047;font:18px/1.6 Outfit,Arial,sans-serif;overflow-wrap:anywhere;word-break:break-word"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;table-layout:fixed"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="600" style="width:100%;max-width:600px;background:white;table-layout:fixed;border-collapse:collapse"><tr><td style="padding:28px;background:#32105a;color:white;border-bottom:6px solid #00c9d2"><p style="margin:0;font-size:11px;font-weight:700;letter-spacing:2.4px;text-transform:uppercase;color:#d6c7ea">FUSION PARTY AUSTRALIA</p><p style="font:38px Newsreader,Georgia,serif;margin:6px 0 0">Engage</p></td></tr><tr><td style="padding:28px"><p>Hello ${e(name || 'member')},</p><h1 style="font:32px/1.2 Newsreader,Georgia,serif">${title}</h1><p>${detail}</p><p><a href="${e(href)}" style="display:inline-block;padding:14px 24px;background:#32105a;color:white;border-radius:6px">${cta}</a></p><p>Sign in if prompted. Your ballot eligibility is checked when you return.</p><p>Keep Engage handy:<br><a href="${e(origin)}/member/">${e(origin)}/member/</a></p><p style="font-size:14px;color:#54465f"><strong>Fusion Party Australia · Engage</strong><br>This account notification is separate from optional Engage digests. <a href="${e(origin)}/member/?view=notifications">Notification preferences</a></p></td></tr></table></td></tr></table></body></html>`};
}

/** One durable account/status claim. Ambiguous delivery is held, never blindly retried. */
export async function sendVerificationNotice(db: Db, env: PlatformEnv, memberId: string, status: 'verified' | 'suspended', send: typeof fetch = fetch, now = new Date()) {
  const [account, membership, preference] = await Promise.all([
    db.collection('user').findOne({_id:new ObjectId(memberId)}),
    db.collection('memberships').findOne({memberId}),
    db.collection('engagement_email_preferences').findOne({memberId}),
  ]);
  if (!account || membership?.status !== status || account.disabled) return 'not-needed';
  const id=`verification:${status}:${memberId}`;
  const outbox=db.collection<any>('engagement_email_outbox');
  try { await outbox.insertOne({_id:id,kind:'verification',verificationStatus:status,memberId,status:'queued',createdAt:now}); }
  catch(error) { if ((error as {code?:number}).code === 11000) return 'not-needed'; throw error; }
  await recordLifecycle(db,memberId,'verification_notification_queued',now,status);
  if (!notificationEnabled(preference,'essential')) {
    await outbox.updateOne({_id:id},{$set:{status:'suppressed'}});
    return 'suppressed';
  }
  let origin: string;
  try { origin=emailOrigin(env); if (!env.RESEND_API_KEY || !env.AUTH_EMAIL_FROM) throw new Error('Missing email configuration'); }
  catch { await outbox.updateOne({_id:id},{$set:{status:'failed',failedAt:now,failureReason:'configuration'}}); await recordLifecycle(db,memberId,'verification_notification_failed',now,status); return 'failed'; }
  await outbox.updateOne({_id:id},{$set:{status:'sending'}});
  try {
    const latest=await db.collection('engagement_email_preferences').findOne({memberId});
    if (!notificationEnabled(latest,'essential')) { await outbox.updateOne({_id:id},{$set:{status:'suppressed'}}); return 'suppressed'; }
    const response=await send('https://api.resend.com/emails',{method:'POST',headers:{authorization:`Bearer ${env.RESEND_API_KEY}`,'content-type':'application/json','Idempotency-Key':id},body:JSON.stringify({from:env.AUTH_EMAIL_FROM,to:[account.email],...renderVerification(String(account.name || ''),origin,status==='verified')}),signal:AbortSignal.timeout(10000)});
    const receipt=await response.json() as {id?:string};
    if (!response.ok || typeof receipt.id !== 'string') throw new Error('Unconfirmed provider receipt');
    await outbox.updateOne({_id:id},{$set:{status:'sent',providerId:receipt.id,acceptedAt:now}});
    // Reconcile early webhook receipts without relying on the optional digest scheduler.
    const early=await db.collection<any>('engagement_email_events').find({providerId:receipt.id,processed:{$ne:true}}).toArray();
    const { recordEmailEvent }=await import('./engagement-email.ts');
    for (const event of early) await recordEmailEvent(db,event._id,{type:event.type,data:{email_id:receipt.id}},event.receivedAt);
    return 'sent';
  } catch {
    await outbox.updateOne({_id:id},{$set:{status:'held',heldAt:now,failureReason:'unconfirmed-provider-outcome'}});
    return 'held';
  }
}
