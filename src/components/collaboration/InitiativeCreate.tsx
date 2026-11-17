import { useState } from 'react';
import { Alert, AlertDescription } from '../ui/alert';
import { Button } from '../ui/button';
import { Field } from '../ui/field';
import { Input } from '../ui/input';
import { NativeSelect } from '../ui/native-select';
import { Textarea } from '../ui/textarea';

interface Props {
  defaultCorrectionEmail: string;
}

/**
 * Create an invitation as a draft. Opening it is a separate, deliberate save on
 * the invitation page.
 */
export default function InitiativeCreate({ defaultCorrectionEmail }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    setBusy(true);
    setError('');
    try {
      const body = Object.fromEntries(new FormData(form));
      const response = await fetch('/api/admin/collaboration/initiative', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Couldn’t create the invitation. Try again.');
      window.location.assign(`/admin/collaboration/invitation/${result.initiative.slug}/`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Couldn’t create the invitation. Try again.');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-5">
      <Field
        label="What does it collect?"
        htmlFor="new-profile"
        hint="A story invitation accepts photographs, credit and edit permissions. Written responses never do."
      >
        <NativeSelect id="new-profile" name="profile" defaultValue="story">
          <option value="story">Story with photographs</option>
          <option value="consultation">Written responses</option>
        </NativeSelect>
      </Field>
      <Field label="Invitation title" htmlFor="new-title" hint="Also becomes the public web address.">
        <Input id="new-title" name="title" required minLength={3} maxLength={120} />
      </Field>
      <Field label="Summary" htmlFor="new-summary" hint="One or two sentences under the title.">
        <Textarea id="new-summary" name="summary" required minLength={10} maxLength={600} rows={3} />
      </Field>
      <Field label="Why we are asking" htmlFor="new-purpose" hint="Above the form: what the material is for and how it may be used.">
        <Textarea id="new-purpose" name="purpose" required minLength={10} maxLength={1200} rows={4} />
      </Field>
      <Field label="First question" htmlFor="new-question" hint="You can add more, and edit this, before opening.">
        <Input id="new-question" name="question" required minLength={3} maxLength={160} />
      </Field>
      <Field label="Question hint" htmlFor="new-hint" hint="Optional. Shown under the question.">
        <Input id="new-hint" name="hint" maxLength={200} />
      </Field>
      <Field label="Corrections and removals" htmlFor="new-email" hint="Where contributors write to correct or remove their contribution.">
        <Input id="new-email" name="correctionEmail" type="email" required maxLength={254} defaultValue={defaultCorrectionEmail} />
      </Field>

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create draft'}</Button>
        <Button href="/admin/collaboration/invitation/" variant="outline">Cancel</Button>
      </div>
    </form>
  );
}
