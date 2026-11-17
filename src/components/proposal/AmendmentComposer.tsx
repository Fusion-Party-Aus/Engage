import { useMemo, useState } from 'react';
import {
  diffWords,
  paragraphs,
  wordingBlocks,
  type AmendmentSuggestion,
  type SuggestionMode,
  type WordingField,
  type WordingSnapshot,
} from '../../lib/amendment-suggestions';
import { trackEngage } from '../../lib/analytics';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Field } from '../ui/field';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';

interface Draft {
  mode: SuggestionMode;
  field: WordingField;
  index: number;
  original: string;
  proposed: string;
  comment: string;
}

interface AmendmentComposerProps {
  proposalId: string;
  baseRevisionId: string;
  snapshot: WordingSnapshot;
}

function draftFromSuggestion(suggestion: AmendmentSuggestion): Draft {
  return {
    mode: suggestion.mode,
    field: suggestion.field,
    index: suggestion.index,
    original: suggestion.original,
    proposed: suggestion.proposed,
    comment: suggestion.comment ?? '',
  };
}

function fieldLabel(field: WordingField) {
  return field === 'title' ? 'Title' : field === 'summary' ? 'Summary' : field === 'outcomes' ? 'Key commitments' : 'Rationale';
}

function blockLabel(field: WordingField, index: number) {
  if (field === 'title') return 'Title';
  if (field === 'outcomes') return `Commitment ${index + 1}`;
  return `${field === 'summary' ? 'Summary' : 'Rationale'} · paragraph ${index + 1}`;
}

