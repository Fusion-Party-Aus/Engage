import { useState } from 'react';
import { Alert, AlertDescription } from '../ui/alert';
import { Button } from '../ui/button';
import { Field } from '../ui/field';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { SearchPicker, type PickerResult } from '../admin-search-picker';

interface Owner {
  id: string;
  name: string;
  status: string;
}

interface Events {
  at: string;
  actorId: string;
  changedFields: string[];
}

interface Owners {
  assigned: boolean;
  primary: Owner | null;
  backup: Owner | null;
  retention: Owner | null;
  correctionEmail: string;
  escalationDetails: string;
  updatedAt: string | null;
  updatedBy: string | null;
  events: Events[];
}

function toPicker(owner: Owner | null): PickerResult | null {
  return owner ? { id: owner.id, label: owner.name, detail: owner.status } : null;
}

/**
 * Administrators assign the people responsible for corrections, continuity and
 * retention. Changes take effect immediately and are audited.
 */
export default function OperationalOwners({ initial }: { initial: Owners }) {
  const [owners, setOwners] = useState(initial);
  const [primary, setPrimary] = useState<PickerResult | null>(toPicker(initial.primary));
  const [backup, setBackup] = useState<PickerResult | null>(toPicker(initial.backup));
  const [retention, setRetention] = useState<PickerResult | null>(toPicker(initial.retention));
  const [correctionEmail, setCorrectionEmail] = useState(initial.correctionEmail);
  const [escalationDetails, setEscalationDetails] = useState(initial.escalationDetails);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');

  async function save() {
    if (busy) return;
    setBusy(true);
    setError('');
    setFeedback('');
    try {
      const response = await fetch('/api/admin/collaboration/operations', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          primaryOwnerId: primary?.id ?? '',
          backupOwnerId: backup?.id ?? '',
          retentionOwnerId: retention?.id ?? '',
          correctionEmail,
          escalationDetails,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Couldn’t save the operational owners. Try again.');
      if (result.owners) {
        setOwners(result.owners as Owners);
        setPrimary(toPicker((result.owners as Owners).primary));
        setBackup(toPicker((result.owners as Owners).backup));
        setRetention(toPicker((result.owners as Owners).retention));
      }
      setFeedback('Operational owners saved. The correction commitments now point to these people.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Couldn’t save the operational owners. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-5">
      <p className="m-0 text-sm text-muted-foreground">
        {owners.assigned
          ? 'Assigned. Changes take effect immediately and are recorded in the audit trail.'
          : 'Not yet assigned. Until all three people and a correction address are set, the pilot has no accountable coverage.'}
      </p>

      <SearchPicker
        label="Primary owner"
        placeholder="Search by name"
        type="member"
        endpoint="/api/admin/collaboration/members"
        value={primary}
        onChange={setPrimary}
        emptyHint="Type at least 2 letters of a member's name."
      />
      <SearchPicker
        label="Backup owner"
        placeholder="Search by name"
        type="member"
        endpoint="/api/admin/collaboration/members"
        value={backup}
        onChange={setBackup}
        emptyHint="A different person who can act when the primary is unavailable."
      />
      <SearchPicker
        label="Retention sweep owner"
        placeholder="Search by name"
        type="member"
        endpoint="/api/admin/collaboration/members"
        value={retention}
        onChange={setRetention}
        emptyHint="The person who runs the monthly retention sweep."
      />

      <Field
        label="Correction and removal address"
        htmlFor="operations-email"
        hint="Shown on public invitations. The primary owner monitors it."
      >
        <Input
          id="operations-email"
          type="email"
          value={correctionEmail}
          maxLength={254}
          onChange={(event) => setCorrectionEmail(event.currentTarget.value)}
        />
      </Field>

      <Field
        label="Escalation details"
        htmlFor="operations-escalation"
        hint="Who handles disputed consent, suspected unauthorised publication and unanswered requests."
      >
        <Textarea
          id="operations-escalation"
          rows={3}
          value={escalationDetails}
          maxLength={500}
          onChange={(event) => setEscalationDetails(event.currentTarget.value)}
        />
      </Field>

      {feedback && <p role="status" className="m-0 text-sm">{feedback}</p>}
      {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}

      <div>
        <Button type="button" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save operational owners'}</Button>
      </div>

      {owners.events.length > 0 && (
        <details>
          <summary>Recent changes</summary>
          <ul className="m-0 mt-2 grid list-none gap-2 p-0 text-sm text-muted-foreground">
            {owners.events.map((event, index) => (
              <li key={`${event.at}-${index}`}>
                {new Date(event.at).toLocaleString('en-AU')} · {event.actorId} ·{' '}
                {event.changedFields.length ? event.changedFields.join(', ') : 'no change'}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
