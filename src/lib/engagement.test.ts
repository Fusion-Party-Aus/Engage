import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { ObjectId } from "mongodb";
import { digestEnabled, ensureDigestCohort, notificationEnabled, notificationPreferenceChanges } from "./digest-preferences.ts";
import { POST as sendTestEndpoint } from "../pages/api/admin/email/test.ts";
import { ALL as unsubscribe } from "../pages/api/email/unsubscribe.ts";
import { getDatabase } from "./db.ts";
import { readFile } from "node:fs/promises";
import { createMemoryDb } from "./db.ts";
import { ballotExpired, CURRENT_BALLOT_CLOSES_AT, closesWithinSevenDays } from "./ballot-deadline.ts";
import { rankProposals } from "./proposal-metrics.ts";
import { digestBallots, renderDigest, runBallotDigests, unsubscribeToken, readUnsubscribeToken, verifyResendWebhook, recordEmailEvent, sendAdminTestEmail } from "./engagement-email.ts";
import { castVote, listOutstandingDecisions, promotePendingVotePreferences, savePendingVotePreference, PENDING_VOTE_PREFERENCES } from "./store.ts";
import type { ProposalSummaryView, SessionUser } from "./types.ts";
import { PROPOSAL_VOTES } from "./vote-storage.ts";
const now = new Date("2026-12-20T00:00:00Z");
const memberId = new ObjectId().toString();
const user: SessionUser = {memberId,name:"Member",email:"member@example.test",role:"member",status:"verified",canParticipate:true,isStaff:false,isAdmin:false};
const proposal = (id:string,approve=3,reject=3,abstain=0,comments=0):ProposalSummaryView => ({proposalId:id,slug:id,title:id,space:"General",summary:"Summary",outcomes:[],details:"",stage:"decide",publicationScope:"national",createdAt:now,updatedAt:now,ballotRevisionId:"r1",ballotClosesAt:new Date(CURRENT_BALLOT_CLOSES_AT),votes:{approve,reject,abstain,total:approve+reject+abstain},commentCount:comments});
async function fixture() {
 const db = createMemoryDb();
 const p = proposal("P1");
 await db.collection("proposals").insertOne(p);
 await db.collection("proposal_revisions").insertOne({proposalId:"P1",revisionId:"r1",createdAt:now});
 return {db,p};
}
test("rankings exclude tiny samples, distinguish abstentions and tie-break by participation",()=>{
 const split=proposal("split",3,3), approved=proposal("approved",9,1,90), tiny=proposal("tiny",1,0), active=proposal("active",1,1,0,200);
 assert.equal(rankProposals([tiny,approved,split,active],"divisive")[0].proposalId,"split");
 assert.equal(rankProposals([tiny,approved,split,active],"approved")[0].proposalId,"approved");
 assert.equal(rankProposals([tiny,approved,split,active],"active")[0].proposalId,"active");
 assert.equal(rankProposals([tiny],"approved").length,0);
 assert.equal(rankProposals([proposal("unanimous",5,0)],"divisive").length,0);
});
test("deadline is end of Thursday 24 December Melbourne, exclusive and fail-closed",()=>{
 const p=proposal("P");
 assert.equal(ballotExpired(p,new Date("2026-12-24T12:59:59.999Z")),false);
 assert.equal(ballotExpired(p,new Date(CURRENT_BALLOT_CLOSES_AT)),true);
 assert.equal(ballotExpired({ballotClosesAt:"bad"}),true);
 assert.equal(closesWithinSevenDays(p,now),true);
 assert.equal(closesWithinSevenDays(p,new Date("2026-12-10")),false);
});
test("closed ballots reject formal votes, saved choices and promotion and leave outstanding queue",async()=>{
 const {db}=await fixture();
 await db.collection("proposals").updateOne({proposalId:"P1"},{$set:{ballotClosesAt:new Date(0)}});
 await assert.rejects(castVote(db,user,{proposalId:"P1",choice:"approve"}),/closed/);
 await assert.rejects(savePendingVotePreference(db,user,{proposalId:"P1",choice:"approve"}),/closed/);
 await db.collection("memberships").insertOne({memberId,status:"verified"});
 await db.collection(PENDING_VOTE_PREFERENCES).insertOne({memberId,proposalId:"P1",ballotId:"proposal:P1",revisionId:"r1",choice:"approve"});
 assert.equal(await promotePendingVotePreferences(db,memberId),0);
 assert.equal((await listOutstandingDecisions(db,memberId,user)).length,0);
});
test("digest excludes voted, closed, hidden and ineligible branch proposals",async()=>{
 const {db,p}=await fixture();
 const branch={...proposal("branch"),jurisdictionBranchId:"vic"};
 const hidden={...proposal("hidden"),publicationScope:"private" as const,authorId:"other"};
 assert.equal((await digestBallots(db,user,[p,branch,hidden],now)).length,1);
 await db.collection(PROPOSAL_VOTES).insertOne({memberId,proposalId:"P1",ballotId:"proposal:P1",revisionId:"r1",choice:"approve"});
 assert.equal((await digestBallots(db,user,[p,branch,hidden],now)).length,0);
 await db.collection("branch_memberships").insertOne({memberId,branchId:"vic",status:"active"});
 await db.collection("branches").insertOne({branchId:"vic",recognised:true});
 assert.equal((await digestBallots(db,user,[branch],now)).length,1);
 assert.equal((await digestBallots(db,{...user,canParticipate:false},[p],now)).length,0);
});
test("unsubscribe tokens reject tampering and emails escape proposal markup",()=>{
 const token=unsubscribeToken(memberId,"secret");
 assert.equal(readUnsubscribeToken(token,"secret"),memberId);
 assert.equal(readUnsubscribeToken(token+"x","secret"),null);
 const mail=renderDigest('<img src=x>',[{key:"a",title:'<script>bad</script>',href:"/proposals/a/",closesAt:new Date(CURRENT_BALLOT_CLOSES_AT),proposalId:"a"}],"https://example.test","https://example.test/unsubscribe");
 assert.ok(!mail.html.includes('<script>'));
 assert.ok(mail.html.includes('&lt;script&gt;'));
 assert.ok(mail.text.includes('Unsubscribe:'));
});
test("signed webhooks reject tampering and stale replays; bounce suppresses reminders",async()=>{
 const {db}=await fixture();
 const secret='whsec_'+Buffer.from('test-secret').toString('base64');
 const timestamp=String(Math.floor(now.getTime()/1000));
 const raw=JSON.stringify({type:"email.bounced",data:{email_id:"e1"}});
 const signature=createHmac("sha256",Buffer.from('test-secret')).update(`evt1.${timestamp}.${raw}`).digest('base64');
 const headers=new Headers({'svix-id':'evt1','svix-timestamp':timestamp,'svix-signature':`v1,${signature}`});
 assert.equal(verifyResendWebhook(raw,headers,secret,now.getTime()),true);
 assert.equal(verifyResendWebhook(raw+'x',headers,secret,now.getTime()),false);
 assert.equal(verifyResendWebhook(raw,headers,secret,now.getTime()+301000),false);
 await db.collection("engagement_email_outbox").insertOne({memberId,providerId:"e1",status:"sent"});
 await recordEmailEvent(db,"evt1",JSON.parse(raw),now);
 await recordEmailEvent(db,"evt1",JSON.parse(raw),now);
 assert.equal((await db.collection("engagement_email_preferences").findOne({memberId}))?.suppressed,true);
 assert.equal(await db.collection("engagement_email_events").countDocuments({}),1);
});
test("new accounts require opt-in, record provider acceptance and are reminded once",async()=>{
 const {db}=await fixture();
 await ensureDigestCohort(db);
 await db.collection("user").insertOne({_id:new ObjectId(memberId),name:"Member",email:"member@example.test",emailVerified:true});
 await db.collection("memberships").insertOne({memberId,status:"verified"});
 const env={ENGAGE_DIGEST_ENABLED:"true",ENGAGE_EMAIL_SECRET:"secret",RESEND_API_KEY:"key",AUTH_EMAIL_FROM:"Engage <test@example.test>",PUBLIC_ORIGIN:"https://example.test"};
 let calls=0;
 const send:typeof fetch=async(_url,init)=>{calls++;assert.ok(new Headers(init?.headers).get('Idempotency-Key'));assert.ok(JSON.parse(String(init?.body)).headers['List-Unsubscribe-Post']);return Response.json({id:"provider1"});};
 assert.equal((await runBallotDigests(db,env,send,now)).sent,0);
 await db.collection("engagement_email_preferences").insertOne({memberId,digestEnabled:true});
 assert.equal((await runBallotDigests(db,env,send,now)).sent,1);
 assert.equal((await runBallotDigests(db,env,send,new Date(now.getTime()+86400000))).sent,0);
 assert.equal(calls,1);
});
test("ambiguous email sends are held and never automatically repeated",async()=>{
 const {db}=await fixture();
 await db.collection("user").insertOne({_id:new ObjectId(memberId),name:"Member",email:"member@example.test",emailVerified:true});
 await db.collection("memberships").insertOne({memberId,status:"verified"});
 await db.collection("engagement_email_preferences").insertOne({memberId,digestEnabled:true});
 const env={ENGAGE_DIGEST_ENABLED:"true",ENGAGE_EMAIL_SECRET:"secret",RESEND_API_KEY:"key",AUTH_EMAIL_FROM:"test@example.test",PUBLIC_ORIGIN:"https://example.test"};
 let calls=0;const send:typeof fetch=async()=>{calls++;throw new Error("timeout");};
 assert.equal((await runBallotDigests(db,env,send,now)).held,1);
 await runBallotDigests(db,env,send,new Date(now.getTime()+86400000));
 assert.equal(calls,1);
});
test("webhook backlog reconciliation processes beyond the first 500 events",async()=>{
 const db=createMemoryDb();
 for(let i=0;i<501;i++) {
  await db.collection<any>('engagement_email_events').insertOne({_id:`evt-${String(i).padStart(4,'0')}`,providerId:`provider-${i}`,type:'email.delivered',receivedAt:now});
  await db.collection('engagement_email_outbox').insertOne({providerId:`provider-${i}`,memberId:`member-${i}`,status:'sent'});
 }
 await runBallotDigests(db,{ENGAGE_DIGEST_ENABLED:'true',ENGAGE_EMAIL_SECRET:'secret',RESEND_API_KEY:'key',AUTH_EMAIL_FROM:'test@example.test',PUBLIC_ORIGIN:'https://example.test'},async()=>{throw new Error('No mail expected');},now);
 assert.equal(await db.collection('engagement_email_events').countDocuments({processed:true}),501);
 assert.ok((await db.collection('engagement_email_outbox').findOne({providerId:'provider-500'}))?.deliveredAt);
});

