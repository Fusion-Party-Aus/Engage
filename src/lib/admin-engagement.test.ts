import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryDb} from './db.ts';
import {POST} from '../pages/api/admin/email/test.ts';
import {sendAdminTestEmail} from './engagement-email.ts';
import {recordEmailEvent} from './engagement-email.ts';
import {deliveryBreakdown,percentage,testDeliveryHistory} from './admin-engagement.ts';

const admin={memberId:'test-admin',email:'admin@example.test',name:'Admin',role:'administrator' as const,status:'verified' as const,canParticipate:true,isAdmin:true,isStaff:true};
const env={APP_MODE:'preview',ENGAGE_EMAIL_SECRET:'secret',RESEND_API_KEY:'secret-key',AUTH_EMAIL_FROM:'Engage <test@example.test>',PUBLIC_ORIGIN:'https://public.example.test'};
test('test endpoint accepts configured public origin behind an internal HTTP proxy',async()=>{
 const url=new URL('http://internal:4321/api/admin/email/test');
 const response=await POST({url,request:new Request(url,{method:'POST',headers:{origin:env.PUBLIC_ORIGIN,'content-type':'application/json'}}),locals:{env:{...env,RESEND_API_KEY:''}}} as never);
 assert.equal(response.status,401,'must reach authentication rather than reject the public origin');
});
test('cross-site origins remain rejected even when a forwarded host impersonates public origin',async()=>{
 const url=new URL('http://internal/api/admin/email/test');
 const response=await POST({url,request:new Request(url,{method:'POST',headers:{origin:'https://attacker.test','x-forwarded-host':'public.example.test'}}),locals:{env}} as never);
 assert.equal(response.status,403);
});
test('receipt history reconciles early events with scheduler off and isolates admin and digest records',async()=>{
 const db=createMemoryDb();
 await recordEmailEvent(db,'early',{type:'email.delivered',data:{email_id:'test-receipt'}});
 await db.collection<any>('engagement_email_outbox').insertOne({_id:'mine',kind:'test',memberId:admin.memberId,providerId:'test-receipt',status:'sent',createdAt:new Date(),privateProviderResponse:'SECRET'});
 await db.collection('engagement_email_outbox').insertOne({kind:'test',memberId:'other',providerId:'other-receipt'});
 await db.collection('engagement_email_outbox').insertOne({memberId:admin.memberId,providerId:'digest-receipt'});
 const history=await testDeliveryHistory(db,admin.memberId);
 assert.equal(history.length,1);assert.equal(history[0].status,'Delivered');
 assert.equal(history[0].providerId,'test-receipt');assert.ok(!JSON.stringify(history).includes('SECRET'));
});
test('delivery breakdown is mutually exclusive and missing denominator differs from zero',()=>{
 assert.deepEqual(deliveryBreakdown([{providerId:'1'},{providerId:'2',deliveredAt:new Date()},{providerId:'3',deliveredAt:new Date(),bouncedAt:new Date()},{complainedAt:new Date()},{status:'failed'},{status:'held'}]),{accepted:1,delivered:1,bounced:1,complained:1,failed:1,held:1});
 assert.equal(percentage(0,0),'Unavailable');assert.equal(percentage(0,10),'0.0%');
});
test('test bounce receipts do not change member preferences',async()=>{
 const db=createMemoryDb();
 await db.collection('engagement_email_preferences').insertOne({memberId:admin.memberId,digestEnabled:true});
 await db.collection('engagement_email_outbox').insertOne({kind:'test',memberId:admin.memberId,providerId:'test-bounce'});
 await recordEmailEvent(db,'bounce-test',{type:'email.bounced',data:{email_id:'test-bounce'}});
 assert.equal((await db.collection('engagement_email_preferences').findOne({memberId:admin.memberId}))?.suppressed,undefined);
 assert.ok((await db.collection('engagement_email_outbox').findOne({providerId:'test-bounce'}))?.bouncedAt);
});
test('concurrent test sends claim one per admin per calendar minute, including failures',async()=>{
 const db=createMemoryDb();let calls=0;const now=new Date('2026-11-09T12:30:30Z');
 const send:typeof fetch=async()=>{calls++;return Response.json({id:'one'});};
 const results=await Promise.allSettled(Array.from({length:10},()=>sendAdminTestEmail(db,env,admin,send,now)));
 assert.equal(calls,1);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(await db.collection('engagement_email_outbox').countDocuments({kind:'test'}),1);
});
test('explicit provider rejection is failed, actionable and never reveals the provider body',async()=>{
 const db=createMemoryDb();
 await assert.rejects(sendAdminTestEmail(db,env,admin,async()=>Response.json({message:'secret internal provider response',name:'validation_error'},{status:403})),/sender|domain/i);
 const row=await db.collection('engagement_email_outbox').findOne({kind:'test'});
 assert.equal(row?.status,'failed');assert.equal(row?.providerHttpStatus,403);
 assert.ok(!JSON.stringify(row).includes('secret internal'));
});
test('successful test returns recipient and acceptance with an isolated receipt',async()=>{
 const db=createMemoryDb();
 const result=await sendAdminTestEmail(db,env,admin,async()=>Response.json({id:'receipt-123'}));
 assert.equal(result.status,'accepted');assert.equal((result as any).recipient,admin.email);
 assert.equal(result.providerId,'receipt-123');
});
