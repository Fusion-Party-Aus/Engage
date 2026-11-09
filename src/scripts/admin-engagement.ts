/** Progressive admin controls. Never render provider/API payloads as HTML. */
export {};
function feedback(target:HTMLElement,text:string,state='info') {target.textContent=text;target.dataset.state=state;}
async function request(url:string,init:RequestInit={}) {
 const response=await fetch(url,{credentials:'same-origin',...init,signal:AbortSignal.timeout(15000)});
 let data:any;
 try {data=await response.json();} catch {throw Error(response.status===403 ? 'The server refused this request. Refresh Engage and sign in again. If it persists, ask the operator to check the public site URL and proxy configuration.' : 'The server returned an unexpected response. Refresh Engage and try again.');}
 if (!response.ok) throw Error(typeof data.error==='string' ? data.error : 'The request could not be completed. Try again shortly.');
 return data;
}
const el=(tag:string,text?:string)=>{const node=document.createElement(tag);if(text!==undefined) node.textContent=text;return node;};
const date=(value:string|null)=>value ? `${new Date(value).toLocaleString('en-AU',{timeZone:'Australia/Melbourne'})} Melbourne` : 'Not recorded';
const history=document.querySelector<HTMLElement>('#test-history');
const refresh=document.querySelector<HTMLButtonElement>('#refresh-test-history');
async function refreshHistory() {
 if(!history) return;
 if(refresh) refresh.disabled=true;
 history.setAttribute('aria-busy','true');
 try {
  const data=await request('/api/admin/email/test');
  if(!Array.isArray(data.messages)) throw Error('Delivery history could not be read. Refresh to try again.');
  const rows=data.messages.map((m:any)=>{
   const row=el('article');row.className='engagement-receipt';row.append(el('strong',m.status),el('time',date(m.createdAt)));
   const details=el('details'),list=el('dl');details.append(el('summary','Provider receipt'));
   for(const [label,value] of [['Message ID',m.providerId || 'Not accepted'],['Provider HTTP status',m.providerHttpStatus ?? 'Not recorded'],['Accepted',date(m.acceptedAt)],['Delivered',date(m.deliveredAt)]]) list.append(el('dt',String(label)),el('dd',String(value)));
   details.append(list);row.append(details);return row;
  });
  history.replaceChildren(...(rows.length ? rows : [el('p','No test emails recorded for your account.')]));
 } catch(error) {const message=el('p',error instanceof Error ? error.message : 'History unavailable. Try refreshing shortly.');message.setAttribute('role','alert');history.replaceChildren(message);}
 finally {history.removeAttribute('aria-busy');if(refresh) refresh.disabled=false;}
}
refresh?.addEventListener('click',refreshHistory);
const form=document.querySelector<HTMLFormElement>('#test-digest-form');
const button=document.querySelector<HTMLButtonElement>('#test-digest-button');
const status=document.querySelector<HTMLElement>('#test-digest-status');
form?.addEventListener('submit',async(event)=>{
 event.preventDefault();if(!button || !status || button.disabled) return;
 button.disabled=true;button.textContent='Sending…';form.setAttribute('aria-busy','true');feedback(status,'Sending your sample digest…');
 try {
  // JSON avoids Astro's form-origin comparison against the proxy's internal URL.
  // The endpoint independently checks the trusted configured public origin and admin session.
  const result=await request('/api/admin/email/test',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  if(result.status!=='accepted' || !result.providerId || !result.recipient) throw Error('Acceptance could not be confirmed. Inspect recent tests before trying again.');
  feedback(status,`Accepted by the email provider for ${result.recipient}. Inbox delivery is pending; use Refresh status to check the receipt.`,'success');
 } catch(error) {feedback(status,error instanceof Error && error.name!=='TimeoutError' && error.name!=='TypeError' ? error.message : 'The request was interrupted. Delivery may still have been accepted. Inspect recent tests before trying again.','error');}
 finally {button.disabled=false;button.textContent='Send test email to me';form.removeAttribute('aria-busy');await refreshHistory();}
});
const preview=document.querySelector<HTMLFormElement>('#reengagement-preview-form');
const previewStatus=document.querySelector<HTMLElement>('#reengagement-status');
const results=document.querySelector<HTMLElement>('#reengagement-results');
const reasons:Record<string,string>={eligible:'Eligible',suppressed:'Delivery suppressed','inactive-or-unconfirmed-email':'Inactive account or unconfirmed email','explicit-engage-opt-out':'Explicitly opted out','new-member-opt-in-required':'New member opt-in required','verified-after-cutoff':'Verified after cutoff','notification-sent-or-uncertain':'Already notified or delivery uncertain','already-participated':'Already voted','recently-active':'Recently active','review-verification-date':'Verification date needs review','review-legacy-cohort':'Historical cohort needs review','review-legacy-lawful-basis':'Historical consent basis needs review'};
preview?.addEventListener('submit',async(event)=>{
 event.preventDefault();if(!previewStatus || !results || !preview.reportValidity()) return;
 const submit=preview.querySelector<HTMLButtonElement>('button');if(submit?.disabled) return;
 if(submit) submit.disabled=true;preview.setAttribute('aria-busy','true');feedback(previewStatus,'Checking eligibility…');
 try {
  const cutoff=String(new FormData(preview).get('cutoff') || '');
  const data=await request(`/api/admin/email/reengagement?cutoff=${encodeURIComponent(cutoff)}`);
  if(data.dryRun!==true || typeof data.eligible!=='number') throw Error('The preview returned an unexpected result. Try again shortly.');
  const list=el('dl');list.className='engagement-metrics';
  for(const [label,value] of [['Eligible',data.eligible],['Excluded',data.excluded],['Suppressed',data.suppressed],['Needs review',data.needsReview],['Total reviewed',data.total]]) {const row=el('div');row.append(el('dt',String(label)),el('dd',String(value)));list.append(row);}
  const details=el('details'),breakdown=el('dl');breakdown.className='engagement-metrics';details.append(el('summary','Eligibility breakdown'));
  for(const [key,value] of Object.entries(data.reasons || {})){const row=el('div');row.append(el('dt',reasons[key] || 'Other eligibility review'),el('dd',String(value)));breakdown.append(row);}
  details.append(breakdown);results.replaceChildren(list,details);feedback(previewStatus,'Preview complete. No messages sent.','success');
 } catch(error) {results.replaceChildren();feedback(previewStatus,error instanceof Error ? error.message : 'Preview unavailable. Try again shortly.','error');}
 finally {if(submit) submit.disabled=false;preview.removeAttribute('aria-busy');}
});
