import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

/**
 * The member-driven seconding act (D3). Seconding performs the Propose →
 * Deliberate transition and starts the 30-day deliberation clock, so the
 * server owns every rule; this control only submits the intent.
 */
export default function SecondProposalButton({
  proposalId,
}: {
  proposalId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function second() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch(
        `/api/proposals/${encodeURIComponent(proposalId)}/second`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || 'Could not second this proposal.');
      }
      setMessage('Seconded. Deliberation is now open for 30 days.');
      window.setTimeout(() => window.location.reload(), 900);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not second this proposal.',
      );
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2">
      {message ? (
        <Alert variant="success" role="status">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : (
        <Button type="button" size="sm" onClick={second} disabled={busy}>
          {busy ? 'Seconding…' : 'Second this proposal'}
        </Button>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
