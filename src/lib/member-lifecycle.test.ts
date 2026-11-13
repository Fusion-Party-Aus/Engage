import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId, MongoClient } from 'mongodb';
import { createMemoryDb } from './db.ts';
import { sendVerificationNotice, renderVerification } from './verification-email.ts';
import { recordEmailEvent } from './engagement-email.ts';
import { recordLifecycle, recordParticipation, lifecycleConversion, memberNextAction } from './member-lifecycle.ts';
import { previewMemberReengagement } from './member-reengagement.ts';
import { safeMemberReturn } from './return-destination.ts';
import { listOutstandingDecisions } from './store.ts';
const env={APP_MODE:'preview',RESEND_API_KEY:'synthetic',AUTH_EMAIL_FROM:'test@example.test',BETTER_AUTH_URL:'https://example.test'};
const now=new Date('2026-11-09T00:00:00Z');
async function fixture(db=createMemoryDb()) {
  const id=new ObjectId(); const memberId=String(id);
  await db.collection('user').insertOne({_id:id,name:'Example <Member>',email:'synthetic@example.test',emailVerified:true});
  await db.collection('memberships').insertOne({memberId,status:'verified',verifiedAt:new Date('2026-09-01')});
  return {db,memberId};
}
test('verification claim prevents concurrent sends and reactivation mail',async()=>{
 const {db,memberId}=await fixture(); let sends=0;
 const send:typeof fetch=async(_url,init)=>{sends++; assert.equal(new Headers(init?.headers).get('Idempotency-Key'),`verification:verified:${memberId}`);return Response.json({id:'receipt'});};
 await Promise.all(Array.from({length:10},()=>sendVerificationNotice(db,env,memberId,'verified',send)));
 assert.equal(sends,1);
 assert.equal(await sendVerificationNotice(db,env,memberId,'verified',send),'not-needed');
 await recordEmailEvent(db,'delivery',{type:'email.delivered',data:{email_id:'receipt'}});
 await recordEmailEvent(db,'delivery',{type:'email.delivered',data:{email_id:'receipt'}});
 assert.equal(await db.collection('engagement_lifecycle_events').countDocuments({event:'verification_notification_delivered'}),1);
});
test('timeouts hold delivery and late receipts correlate without enabling digests',async()=>{
 const {db,memberId}=await fixture();
 assert.equal(await sendVerificationNotice(db,env,memberId,'verified',async()=>{throw new Error('timeout');}),'held');
 assert.equal(await sendVerificationNotice(db,env,memberId,'verified',async()=>{throw new Error('must not retry');}),'not-needed');
 const second=await fixture(db);
 const result=await sendVerificationNotice(db,env,second.memberId,'verified',async()=>{
   await recordEmailEvent(db,'early',{type:'email.bounced',data:{email_id:'early-id'}});
   return Response.json({id:'early-id'});
 });
 assert.equal(result,'sent');
 assert.equal((await db.collection('engagement_email_preferences').findOne({memberId:second.memberId}))?.suppressed,true);
});
test('account preferences and suppression block verification; digest opt-out does not block transactional mail',async()=>{
 for (const preference of [{accountNotificationsEnabled:false},{suppressed:true},{digestEnabled:false}]) {
  const {db,memberId}=await fixture(); let sent=0;
  await db.collection('engagement_email_preferences').insertOne({memberId,...preference});
  await sendVerificationNotice(db,env,memberId,'verified',async()=>{sent++;return Response.json({id:'ok'});});
  assert.equal(sent,'digestEnabled' in preference ? 1 : 0);
 }
});
test('configuration failure remains observable and non-sendable',async()=>{
 const {db,memberId}=await fixture();
 assert.equal(await sendVerificationNotice(db,{},memberId,'verified'),'failed');
 assert.equal((await db.collection('engagement_email_outbox').findOne({memberId}))?.failureReason,'configuration');
});
test('email escapes member names, includes branding and a fixed authenticated voting destination',()=>{
 const mail=renderVerification('<script>','https://example.test');
 assert.ok(!mail.html.includes('<script>'));assert.ok(mail.html.includes('&lt;script&gt;'));
 assert.match(mail.html,/Start voting/); assert.match(mail.text,/\/member\/\?intent=vote&source=verification#outstanding-ballots/);
 assert.match(mail.html,/viewport/); assert.match(renderVerification('Member','https://example.test',false).text,/suspended/);
 for (const raw of ['//evil.test','/\\evil.test','/api/auth','/%61pi/auth','/\n/evil.test','https://evil.test']) assert.equal(safeMemberReturn(raw),'/member/');
 assert.equal(safeMemberReturn('/proposals/example/?intent=vote#proposal-vote'),'/proposals/example/?intent=vote#proposal-vote');
});
test('funnel deduplicates first vote and uses mature cohorts and subsequent participation days',async()=>{
 const {db,memberId}=await fixture();
 await recordLifecycle(db,memberId,'verification_approved',new Date('2026-10-01'));
 await recordParticipation(db,memberId,new Date('2026-10-02'));
 await recordParticipation(db,memberId,new Date('2026-10-02'));
 await recordParticipation(db,memberId,new Date('2026-10-08'));
 const events=await db.collection<any>('engagement_lifecycle_events').find({}).toArray();
 assert.deepEqual(lifecycleConversion(events,now),{sevenDayEligible:1,sevenDayConverted:1,thirtyDayEligible:1,thirtyDayReturned:1});
 assert.equal(lifecycleConversion(events,new Date('2026-10-03')).sevenDayEligible,0);
});
test('lifecycle actions never promise voting to pending or suspended members',()=>{
 assert.equal(memberNextAction('pending',false,0,9).title,'View application status');
 assert.equal(memberNextAction('suspended',false,0,9).title,'Review your membership status');
 assert.equal(memberNextAction('verified',true,0,1).title,'Cast your first vote');
 assert.equal(memberNextAction('verified',true,0,0).title,'Explore open ballots');
 assert.equal(memberNextAction('verified',true,1,1).title,'Review outstanding ballots');
 assert.equal(memberNextAction('verified',true,1,0).title,'View participation history');
});
test('reengagement preview separates Engage opt-outs, suppressions and uncertain dates without writes',async()=>{
 const db=createMemoryDb();
 for (const reason of ['eligible','no-consent','suppressed','participated','recent','unknown-date','held']) {
  const {memberId}=await fixture(db);
  await db.collection('engagement_email_preferences').insertOne({memberId,digestEnabled:reason!=='no-consent',generalCommunicationsEnabled:false,suppressed:reason==='suppressed'});
  if(reason==='participated') await db.collection('proposal_votes').insertOne({memberId});
  if(reason==='recent') await recordLifecycle(db,memberId,'my_engage_viewed',now);
  if(reason==='unknown-date') await db.collection('memberships').updateOne({memberId},{$unset:{verifiedAt:''}});
  if(reason==='held') await db.collection('engagement_email_outbox').insertOne({memberId,kind:'verification',status:'held'});
 }
 const before=await db.collection('engagement_email_preferences').find({}).toArray();
 const report=await previewMemberReengagement(db,new Date('2026-10-01'),now);
 assert.equal(report.eligible,1);assert.equal(report.suppressed,1);assert.equal(report.excluded,4);assert.equal(report.needsReview,1);
 assert.deepEqual(await db.collection('engagement_email_preferences').find({}).toArray(),before);
 assert.ok(!JSON.stringify(report).includes('memberId'));assert.ok(!JSON.stringify(report).includes('@'));
});
test('outstanding discovery excludes unbound and ineligible ballots and retains revised unvoted ballots',async()=>{
 const db=createMemoryDb();const memberId='test';
 for(const id of ['unbound','revised','voted']) await db.collection('proposals').insertOne({proposalId:id,slug:id,title:id,stage:'decide',...(id!=='unbound'?{ballotRevisionId:'r2'}:{})});
 for(const [id,revisionId] of [['revised','r1'],['voted','r2']]) await db.collection('proposal_votes').insertOne({memberId,proposalId:id,ballotId:`proposal:${id}`,revisionId});
 const user={memberId,status:'verified',canParticipate:true} as any;
 assert.deepEqual((await listOutstandingDecisions(db,memberId,user)).map(p=>p.proposalId),['revised']);
 assert.equal((await listOutstandingDecisions(db,memberId,{...user,canParticipate:false})).length,0);
});
test('real MongoDB concurrently claims exactly one verification delivery',{skip:!process.env.VOTING_TEST_MONGODB_URI},async()=>{
 const client=await new MongoClient(process.env.VOTING_TEST_MONGODB_URI!).connect();
 const db=client.db(`engage_lifecycle_test_${crypto.randomUUID().replaceAll('-','')}`);
 try {const {memberId}=await fixture(db);let sends=0;
 await Promise.all(Array.from({length:15},()=>sendVerificationNotice(db,env,memberId,'verified',async()=>{sends++;return Response.json({id:'receipt'});})));
 assert.equal(sends,1);assert.equal(await db.collection('engagement_email_outbox').countDocuments(),1);
 } finally {await db.dropDatabase();await client.close();}
});
test('existing voters are excluded from the new first-vote cohort',async()=>{
 const {db,memberId}=await fixture();
 await db.collection('proposal_votes').insertOne({memberId,updatedAt:new Date('2026-09-01')});
 const {notePriorParticipation}=await import('./member-lifecycle.ts');
 await notePriorParticipation(db,memberId);
 await recordParticipation(db,memberId,now);
 assert.equal(await db.collection('engagement_lifecycle_events').countDocuments({event:'first_vote_submitted'}),0);
 assert.equal(await db.collection('engagement_lifecycle_events').countDocuments({event:'participation_day'}),1);
});
test('dry-run endpoint rejects anonymous access and non-admin members',async()=>{
 const {GET}=await import('../pages/api/admin/email/reengagement.ts');
 for(const [cookie, expectedStatus] of [['', 401], ['engage_dev_user=member', 403]] as const) {
 const response=await GET({request:new Request('https://example.test/api/admin/email/reengagement',{headers:{cookie}}),url:new URL('https://example.test/api/admin/email/reengagement'),locals:{env:{APP_MODE:'preview',MONGODB_URI:''}}} as never);
 assert.equal(response.status,expectedStatus);
 }
});
test('shared outstanding discovery includes undated amendment ballots and digest keeps its seven-day window',async()=>{
 const {outstandingBallots,digestBallots}=await import('./engagement-email.ts');
 const db=createMemoryDb();const memberId='test';
 const proposal={proposalId:'p',slug:'p',title:'p',stage:'decide',ballotRevisionId:'r1'} as any;
 await db.collection('amendments').insertOne({amendmentId:'a',proposalId:'p',title:'a',status:'voting',baseRevisionId:'r1',ballotRevisionId:'r1',currentRevisionId:'a1',ballotAmendmentRevisionId:'a1'});
 const user={memberId,canParticipate:true,status:'verified'} as any;
 assert.equal((await outstandingBallots(db,user,[proposal])).length,2);
 assert.equal((await digestBallots(db,user,[proposal])).length,0);
 await db.collection('proposal_votes').insertOne({memberId,proposalId:'p',ballotId:'proposal:p',revisionId:'r1'});
 const outstanding=await outstandingBallots(db,user,[proposal]);
 assert.equal(outstanding.length,1);assert.ok(outstanding[0].key.startsWith('amendment:'));
});
test('legacy preference absence is reviewable, not refusal, and reviewed inferred consent can qualify without general consent',async()=>{
 const {engageConsentState}=await import('./digest-preferences.ts');
 assert.equal(engageConsentState(null,true),'legacy-unrecorded');
 assert.equal(engageConsentState({generalCommunicationsEnabled:false},true),'legacy-unrecorded');
 assert.equal(engageConsentState({digestEnabled:false},true),'explicit-opt-out');
 assert.equal(engageConsentState({digestEnabled:true},false),'explicit-opt-in');
 assert.equal(engageConsentState({digestEnabled:true,suppressed:true},true),'suppressed');
 assert.equal(engageConsentState(null,false),'new-unrecorded');
 const {db,memberId}=await fixture();
 await db.collection<any>('engagement_email_rollouts').insertOne({_id:'ballot-reminders-v1',memberIds:[memberId]});
 await db.collection('engagement_email_preferences').insertOne({memberId,generalCommunicationsEnabled:false});
 let report=await previewMemberReengagement(db,new Date('2026-10-01'),now);
 assert.equal(report.needsReview,1);assert.equal(report.excluded,0);assert.equal(report.consentCounts['legacy-unrecorded'],1);
 await db.collection('engagement_consent_assessments').insertOne({scope:'engage-participation',status:'approved',rolloutId:'ballot-reminders-v1',basis:'inferred-membership',reviewedBy:'synthetic-reviewer',reviewedAt:new Date('2026-11-01'),validUntil:new Date('2026-12-01'),evidenceReferences:['synthetic archived membership/disclosure assessment']});
 report=await previewMemberReengagement(db,new Date('2026-10-01'),now);
 assert.equal(report.eligible,1);assert.equal(report.campaignApprovalRequired,true);
 await db.collection('engagement_email_preferences').updateOne({memberId},{$set:{digestEnabled:false}});
 assert.equal((await previewMemberReengagement(db,new Date('2026-10-01'),now)).reasons['explicit-engage-opt-out'],1);
 await db.collection('engagement_email_preferences').updateOne({memberId},{$set:{digestEnabled:true,suppressed:true}});
 assert.equal((await previewMemberReengagement(db,new Date('2026-10-01'),now)).suppressed,1);
});
test('unreviewed or expired legacy assessments never make the audience sendable and new accounts need opt-in',async()=>{
 const {db,memberId}=await fixture();
 await db.collection<any>('engagement_email_rollouts').insertOne({_id:'ballot-reminders-v1',memberIds:[]});
 let report=await previewMemberReengagement(db,new Date('2026-10-01'),now);
 assert.equal(report.reasons['new-member-opt-in-required'],1);
 await db.collection<any>('engagement_email_rollouts').updateOne({_id:'ballot-reminders-v1'},{$set:{memberIds:[memberId]}});
 await db.collection('engagement_consent_assessments').insertOne({scope:'engage-participation',status:'approved',memberId,basis:'inferred-membership',reviewedBy:'synthetic',reviewedAt:new Date('2026-10-01'),validUntil:new Date('2026-10-31'),evidenceReferences:['synthetic']});
 report=await previewMemberReengagement(db,new Date('2026-10-01'),now);
 assert.equal(report.eligible,0);assert.equal(report.needsReview,1);
});
test('administrator audience detail is opt-in and contains no addresses or ballot choices',async()=>{
 const {db,memberId}=await fixture();
 await db.collection('engagement_email_preferences').insertOne({memberId,digestEnabled:true});
 const aggregate=await previewMemberReengagement(db,new Date('2026-10-01'),now);
 assert.equal(aggregate.members,undefined);
 const detail=await previewMemberReengagement(db,new Date('2026-10-01'),now,true);
 assert.deepEqual(detail.members,[{memberId,consent:'explicit-opt-in',classification:'eligible',reason:'eligible'}]);
 assert.ok(!JSON.stringify(detail).includes('@'));assert.ok(!JSON.stringify(detail).includes('choice'));
});
