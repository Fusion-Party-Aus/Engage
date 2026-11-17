import { useState } from 'react';
import { Alert, AlertDescription } from '../ui/alert';
import { Button } from '../ui/button';
import { Field } from '../ui/field';
import { Input } from '../ui/input';
import { NativeSelect } from '../ui/native-select';
import { Textarea } from '../ui/textarea';
import {
  COLLABORATION_STATUSES,
  PUBLICATION_CHANNELS,
  type CollaborationStatus,
  type PublicationChannel,
} from '../../lib/collaboration-options';

interface Props {
  contributionId: string;
  version: number;
  status: CollaborationStatus;
  /** Channels the contributor permitted. Empty means private only. */
  channels: PublicationChannel[];
  usedChannels: PublicationChannel[];
}

/**
 * Reviewer actions for one contribution. Status and notes save together; a use
 * record is a separate act so it is never implied by approval.
 */
export default function ContributionReviewer({ contributionId, version, status, channels, usedChannels }: Props) {
  const [current, setCurrent] = useState<CollaborationStatus>(status);
  const [currentVersion, setCurrentVersion] = useState(version);
  const [notes, setNotes] = useState('');
  const [message, setMessage] = useState('');
  const [channel, setChannel] = useState<PublicationChannel | ''>(channels[0] ?? '');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');

  async function send(body: Record<string, unknown>, saved: string) {
    if (busy) return;
    setBusy(true);
    setError('');
    setFeedback('');
    try {
      const response = await fetch(`/api/admin/collaboration/contributions/${contributionId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, version: currentVersion }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Couldn’t save this decision. Try again.');
      if (typeof result.version === 'number') setCurrentVersion(result.version);
      setFeedback(saved);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Couldn’t save this decision. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const used = new Set(usedChannels);
  const unusedChannels = channels.filter((key) => !used.has(key));

  return (
    <div className="grid gap-4 border-t pt-4">
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Decision" htmlFor={`status-${contributionId}`}>
          <NativeSelect
            id={`status-${contributionId}`}
            value={current}
            onChange={(event) => setCurrent(event.currentTarget.value as CollaborationStatus)}
          >
            {Object.entries(COLLABORATION_STATUSES).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </NativeSelect>
        </Field>
        <Field
          label="Message to contributor"
          htmlFor={`message-${contributionId}`}
          hint="Optional. Copy it into your reply; nothing is emailed automatically."
        >
          <Input id={`message-${contributionId}`} value={message} maxLength={1000} onChange={(event) => setMessage(event.currentTarget.value)} />
        </Field>
      </div>
      <Field label="Internal notes" htmlFor={`notes-${contributionId}`} hint="Not shown to the contributor.">
        <Textarea id={`notes-${contributionId}`} rows={2} value={notes} maxLength={2000} onChange={(event) => setNotes(event.currentTarget.value)} />
      </Field>
      <div>
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => send({ action: 'set_status', status: current, contributorMessage: message, internalNotes: notes }, 'Decision saved.')}
        >
          Save decision
        </Button>
      </div>

      {current === 'approved' && channels.length > 0 && (
        <div className="grid gap-3 rounded-md border p-3">
          <p className="m-0 text-sm font-semibold">Record where it was used</p>
          {unusedChannels.length ? (
            <>
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="Channel" htmlFor={`channel-${contributionId}`}>
                  <NativeSelect
                    id={`channel-${contributionId}`}
                    value={channel}
                    onChange={(event) => setChannel(event.currentTarget.value as PublicationChannel)}
                  >
                    {unusedChannels.map((key) => (
                      <option key={key} value={key}>{PUBLICATION_CHANNELS[key]}</option>
                    ))}
                  </NativeSelect>
                </Field>
                <Field label="Where exactly" htmlFor={`reference-${contributionId}`} hint="A page address, campaign or issue.">
                  <Input id={`reference-${contributionId}`} value={reference} maxLength={200} onChange={(event) => setReference(event.currentTarget.value)} />
                </Field>
              </div>
              <div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy || !channel || reference.trim().length < 2}
                  onClick={() => send({ action: 'record_use', channel, reference }, 'Use recorded.')}
                >
                  Record use
                </Button>
              </div>
            </>
          ) : (
            <p className="m-0 text-sm text-muted-foreground">Every permitted channel has a use recorded.</p>
          )}
        </div>
      )}

      {feedback && <p role="status" className="m-0 text-sm text-muted-foreground">{feedback}</p>}
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
