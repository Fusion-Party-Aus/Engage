import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMemoryDb } from './db.ts';
import { submitSense, listSense, reviewSense, claimSenseSlot, senseDestinations } from './sense-box.ts';
import type { SessionUser } from './types.ts';
const admin = { memberId:'organiser', isAdmin:false, branchAdminIds:['branch-vic'] } as SessionUser;
const input = { requestId:'12345678-1234-4234-8234-123456789abc', branchId:'branch-vic', title:'Better regional transport', detail:'More frequent trains would help our community.', locality:'Bendigo', topic:'transport', consent:true };
async function setup() {
  const db = createMemoryDb();
  await db.collection('branches').insertOne({branchId:'branch-vic', name:'Fusion Victoria', kind:'state', recognised:true});
  await db.collection('branches').insertOne({branchId:'branch-nsw', name:'Fusion NSW', kind:'state', recognised:true});
  return db;
}
test('public intake is private, branch-aware and idempotent, without creating governance records', async () => {
  const db = await setup();
  const first = await submitSense(db,input);
  assert.equal(await submitSense(db,input), first);
  assert.equal(await db.collection('sense_submissions').countDocuments(),1);
  assert.equal(await db.collection('proposals').countDocuments(),0);
  const row = await db.collection('sense_submissions').findOne({});
  assert.equal(row?.branchId,'branch-vic'); assert.equal(row?.status,'new');
  assert.equal(row?.memberId,undefined);
  await assert.rejects(submitSense(db,{...input,title:'Changed title'}), /already used/);
});
test('intake rejects invalid branches, unbounded text, missing consent and query operators', async () => {
  const db = await setup();
  for (const change of [{branchId:'missing'},{branchId:{$ne:''}},{consent:false},{detail:'x'.repeat(3001)},{title:''},{topic:'unknown'}]) {
    await assert.rejects(submitSense(db,{...input,...change}));
  }
  await db.collection('branches').updateOne({branchId:'branch-vic'},{$set:{recognised:false}});
  await assert.rejects(submitSense(db,input), /available/);
});
test('branch organisers see and update only their submissions, with conflict protection', async () => {
  const db = await setup();
  const id = await submitSense(db,input);
  await submitSense(db,{...input,requestId:'22345678-1234-4234-8234-123456789abc',branchId:'branch-nsw'});
  const list = await listSense(db,admin,{});
  assert.equal(list.total,1); assert.equal(list.items[0]?.submissionId,id);
  await assert.rejects(listSense(db,admin,{branchId:'branch-nsw'}), /access/);
  await assert.rejects(listSense(db,{...admin,branchAdminIds:[]},{}), /access/);
  await assert.rejects(reviewSense(db,admin,{submissionId:id,status:'reviewed',version:0,branchId:'branch-nsw'}), /access/);
  await reviewSense(db,admin,{submissionId:id,status:'reviewed',version:0,branchId:'branch-vic'});
  await assert.rejects(reviewSense(db,admin,{submissionId:id,status:'archived',version:0,branchId:'branch-vic'}), /changed/);
  assert.equal((await listSense(db,admin,{status:'reviewed'})).total,1);
  assert.equal((await listSense(db,admin,{topic:'housing'})).total,0);
});
test('database-backed intake throttle bounds parallel requests and keeps raw addresses out of storage', async () => {
  const db = await setup();
  const outcomes = await Promise.allSettled(Array.from({length:12},()=>claimSenseSlot(db,'192.0.2.1','test-secret',1000000)));
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,10);
  assert.equal(JSON.stringify(await db.collection('sense_limits').find({}).toArray()).includes('192.0.2.1'),false);
  await claimSenseSlot(db,'192.0.2.1','test-secret',1600000);
});

test('fresh installation accepts a local concern into the selected branch inbox without creating membership', async () => {
 const db=createMemoryDb();
 assert.equal((await senseDestinations(db)).length,8);
 await submitSense(db,{...input,title:'The buses in my suburb are terrible'});
 assert.equal((await listSense(db,admin,{status:'new'})).items[0]?.title,'The buses in my suburb are terrible');
 assert.equal(await db.collection('branch_memberships').countDocuments(),0);
 assert.equal(await db.collection('branches').countDocuments(),0);
});
