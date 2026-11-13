import { Select } from 'radix-ui';
import { ChevronDown, Check } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { SENSE_TOPICS } from '../lib/sense-box-options';
export default function SenseBox({branches,initialBranch}: {branches:{branchId:string;name:string;label?:string;code?:string}[];initialBranch:string}) {
  const [busy,setBusy]=useState(false),[saved,setSaved]=useState(false),[error,setError]=useState('');
  const id=useRef('');
  const [branchId,setBranchId]=useState(initialBranch);
  const trigger=useRef<HTMLButtonElement>(null);
  const destination=branches.find(b=>b.branchId===branchId);
  async function submit(event:React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if(busy)return;
    if(!branchId){setError('Choose National, a state or territory.');trigger.current?.focus();return;}
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
      <div>
        <label id="sense-branch-label" htmlFor="sense-branch">State or territory</label>
        <Select.Root name="branchId" value={branchId} onValueChange={setBranchId} disabled={busy}>
          <Select.Trigger ref={trigger} id="sense-branch" aria-labelledby="sense-branch-label" aria-describedby="sense-destination" aria-required="true" className="flex h-10 w-full items-center justify-between gap-3 rounded-md border border-input bg-background px-3 text-base text-foreground shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
            <Select.Value placeholder="Choose National, a state or territory"/><Select.Icon><ChevronDown className="size-4"/></Select.Icon>
          </Select.Trigger>
          <Select.Portal><Select.Content position="popper" sideOffset={4} className="z-50 max-h-[min(24rem,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-input bg-background p-1 text-foreground shadow-md"><Select.Viewport>{branches.map(b=><Select.Item key={b.code || b.branchId} value={b.branchId} className="relative flex cursor-default select-none items-center rounded-sm py-2 pl-8 pr-3 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"><Select.ItemIndicator className="absolute left-2"><Check className="size-4"/></Select.ItemIndicator><Select.ItemText>{b.label || b.name.replace(/^Fusion /,'')}</Select.ItemText></Select.Item>)}</Select.Viewport></Select.Content></Select.Portal>
        </Select.Root>
        <p id="sense-destination" className="mt-2 text-sm text-muted-foreground">{destination?`Your concern will be shared with ${destination.name}.`:'Choose where your concern applies.'}</p>
      </div>
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
