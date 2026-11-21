import { useEffect, useRef, useState } from 'react';
import { trackEngage } from '../../lib/analytics.ts';
import {
  ballotDeadlineDateLabel, ballotExpired, formatLocalDeadline, formatRelativeDeadline,
} from '../../lib/ballot-deadline.ts';
import { ArrowLeft, ArrowRight, CheckCircle2, Circle, Clock, Info, Loader2, Lock, Share2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription, AlertTitle } from './alert';
import { Badge } from './badge';
import { Button } from './button';
import { Card, CardContent } from './card';
import { Field } from './field';
import { Input } from './input';
import { Separator } from './separator';
import { ToggleGroup, ToggleGroupItem } from './toggle-group';

type Choice = 'approve' | 'abstain' | 'reject';
type Tally = { approve: number; abstain: number; reject: number; total: number };
type ReviewDraft = { choice: Choice; reason: string };

interface NextBallotInfo { slug: string; title: string; remainingCount: number; }
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
const isChoice = (value: unknown): value is Choice => choices.some((option) => option.value === value);
const choiceLabel = (choice: Choice | null) => choices.find((option) => option.value === choice)?.label ?? 'Unrecorded';
const GUEST_CHOICE_STORAGE_PREFIX = 'engage_guest_ballot_choice:';

