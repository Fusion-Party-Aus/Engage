// Run only against fresh isolated in-memory preview servers, never production.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const modulePath = process.env.ENGAGE_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error('Set ENGAGE_PLAYWRIGHT_MODULE to an isolated Playwright index.mjs.');
const { chromium } = await import(pathToFileURL(modulePath).href);
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
const out=path.resolve('docs/screenshots/proposal-experience');
const browser=await chromium.launch({...(process.env.CHROME_EXECUTABLE ? {executablePath:process.env.CHROME_EXECUTABLE} : {}),headless:true});
// Prepare exactly 23 eligible ballots through the same authorised API as administration.
for (const port of (process.env.AFTER_ONLY ? [4397] : [4396,4397])) {
 const origin = `http://127.0.0.1:${port}`;
 const headers = {'Cookie':'engage_dev_user=administrator','Content-Type':'application/json'};
 const {proposals} = await fetch(origin+'/api/proposals',{headers}).then(r=>r.json());
 for (const proposal of proposals.slice(0,23)) {
  const response = await fetch(origin+'/api/proposals/'+proposal.proposalId,{method:'PATCH',headers,body:JSON.stringify({stage:'decide'})});
  assert.ok(response.ok,await response.text());
 }
}
const results=[];
try {
for(const [version,port] of (process.env.AFTER_ONLY ? [['after',4397]] : [['before',4396],['after',4397]])) {
const origin=`http://127.0.0.1:${port}`;
for(const [device,width,height] of [['desktop',1440,1000],['mobile',390,844]]) {
const context=await browser.newContext({viewport:{width,height}});
await context.addCookies([{name:'engage_dev_user',value:'member',url:origin}]);
const page=await context.newPage();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
const go=async path=>{console.log(version,device,path);await page.goto(origin+path,{waitUntil:'networkidle'});await page.addStyleTag({content:'astro-dev-toolbar { display: none !important; }'});};
const shot=async name=>{console.log('screenshot',version,device,name);await page.screenshot({path:`${out}/${version}-${name}-${device}.png`,fullPage:false});assert.ok(await page.locator('body').evaluate(e=>e.scrollWidth<=innerWidth+1),'horizontal overflow');};
await go('/proposals/');await shot('all');
await go('/proposals/?stage=decide'+(version==='before'?'&focus=needs-vote':''));await shot('outstanding');
const link=await page.locator('.proposal-item h2 a, .proposal-item h3 a').first().getAttribute('href');assert.ok(link);
await go(link);if(version==='after') {
 await page.evaluate(()=>window.scrollTo(0,0));
 const rect=await page.locator('.decision-content').evaluate(e=>{const r=e.getBoundingClientRect();return {x:r.left+scrollX,y:r.top+scrollY,width:r.width,height:r.height,scale:1}});
 const cdp=await context.newCDPSession(page);
 const capture=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:rect});
 await writeFile(`${out}/${version}-decision-${device}.png`,Buffer.from(capture.data,'base64'));
 await cdp.detach();
} else {await page.locator('#outcomes-heading').scrollIntoViewIfNeeded();await shot('decision');}
await page.locator('#proposal-vote').evaluate(e=>window.scrollTo(0,e.getBoundingClientRect().top+scrollY-125));
await page.getByRole('group',{name:'Choose your vote'}).count().catch(()=>0);
await shot('ballot-before');
if(version==='after') {
 const next=page.getByRole('navigation',{name:'Ballot navigation'}).getByRole('link').first();
 const nextHref=await next.getAttribute('href');
 await next.click();assert.ok(page.url().includes(nextHref.split('#')[0]));
 const detail=await context.request.get(origin+'/api/proposals/'+link.split('/')[2]);
 assert.equal((await detail.json()).myVote,null,'skip must not vote');
 await go(link+'#proposal-vote');
}
await page.locator('astro-island[component-url*="ProposalBallot"]:not([ssr])').waitFor();
await page.getByRole('radio',{name:'Approve',exact:true}).click();
if(version==='after') {
 await page.route('**/api/votes',route=>route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:"Couldn't save vote. Try again."})}),{times:1});
 await page.getByRole('button',{name:'Record vote',exact:true}).click();
 await page.getByRole('alert').filter({hasText:"Couldn't save vote"}).waitFor();
 assert.equal(await page.getByRole('radio',{name:'Approve',exact:true}).getAttribute('aria-checked'),'true');
}
await page.getByRole('button',{name:'Record vote',exact:true}).click();
await page.getByText(version==='after'?'Vote saved: Approve':'Vote recorded (Approve).',{exact:true}).waitFor();
if(version==='after') {
 assert.match(await page.locator('.personal-vote-chip').innerText(), /Approve/);
 assert.match(await page.locator('.next-action-bar__title').innerText(), /Your vote: Approve/);
}
await page.locator('#proposal-vote').evaluate(e=>window.scrollTo(0,e.getBoundingClientRect().top+scrollY-125));await shot('ballot-after');
await go(link+'#proposal-vote');await shot('ballot-review');
await page.getByRole('radio',{name:'Reject',exact:true}).click();await page.getByRole('button',{name:'Update vote',exact:true}).click();
await page.getByText(version==='after'?'Vote saved: Reject':'Vote recorded (Reject).',{exact:true}).waitFor();
const saved=await context.request.get(origin+'/api/proposals/'+link.split('/')[2]);assert.equal((await saved.json()).myVote,'reject');
results.push({version,device,errors,voteSaved:true,voteUpdated:true});assert.deepEqual(errors,[]);
await context.close();
}
}
for(const [version,port] of (process.env.AFTER_ONLY ? [['after',4397]] : [['before',4396],['after',4397]])) {
 const origin=`http://127.0.0.1:${port}`;
 const context=await browser.newContext();
 await context.addCookies([{name:'engage_dev_user',value:'member',url:origin}]);
 const list=await context.request.get(origin+'/api/proposals?stage=decide').then(r=>r.json());
 for(const proposal of list.proposals.filter(p=>p.ballotRevisionId)) {
  const response=await context.request.post(origin+'/api/votes',{data:{proposalId:proposal.proposalId,choice:'approve',reason:''}});
  assert.ok(response.ok(),await response.text());
 }
 const page=await context.newPage();
 for(const [device,width,height] of [['desktop',1440,1000],['mobile',390,844]]) {
  await page.setViewportSize({width,height});
  await page.goto(origin+'/proposals/?stage=decide&focus=needs-vote',{waitUntil:'networkidle'});
  if(version==='after') await page.getByRole('heading',{name:"You're up to date",exact:true}).waitFor();
  await page.screenshot({path:`${out}/${version}-complete-${device}.png`});
 }
 if(version==='after') {
  await page.selectOption('#proposal-focus','all');await page.waitForURL('**focus=all**');
  assert.ok(await page.locator('.proposal-item').count()>0,'opt-out shows active ballots');
  await page.getByRole('link',{name:/^All\s/}).first().click();
  await page.getByRole('link',{name:/^Voting\s/}).first().click();
  assert.equal(new URL(page.url()).searchParams.get('focus'),'all','opt-out survives stage browsing');
  await page.goBack();await page.goForward();
  assert.equal(await page.locator('#proposal-focus').inputValue(),'all');
  await page.goto(origin+'/proposals/?stage=decide&focus=all&q=zzzzmissing',{waitUntil:'networkidle'});
  await page.getByRole('heading',{name:'No matching proposals'}).waitFor();
 }
 results.push({version,completion:true});await context.close();
}
await writeFile(`${out}/verification.json`,JSON.stringify(results,null,2)+'\n');
}finally{await browser.close();}