test("rollout cohort stays fixed across restarts; explicit opt-outs and suppressions win",async()=>{
 const db=createMemoryDb();
 const oldId=new ObjectId(), newId=new ObjectId();
 await db.collection("user").insertOne({_id:oldId});
 const existing=await ensureDigestCohort(db);
 assert.equal(existing.has(oldId.toString()),true);
 assert.equal(digestEnabled(null,existing.has(oldId.toString())),true);
 await db.collection("user").insertOne({_id:newId});
 const restarted=await ensureDigestCohort(db);
 assert.equal(restarted.has(newId.toString()),false);
 assert.equal(digestEnabled(null,restarted.has(newId.toString())),false);
 assert.equal(digestEnabled({digestEnabled:false},true),false);
 assert.equal(digestEnabled({unsubscribedAt:new Date()},true),false);
 assert.equal(digestEnabled({digestEnabled:true,suppressed:true},true),false);
 assert.equal(digestEnabled({suppressed:true},true),false);
 assert.equal(digestEnabled({digestEnabled:true},false),true);
});
test("existing verified accounts receive reminders without returning to opt in",async()=>{
 const {db}=await fixture();
 await db.collection("user").insertOne({_id:new ObjectId(memberId),name:"Member",email:"member@example.test",emailVerified:true});
 await db.collection("memberships").insertOne({memberId,status:"verified"});
 const env={ENGAGE_DIGEST_ENABLED:"true",ENGAGE_EMAIL_SECRET:"secret",RESEND_API_KEY:"key",AUTH_EMAIL_FROM:"test@example.test",PUBLIC_ORIGIN:"https://example.test"};
 let calls=0; const send:typeof fetch=async(_url,init)=>{calls++;const body=JSON.parse(String(init?.body));assert.ok(body.text.includes('existing Engage account'));assert.ok(!body.text.includes('because you enabled'));return Response.json({id:'existing-member-mail'});};
 assert.equal((await runBallotDigests(db,env,send,now)).sent,1);
 assert.equal(calls,1);
 assert.equal(await db.collection("engagement_email_preferences").countDocuments({}),0);
});
test("default-enabled existing accounts still respect explicit opt-outs and bounce suppression",async()=>{
 for(const preference of [{digestEnabled:false},{suppressed:true},{digestEnabled:true,suppressed:true}]) {
  const {db}=await fixture();
  await db.collection("user").insertOne({_id:new ObjectId(memberId),name:"Member",email:"member@example.test",emailVerified:true});
  await db.collection("memberships").insertOne({memberId,status:"verified"});
  await db.collection("engagement_email_preferences").insertOne({memberId,...preference});
  const env={ENGAGE_DIGEST_ENABLED:"true",ENGAGE_EMAIL_SECRET:"secret",RESEND_API_KEY:"key",AUTH_EMAIL_FROM:"test@example.test",PUBLIC_ORIGIN:"https://example.test"};
  assert.equal((await runBallotDigests(db,env,async()=>{throw Error('Must not send');},now)).sent,0);
  const saved=await db.collection("engagement_email_preferences").findOne({memberId});
  for(const [key,value] of Object.entries(preference)) assert.equal(saved?.[key],value);
 }
});

