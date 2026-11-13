import { useEffect, useState } from 'react';
import { trackEngage } from '../../lib/analytics.ts';
import {
  ballotDeadlineDateLabel,
  ballotExpired,
  formatLocalDeadline,
  formatRelativeDeadline,
} from '../../lib/ballot-deadline.ts';
import { ArrowRight, CheckCircle2, Clock, Loader2, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from './badge';
import { Button } from './button';
import { Field } from './field';
import { Input } from './input';
import { Separator } from './separator';
import { ToggleGroup, ToggleGroupItem } from './toggle-group';

type Choice = 'approve' | 'abstain' | 'reject';
type Tally = { approve: number; abstain: number; reject: number; total: number };

interface NextBallotInfo {
  slug: string;
  title: string;
  remainingCount: number;
}

interface Props {
  proposalId: string;
  proposalSlug?: string;
  proposalTitle?: string;
  initialChoice: Choice | null;
  initialReason: string;
  initialPendingChoice?: Choice | null;
  initialPendingReason?: string;
  initialTally: Tally;
  open: boolean;
  canVote: boolean;
  ineligibleReason?: string;
  isGuest?: boolean;
  isPendingMember?: boolean;
  nextBallot?: NextBallotInfo | null;
  ballotClosesAt?: string | null;
}

const choices: Array<{ value: Choice; label: string }> = [
  { value: 'approve', label: 'Approve' },
  { value: 'abstain', label: 'Abstain' },
  { value: 'reject', label: 'Reject' },
];

const choiceLabel = (choice: Choice | null) =>
  choices.find((option) => option.value === choice)?.label ?? 'Unrecorded';

const GUEST_CHOICE_STORAGE_PREFIX = 'engage_guest_ballot_choice:';

export default function ProposalBallot({
  proposalId,
  proposalSlug,
  proposalTitle,
  initialChoice,
  initialReason,
  initialPendingChoice = null,
  initialPendingReason = '',
  initialTally,
  open,
  canVote,
  ineligibleReason,
  isGuest = false,
  isPendingMember = false,
  nextBallot = null,
  ballotClosesAt = null,
}: Props) {
  const effectiveInitialChoice = initialChoice ?? initialPendingChoice ?? null;
  const effectiveInitialReason = initialChoice ? initialReason : (initialPendingReason || initialReason);

  const [selected, setSelected] = useState<Choice | null>(effectiveInitialChoice);
  const [savedChoice, setSavedChoice] = useState<Choice | null>(initialChoice);
  const [savedPendingChoice, setSavedPendingChoice] = useState<Choice | null>(initialPendingChoice);
  const [reason, setReason] = useState(effectiveInitialReason);
  const [savedReason, setSavedReason] = useState(effectiveInitialReason);
  const [tally, setTally] = useState(initialTally);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [justVoted, setJustVoted] = useState(false);
  const [justSavedPending, setJustSavedPending] = useState(false);
  const [clientNow, setClientNow] = useState<Date | null>(null);

  useEffect(() => {
    setClientNow(new Date());
  }, [ballotClosesAt]);

  // Restore guest's selected choice from URL query (`?choice=approve`) or sessionStorage
  useEffect(() => {
    if (savedChoice || savedPendingChoice) return;
    try {
      const params = new URLSearchParams(window.location.search);
      const urlChoice = params.get('choice')?.toLowerCase();
      const storedChoice = sessionStorage.getItem(`${GUEST_CHOICE_STORAGE_PREFIX}${proposalId}`);
      const candidate = (urlChoice || storedChoice) as Choice | null;
      if (candidate && ['approve', 'abstain', 'reject'].includes(candidate)) {
        setSelected(candidate);
      }
    } catch {
      // Ignore storage access restrictions
    }
  }, [proposalId, savedChoice, savedPendingChoice]);

  const canInteractWithToggle = open && (canVote || isGuest || isPendingMember) && !busy;
  const activeSavedChoice = canVote ? savedChoice : savedPendingChoice;
  const dirty =
    selected !== activeSavedChoice || reason.trim() !== savedReason.trim();
  const canSubmit = open && (canVote || isPendingMember) && !busy && Boolean(selected) && dirty;

  async function submitVote() {
    if (!selected || !canSubmit) return;
    trackEngage('contribution_attempted', { action: 'ballot' });
    setBusy(true);
    setError('');
    setJustVoted(false);
    setJustSavedPending(false);
    setMessage(
      isPendingMember && !canVote
        ? 'Saving your vote pending membership verification…'
        : 'Recording your vote…',
    );
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
      try {
        sessionStorage.removeItem(`${GUEST_CHOICE_STORAGE_PREFIX}${proposalId}`);
      } catch {
        // Ignore
      }
      trackEngage('contribution_result', { action: 'ballot', outcome: result.pendingVerification ? 'pending_verification' : 'success' });
      if (result.pendingVerification) {
        setSavedPendingChoice(selected);
        setSavedReason(reason);
        setJustSavedPending(true);
        setMessage('Your vote preference is saved pending membership verification.');
      } else {
        setSavedChoice(selected);
        setSavedPendingChoice(null);
        setSavedReason(reason);
        if (result.votes) setTally(result.votes);
        setJustVoted(true);
        setMessage('Your vote was recorded.');
        window.dispatchEvent(new CustomEvent('engage:vote-saved', { detail: { choice: choiceLabel(selected) } }));
      }
    } catch (submitError) {
      trackEngage('contribution_result', { action: 'ballot', outcome: 'failed' });
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

  const returnPath = proposalSlug
    ? `/proposals/${proposalSlug}/?choice=${encodeURIComponent(selected ?? 'approve')}#proposal-vote`
    : `/proposals/#proposal-vote`;
  const guestSignInHref = `/member/?returnTo=${encodeURIComponent(returnPath)}&intent=vote${proposalTitle ? `&title=${encodeURIComponent(proposalTitle)}` : ''}`;

  return (
    <div className="flex flex-col gap-4">
      {open ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-semibold">Your ballot</span>
            {savedChoice ? (
              <Badge variant="secondary">Recorded: {choiceLabel(savedChoice)}</Badge>
            ) : savedPendingChoice ? (
              <Badge variant="warning">
                Queued: {choiceLabel(savedPendingChoice)} (Pending verification)
              </Badge>
            ) : canVote ? (
              <Badge variant="warning">Unrecorded · ~30 sec</Badge>
            ) : isPendingMember ? (
              <Badge variant="outline">Verification pending</Badge>
            ) : (
              <Badge variant="muted">Select to preview</Badge>
            )}
          </div>

          {ballotClosesAt && (
            <div
              className="flex items-start gap-2 rounded-lg border border-[var(--horizon-line)] bg-[var(--horizon-lavender-soft)] px-3 py-2 text-sm text-[var(--horizon-purple-deep)]"
              data-testid="ballot-deadline-banner"
            >
              <Clock className="mt-0.5 size-4 shrink-0 text-[var(--horizon-purple)]" aria-hidden="true" />
              <div className="grid gap-0.5">
                <span className="font-semibold">
                  {ballotExpired({ ballotClosesAt }, clientNow ?? undefined)
                    ? 'Voting closed'
                    : 'Voting closes'}{' '}
                  {clientNow
                    ? formatRelativeDeadline(ballotClosesAt, clientNow)
                    : ballotDeadlineDateLabel(ballotClosesAt)}
                </span>
                <time
                  dateTime={ballotClosesAt}
                  className="text-xs text-muted-foreground"
                >
                  {clientNow
                    ? formatLocalDeadline(ballotClosesAt)
                    : `${ballotDeadlineDateLabel(ballotClosesAt)} (your local time)`}
                </time>
              </div>
            </div>
          )}

          <ToggleGroup
            aria-label="Choose your vote"
            className="grid w-full grid-cols-3 rounded-lg border border-border bg-muted/50 p-1"
            disabled={!canInteractWithToggle}
            onKeyDown={(event) => {
              if (
                !canInteractWithToggle ||
                !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(
                  event.key,
                )
              )
                return;
              // Radix moves focus on arrow keys; keep single-select radio
              // semantics by selecting the newly focused segment.
              window.setTimeout(() => {
                const value = document.activeElement?.getAttribute('data-choice');
                if (value) {
                  setSelected(value as Choice);
                  if (isGuest) {
                    try {
                      sessionStorage.setItem(`${GUEST_CHOICE_STORAGE_PREFIX}${proposalId}`, value);
                    } catch {
                      // Ignore
                    }
                  }
                }
              }, 0);
            }}
            onValueChange={(value) => {
              if (!value) return;
              setSelected(value as Choice);
              setError('');
              setMessage('');
              if (isGuest) {
                try {
                  sessionStorage.setItem(`${GUEST_CHOICE_STORAGE_PREFIX}${proposalId}`, value);
                } catch {
                  // Ignore
                }
              }
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

          {isGuest ? (
            selected ? (
              <div
                aria-live="polite"
                className="grid gap-2.5 rounded-lg border border-[var(--horizon-line)] bg-[var(--horizon-lavender-soft)] p-3.5 text-sm text-[var(--horizon-purple-deep)]"
              >
                <div className="flex items-start gap-2">
                  <Lock className="mt-0.5 size-4 shrink-0 text-[var(--horizon-purple)]" aria-hidden="true" />
                  <div className="grid gap-1">
                    <strong className="font-semibold">
                      Sign in to save your &ldquo;{choiceLabel(selected)}&rdquo; vote
                    </strong>
                    <p className="m-0 text-xs leading-relaxed text-[var(--horizon-muted)]">
                      Verified membership is required. If verification is pending, your choice is saved until it can be recorded.
                    </p>
                  </div>
                </div>
                <Button href={guestSignInHref} size="sm" className="w-full justify-center">
                  Sign in to save vote
                  <ArrowRight className="size-3.5" aria-hidden="true" />
                </Button>
              </div>
            ) : (
              <p className="m-0 text-xs text-muted-foreground">
                Select <strong>Approve</strong>, <strong>Abstain</strong>, or <strong>Reject</strong> above to start your ballot.
              </p>
            )
          ) : (
            <>
              <Field
                hint={
                  <span className="block text-right tabular-nums">
                    {reason.length}/500
                  </span>
                }
                htmlFor="ballot-reason"
                label="Why? (optional)"
              >
                <Input
                  disabled={!canInteractWithToggle}
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
                      {isPendingMember && !canVote ? 'Saving…' : 'Recording…'}
                    </>
                  ) : isPendingMember && !canVote ? (
                    savedPendingChoice ? (
                      'Update queued vote'
                    ) : (
                      'Save vote pending verification'
                    )
                  ) : savedChoice ? (
                    'Update vote'
                  ) : (
                    'Record vote'
                  )}
                </Button>
                {!canVote && !isPendingMember && (
                  <p className="m-0 text-sm text-muted-foreground">
                    {ineligibleReason ||
                      'You can read this ballot but are not eligible to vote in this branch electorate.'}
                  </p>
                )}
              </div>
            </>
          )}
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

      {(message || error || (!justSavedPending && savedPendingChoice && !canVote)) && (
        <div
          aria-live="polite"
          className={cn(
            'rounded-lg border px-3.5 py-2.5 text-sm',
            error
              ? 'border-[var(--horizon-danger-ink)] bg-[var(--horizon-danger-bg)] font-medium text-[var(--horizon-danger-ink)]'
              : justVoted || justSavedPending || savedPendingChoice
                ? 'border-[var(--horizon-line)] bg-[var(--horizon-lavender-soft)] text-[var(--horizon-purple-deep)]'
                : 'border-transparent px-0 py-0 text-muted-foreground',
          )}
          role={error ? 'alert' : 'status'}
        >
          {error ? (
            <p className="m-0">{error}</p>
          ) : justVoted && savedChoice ? (
            <div className="grid gap-2">
              <p className="m-0 flex items-center gap-1.5 font-semibold text-[var(--horizon-success-ink)]">
                <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
                <span>Vote saved: {choiceLabel(savedChoice)}</span>
              </p>
              <p className="m-0 text-xs text-[var(--horizon-muted)]">
                You can change your vote until voting closes.
              </p>



            </div>
          ) : savedPendingChoice && !canVote ? (
            <div className="grid gap-1.5">
              <p className="m-0 flex items-center gap-1.5 font-semibold text-[var(--horizon-purple-deep)]">
                <Clock className="size-4 shrink-0 text-[var(--horizon-purple)]" aria-hidden="true" />
                <span>
                  Saved pending verification ({choiceLabel(savedPendingChoice)}).
                </span>
              </p>
              <p className="m-0 text-xs leading-relaxed text-[var(--horizon-muted)]">
                Your vote will be recorded when your membership is verified, provided voting is still open.
              </p>
            </div>
          ) : (
            <p className="m-0">{message}</p>
          )}
        </div>
      )}

      {open && canVote && (
        <nav aria-label="Ballot navigation" className="grid gap-2 border-t border-border pt-4">
          {nextBallot ? (
            <>
              <a href={`/proposals/${nextBallot.slug}/`} className="inline-flex min-h-11 items-center gap-2 font-semibold text-[var(--horizon-purple-deep)] hover:underline">
                {savedChoice ? 'Read next proposal' : 'Skip for now'}
                <ArrowRight className="size-4" aria-hidden="true" />
              </a>
              <span className="text-sm text-muted-foreground">{nextBallot.remainingCount + (savedChoice ? 0 : 1)} need your vote · Next: {nextBallot.title}</span>
            </>
          ) : (
            <p className="m-0 text-sm">{savedChoice ? "You're up to date" : 'This is your last outstanding ballot.'}</p>
          )}
          <a href="/proposals/?stage=decide&focus=all" className="text-sm underline underline-offset-4">All active ballots</a>
        </nav>
      )}

      {savedChoice && (
        <div className="flex flex-wrap gap-4 text-sm">
          <a href="#deliberation" className="underline underline-offset-4">Join discussion</a>
          <button type="button" className="underline underline-offset-4" onClick={async () => {
            try { await navigator.clipboard.writeText(window.location.href.split('#')[0]); setMessage('Link copied.'); setJustVoted(false); } catch { setError("Couldn't copy link. Copy the address from your browser."); }
          }}>Share</button>
        </div>
      )}
      <Separator />

      <section aria-label="Ballot results" className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <h4 className="m-0 text-sm font-semibold">Results</h4>
          {tally.total > 0 && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {tally.total} verified {tally.total === 1 ? 'vote' : 'votes'}
            </span>
          )}
        </div>
        {tally.total === 0 ? (
          <p className="m-0 text-sm text-muted-foreground">
            No verified votes recorded yet.
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
            <p className="m-0 text-xs text-muted-foreground tabular-nums">
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

