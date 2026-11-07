import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from './badge';
import { Button } from './button';
import { Field } from './field';
import { Input } from './input';
import { Separator } from './separator';
import { ToggleGroup, ToggleGroupItem } from './toggle-group';

type Choice = 'approve' | 'abstain' | 'reject';
type Tally = { approve: number; abstain: number; reject: number; total: number };

interface Props {
  proposalId: string;
  initialChoice: Choice | null;
  initialReason: string;
  initialTally: Tally;
  open: boolean;
  canVote: boolean;
}

const choices: Array<{ value: Choice; label: string }> = [
  { value: 'approve', label: 'Approve' },
  { value: 'abstain', label: 'Abstain' },
  { value: 'reject', label: 'Reject' },
];

const choiceLabel = (choice: Choice | null) =>
  choices.find((option) => option.value === choice)?.label ?? 'Not voted';

export default function ProposalBallot({
  proposalId,
  initialChoice,
  initialReason,
  initialTally,
  open,
  canVote,
}: Props) {
  const [selected, setSelected] = useState<Choice | null>(initialChoice);
  const [savedChoice, setSavedChoice] = useState<Choice | null>(initialChoice);
  const [reason, setReason] = useState(initialReason);
  const [savedReason, setSavedReason] = useState(initialReason);
  const [tally, setTally] = useState(initialTally);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const interactive = open && canVote && !busy;
  const dirty =
    selected !== savedChoice || reason.trim() !== savedReason.trim();
  const canSubmit = interactive && Boolean(selected) && dirty;

  async function submitVote() {
    if (!selected || !canSubmit) return;
    setBusy(true);
    setError('');
    setMessage('Recording your vote…');
    try {
      const response = await fetch('/api/votes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposalId, choice: selected, reason }),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || 'Could not record your vote.');
      }
      setSavedChoice(selected);
      setSavedReason(reason);
      if (result.votes) setTally(result.votes);
      setMessage('Your vote was recorded.');
    } catch (submitError) {
      setMessage('');
      setError(
        submitError instanceof Error
          ? submitError.message
          : 'Could not record your vote.',
      );
    } finally {
      setBusy(false);
    }
  }

  const pct = (value: number) =>
    tally.total ? Math.round((value / tally.total) * 100) : 0;

  return (
    <div className="flex flex-col gap-4">
      {open ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-semibold">Your vote</span>
            <Badge variant={savedChoice ? 'secondary' : 'muted'}>
              {savedChoice ? `Recorded: ${choiceLabel(savedChoice)}` : 'Not voted'}
            </Badge>
          </div>

          <ToggleGroup
            aria-label="Choose your vote"
            className="grid w-full grid-cols-3 rounded-lg border border-border bg-muted/50 p-1"
            disabled={!interactive}
            onKeyDown={(event) => {
              if (
                !interactive ||
                !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(
                  event.key,
                )
              )
                return;
              // Radix moves focus on arrow keys; keep single-select radio
              // semantics by selecting the newly focused segment.
              window.setTimeout(() => {
                const value = document.activeElement?.getAttribute('data-choice');
                if (value) setSelected(value as Choice);
              }, 0);
            }}
            onValueChange={(value) => {
              if (!value) return;
              setSelected(value as Choice);
              setError('');
              setMessage('');
            }}
            type="single"
            value={selected ?? ''}
          >
            {choices.map((option) => (
              <ToggleGroupItem
                className="h-9 w-full rounded-md px-2 text-sm font-medium data-[state=on]:bg-background data-[state=on]:font-semibold data-[state=on]:text-foreground data-[state=on]:shadow-sm data-[state=on]:ring-1 data-[state=on]:ring-border"
                data-choice={option.value}
                key={option.value}
                value={option.value}
              >
                {option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          <Field
            hint={
              <span className="block text-right tabular-nums">
                {reason.length}/500
              </span>
            }
            htmlFor="ballot-reason"
            label="Reason (optional)"
          >
            <Input
              disabled={!interactive}
              id="ballot-reason"
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Add a short explanation"
              value={reason}
            />
          </Field>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              className="w-full rounded-lg disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100 disabled:shadow-none"
              disabled={!canSubmit}
              onClick={submitVote}
              type="button"
            >
              {busy ? (
                <>
                  <Loader2
                    aria-hidden="true"
                    className="animate-spin"
                    data-icon="inline-start"
                  />
                  Recording…
                </>
              ) : savedChoice ? (
                'Update vote'
              ) : (
                'Record vote'
              )}
            </Button>
            {!canVote && (
              <p className="m-0 text-sm text-muted-foreground">
                You can read this ballot but are not eligible to vote in it.
              </p>
            )}
          </div>
        </div>
      ) : savedChoice ? (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">Your recorded vote</span>
            <Badge variant="secondary">{choiceLabel(savedChoice)}</Badge>
          </div>
          {savedReason && (
            <p className="m-0 text-sm text-muted-foreground">{savedReason}</p>
          )}
        </div>
      ) : (
        <p className="m-0 text-sm text-muted-foreground">
          Voting has closed for this ballot.
        </p>
      )}

      {(message || error) && (
        <p
          aria-live="polite"
          className={cn(
            'm-0 text-sm',
            error ? 'font-medium text-destructive' : 'text-muted-foreground',
          )}
          role={error ? 'alert' : 'status'}
        >
          {error || message}
        </p>
      )}

      <Separator />

      <section aria-label="Ballot results" className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <h4 className="m-0 text-sm font-semibold">Results</h4>
          {tally.total > 0 && (
            <span className="text-xs text-muted-foreground">
              {tally.total} verified {tally.total === 1 ? 'vote' : 'votes'}
            </span>
          )}
        </div>
        {tally.total === 0 ? (
          <p className="m-0 text-sm text-muted-foreground">
            No votes recorded yet.
          </p>
        ) : (
          <>
            <div
              aria-hidden="true"
              className="flex h-1.5 overflow-hidden rounded-full bg-muted"
            >
              <span
                className="bg-[var(--horizon-success-ink)]"
                style={{ width: `${pct(tally.approve)}%` }}
              />
              <span
                className="bg-[#8a6100]"
                style={{ width: `${pct(tally.abstain)}%` }}
              />
              <span
                className="bg-[var(--horizon-danger-ink)]"
                style={{ width: `${pct(tally.reject)}%` }}
              />
            </div>
            <p className="m-0 text-xs text-muted-foreground">
              <strong className="text-foreground">{tally.approve}</strong> approve ·{' '}
              <strong className="text-foreground">{tally.abstain}</strong> abstain ·{' '}
              <strong className="text-foreground">{tally.reject}</strong> reject
            </p>
          </>
        )}
      </section>
    </div>
  );
}
