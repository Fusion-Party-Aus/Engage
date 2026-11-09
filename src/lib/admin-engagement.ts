import type {Db} from 'mongodb';
import {recordEmailEvent} from './engagement-email.ts';

export function deliveryStatus(message:Record<string,any>):string {
 if (message.complainedAt) return 'Spam complaint';
 if (message.bouncedAt) return 'Bounced';
 if (message.failedAt || message.status === 'failed') return 'Failed';
 if (message.deliveredAt) return 'Delivered';
 if (message.providerId) return 'Accepted · awaiting delivery';
 if (message.status === 'held') return 'Held · acceptance uncertain';
 return 'Sending · awaiting acceptance';
}
/** A bounded, self-only receipt view; never return raw outbox/provider documents. */
export async function testDeliveryHistory(db:Db,memberId:string) {
 const rows=await db.collection('engagement_email_outbox').find({kind:'test',memberId}).sort({createdAt:-1}).limit(5).toArray();
 // A receipt can beat the provider's HTTP response. Reconcile these even while the scheduler is off.
 for(const row of rows) {
  if(!row.providerId) continue;
  const events=await db.collection<any>('engagement_email_events').find({providerId:row.providerId,processed:{$ne:true}}).toArray();
  for(const event of events) await recordEmailEvent(db,event._id,{type:event.type,data:{email_id:row.providerId}},event.receivedAt);
  if(events.length) Object.assign(row,await db.collection('engagement_email_outbox').findOne({_id:row._id}));
 }
 return rows.map(m=>({createdAt:m.createdAt,status:deliveryStatus(m),providerId:typeof m.providerId === 'string' ? m.providerId : null,providerHttpStatus:typeof m.providerHttpStatus === 'number' ? m.providerHttpStatus : null,acceptedAt:m.acceptedAt ?? null,deliveredAt:m.deliveredAt ?? null,failedAt:m.failedAt ?? null}));
}
export function deliveryBreakdown(messages:Record<string,any>[]) {
 const counts={accepted:0,delivered:0,bounced:0,complained:0,failed:0,held:0};
 for(const m of messages) {
  if(m.complainedAt) counts.complained++;
  else if(m.bouncedAt) counts.bounced++;
  else if(m.failedAt || m.status === 'failed') counts.failed++;
  else if(m.deliveredAt) counts.delivered++;
  else if(m.providerId) counts.accepted++;
  else if(['held','sending','queued'].includes(m.status)) counts.held++;
 }
 return counts;
}
export const percentage=(n:number,d:number)=>d ? `${(100*n/d).toFixed(1)}%` : 'Unavailable';
