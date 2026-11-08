import { useState } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
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
  const [justVoted, setJustVoted] = useState(false);

  const interactive = open && canVote && !busy;
  const dirty =
    selected !== savedChoice || reason.trim() !== savedReason.trim();
  const canSubmit = interactive && Boolean(selected) && dirty;

  async function submitVote() {
    if (!selected || !canSubmit) return;
    setBusy(true);
    setError('');
    setJustVoted(false);
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
      setJustVoted(true);
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
        <div
          aria-live="polite"
          className={cn(
            'rounded-lg border px-3.5 py-2.5 text-sm',
            error
              ? 'border-[var(--horizon-danger-ink)] bg-[var(--horizon-danger-bg)] font-medium text-[var(--horizon-danger-ink)]'
              : justVoted
                ? 'border-[var(--horizon-line)] bg-[var(--horizon-lavender-soft)] text-[var(--horizon-purple-deep)]'
                : 'border-transparent px-0 py-0 text-muted-foreground',
          )}
          role={error ? 'alert' : 'status'}
        >
          {error ? (
            <p className="m-0">{error}</p>
          ) : justVoted && savedChoice ? (
            <div className="grid gap-1.5">
              <p className="m-0 flex items-center gap-1.5 font-semibold text-[var(--horizon-success-ink)]">
                <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
                <span>Vote recorded ({choiceLabel(savedChoice)}).</span>
              </p>
              <p className="m-0 text-xs text-[var(--horizon-muted)]">
                Your ballot is bound to this wording snapshot. You can update your choice anytime while voting stays open.
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-3 text-xs font-semibold">
                <a
                  href="#deliberation"
                  className="text-[var(--horizon-purple-deep)] hover:underline"
                >
                  Share your reasoning in discussion →
                </a>
                <a
                  href="/member/"
                  className="text-[var(--horizon-purple-deep)] hover:underline"
                >
                  Check remaining open ballots →
                </a>
              </div>
            </div>
          ) : (
            <p className="m-0">{message}</p>
          )}
        </div>
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
