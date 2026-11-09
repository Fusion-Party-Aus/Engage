// Synthetic preview only. All provider handoffs are mocked; no production email is sent.
import {dev} from 'astro';
import assert from 'node:assert/strict';
process.env.APP_MODE='preview';process.env.MONGODB_URI='';process.env.PUBLIC_ORIGIN='https://public.example.test';process.env.RESEND_API_KEY='mock-key';process.env.AUTH_EMAIL_FROM='Engage <admin@example.test>';process.env.ENGAGE_EMAIL_SECRET='mock-signing-secret';process.env.ENGAGE_DIGEST_ENABLED='false';
const original=globalThis.fetch;let providerCalls=0;
globalThis.fetch=async(url,init)=>String(url)==='https://api.resend.com/emails' ? (providerCalls++,Response.json({id:'mock-http-receipt'})) : original(url,init);
const server=await dev({root:process.cwd(),server:{host:'127.0.0.1',port:4349}});
const base='http://127.0.0.1:4349',cookie='engage_dev_user=administrator';
try {
 const page=await original(base+'/admin/engagement/',{headers:{cookie}});assert.equal(page.status,200);const html=await page.text();assert.ok(html.includes('Scheduled digests disabled'));assert.ok(html.includes('Delivery diagnostics'));assert.ok(!html.includes('Preview historical re-engagement counts with'));
 const post=(cookieValue=cookie,origin=process.env.PUBLIC_ORIGIN)=>original(base+'/api/admin/email/test',{method:'POST',headers:{cookie:cookieValue,origin,'content-type':'application/json'},body:'{}'});
 assert.equal((await post('')).status,401);assert.equal((await post('engage_dev_user=member')).status,403);assert.equal((await post(cookie,'https://attacker.test')).status,403);
 const response=await post();assert.equal(response.status,200);const receipt=await response.json();assert.equal(receipt.status,'accepted');assert.equal(receipt.providerId,'mock-http-receipt');assert.ok(receipt.recipient.includes('@'));assert.equal(providerCalls,1);
 assert.equal((await post()).status,429);assert.equal(providerCalls,1);
 const history=await original(base+'/api/admin/email/test',{headers:{cookie}});assert.equal(history.status,200);assert.equal((await history.json()).messages[0].providerId,'mock-http-receipt');
 const preview=await original(base+'/api/admin/email/reengagement?cutoff=2026-10-01',{headers:{cookie}});assert.equal(preview.status,200);assert.equal((await preview.json()).dryRun,true);assert.equal(providerCalls,1);
 console.log('PASS: real Astro HTTP stack, dashboard render, proxy-origin JSON POST, anonymous/member/cross-site rejection, mocked provider acceptance and history, rate limit, read-only preview. Production sends: 0.');
} finally {await server.stop();globalThis.fetch=original;}