export default function AmendmentComposer({ proposalId, baseRevisionId, snapshot }: AmendmentComposerProps) {
  const [suggestions, setSuggestions] = useState<AmendmentSuggestion[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const blocks = useMemo(() => wordingBlocks(snapshot), [snapshot]);

  const startReplace = (field: WordingField, index: number, value: string) =>
    setDraft({ mode: 'replace', field, index, original: value, proposed: value, comment: '' });
  const startAdd = (field: WordingField) => {
    const additions = suggestions.filter((suggestion) => suggestion.field === field && suggestion.mode === 'add').length;
    const length = field === 'outcomes'
      ? snapshot.outcomes.length
      : field === 'title'
        ? 1
        : paragraphs(snapshot[field]).length;
    setDraft({ mode: 'add', field, index: length + additions, original: '', proposed: '', comment: '' });
  };
  const startRemove = (field: WordingField, index: number, value: string) =>
    setDraft({ mode: 'remove', field, index, original: value, proposed: '', comment: '' });

  function saveDraft() {
    if (!draft) return;
    const proposed = draft.proposed.trim();
    if (draft.mode !== 'remove' && proposed.length < 2) {
      setError('Write the replacement wording before saving.');
      return;
    }
    if (draft.mode === 'replace' && proposed === draft.original) {
      setError('The replacement is the same as the current wording.');
      return;
    }
    const comment = draft.comment.trim();
    const existing = suggestions.find((suggestion) => suggestion.field === draft.field && suggestion.index === draft.index);
    const next: AmendmentSuggestion = {
      suggestionId: existing?.suggestionId ?? `local-${draft.field}-${draft.index}-${Date.now()}`,
      field: draft.field,
      index: draft.index,
      original: draft.original,
      proposed: draft.mode === 'remove' ? '' : proposed,
      ...(comment ? { comment } : {}),
      mode: draft.mode,
    };
    setSuggestions((current) => [
      ...current.filter((suggestion) => !(suggestion.field === draft.field && suggestion.index === draft.index)),
      next,
    ].sort((a, b) => a.field.localeCompare(b.field) || a.index - b.index));
    setDraft(null);
    setError('');
    setStatus('Suggestion added. Review the preview, then submit the amendment.');
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!suggestions.length) {
      setError('Add at least one suggested change.');
      return;
    }
    setBusy(true);
    setError('');
    setStatus('Submitting amendment…');
    trackEngage('contribution_attempted', { action: 'amendment' });
    try {
      const response = await fetch('/api/amendments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proposalId,
          baseRevisionId,
          suggestions: suggestions.map(({ field, index, original, proposed, comment }) => ({
            field,
            index,
            original,
            proposed,
            ...(comment ? { comment } : {}),
          })),
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Could not submit the amendment.');
      trackEngage('contribution_result', { action: 'amendment', outcome: 'success' });
      setStatus('Amendment submitted. Reloading…');
      location.reload();
    } catch (caught) {
      trackEngage('contribution_result', { action: 'amendment', outcome: 'failed' });
      setError(caught instanceof Error ? caught.message : 'Could not submit the amendment.');
      setStatus('');
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Suggest changes block by block. Quote the wording you are changing, then write the replacement. This creates a formal amendment; general feedback belongs in Discussion.
      </p>

      <div className="space-y-3">
        {blocks.map((block) => {
          const suggestion = suggestions.find((item) => item.field === block.field && item.index === block.index);
          const editing = draft && draft.field === block.field && draft.index === block.index && draft.mode !== 'add';
          return (
            <div key={block.blockId} className="rounded-lg border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="m-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{block.label}</p>
                  <p className="mt-1 mb-0 whitespace-pre-wrap break-words text-sm">{block.value}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {suggestion ? (
                    <>
                      <Badge variant="info">Suggestion added</Badge>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(draftFromSuggestion(suggestion))}>Edit</Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setSuggestions((current) => current.filter((item) => item !== suggestion))}>Remove</Button>
                    </>
                  ) : (
                    <>
                      <Button type="button" size="sm" variant="outline" onClick={() => startReplace(block.field, block.index, block.value)}>Suggest change</Button>
                      {block.field !== 'title' && (
                        <Button type="button" size="sm" variant="ghost" onClick={() => startRemove(block.field, block.index, block.value)}>Remove</Button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {editing && draft && (
                <div className="mt-3 space-y-3 border-t pt-3">
                  {draft.mode === 'remove' ? (
                    <p className="m-0 text-sm">Remove this block: <del>{draft.original}</del></p>
                  ) : (
                    <Field label="Replacement wording" htmlFor={`suggestion-${block.blockId}`}>
                      <Textarea
                        id={`suggestion-${block.blockId}`}
                        rows={4}
                        value={draft.proposed}
                        onChange={(event) => setDraft({ ...draft, proposed: event.target.value })}
                      />
                    </Field>
                  )}
                  <Field label="Why this change? (optional)" htmlFor={`suggestion-note-${block.blockId}`}>
                    <Input
                      id={`suggestion-note-${block.blockId}`}
                      value={draft.comment}
                      maxLength={500}
                      onChange={(event) => setDraft({ ...draft, comment: event.target.value })}
                      placeholder="A short reason helps reviewers and other members"
                    />
                  </Field>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" onClick={saveDraft}>Save suggestion</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => startAdd('outcomes')}>Add commitment</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => startAdd('details')}>Add rationale paragraph</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => startAdd('summary')}>Add summary paragraph</Button>
      </div>

      {draft?.mode === 'add' && (
        <div className="space-y-3 rounded-lg border border-dashed p-3">
          <p className="m-0 text-sm font-semibold">New {fieldLabel(draft.field).toLowerCase()}</p>
          <Field label="Wording" htmlFor="suggestion-add">
            <Textarea
              id="suggestion-add"
              rows={3}
              value={draft.proposed}
              onChange={(event) => setDraft({ ...draft, proposed: event.target.value })}
              placeholder={draft.field === 'outcomes' ? 'A new commitment' : 'A new paragraph'}
            />
          </Field>
          <Field label="Why this addition? (optional)" htmlFor="suggestion-add-note">
            <Input
              id="suggestion-add-note"
              value={draft.comment}
              maxLength={500}
              onChange={(event) => setDraft({ ...draft, comment: event.target.value })}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={saveDraft}>Add suggestion</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
          </div>
        </div>
      )}

      {suggestions.length > 0 && (
        <div className="space-y-3">
          <h3 className="m-0 text-base">Preview</h3>
          {suggestions.map((suggestion) => (
            <div key={`${suggestion.field}:${suggestion.index}`} className="rounded-lg border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="text-sm">{blockLabel(suggestion.field, suggestion.index)}</strong>
                <Badge variant="muted">{suggestion.mode === 'add' ? 'Addition' : suggestion.mode === 'remove' ? 'Removal' : 'Replacement'}</Badge>
              </div>
              {suggestion.comment && <p className="mt-1 mb-0 text-sm text-muted-foreground">{suggestion.comment}</p>}
              <p className="mt-2 mb-0 text-sm">
                {suggestion.mode === 'add' ? (
                  <ins className="bg-[var(--horizon-success-bg)] text-[var(--horizon-success-ink)] no-underline">{suggestion.proposed}</ins>
                ) : suggestion.mode === 'remove' ? (
                  <del className="bg-[var(--horizon-danger-bg)] text-[var(--horizon-danger-ink)]">{suggestion.original}</del>
                ) : (
                  diffWords(suggestion.original, suggestion.proposed).map((segment, index) =>
                    segment.type === 'same' ? (
                      <span key={index}>{segment.text}</span>
                    ) : segment.type === 'remove' ? (
                      <del key={index} className="bg-[var(--horizon-danger-bg)] text-[var(--horizon-danger-ink)]">{segment.text}</del>
                    ) : (
                      <ins key={index} className="bg-[var(--horizon-success-bg)] text-[var(--horizon-success-ink)] no-underline">{segment.text}</ins>
                    ),
                  )
                )}
              </p>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={submit} className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={busy || !suggestions.length}>
          {busy ? 'Submitting…' : `Submit formal amendment${suggestions.length ? ` (${suggestions.length})` : ''}`}
        </Button>
        <span role="status" aria-live="polite" className="text-sm text-muted-foreground">{status}</span>
      </form>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
