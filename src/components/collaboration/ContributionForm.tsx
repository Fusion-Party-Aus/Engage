import { useEffect, useRef, useState } from 'react';
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
  type ContributionProfile,
  type ContributionQuestion,
} from '../../lib/collaboration-options';

interface Props {
  initiativeSlug: string;
  questions: readonly ContributionQuestion[];
  profile: ContributionProfile;
  turnstileSiteKey?: string;
}

/**
 * Guest contribution form. No account is required and no input is lost when a
 * submission fails: the fields stay mounted, only the error is added.
 */
export default function ContributionForm({
  initiativeSlug,
  questions,
  profile,
  turnstileSiteKey = '',
}: Props) {
  const story = profile === 'story';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<null | { shareable: boolean; reference: string; manageToken: string }>(null);
  const [attribution, setAttribution] = useState<Attribution>('named');
  const [contact, setContact] = useState(false);
  const [aiEdits, setAiEdits] = useState(false);
  const [previews, setPreviews] = useState<Array<{ name: string; url: string }>>([]);
  const requestId = useRef('');
  const started = useRef(false);

  /** Aggregate only: no identity, no content, no cookie. */
  function report(stage: 'start' | 'account_intent') {
    fetch('/api/collaboration/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initiativeSlug, stage }),
      keepalive: true,
    }).catch(() => {});
  }

  function noteStart() {
    if (started.current) return;
    started.current = true;
    report('start');
  }

  // Object URLs are revoked when the selection changes or the form unmounts.
  useEffect(() => () => previews.forEach((preview) => URL.revokeObjectURL(preview.url)), [previews]);

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
      setSaved({
        shareable: result.shareable === true,
        reference: String(result.reference ?? ''),
        manageToken: String(result.manageToken ?? ''),
      });
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
          You don’t need an account. If you ask us to correct or remove this, quote reference{' '}
          <strong className="font-mono text-foreground">{saved.reference.slice(0, 8)}</strong>.
        </p>
        {saved.manageToken && (
          <div className="grid gap-2 rounded-md border p-4">
            <p className="m-0 font-semibold">Keep this private link</p>
            <p className="m-0 text-sm text-muted-foreground">
              It is the only way to correct or remove your contribution without emailing us. Anyone with the link
              can manage it, so don’t share it.
            </p>
            <div>
              <Button href={`/collaborate/manage/#${saved.manageToken}`} variant="outline">
                Manage or withdraw
              </Button>
            </div>
          </div>
        )}
        <div className="grid gap-2">
          <p className="m-0 font-semibold">You’ve already contributed. Want to see what else you can shape?</p>
          <p className="m-0 text-sm text-muted-foreground">
            Engage is where people discuss ideas, improve proposals and decide together. An account is free and
            separate from joining Fusion.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button href="/proposals/">Explore Engage</Button>
          <Button href="/member/" variant="outline" onClick={() => report('account_intent')}>
            Create an account
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-8" onFocusCapture={noteStart}>
      <FieldSet>
        <FieldLegend>{story ? 'Your story' : 'Your response'}</FieldLegend>
        <FieldDescription>
          {story
            ? 'Answer as many as you like. A few honest sentences, a photo, or both is plenty.'
            : 'Answer as many as you like. A few sentences is plenty.'}
        </FieldDescription>
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
          {story && (
          <Field
            label="Add photos"
            htmlFor="photos"
            hint={
              <>
                Optional. Up to {MEDIA_LIMITS.files} JPEG or PNG photos, {MEDIA_LIMITS.fileBytes / (1024 * 1024)} MB each.
                <span className="block">
                  If other people are recognisable, ask them first. Photographs must not show identifiable children.
                </span>
              </>
            }
          >
            <Input
              id="photos"
              name="photos"
              type="file"
              multiple
              accept="image/jpeg,image/png"
              onChange={(event) =>
                setPreviews(
                  Array.from(event.currentTarget.files ?? []).map((file) => ({
                    name: file.name,
                    url: URL.createObjectURL(file),
                  })),
                )
              }
              aria-describedby="photos-help"
            />
          </Field>
          )}
          {previews.length > 0 && (
            <ul className="m-0 flex list-none flex-wrap gap-3 p-0">
              {previews.map((preview) => (
                <li key={preview.url} className="grid gap-1">
                  <img
                    src={preview.url}
                    alt={`Preview of ${preview.name}`}
                    className="size-28 rounded-md border object-cover"
                  />
                  <span className="max-w-28 truncate text-xs text-muted-foreground">{preview.name}</span>
                </li>
              ))}
            </ul>
          )}
          {story && previews.length > 0 && (
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
            <FieldLabel>{story ? 'May we publish this?' : 'May we publish your response?'}</FieldLabel>
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

          {story && (
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
            <FieldDescription>
              A photo can still identify you even when we don’t print your name. We only publish a photo you
              allow.
            </FieldDescription>
            <input type="hidden" name="attribution" value={attribution} readOnly />
          </Field>
          )}

          {story && attribution === 'named' && (
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

          {story && (
          <>
          <label className="flex items-start gap-3 text-sm">
            <Checkbox name="allowEdits" className="mt-0.5 size-5" />
            <span>
              You may crop, resize and adjust colour.
              <span className="block text-muted-foreground">Ordinary presentation edits. We won’t change what the photo shows.</span>
            </span>
          </label>

          <label className="flex items-start gap-3 text-sm">
            <Checkbox
              name="allowAiEdits"
              className="mt-0.5 size-5"
              checked={aiEdits}
              disabled={!contact}
              onChange={(event) => setAiEdits(event.currentTarget.checked)}
            />
            <span>
              You may use AI-assisted edits on my photos.
              <span className="block text-muted-foreground">
                Optional, off by default. For example adding Fusion branding. We show you the result before it
                is used, so this needs a reply address.
              </span>
            </span>
          </label>
          </>
          )}
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
              onChange={(event) => {
                setContact(event.currentTarget.checked);
                if (!event.currentTarget.checked) setAiEdits(false);
              }}
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
          <Checkbox name="adultAttested" required className="mt-0.5 size-5" />
          <span>I’m 18 or over.</span>
        </label>
        <label className="flex items-start gap-3 text-sm">
          <Checkbox name="consent" required className="mt-0.5 size-5" />
          <span>
            {story
              ? 'This is my own story and my own photos, I have the right to share them, and I have permission from anyone who can be recognised in a photo.'
              : 'This is my own response and I have the right to share it.'}{' '}
            I’ve read the <a href="/privacy/">privacy policy</a>.
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
            {busy ? 'Sending…' : story ? 'Send my story' : 'Send my response'}
          </Button>
        </div>
      </div>
    </form>
  );
}
