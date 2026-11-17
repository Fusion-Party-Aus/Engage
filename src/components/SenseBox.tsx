import { useRef, useState } from 'react';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { NativeSelect } from './ui/native-select';
import { Textarea } from './ui/textarea';
import { Turnstile } from './ui/turnstile';
import { SENSE_TOPICS } from '../lib/sense-box-options';

export default function SenseBox({ branches, initialBranch, turnstileSiteKey = '' }: { branches: { branchId: string; name: string; label?: string; code?: string }[]; initialBranch: string; turnstileSiteKey?: string }) {
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [receipt, setReceipt] = useState<{ submissionId: string; statusPath: string } | null>(null);
  const [error, setError] = useState('');
  const id = useRef('');
  const [branchId, setBranchId] = useState(initialBranch);
  const destination = branches.find((branch) => branch.branchId === branchId);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!branchId) {
      setError('Choose National, a state or territory.');
      document.getElementById('sense-branch')?.focus();
      return;
    }
    const data = Object.fromEntries(new FormData(event.currentTarget));
    id.current ||= crypto.randomUUID();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/sense-box', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, consent: data.consent === 'on', requestId: id.current }),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error);
      }
      setReceipt(result.receipt ?? null);
      setSaved(true);
    } catch (caught) {
      // Any failed or uncertain POST may have consumed the single-use Turnstile token.
      window.dispatchEvent(new Event('engage:turnstile-reset'));
      setError(caught instanceof Error ? caught.message : "Couldn't send your priority. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (saved) {
    return (
      <div role="status" className="space-y-4">
        <h2>Thank you for sharing</h2>
        <p>Your priority has been sent to the selected branch’s Sense Box. An organiser will review it.</p>
        <p>If it is published, it will appear with other community priorities and verified members can discuss it. We don’t collect contact details, so this status page is the only way to follow it.</p>        {receipt && (
          <div className="rounded-lg border p-4">
            <p className="mt-0"><strong>Keep this link to check what happens next.</strong></p>
            <p className="text-sm text-muted-foreground">Anyone with the link can see the status. It does not show your account or contact details.</p>
            <Button href={receipt.statusPath}>Check this priority’s status</Button>
            <p className="mb-0 mt-3 text-sm text-muted-foreground">Reference: <code>{receipt.submissionId}</code></p>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button href="/sense-box/#priorities" variant="outline">Read published priorities</Button>
          <Button href="/proposals/" variant="outline">Explore proposals</Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <fieldset disabled={busy} className="space-y-5">
        <div className="grid gap-2">
          <Label htmlFor="sense-branch">Where does this apply?</Label>
          <NativeSelect
            id="sense-branch"
            name="branchId"
            value={branchId}
            onChange={(event) => setBranchId(event.target.value)}
            disabled={busy}
            required
            aria-describedby="sense-destination"
          >
            <option value="">Choose National, a state or territory</option>
            {branches.map((branch) => (
              <option key={branch.code || branch.branchId} value={branch.branchId}>
                {branch.label || branch.name.replace(/^Fusion /, '')}
              </option>
            ))}
          </NativeSelect>
          <p id="sense-destination" className="text-sm text-muted-foreground">
            {destination ? `Your concern will be shared with ${destination.name}.` : 'Choose where your concern applies.'}
          </p>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="sense-title">What matters to you?</Label>
          <Input id="sense-title" name="title" required minLength={5} maxLength={120} placeholder="A short name for your priority" />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="sense-detail">Tell us a little more</Label>
          <p id="sense-help" className="text-sm text-muted-foreground">
            What’s happening, and what would you like to change? Please leave out personal or sensitive details about other people.
          </p>
          <Textarea id="sense-detail" name="detail" required minLength={10} maxLength={3000} rows={6} aria-describedby="sense-help" />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="sense-topic">Topic</Label>
          <NativeSelect id="sense-topic" name="topic" defaultValue="other">
            {Object.entries(SENSE_TOPICS).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </NativeSelect>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="sense-locality">Suburb or town <span className="text-muted-foreground">(optional)</span></Label>
          <Input id="sense-locality" name="locality" maxLength={100} autoComplete="address-level2" />
        </div>

        <div hidden>
          <Label htmlFor="sense-website">Website</Label>
          <Input id="sense-website" name="website" tabIndex={-1} autoComplete="off" />
        </div>

        <label className="flex items-start gap-3">
          <Checkbox name="consent" required className="mt-1 size-5 shrink-0" />
          <span className="text-sm">
            I agree to Fusion reviewing my input and, if it is published, showing my priority and its discussion publicly. My name and contact details are not collected. <a href="/privacy/">Privacy policy</a>
          </span>
        </label>

        <Turnstile siteKey={turnstileSiteKey} action="sense-box" />

        <Button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Share my priority'}</Button>
      </fieldset>
      {error && <p role="alert" className="text-destructive">{error} Your input is still here.</p>}
    </form>
  );
}
