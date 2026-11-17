import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '../ui/alert';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Field } from '../ui/field';
import { Textarea } from '../ui/textarea';
import { COLLABORATION_STATUSES, type CollaborationStatus } from '../../lib/collaboration-options';

interface ManagedView {
  contributionId: string;
  initiativeTitle: string;
  profile: 'story' | 'consultation';
  answers: Array<{ key: string; label: string; text: string }>;
  caption: string;
  status: CollaborationStatus;
  published: boolean;
  hiddenFromGallery: boolean;
  contactAllowed: boolean;
  emailMasked: string;
  claimedByMemberId: string | null;
  claimedAt: string | null;
  createdAt: string;
}

type TokenState = 'missing' | 'loading' | 'ready' | 'invalid';

/**
 * The contributor's private link. The token lives in the URL fragment, so it is
 * never sent to the server in a URL and never appears in a referrer.
 */
export default function ManageContribution() {
  const [token, setToken] = useState('');
  const [state, setState] = useState<TokenState>('loading');
  const [view, setView] = useState<ManagedView | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [caption, setCaption] = useState('');
  const [withdrawn, setWithdrawn] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [session, setSession] = useState<null | { memberId: string; name: string }>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [linkConsent, setLinkConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const fromHash = window.location.hash.replace(/^#/, '');
    if (!fromHash) {
      setState('missing');
      return;
    }
    setToken(fromHash);
    fetch('/api/session', { headers: { accept: 'application/json' } })
      .then((response) => response.json())
      .then((data) => {
        const identity = data?.identity;
        if (identity?.memberId) setSession({ memberId: String(identity.memberId), name: String(identity.name ?? '') });
      })
      .catch(() => {})
      .finally(() => setSessionLoaded(true));
    call(fromHash, 'view').then((result) => {
      if (result?.view) {
        setView(result.view as ManagedView);
        setAnswers(Object.fromEntries((result.view as ManagedView).answers.map((answer) => [answer.key, answer.text])));
        setCaption((result.view as ManagedView).caption);
        setState('ready');
      } else {
        setState('invalid');
      }
    });
    // Runs once: the fragment is the credential.
  }, []);

  async function call(currentToken: string, action: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/collaboration/manage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: currentToken, action, ...extra }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Couldn’t open your link. Try again.');
      return result as Record<string, unknown>;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Couldn’t open your link. Try again.');
      setState((current) => (current === 'loading' ? 'invalid' : current));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function saveCorrections() {
    const result = await call(token, 'correct', { answers, caption });
    if (result) {
      setFeedback('Saved. Your contribution is back with the team for review and has been removed from the public gallery.');
      setView((current) => current ? { ...current, status: 'needs_follow_up', published: false } : current);
    }
  }

  async function hideFromGallery() {
    const result = await call(token, 'hide');
    if (result) {
      setView((current) => current ? { ...current, published: false, hiddenFromGallery: true } : current);
      setFeedback('Removed from the public gallery. Your approval is unchanged.');
    }
  }

  async function linkToAccount() {
    if (!linkConsent) return;
    const result = await call(token, 'claim', { consentToLink: true });
    if (result) {
      setView((current) => current ? { ...current, claimedByMemberId: session?.memberId ?? null } : current);
      setFeedback('Linked to your account. You can unlink at any time.');
    }
  }

  async function unlinkFromAccount() {
    const result = await call(token, 'unclaim');
    if (result) {
      setView((current) => current ? { ...current, claimedByMemberId: null } : current);
      setFeedback('Unlinked from your account. The private link still works.');
    }
  }

  async function withdraw() {
    const result = await call(token, 'withdraw');
    if (result) {
      setWithdrawn(true);
      setFeedback('Your contribution has been withdrawn. The story text, name, contact details and photographs have been deleted.');
    }
  }

  if (state === 'missing') {
    return (
      <div className="grid gap-4">
        <h2 className="m-0">Open the link from your confirmation</h2>
        <p className="m-0">
          The link is unique to your contribution and includes a private code. We can’t find it from your name or
          email. If you have lost it, email the address on the invitation.
        </p>
        <div><Button href="/collaborate/">See open invitations</Button></div>
      </div>
    );
  }

  if (state === 'invalid') {
    return (
      <div className="grid gap-4">
        <h2 className="m-0">This link isn’t valid</h2>
        <p className="m-0">Check that you copied the whole link. If it still fails, email the address on the invitation.</p>
        {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
      </div>
    );
  }

  if (state === 'loading' || !view) {
    return <p role="status">Opening your contribution…</p>;
  }

  if (withdrawn) {
    return (
      <div className="grid gap-4">
        <h2 className="m-0">Withdrawn</h2>
        <p className="m-0">{feedback}</p>
        <p className="m-0 text-sm text-muted-foreground">
          Copies someone already downloaded, screenshotted or printed cannot be recalled. Email the invitation’s
          address if you need help with one.
        </p>
        <div><Button href="/collaborate/">See open invitations</Button></div>
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      <div className="grid gap-1 text-sm text-muted-foreground">
        <p className="m-0">
          {view.initiativeTitle} · sent {new Date(view.createdAt).toLocaleDateString('en-AU')}
        </p>
        <p className="m-0">Status: {COLLABORATION_STATUSES[view.status]}</p>
        <p className="m-0">
          {view.published
            ? 'Visible in the public gallery.'
            : view.hiddenFromGallery
              ? 'Hidden from the public gallery.'
              : 'Not in the public gallery.'}
        </p>
        {view.contactAllowed && view.emailMasked && <p className="m-0">Reply address: {view.emailMasked}</p>}
      </div>

      <div className="grid gap-4">
        {view.answers.map((answer) => (
          <Field key={answer.key} label={answer.label} htmlFor={`manage-${answer.key}`}>
            <Textarea
              id={`manage-${answer.key}`}
              rows={3}
              value={answers[answer.key] ?? ''}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setAnswers((current) => ({ ...current, [answer.key]: value }));
              }}
            />
          </Field>
        ))}
        {view.profile === 'story' && (
          <Field label="Photo caption" htmlFor="manage-caption" hint="Your photographs stay as they are.">
            <Textarea id="manage-caption" rows={2} value={caption} onChange={(event) => setCaption(event.currentTarget.value)} />
          </Field>
        )}
      </div>

      {sessionLoaded && session && (
        <div className="grid gap-2 rounded-md border p-4">
          <p className="m-0 font-semibold">Your Engage account</p>
          {view.claimedByMemberId === session.memberId ? (
            <>
              <p className="m-0 text-sm text-muted-foreground">
                Linked to your account as {session.name || 'this account'}.
              </p>
              <div><Button type="button" size="sm" variant="outline" disabled={busy} onClick={unlinkFromAccount}>Unlink</Button></div>
            </>
          ) : view.claimedByMemberId ? (
            <p className="m-0 text-sm text-muted-foreground">This contribution is linked to a different account.</p>
          ) : (
            <>
              <label className="flex items-start gap-3 text-sm">
                <Checkbox className="mt-0.5 size-5" checked={linkConsent} onChange={(event) => setLinkConsent(event.currentTarget.checked)} />
                <span>Link this contribution to my account{session.name ? ` (${session.name})` : ''}.</span>
              </label>
              <p className="m-0 text-sm text-muted-foreground">
                Optional. It does not change publication, approval, or who can manage this contribution. The
                private link remains the only way to correct or withdraw it.
              </p>
              <div><Button type="button" size="sm" disabled={busy || !linkConsent} onClick={linkToAccount}>Link to my account</Button></div>
            </>
          )}
        </div>
      )}
      {sessionLoaded && !session && (
        <p className="m-0 text-sm text-muted-foreground">
          Optional: if you sign in and reopen this private link, you can connect the contribution to your
          account.
        </p>
      )}

      {feedback && <p role="status" className="m-0 text-sm">{feedback}</p>}
      {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={saveCorrections} disabled={busy}>Save corrections</Button>
        {view.published && (
          <Button type="button" variant="outline" onClick={hideFromGallery} disabled={busy}>
            Remove from public gallery
          </Button>
        )}
        {!confirming && (
          <Button type="button" variant="destructive" disabled={busy} onClick={() => setConfirming(true)}>
            Withdraw completely
          </Button>
        )}
      </div>

      {confirming && (
        <Alert variant="destructive">
          <AlertDescription className="grid gap-3">
            <span>
              Withdrawing deletes your story, name, contact details and photographs. It cannot be undone, and
              any copy already downloaded or printed cannot be recalled by us.
            </span>
            <span className="flex flex-wrap gap-3">
              <Button type="button" variant="destructive" autoFocus disabled={busy} onClick={withdraw}>
                Yes, withdraw it
              </Button>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirming(false)}>
                Keep it
              </Button>
            </span>
          </AlertDescription>
        </Alert>
      )}

      <p className="m-0 text-sm text-muted-foreground">
        Corrections go back to the team for review before anything appears publicly. Withdrawing removes the
        material at once.
      </p>
    </div>
  );
}
