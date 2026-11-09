import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { ObjectId } from "mongodb";
import { createMemoryDb } from "./db.ts";
import { ballotExpired, CURRENT_BALLOT_CLOSES_AT, closesWithinSevenDays } from "./ballot-deadline.ts";
import { rankProposals } from "./proposal-metrics.ts";
import { digestBallots, renderDigest, runBallotDigests, unsubscribeToken, readUnsubscribeToken, verifyResendWebhook, recordEmailEvent } from "./engagement-email.ts";
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
test("digest sends only to opted-in verified accounts, records provider acceptance and reminds once",async()=>{
 const {db}=await fixture();
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