export default function ProposalBallot({
  proposalId, proposalSlug, proposalTitle, initialChoice, initialReason,
  initialPendingChoice = null, initialPendingReason = '', initialTally, open,
  canVote, ineligibleReason, isGuest = false, isPendingMember = false,
  nextBallot = null, ballotClosesAt = null,
}: Props) {
  const effectiveInitialChoice = initialChoice ?? initialPendingChoice ?? null;
  const effectiveInitialReason = initialChoice ? initialReason : (initialPendingReason || initialReason);
  const [selected, setSelected] = useState<Choice | null>(effectiveInitialChoice);
  const [savedChoice, setSavedChoice] = useState<Choice | null>(initialChoice);
  const [savedPendingChoice, setSavedPendingChoice] = useState<Choice | null>(initialPendingChoice);
  const [reason, setReason] = useState(effectiveInitialReason);
  const [savedReason, setSavedReason] = useState(effectiveInitialReason);
  // A later pending preference must not replace the reason attached to a
  // previously recorded formal vote if membership changes while this is open.
  const [recordedReason, setRecordedReason] = useState(initialReason);
  const [tally, setTally] = useState(initialTally);
  const [review, setReview] = useState<ReviewDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [justVoted, setJustVoted] = useState(false);
  const [justSavedPending, setJustSavedPending] = useState(false);
  const [restoredDraft, setRestoredDraft] = useState(false);
  const [pendingOnly, setPendingOnly] = useState(isPendingMember && !canVote);
  const [clientNow, setClientNow] = useState<Date | null>(null);
  const submissionInFlight = useRef(false);
  const selectionHeading = useRef<HTMLHeadingElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const statusPanel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setClientNow(new Date());
    const timer = window.setInterval(() => setClientNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, [ballotClosesAt]);

  // Restore only a choice the person already made. Restoration never submits it.
  useEffect(() => {
    if (savedChoice || savedPendingChoice) return;
    try {
      const params = new URLSearchParams(window.location.search);
      const candidate = params.get('choice')?.toLowerCase()
        || sessionStorage.getItem(`${GUEST_CHOICE_STORAGE_PREFIX}${proposalId}`);
      if (isChoice(candidate)) {
        setSelected(candidate);
        setRestoredDraft(true);
      }
    } catch { /* A restricted browser must still be able to use the ballot. */ }
  }, [proposalId, savedChoice, savedPendingChoice]);

  useEffect(() => { if (review) reviewHeading.current?.focus(); }, [review]);
  useEffect(() => {
    if (justVoted || justSavedPending) statusPanel.current?.focus();
  }, [justVoted, justSavedPending]);

  const isOpen = open && !(clientNow && ballotExpired({ ballotClosesAt }, clientNow));
  const canInteractWithToggle = isOpen && (canVote || isGuest || isPendingMember || pendingOnly) && !busy;
  const activeSavedChoice = canVote && !pendingOnly ? savedChoice : savedPendingChoice;
  const dirty = selected !== activeSavedChoice || reason.trim() !== savedReason.trim();
  const canSubmit = isOpen && (canVote || isPendingMember || pendingOnly) && !busy && !uncertain && Boolean(selected) && dirty;

  function selectChoice(value: string) {
    if (!isChoice(value)) return;
    setSelected(value);
    setRestoredDraft(false);
    if (!uncertain) setError('');
    setMessage('');
    setJustVoted(false);
    setJustSavedPending(false);
    if (isGuest) {
      try { sessionStorage.setItem(`${GUEST_CHOICE_STORAGE_PREFIX}${proposalId}`, value); } catch { /* Optional draft persistence. */ }
    }
  }
  function startReview() {
    if (!selected || !canSubmit) return;
    setError('');
    setMessage('');
    setUncertain(false);
    setReview({ choice: selected, reason: reason.trim() });
  }
  function editChoice() {
    if (busy) return;
    setReview(null);
    window.requestAnimationFrame(() => selectionHeading.current?.focus());
  }

  async function submitVote() {
    if (!review || !canSubmit || submissionInFlight.current) return;
    // This is a convenience check only; the server remains authoritative.
    if (ballotExpired({ ballotClosesAt })) {
      setClientNow(new Date());
      setReview(null);
      setError('The closing time has passed. Reload this page to check the ballot state.');
      return;
    }
    const submitted = review;
    submissionInFlight.current = true;
    trackEngage('contribution_attempted', { action: 'ballot' });
    setBusy(true);
    setError('');
    setUncertain(false);
    setJustVoted(false);
    setJustSavedPending(false);
    setMessage(pendingOnly ? 'Saving your choice pending verification…' : 'Recording your vote…');
    let serverRejected = false;
    try {
      const response = await fetch('/api/votes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposalId, choice: submitted.choice, reason: submitted.reason }),
      });
      const result = await response.json();
      if (!response.ok) {
        serverRejected = response.status < 500;
        throw new Error(result.error || 'Could not record your vote.');
      }
      if (!isChoice(result.choice)) throw new Error('The server response could not be confirmed.');
      try { sessionStorage.removeItem(`${GUEST_CHOICE_STORAGE_PREFIX}${proposalId}`); } catch { /* Optional draft persistence. */ }
      setSelected(result.choice);
      setReason(submitted.reason);
      setSavedReason(submitted.reason);
      setRestoredDraft(false);
      setReview(null);
      trackEngage('contribution_result', { action: 'ballot', outcome: result.pendingVerification ? 'pending_verification' : 'success' });
      if (result.pendingVerification) {
        setPendingOnly(true);
        setSavedPendingChoice(result.choice);
        setJustSavedPending(true);
        setMessage('Your vote preference is saved pending membership verification.');
      } else {
        setPendingOnly(false);
        setSavedChoice(result.choice);
        setRecordedReason(submitted.reason);
        setSavedPendingChoice(null);
        if (result.votes) setTally(result.votes);
        setJustVoted(true);
        setMessage('Your vote was recorded.');
        window.dispatchEvent(new CustomEvent('engage:vote-saved', { detail: { choice: choiceLabel(result.choice) } }));
      }
    } catch (submitError) {
      trackEngage('contribution_result', { action: 'ballot', outcome: 'failed' });
      setMessage('');
      setUncertain(!serverRejected);
      setError(serverRejected
        ? submitError instanceof Error ? submitError.message : 'Could not record your vote.'
        : 'We could not confirm the server response. Your vote may have been recorded. Reload to check your recorded choice before trying again.');
    } finally {
      submissionInFlight.current = false;
      setBusy(false);
    }
  }

  async function shareBallot() {
    try {
      // Never copy a restored choice, sign-in parameter or other private query.
      const path = proposalSlug ? `/proposals/${encodeURIComponent(proposalSlug)}/` : window.location.pathname;
      await navigator.clipboard.writeText(new URL(path, window.location.origin).href);
      setMessage('Link copied.');
      if (!uncertain) setError('');
      setJustVoted(false);
      setJustSavedPending(false);
    } catch {
      if (!uncertain) setError('Could not copy the link. Use the proposal address without any query parameters.');
    }
  }

  const pct = (value: number) => tally.total ? Math.round((value / tally.total) * 100) : 0;
  const returnPath = proposalSlug
    ? `/proposals/${proposalSlug}/${selected ? `?choice=${encodeURIComponent(selected)}` : ''}#proposal-vote`
    : '/proposals/#proposal-vote';
  const guestSignInHref = `/member/?returnTo=${encodeURIComponent(returnPath)}&intent=vote${proposalTitle ? `&title=${encodeURIComponent(proposalTitle)}` : ''}`;

  return (
    <div className="flex min-w-0 flex-col gap-5" data-ballot-experience="review">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Badge variant="info" className="mb-2">Formal ballot</Badge>
          <h3 ref={selectionHeading} tabIndex={-1} className="m-0 font-[var(--font-outfit)] text-xl font-bold text-[var(--horizon-purple-deep)] focus:outline-none">Your ballot</h3>
        </div>
        {savedChoice ? <Badge variant="secondary">Recorded: {choiceLabel(savedChoice)}</Badge>
          : savedPendingChoice ? <Badge variant="warning">Saved: {choiceLabel(savedPendingChoice)} · awaiting verification</Badge>
          : canVote ? <Badge variant="outline">Not yet recorded</Badge>
          : pendingOnly ? <Badge variant="warning">Verification pending</Badge>
          : <Badge variant="muted">Read and explore</Badge>}
      </div>

      {ballotClosesAt && (
        <Alert variant="info" role="note" data-testid="ballot-deadline-banner" className="bg-[var(--horizon-blue-soft)]">
          <Clock aria-hidden="true" />
          <AlertTitle><span suppressHydrationWarning>{isOpen ? 'Voting closes' : 'Scheduled closing time'} {clientNow ? formatRelativeDeadline(ballotClosesAt, clientNow) : ballotDeadlineDateLabel(ballotClosesAt)}</span></AlertTitle>
          <AlertDescription><time dateTime={ballotClosesAt} suppressHydrationWarning>{clientNow ? formatLocalDeadline(ballotClosesAt) : `${ballotDeadlineDateLabel(ballotClosesAt)} (Melbourne time)`}</time></AlertDescription>
        </Alert>
      )}

      {isOpen ? (
        <>
          <ol aria-label="Ballot steps" className="m-0 flex list-none flex-wrap gap-x-4 gap-y-2 p-0 text-xs font-semibold text-muted-foreground">
            {['Choose', 'Review', 'Confirmation'].map((label, index) => {
              const current = justVoted || justSavedPending ? 2 : review ? 1 : 0;
              return <li key={label} aria-current={current === index ? 'step' : undefined} className={cn('inline-flex items-center gap-1.5', current === index && 'text-[var(--horizon-purple-deep)]')}><span aria-hidden="true" className={cn('grid size-6 place-items-center rounded-full border border-border', current === index && 'border-[var(--horizon-purple)] bg-[var(--horizon-purple)] text-[var(--horizon-white)]')}>{index + 1}</span>{label}</li>;
            })}
          </ol>

          {review ? (
            <Card className="gap-0 border-[var(--horizon-purple)] bg-[var(--horizon-lavender-soft)]">
              <CardContent className="grid gap-4 pt-5">
                <h4 ref={reviewHeading} tabIndex={-1} className="m-0 font-[var(--font-outfit)] text-lg font-bold focus:outline-none">Review your {pendingOnly ? 'saved choice' : 'vote'}</h4>
                {proposalTitle && <p className="m-0 text-sm font-semibold">{proposalTitle}</p>}
                <dl className="m-0 grid gap-3 text-sm">
                  <div><dt className="text-muted-foreground">Your choice</dt><dd className="m-0 mt-1 text-xl font-bold text-[var(--horizon-purple-deep)]">{choiceLabel(review.choice)}</dd></div>
                  <div><dt className="text-muted-foreground">Your reason</dt><dd className="m-0 mt-1 whitespace-pre-wrap break-words">{review.reason || 'No reason added (optional).'}</dd></div>
                </dl>
                <p className="m-0 text-sm text-muted-foreground">{pendingOnly ? 'This saves a preference. It does not count as a formal vote while verification is pending.' : 'Check your choice against the ballot wording on this page. Nothing is submitted until you confirm below.'}</p>
                <div className="grid gap-2">
                  <Button type="button" onClick={submitVote} disabled={!canSubmit || uncertain} className="min-h-12 w-full">
                    {busy ? <><Loader2 className="animate-spin" aria-hidden="true" />{pendingOnly ? 'Saving…' : 'Recording…'}</>
                      : pendingOnly ? savedPendingChoice ? 'Update saved choice' : 'Save choice pending verification'
                      : savedChoice ? 'Update vote' : 'Record vote'}
                  </Button>
                  <Button type="button" variant="outline" onClick={editChoice} disabled={busy} className="min-h-11"><ArrowLeft aria-hidden="true" />Edit choice</Button>
                </div>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4">
              <p className="m-0 text-sm text-muted-foreground">Read the ballot wording, choose an option, then review before submitting.</p>
              <ToggleGroup
                aria-label="Choose your vote"
                className="grid w-full grid-cols-3 gap-2"
                spacing={2}
                disabled={!canInteractWithToggle}
                onKeyDown={(event) => {
                  if (!canInteractWithToggle || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
                  window.setTimeout(() => {
                    const value = document.activeElement?.getAttribute('data-choice');
                    if (value) selectChoice(value);
                  }, 0);
                }}
                onValueChange={selectChoice}
                type="single"
                value={selected ?? ''}
              >
                {choices.map((option) => (
                  <ToggleGroupItem key={option.value} value={option.value} data-choice={option.value} className="flex min-h-16 w-full flex-col gap-1 rounded-xl border border-border bg-background px-1 text-sm font-semibold text-foreground data-[state=on]:border-[var(--horizon-purple)] data-[state=on]:bg-[var(--horizon-lavender)] data-[state=on]:text-[var(--horizon-purple-deep)] data-[state=on]:ring-1 data-[state=on]:ring-[var(--horizon-purple)]">
                    <Circle className={cn('size-4', selected === option.value && 'fill-current')} aria-hidden="true" />{option.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              {restoredDraft && <p className="m-0 text-sm text-muted-foreground">Your earlier selection has been restored. It has not been submitted.</p>}
              {!restoredDraft && dirty && activeSavedChoice && <p className="m-0 text-sm text-muted-foreground">Your changes have not been submitted. Your saved choice remains {choiceLabel(activeSavedChoice)}.</p>}

              {isGuest ? selected ? (
                <Alert variant="info" role="note">
                  <Lock aria-hidden="true" />
                  <AlertTitle>Sign in to continue</AlertTitle>
                  <AlertDescription>
                    <p>Your selection is {choiceLabel(selected)}. Verified membership and ballot eligibility are required for a formal vote.</p>
                    <Button href={guestSignInHref} className="mt-2 min-h-11 w-full">Sign in to save vote <ArrowRight aria-hidden="true" /></Button>
                  </AlertDescription>
                </Alert>
              ) : <p className="m-0 text-sm text-muted-foreground">You can explore the choices before signing in.</p> : (
                <>
                  <Field htmlFor="ballot-reason" label="Why? (optional)" hint={<span className="block text-right tabular-nums">{reason.length}/500</span>}>
                    <Input disabled={!canInteractWithToggle} id="ballot-reason" maxLength={500} onChange={(event) => { setReason(event.target.value); setJustVoted(false); setJustSavedPending(false); }} placeholder="Add a short explanation" value={reason} />
                  </Field>
                  <Button type="button" onClick={startReview} disabled={!canSubmit} className="min-h-12 w-full">{pendingOnly ? 'Review saved choice' : savedChoice ? 'Review update' : 'Review vote'}<ArrowRight aria-hidden="true" /></Button>
                  {!canVote && !isPendingMember && <p className="m-0 text-sm text-muted-foreground">{ineligibleReason || 'You can read this ballot but are not eligible to vote in it.'}</p>}
                </>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="grid gap-2 text-sm">
          <p className="m-0 font-semibold">Voting is closed for this ballot.</p>
          {savedChoice && <p className="m-0">Your recorded vote: <strong>{choiceLabel(savedChoice)}</strong></p>}
          {savedChoice && recordedReason && <p className="m-0 whitespace-pre-wrap break-words text-muted-foreground">{recordedReason}</p>}
        </div>
      )}

      {(message || error || savedPendingChoice && pendingOnly) && (
        <Alert ref={statusPanel} tabIndex={-1} variant={error ? 'destructive' : justVoted ? 'success' : 'info'} role={error ? 'alert' : 'status'} aria-live="polite" className="focus:outline-none">
          {error ? <Info aria-hidden="true" /> : justVoted ? <CheckCircle2 aria-hidden="true" /> : <Clock aria-hidden="true" />}
          <AlertDescription>
            {error ? <><p className="m-0">{error}</p>{uncertain && <Button type="button" onClick={() => window.location.reload()} variant="outline" className="mt-2">Reload and check recorded vote</Button>}</>
              : justVoted && savedChoice ? <><p className="m-0 font-semibold">Vote saved: {choiceLabel(savedChoice)}</p><p className="m-0">{isOpen ? 'You can change your vote until voting closes.' : 'Voting is now closed.'}</p></>
              : savedPendingChoice && pendingOnly ? <><p className="m-0 font-semibold">Saved pending verification ({choiceLabel(savedPendingChoice)}).</p><p className="m-0">Your saved choice can count after verification only if you are eligible, voting is still open and the ballot wording still matches.</p></>
              : <p className="m-0">{message}</p>}
          </AlertDescription>
        </Alert>
      )}

      {isOpen && canVote && !pendingOnly && (
        <nav aria-label="Ballot navigation" className="grid gap-2 border-t border-border pt-4">
          {nextBallot ? <><Button href={`/proposals/${nextBallot.slug}/`} variant="outline" className="min-h-11 justify-between">{savedChoice ? 'Read next proposal' : 'Skip for now'}<ArrowRight aria-hidden="true" /></Button><span className="text-sm text-muted-foreground">{nextBallot.remainingCount + (savedChoice ? 0 : 1)} you haven’t voted on · Next: {nextBallot.title}</span></>
            : <p className="m-0 text-sm">{savedChoice ? "You're up to date" : 'This is the last open ballot you are eligible for and haven’t voted on.'}</p>}
          <a href="/proposals/?stage=decide&focus=all" className="text-sm underline underline-offset-4">All active ballots</a>
        </nav>
      )}
      {savedChoice && <div className="flex flex-wrap gap-2"><Button href="#deliberation" variant="ghost" size="sm">Join discussion</Button><Button type="button" variant="ghost" size="sm" onClick={shareBallot}><Share2 aria-hidden="true" />Share</Button></div>}
      <Separator />
      <section aria-label="Ballot totals" className="grid gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2"><h4 className="m-0 font-[var(--font-outfit)] text-sm font-semibold">Vote totals</h4>{tally.total > 0 && <span className="text-xs text-muted-foreground tabular-nums">{tally.total} verified {tally.total === 1 ? 'vote' : 'votes'}</span>}</div>
        {tally.total === 0 ? <p className="m-0 text-sm text-muted-foreground">No verified votes recorded yet.</p>
          : <dl className="m-0 grid grid-cols-3 gap-3">{choices.map(({ value, label }) => <div key={value} className="grid gap-1"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="m-0 text-base font-bold tabular-nums">{tally[value]}</dd><div aria-hidden="true" className="h-1 rounded-full bg-muted"><div className="h-1 rounded-full bg-[var(--horizon-purple)]" style={{ width: `${pct(tally[value])}%` }} /></div></div>)}</dl>}
        <p className="m-0 text-xs text-muted-foreground">Vote totals are separate from the formally recorded outcome.</p>
      </section>
    </div>
  );
}
