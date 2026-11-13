import { useRef, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { SENSE_TOPICS } from '../lib/sense-box-options';
export default function SenseBox({branches,initialBranch}: {branches:{branchId:string;name:string}[];initialBranch:string}) {
  const [busy,setBusy]=useState(false),[saved,setSaved]=useState(false),[error,setError]=useState('');
  const id=useRef('');
  async function submit(event:React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if(busy)return;
    const data=Object.fromEntries(new FormData(event.currentTarget));
    id.current ||= crypto.randomUUID(); setBusy(true);setError('');
    try {
      const response=await fetch('/api/sense-box',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...data,consent:data.consent==='on',requestId:id.current})});
      const result=await response.json(); if(!response.ok)throw new Error(result.error);
      setSaved(true);
    }catch(e){setError(e instanceof Error?e.message:"Couldn't send your priority. Try again.");}finally{setBusy(false);}
  }
  if(saved)return <div role="status" className="space-y-4"><h2>Thank you for sharing</h2><p>Your priority is in your branch’s Sense Box. Organisers can use it to identify shared concerns and explore future proposals.</p><p>We don’t collect contact details here, so you won’t receive a personal reply.</p><Button href="/proposals/">Explore Engage proposals</Button></div>;
  return <form onSubmit={submit} className="space-y-5">
    <fieldset disabled={busy} className="space-y-5">
      <div><label htmlFor="sense-branch">State or territory</label><select id="sense-branch" name="branchId" required defaultValue={initialBranch} className="block w-full rounded-md border border-input bg-background p-3"><option value="">Choose your state or territory</option>{branches.map(b=><option key={b.branchId} value={b.branchId}>{b.name}</option>)}</select></div>
      <div><label htmlFor="sense-title">What matters to you?</label><Input id="sense-title" name="title" required minLength={5} maxLength={120} placeholder="A short name for your priority" /></div>
      <div><label htmlFor="sense-detail">Tell us a little more</label><p id="sense-help" className="text-sm text-muted-foreground mb-2">What’s happening, and what would you like to change? Please leave out personal or sensitive details about other people.</p><Textarea id="sense-detail" name="detail" required minLength={10} maxLength={3000} rows={6} aria-describedby="sense-help" /></div>
      <div><label htmlFor="sense-topic">Topic</label><select id="sense-topic" name="topic" defaultValue="other" className="block w-full rounded-md border border-input bg-background p-3">{Object.entries(SENSE_TOPICS).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></div>
      <div><label htmlFor="sense-locality">Suburb or town <span className="text-muted-foreground">(optional)</span></label><Input id="sense-locality" name="locality" maxLength={100} autoComplete="address-level2" /></div>
      <div hidden><label htmlFor="sense-website">Website</label><input id="sense-website" name="website" tabIndex={-1} autoComplete="off" /></div>
      <label className="flex gap-3 items-start"><input type="checkbox" name="consent" required className="mt-1 size-5 shrink-0" /><span className="text-sm">I agree to Fusion using my input to understand community priorities and develop ideas. It will be visible to authorised organisers for my branch and national administrators. Summaries may inform public proposals. <a href="/privacy/">Privacy policy</a></span></label>
      <Button type="submit" disabled={busy}>{busy?'Sending…':'Share my priority'}</Button>
    </fieldset>
    {error&&<p role="alert" className="text-destructive">{error} Your input is still here.</p>}
  </form>;
}