test("notification categories save independently and have separate defaults",()=>{
 const existing={digestEnabled:true,accountNotificationsEnabled:false,generalCommunicationsEnabled:true};
 for (const category of ["essential","engage","general"] as const) {
  const form=new FormData();form.set("category",category);
  const changes=notificationPreferenceChanges(form);
  const result={...existing,...changes};
  assert.equal(Object.keys(changes).length,1);
  assert.equal(notificationEnabled(result,category,true),false);
  for(const key of Object.keys(existing)) if(!(key in changes)) assert.equal(result[key as keyof typeof existing],existing[key as keyof typeof existing]);
 }
 assert.equal(notificationEnabled(null,"essential"),true);
 assert.equal(notificationEnabled(null,"general"),false);
 assert.equal(notificationEnabled(null,"engage",true),true);
 assert.equal(notificationEnabled(null,"engage",false),false);
 const unknown=new FormData();unknown.set("category","anything");assert.throws(()=>notificationPreferenceChanges(unknown));
});
test("digest unsubscribe leaves other categories intact and GET link scans do not unsubscribe",async()=>{
 const env={APP_MODE:"preview",ENGAGE_EMAIL_SECRET:"test-secret"};
 const db=await getDatabase(env);
 const id='unsubscribe-'+crypto.randomUUID();
 await db.collection("engagement_email_preferences").insertOne({memberId:id,digestEnabled:true,accountNotificationsEnabled:false,generalCommunicationsEnabled:true});
 const url=new URL('https://example.test/api/email/unsubscribe?token='+unsubscribeToken(id,env.ENGAGE_EMAIL_SECRET));
 const run=(method:string)=>unsubscribe({request:new Request(url,{method}),url,locals:{env}} as never);
 assert.equal((await run("GET")).status,200);
 assert.equal((await db.collection("engagement_email_preferences").findOne({memberId:id}))?.digestEnabled,true);
 assert.equal((await run("POST")).status,200);
 const result=await db.collection("engagement_email_preferences").findOne({memberId:id});
 assert.equal(result?.digestEnabled,false);
 assert.equal(result?.accountNotificationsEnabled,false);
 assert.equal(result?.generalCommunicationsEnabled,true);
 assert.equal(await db.collection("engagement_notification_events").countDocuments({memberId:id,category:"engage",source:"email-unsubscribe"}),1);
});
test("onboarding explains email defaults, three categories and unsubscribe with direct preference controls",async()=>{
 const source=await readFile(new URL('../components/member/MemberOnboarding.tsx',import.meta.url),'utf8');
 for(const text of ['existing Engage accounts','new Engage accounts','My Engage → Notifications','essential account notifications','Engage digests','general communications','Every digest has an unsubscribe link','action="/api/email/preferences"','defaultChecked={props.digestEnabled === true}']) assert.ok(source.includes(text),text);
});

