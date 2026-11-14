import type { ClientSession, Db } from 'mongodb';

// Private operational records. Never forward these documents to Plausible.
export async function recordLifecycle(db: Db, memberId: string, event: string, at = new Date(), window = 'once', session?: ClientSession) {
  try { await db.collection<any>('engagement_lifecycle_events').updateOne(
    {_id: `${event}:${memberId}:${window}`},
    {$setOnInsert: {memberId, event, at}}, {upsert: true, ...(session ? { session } : {})},
  ); } catch(error) { if ((error as {code?:number}).code !== 11000) throw error; }
}
export async function notePriorParticipation(db:Db, memberId:string, session?: ClientSession) {
  const sessionOpts = session ? { session } : undefined;
  const first = await db.collection('engagement_lifecycle_events').findOne({memberId,event:'first_vote_submitted'}, sessionOpts);
  const prior = await db.collection('proposal_votes').findOne({memberId}, sessionOpts);
  if (!first && prior) await recordLifecycle(db,memberId,'historical_participant', new Date(), 'once', session);
}
export async function recordParticipation(db: Db, memberId: string, at = new Date(), session?: ClientSession) {
  const sessionOpts = session ? { session } : undefined;
  if (!await db.collection('engagement_lifecycle_events').findOne({memberId,event:'historical_participant'}, sessionOpts)) await recordLifecycle(db, memberId, 'first_vote_submitted', at, 'once', session);
  await recordLifecycle(db, memberId, 'participation_day', at, at.toISOString().slice(0, 10), session);
}
export function memberNextAction(status: string, canParticipate: boolean, votes: number, outstanding: number) {
  if (status === 'suspended') return {title:'Review your membership status', detail:'Contact an administrator about restoring participation.', href:'/member/?view=account'};
  if (!canParticipate) return {title:'View application status', detail:'Your Fusion membership is awaiting administrator verification. Check your account details are correct.', href:'/member/?view=account'};
  if (outstanding && !votes) return {title:'Cast your first vote', detail:'Your membership is verified. Review the wording of a ballot below before deciding.', href:'/member/#outstanding-ballots'};
  if (outstanding) return {title:'Review outstanding ballots', detail:'These open ballots still need your attention.', href:'/member/#outstanding-ballots'};
  if (!votes) return {title:'Explore open ballots', detail:'No eligible outstanding ballots are available right now. You can explore proposals and return when a ballot opens.', href:'/proposals/?stage=decide'};
  return {title:'View participation history', detail:'You are caught up on eligible open ballots.', href:'/member/?view=activity'};
}
export function lifecycleConversion(events: {memberId:string; event:string; at:Date}[], now = new Date()) {
  const approvals=events.filter(e=>e.event === 'verification_approved' && now.getTime()-new Date(e.at).getTime() >= 7*86400000);
  const firstVotes=events.filter(e=>e.event === 'first_vote_submitted');
  const returningCohort=firstVotes.filter(e=>now.getTime()-new Date(e.at).getTime() >= 30*86400000);
  return {
    sevenDayEligible:approvals.length,
    sevenDayConverted:approvals.filter(a=>firstVotes.some(v=>v.memberId===a.memberId && +new Date(v.at)>=+new Date(a.at) && +new Date(v.at)<=+new Date(a.at)+7*86400000)).length,
    thirtyDayEligible:returningCohort.length,
    thirtyDayReturned:returningCohort.filter(v=>events.some(e=>e.memberId===v.memberId && e.event==='participation_day' && +new Date(e.at)>=+new Date(v.at)+86400000 && +new Date(e.at)<=+new Date(v.at)+30*86400000)).length,
  };
}
