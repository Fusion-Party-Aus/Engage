import { useState } from 'react';
import { Alert, AlertDescription } from '../ui/alert';
import { Button } from '../ui/button';
import { Field } from '../ui/field';
import { Input } from '../ui/input';
import { NativeSelect } from '../ui/native-select';
import { Textarea } from '../ui/textarea';
import {
  CONTRIBUTION_PROFILES,
  INITIATIVE_STATUSES,
  MAX_INITIATIVE_QUESTIONS,
  type ContributionQuestion,
  type InitiativeStatus,
} from '../../lib/collaboration-options';

interface Props {
  slug: string;
  title: string;
  summary: string;
  purpose: string;
  status: InitiativeStatus;
  correctionEmail: string;
  questions: readonly ContributionQuestion[];
  profile: 'story' | 'consultation';
}

/**
 * Editorial control of the invitation: wording, questions and open state.
 * Consent options and upload limits are not here because they are enforced
 * rules, not copy.
 */
export default function InitiativeEditor(props: Props) {
  const [title, setTitle] = useState(props.title);
  const [summary, setSummary] = useState(props.summary);
  const [purpose, setPurpose] = useState(props.purpose);
  const [status, setStatus] = useState(props.status);
  const [correctionEmail, setCorrectionEmail] = useState(props.correctionEmail);
  const [questions, setQuestions] = useState(() => props.questions.map((question) => ({ ...question })));
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');

  function update(index: number, field: 'label' | 'hint', value: string) {
    setQuestions((current) => current.map((question, position) => (position === index ? { ...question, [field]: value } : question)));
  }

  async function save() {
    if (busy) return;
    setBusy(true);
    setError('');
    setFeedback('');
    try {
      const response = await fetch('/api/admin/collaboration/initiative', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: props.slug, title, summary, purpose, status, correctionEmail, questions }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Couldn’t save the invitation. Try again.');
      const saved = result.initiative;
      if (saved?.questions) {
        // Use the server's keys: a new question is assigned a stable key so the
        // next save cannot detach answers that arrive in between.
        setQuestions(saved.questions.map((question: ContributionQuestion) => ({ ...question })));
        setTitle(saved.title);
        setSummary(saved.summary);
        setPurpose(saved.purpose);
        setStatus(saved.status);
        setCorrectionEmail(saved.correctionEmail);
      }
      setFeedback('Invitation saved. The public page uses it immediately.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Couldn’t save the invitation. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-5">
      <p className="m-0 text-sm text-muted-foreground">
        Collects: {CONTRIBUTION_PROFILES[props.profile]}. This is fixed when the invitation is created so
        contributors always answer the same kind of request.
      </p>
      <Field label="Title" htmlFor="invitation-title">
        <Input id="invitation-title" value={title} maxLength={120} onChange={(event) => setTitle(event.currentTarget.value)} />
      </Field>
      <Field label="Summary" htmlFor="invitation-summary" hint="One or two sentences. Shown under the title.">
        <Textarea id="invitation-summary" rows={3} value={summary} maxLength={600} onChange={(event) => setSummary(event.currentTarget.value)} />
      </Field>
      <Field label="Why we are asking" htmlFor="invitation-purpose" hint="Shown above the form. Explain what the material is for.">
        <Textarea id="invitation-purpose" rows={4} value={purpose} maxLength={1200} onChange={(event) => setPurpose(event.currentTarget.value)} />
      </Field>
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          label="State"
          htmlFor="invitation-status"
          hint="Draft and archived are private. Open accepts contributions. Paused and closed show the page with a closing notice."
        >
          <NativeSelect id="invitation-status" value={status} onChange={(event) => setStatus(event.currentTarget.value as InitiativeStatus)}>
            {Object.entries(INITIATIVE_STATUSES).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Corrections and removals" htmlFor="invitation-email" hint="Where contributors write to correct or remove their contribution.">
          <Input id="invitation-email" type="email" value={correctionEmail} maxLength={254} onChange={(event) => setCorrectionEmail(event.currentTarget.value)} />
        </Field>
      </div>

      <div className="grid gap-4">
        <p className="m-0 text-sm font-semibold">Questions</p>
        {questions.map((question, index) => (
          <div key={question.key} className="grid gap-3 rounded-md border p-3">
            <Field label={`Question ${index + 1}`} htmlFor={`question-${question.key}`}>
              <Input
                id={`question-${question.key}`}
                value={question.label}
                maxLength={160}
                onChange={(event) => update(index, 'label', event.currentTarget.value)}
              />
            </Field>
            <Field label="Hint" htmlFor={`hint-${question.key}`} hint="Optional. Leave blank for none.">
              <Input
                id={`hint-${question.key}`}
                value={question.hint ?? ''}
                maxLength={200}
                onChange={(event) => update(index, 'hint', event.currentTarget.value)}
              />
            </Field>
            <div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={questions.length === 1}
                onClick={() => setQuestions((current) => current.filter((_, position) => position !== index))}
              >
                Remove question
              </Button>
            </div>
          </div>
        ))}
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={questions.length >= MAX_INITIATIVE_QUESTIONS}
            onClick={() => setQuestions((current) => [...current, { key: `new-${current.length}`, label: '', hint: '' }])}
          >
            Add question
          </Button>
        </div>
      </div>

      {status === 'archived' && (
        <p className="m-0 text-sm text-muted-foreground">
          Archiving hides the page from the public and stops contributions. Existing contributions and their decisions are kept.
        </p>
      )}
      {feedback && <p role="status" className="m-0 text-sm text-muted-foreground">{feedback}</p>}
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save invitation'}</Button>
        {status !== 'draft' && status !== 'archived' && (
          <Button href={`/collaborate/${props.slug}/`} variant="outline">View public page</Button>
        )}
      </div>
    </div>
  );
}