test("administrator tests use own inbox and sample template while scheduled digests are off",async()=>{
 const db=createMemoryDb();
 const admin={...user,isAdmin:true,role:"administrator" as const};
 const env={ENGAGE_DIGEST_ENABLED:"false",ENGAGE_EMAIL_SECRET:"secret",RESEND_API_KEY:"key",AUTH_EMAIL_FROM:"test@example.test",PUBLIC_ORIGIN:"https://example.test"};
 let calls=0;
 const send:typeof fetch=async(_url,init)=>{
  calls++;const body=JSON.parse(String(init?.body));
  assert.deepEqual(body.to,[admin.email]);assert.ok(body.subject.startsWith('[TEST]'));
  assert.ok(body.html.includes('Test email — sample data only'));
  assert.ok(body.text.includes('not announce a real ballot deadline'));
  assert.ok(!body.text.includes('because you enabled'));
  const token=new URL(body.headers['List-Unsubscribe'].slice(1,-1)).searchParams.get('token');
  assert.ok(token);
  assert.equal(readUnsubscribeToken(token,env.ENGAGE_EMAIL_SECRET),`test:${admin.memberId}`);
  return Response.json({id:'test-provider-id'});
 };
 const result=await sendAdminTestEmail(db,env,admin,send,now);
 assert.equal(result.providerId,'test-provider-id');assert.equal(calls,1);
 const message=await db.collection('engagement_email_outbox').findOne({providerId:result.providerId});
 assert.equal(message?.kind,'test');assert.equal(message?.ballotKeys,undefined);
 assert.equal(await db.collection('engagement_email_preferences').countDocuments({}),0);
 await assert.rejects(sendAdminTestEmail(db,env,admin,send,now),/already attempted/);
 await recordEmailEvent(db,'test-delivery',{type:'email.delivered',data:{email_id:result.providerId}},now);
 assert.ok((await db.collection('engagement_email_outbox').findOne({providerId:result.providerId}))?.deliveredAt);
});
test("test sender rejects members, missing configuration, suppression and ambiguous provider outcomes",async()=>{
 const db=createMemoryDb(), admin={...user,isAdmin:true};
 const env={ENGAGE_EMAIL_SECRET:"secret",RESEND_API_KEY:"key",AUTH_EMAIL_FROM:"test@example.test",PUBLIC_ORIGIN:"https://example.test"};
 const never:typeof fetch=async()=>{throw Error('Should not send');};
 await assert.rejects(sendAdminTestEmail(db,env,user,never,now),/Administrator access/);
 await assert.rejects(sendAdminTestEmail(db,{},admin,never,now),/Configure/);
 await db.collection('engagement_email_preferences').insertOne({memberId,suppressed:true});
 await assert.rejects(sendAdminTestEmail(db,env,admin,never,now),/bounce or spam complaint/);
 await db.collection('engagement_email_preferences').updateOne({memberId},{$set:{suppressed:false}});
 await assert.rejects(sendAdminTestEmail(db,env,admin,async()=>{throw Error('timeout');},now),/uncertain/);
 assert.equal((await db.collection('engagement_email_outbox').findOne({kind:'test'}))?.status,'held');
});
test("test endpoint requires admin authentication and same-origin POST; demo unsubscribe never writes preferences",async()=>{
 const url=new URL('https://example.test/api/admin/email/test');
 const call=(cookie:string,origin:string)=>sendTestEndpoint({url,request:new Request(url,{method:'POST',headers:{cookie,origin}}),locals:{env:{APP_MODE:'preview'}}} as never);
 assert.equal((await call('',url.origin)).status,401);
 assert.equal((await call('engage_dev_user=member',url.origin)).status,403);
 assert.equal((await call('engage_dev_user=administrator','https://other.test')).status,403);
 const env={APP_MODE:'preview',ENGAGE_EMAIL_SECRET:'demo-secret'};
 const demoId=`test:${crypto.randomUUID()}`;
 const demoUrl=new URL('https://example.test/api/email/unsubscribe?token='+unsubscribeToken(demoId,env.ENGAGE_EMAIL_SECRET));
 const response=await unsubscribe({url:demoUrl,request:new Request(demoUrl,{method:'POST'}),locals:{env}} as never);
 assert.equal(response.status,200);assert.ok((await response.text()).includes('No notification preferences changed'));
 const db=await getDatabase(env);
 assert.equal(await db.collection('engagement_email_preferences').countDocuments({memberId:demoId}),0);
});
