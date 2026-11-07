import { useState } from 'react';
import { Button } from './button';
import { Field } from './field';
import { Input } from './input';
import { Badge } from './badge';

type Choice = 'approve' | 'abstain' | 'reject';
type Tally = { approve: number; abstain: number; reject: number; total: number };
interface Props { proposalId: string; revision: string; initialChoice: Choice | null; initialReason: string; initialTally: Tally }
const choices: Array<[Choice, string]> = [['approve','Approve'],['abstain','Abstain'],['reject','Reject']];

export default function ProposalBallot({ proposalId, revision, initialChoice, initialReason, initialTally }: Props) {
  const [choice, setChoice] = useState<Choice | null>(initialChoice);
  const [reason, setReason] = useState(initialReason);
  const [tally, setTally] = useState(initialTally);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function castVote(next: Choice) {
    setBusy(true); setMessage('Recording your vote…');
    try {
      const response = await fetch('/api/votes', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ proposalId, choice:next, reason }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not record your vote.');
      setChoice(next); if (result.votes) setTally(result.votes); setMessage('Your vote was recorded.'); window.setTimeout(() => window.location.reload(), 700);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not record your vote.'); }
    finally { setBusy(false); }
  }
  const pct = (n: number) => tally.total ? Math.round(n / tally.total * 100) : 0;
  return (
    <div className="grid gap-3">
      <p className="m-0 text-sm">Voting on wording revision <code>{revision}</code>. Your vote records your view of this version only.</p>
      <p className="m-0 text-sm">
        Your vote: <Badge variant={choice ? 'secondary' : 'muted'}>{choice ? choice.toUpperCase() : 'Not voted'}</Badge>
      </p>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Cast your vote on this proposal">
        {choices.map(([value, label]) => (
          <Button key={value} variant={choice === value ? 'secondary' : 'outline'} disabled={busy} aria-pressed={choice === value} onClick={() => castVote(value)}>
            {label}
          </Button>
        ))}
      </div>
      <Field label="Reason (optional)" htmlFor="ballot-reason">
        <Input id="ballot-reason" maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Add a short reason" />
      </Field>
      <div className="grid gap-1" aria-label={`${tally.total} recorded votes`}>
        <div className="flex h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
          <i className="bg-[var(--horizon-success-ink)]" style={{ width: `${pct(tally.approve)}%` }} />
          <i className="bg-[#8a6100]" style={{ width: `${pct(tally.abstain)}%` }} />
          <i className="bg-[var(--horizon-danger-ink)]" style={{ width: `${pct(tally.reject)}%` }} />
        </div>
        <p className="m-0 text-xs text-muted-foreground">{tally.approve} approve · {tally.abstain} abstain · {tally.reject} reject · {tally.total} total</p>
      </div>
      <p className="m-0 text-sm" role="status" aria-live="polite">{message}</p>
    </div>
  );
}
