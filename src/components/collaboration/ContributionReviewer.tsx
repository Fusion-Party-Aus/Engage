import { useRef, useState } from 'react';
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

interface HistoryEntry {
  channel: PublicationChannel;
  reference: string;
  recordedAt: string;
}

interface Props {
  contributionId: string;
  version: number;
  status: CollaborationStatus;
  /** Channels the contributor permitted. Empty means private only. */
  channels: PublicationChannel[];
  history: HistoryEntry[];
  initialNotes: string;
  initialMessage: string;
  acceptedAt: string | null;
  galleryHiddenAt: string | null;
  initiativeSlug: string;
}

/**
 * Reviewer actions for one contribution. Existing notes and messages are loaded
 * so a status change cannot erase an earlier record. Accepting private input is
 * separate from approving publication.
 */
export default function ContributionReviewer({
  contributionId,
  version,
  status,
  channels,
  history,
  initialNotes,
  initialMessage,
  acceptedAt,
  galleryHiddenAt,
  initiativeSlug,
}: Props) {
  const [current, setCurrent] = useState<CollaborationStatus>(status);
  const [savedStatus, setSavedStatus] = useState<CollaborationStatus>(status);
  // The select's value is read synchronously on save: a reviewer can choose and
  // click before React has re-rendered.
  const statusRef = useRef<CollaborationStatus>(status);
  const channelRef = useRef<PublicationChannel | ''>(channels[0] ?? '');
  const [currentVersion, setCurrentVersion] = useState(version);
  const [notes, setNotes] = useState(initialNotes);
  const [message, setMessage] = useState(initialMessage);
  const [accepted, setAccepted] = useState(acceptedAt);
  const [galleryHidden, setGalleryHidden] = useState(Boolean(galleryHiddenAt));
  const [uses, setUses] = useState<HistoryEntry[]>(history);
  const [channel, setChannel] = useState<PublicationChannel | ''>(channels[0] ?? '');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');

  // Selecting "withdrawn" is a draft choice; only a saved withdrawal is terminal.
  const terminal = savedStatus === 'withdrawn';

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
      if (typeof result.status === 'string') setSavedStatus(result.status as CollaborationStatus);
      setFeedback(saved);
      return result as Record<string, unknown>;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Couldn’t save this decision. Try again.');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function recordUse() {
    if (!channel) return;
    const result = await send({ action: 'record_use', channel: channelRef.current, reference }, 'Use recorded.');
    if (result) {
      setUses((currentUses) => [
        ...currentUses,
        { channel: channelRef.current as PublicationChannel, reference: reference.trim(), recordedAt: new Date().toISOString() },
      ]);
      setReference('');
    }
  }

  async function toggleGallery() {
    const next = !galleryHidden;
    const result = await send(
      { action: 'set_gallery_visibility', hidden: next },
      next ? 'Removed from the public gallery.' : 'Returned to the public gallery.',
    );
    if (result) setGalleryHidden(next);
  }

  async function acceptInput() {
    const result = await send({ action: 'accept_input' }, 'Accepted as consultation input.');
    if (result) setAccepted(String(result.acceptedAt ?? new Date().toISOString()));
  }

  return (
    <div className="grid gap-4 border-t pt-4">
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Decision" htmlFor={`status-${contributionId}`}>
          <NativeSelect
            id={`status-${contributionId}`}
            value={current}
            onChange={(event) => {
              statusRef.current = event.currentTarget.value as CollaborationStatus;
              setCurrent(statusRef.current);
            }}
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
          <Input
            id={`message-${contributionId}`}
            value={message}
            maxLength={1000}
            onChange={(event) => setMessage(event.currentTarget.value)}
          />
        </Field>
      </div>
      <Field label="Internal notes" htmlFor={`notes-${contributionId}`} hint="Not shown to the contributor.">
        <Textarea
          id={`notes-${contributionId}`}
          rows={2}
          value={notes}
          maxLength={2000}
          onChange={(event) => setNotes(event.currentTarget.value)}
        />
      </Field>

      {terminal ? (
        <p className="m-0 text-sm text-muted-foreground">
          This contribution was withdrawn and its material removed. The decision cannot be reopened.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() =>
              send(
                { action: 'set_status', status: statusRef.current, contributorMessage: message, internalNotes: notes },
                'Decision saved.',
              )
            }
          >
            Save decision
          </Button>
          {!accepted && (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={acceptInput}>
              Accept as consultation input
            </Button>
          )}
          {accepted && <span className="text-sm text-muted-foreground">Accepted as input, not published.</span>}
        </div>
      )}
      {current === 'withdrawn' && !terminal && (
        <p className="m-0 text-sm text-muted-foreground">
          Withdrawing removes the story text, name, contact address and photographs. The review record stays.
        </p>
      )}

      {savedStatus === 'approved' && channels.includes('website') && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={toggleGallery}>
            {galleryHidden ? 'Show in gallery' : 'Hide from gallery'}
          </Button>
          <a href={`/collaborate/${initiativeSlug}/stories/`}>View the public gallery</a>
          {galleryHidden && <span className="text-muted-foreground">Hidden from the public gallery.</span>}
        </div>
      )}

      {current === 'approved' && channels.length > 0 && (
        <div className="grid gap-3 rounded-md border p-3">
          <p className="m-0 text-sm font-semibold">Record where it was used</p>
          <div className="grid gap-3 md:grid-cols-2">
            <Field
              label="Channel"
              htmlFor={`channel-${contributionId}`}
              hint="The same channel can be recorded more than once for a different page or campaign."
            >
              <NativeSelect
                id={`channel-${contributionId}`}
                value={channel}
                onChange={(event) => {
                  channelRef.current = event.currentTarget.value as PublicationChannel;
                  setChannel(channelRef.current);
                }}
              >
                {channels.map((key) => (
                  <option key={key} value={key}>{PUBLICATION_CHANNELS[key]}</option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Where exactly" htmlFor={`reference-${contributionId}`} hint="A page address, campaign or issue.">
              <Input
                id={`reference-${contributionId}`}
                value={reference}
                maxLength={200}
                onChange={(event) => setReference(event.currentTarget.value)}
              />
            </Field>
          </div>
          <div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || !channel || reference.trim().length < 2}
              onClick={recordUse}
            >
              Record use
            </Button>
          </div>
          {uses.length > 0 && (
            <ul className="m-0 grid list-none gap-1 p-0 text-sm text-muted-foreground">
              {uses.map((entry, index) => (
                <li key={`${entry.channel}-${entry.recordedAt}-${index}`}>
                  {PUBLICATION_CHANNELS[entry.channel]}: {entry.reference} ·{' '}
                  {new Date(entry.recordedAt).toLocaleDateString('en-AU')}
                </li>
              ))}
            </ul>
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
