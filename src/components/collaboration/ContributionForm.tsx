import { useRef, useState } from 'react';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '../ui/field';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group';
import { Turnstile } from '../ui/turnstile';
import { Alert, AlertDescription } from '../ui/alert';
import {
  ATTRIBUTION_OPTIONS,
  CONTRIBUTION_LIMITS,
  MEDIA_LIMITS,
  PUBLICATION_CHANNELS,
  type Attribution,
  type ContributionQuestion,
} from '../../lib/collaboration-options';

interface Props {
  initiativeSlug: string;
  questions: readonly ContributionQuestion[];
  turnstileSiteKey?: string;
}

/**
 * Guest contribution form. No account is required and no input is lost when a
 * submission fails: the fields stay mounted, only the error is added.
 */
export default function ContributionForm({ initiativeSlug, questions, turnstileSiteKey = '' }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<null | { shareable: boolean }>(null);
  const [attribution, setAttribution] = useState<Attribution>('named');
  const [contact, setContact] = useState(false);
  const [fileCount, setFileCount] = useState(0);
  const requestId = useRef('');

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    requestId.current ||= crypto.randomUUID();
    const data = new FormData(form);
    data.set('initiativeSlug', initiativeSlug);
    data.set('requestId', requestId.current);
    data.set('attribution', attribution);
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/collaboration/contributions', {
        method: 'POST',
        body: data,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Couldn’t send your contribution. Try again.');
      setSaved({ shareable: result.shareable === true });
    } catch (caught) {
      // A failed POST may have spent the single-use Turnstile token.
      window.dispatchEvent(new Event('engage:turnstile-reset'));
      setError(caught instanceof Error ? caught.message : 'Couldn’t send your contribution. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (saved) {
    return (
      <div role="status" className="grid gap-4">
        <h2 className="m-0">Thank you</h2>
        {saved.shareable ? (
          <p className="m-0">
            Your story is with our team. Someone will read it before anything appears publicly. If you
            asked for a reply, we’ll be in touch.
          </p>
        ) : (
          <p className="m-0">
            Your contribution is with our team and will stay private, as you asked. We won’t publish it.
          </p>
        )}
        <p className="m-0 text-sm text-muted-foreground">
          You don’t need an account to contribute. If you’d like one later, it’s separate from party
          membership.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button href="/proposals/">See what members are deciding</Button>
          <Button href="/how-it-works/" variant="outline">How Engage works</Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-8">
      <FieldSet>
        <FieldLegend>Your story</FieldLegend>
        <FieldDescription>Answer as many as you like. A few honest sentences, a photo, or both is plenty.</FieldDescription>
        <FieldGroup>
          {questions.map((question, index) => (
            <Field
              key={question.key}
              label={question.label}
              htmlFor={`answer-${question.key}`}
              hint={question.hint}
            >
              <Textarea
                id={`answer-${question.key}`}
                name={`answer.${question.key}`}
                rows={index === 0 ? 4 : 3}
                maxLength={CONTRIBUTION_LIMITS.answer}
              />
            </Field>
          ))}
          <Field
            label="Add photos"
            htmlFor="photos"
            hint={`Optional. Up to ${MEDIA_LIMITS.files} JPEG or PNG photos, ${MEDIA_LIMITS.fileBytes / (1024 * 1024)} MB each.`}
          >
            <Input
              id="photos"
              name="photos"
              type="file"
              multiple
              accept="image/jpeg,image/png"
              onChange={(event) => setFileCount(event.currentTarget.files?.length ?? 0)}
              aria-describedby="photos-help"
            />
          </Field>
          {fileCount > 0 && (
            <Field label="Photo caption" htmlFor="caption" hint="Optional. Who, where, when. Skip anything you’d rather not share.">
              <Input id="caption" name="caption" maxLength={MEDIA_LIMITS.caption} />
            </Field>
          )}
        </FieldGroup>
      </FieldSet>

      <FieldSet>
        <FieldLegend>How we may use it</FieldLegend>
        <FieldGroup>
          <Field>
            <FieldLabel>May we publish this?</FieldLabel>
            <FieldDescription>
              Tick every place it could appear. Leave all unticked to keep it private; we can still
              learn from it.
            </FieldDescription>
            <div className="grid gap-3">
              {Object.entries(PUBLICATION_CHANNELS).map(([key, label]) => (
                <label key={key} className="flex items-start gap-3 text-sm">
                  <Checkbox name="channels" value={key} className="mt-0.5 size-5" />
                  <span>{label}</span>
                </label>
              ))}
            </div>
            <FieldDescription>Nothing is published unless you tick a channel and our team approves it.</FieldDescription>
          </Field>

          <Field>
            <FieldLabel id="attribution-label">How should we credit you?</FieldLabel>
            <ToggleGroup
              type="single"
              variant="outline"
              value={attribution}
              onValueChange={(value) => value && setAttribution(value as Attribution)}
              aria-labelledby="attribution-label"
            >
              {Object.entries(ATTRIBUTION_OPTIONS).map(([key, label]) => (
                <ToggleGroupItem key={key} value={key}>
                  {label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <input type="hidden" name="attribution" value={attribution} readOnly />
          </Field>

          {attribution === 'named' && (
            <Field label="Your name" htmlFor="display-name" hint="Only used where the contribution appears.">
              <Input
                id="display-name"
                name="displayName"
                autoComplete="name"
                maxLength={CONTRIBUTION_LIMITS.displayName}
                required
              />
            </Field>
          )}

          <label className="flex items-start gap-3 text-sm">
            <Checkbox name="allowEdits" className="mt-0.5 size-5" />
            <span>
              You may crop, resize and adjust colour.
              <span className="block text-muted-foreground">Ordinary presentation edits. We won’t change what the photo shows.</span>
            </span>
          </label>

          <label className="flex items-start gap-3 text-sm">
            <Checkbox name="allowAiEdits" className="mt-0.5 size-5" />
            <span>
              You may use AI-assisted edits on my photos.
              <span className="block text-muted-foreground">
                Optional, off by default. For example adding Fusion branding. We’ll show you the result before
                it is used.
              </span>
            </span>
          </label>
        </FieldGroup>
      </FieldSet>

      <FieldSet>
        <FieldLegend>Can we reply?</FieldLegend>
        <FieldGroup>
          <label className="flex items-start gap-3 text-sm">
            <Checkbox
              name="contactAllowed"
              className="mt-0.5 size-5"
              checked={contact}
              onChange={(event) => setContact(event.currentTarget.checked)}
            />
            <span>
              Yes, contact me about this contribution.
              <span className="block text-muted-foreground">Only about this contribution. Not a mailing list.</span>
            </span>
          </label>
          {contact && (
            <Field label="Email" htmlFor="email" hint="Kept private. Never shown with your story.">
              <Input id="email" name="email" type="email" autoComplete="email" maxLength={CONTRIBUTION_LIMITS.email} required />
            </Field>
          )}
        </FieldGroup>
      </FieldSet>

      <div className="grid gap-4 border-t pt-6">
        <div hidden>
          <label htmlFor="collaboration-website">Website</label>
          <Input id="collaboration-website" name="website" tabIndex={-1} autoComplete="off" />
        </div>
        <label className="flex items-start gap-3 text-sm">
          <Checkbox name="consent" required className="mt-0.5 size-5" />
          <span>
            This is my own story and my own photos, and I have the right to share them. I’ve read the{' '}
            <a href="/privacy/">privacy policy</a>.
          </span>
        </label>
        <Turnstile siteKey={turnstileSiteKey} action="collaborate" />
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error} Everything you wrote is still here.</AlertDescription>
          </Alert>
        )}
        <div>
          <Button type="submit" size="lg" disabled={busy}>
            {busy ? 'Sending…' : 'Send my story'}
          </Button>
        </div>
      </div>
    </form>
  );
}
