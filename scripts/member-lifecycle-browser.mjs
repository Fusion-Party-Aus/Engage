// Optional browser verification; Playwright is installed in CI's temporary directory,
// never added to the application runtime or used against production/member accounts.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const modulePath=process.env.ENGAGE_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error('Set ENGAGE_PLAYWRIGHT_MODULE to the isolated Playwright index.mjs.');
const {chromium}=await import(pathToFileURL(modulePath).href);
const output=path.resolve('docs/screenshots/member-lifecycle');
await mkdir(output,{recursive:true});
const origin='http://127.0.0.1:4397';
const server=spawn(process.execPath,['dist/server/entry.mjs'],{stdio:'inherit',env:{...process.env,APP_MODE:'preview',MONGODB_URI:'',HOST:'127.0.0.1',PORT:'4397',ASTRO_NODE_LOGGING:'disabled',PUBLIC_ORIGIN:origin,BETTER_AUTH_URL:origin,RESEND_API_KEY:'',AUTH_EMAIL_FROM:'',ENGAGE_DIGEST_ENABLED:'false'}});
let browser;
try {
 let ready=false;
 for(let i=0;i<60;i++) {
  try {if((await fetch(origin+'/member/')).ok){ready=true;break;}}catch{}
  await new Promise(resolve=>setTimeout(resolve,500));
 }
 assert.ok(ready,'Isolated preview server did not start');
 browser=await chromium.launch({headless:true});
 const results=[];
 for(const [device,width,height] of [['desktop',1440,1000],['mobile',390,844]]) {
  const context=await browser.newContext({viewport:{width,height},permissions:['clipboard-read','clipboard-write']});
  const page=await context.newPage();const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/member/',{waitUntil:'networkidle'});
  await page.screenshot({path:path.join(output,`signin-${device}.png`),fullPage:true});
  await context.addCookies([{name:'engage_dev_user',value:'member',url:origin}]);
  await page.goto(origin+'/member/',{waitUntil:'networkidle'});
  await page.locator('#copy-engage-url').click();
  await page.locator('#copy-engage-status').filter({hasText:'Engage URL copied.'}).waitFor();
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),origin+'/member/');
  assert.ok(await page.locator('.lifecycle-card').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'Lifecycle card overflows viewport');
  await page.screenshot({path:path.join(output,`my-engage-${device}.png`),fullPage:true});
  await page.goto(origin+'/member/?view=notifications',{waitUntil:'networkidle'});
  await page.getByRole('heading',{name:'Engage digests',exact:true}).waitFor();
  await page.screenshot({path:path.join(output,`notifications-${device}.png`),fullPage:true});
  for(const status of ['approved','suspended']) {
   await page.goto(pathToFileURL(path.resolve(`docs/member-lifecycle/verification-${status}.html`)).href);
   assert.ok(await page.locator('body').evaluate(el=>el.scrollWidth<=innerWidth+1),'Email overflows viewport');
   await page.screenshot({path:path.join(output,`email-${status}-${device}.png`),fullPage:true});
  }
  assert.deepEqual(errors,[],'Uncaught browser errors');
  results.push({device,width,height,copyUrl:true,lifecycleOverflow:false,emailOverflow:false,uncaughtErrors:errors});
  await context.close();
 }
 await writeFile(path.join(output,'verification.json'),JSON.stringify({syntheticAccountsOnly:true,productionAccess:false,results},null,2)+'\n');
 console.log(JSON.stringify({screenshots:10,output,results}));
} finally {await browser?.close();server.kill('SIGTERM');}
