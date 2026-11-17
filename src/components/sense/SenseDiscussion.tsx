import { useState } from 'react';
import type { SenseComment } from '../../lib/sense-box-options';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Field } from '../ui/field';
import { Textarea } from '../ui/textarea';

interface SenseDiscussionProps {
  submissionId: string;
  comments: SenseComment[];
  visibility?: 'public' | 'internal';
  canPost: boolean;
  canModerate?: boolean;
  signInHref?: string;
  signInLabel?: string;
  emptyText?: string;
}

export default function SenseDiscussion({
  submissionId,
  comments,
  visibility = 'public',
  canPost,
  canModerate = false,
  signInHref,
  signInLabel = 'Sign in to discuss',
  emptyText = 'No comments yet.',
}: SenseDiscussionProps) {
  const [items, setItems] = useState(comments);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  async function post(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const content = body.trim();
    if (content.length < 2) {
      setError('Write a comment before posting.');
      return;
    }
    setBusy(true);
    setError('');
    setStatus('Posting…');
    try {
      const response = await fetch('/api/sense-box/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ submissionId, body: content, visibility }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Could not post your comment.');
      setItems((current) => [...current, result.comment as SenseComment]);
      setBody('');
      setStatus('Posted.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not post your comment.');
      setStatus('');
    } finally {
      setBusy(false);
    }
  }

  async function remove(commentId: string) {
    setError('');
    setStatus('Removing…');
    try {
      const response = await fetch('/api/sense-box/comments', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commentId }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Could not remove that comment.');
      setItems((current) =>
        current.map((comment) =>
          comment.commentId === commentId
            ? { ...comment, body: '', deleted: true }
            : comment,
        ),
      );
      setStatus('Removed.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not remove that comment.');
      setStatus('');
    }
  }

  return (
    <div className="space-y-5">
      {items.length ? (
        <ol className="m-0 list-none space-y-4 p-0">
          {items.map((comment) => (
            <li key={comment.commentId} className="border-t pt-4 first:border-t-0 first:pt-0">
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <strong className="text-foreground">{comment.authorName}</strong>
                <time dateTime={comment.createdAt} data-local-time="off">{comment.createdAtLabel}</time>
                {comment.visibility === 'internal' && <Badge variant="warning">Organiser note</Badge>}
                {(comment.isMine || canModerate) && !comment.deleted && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => remove(comment.commentId)}>
                    Remove
                  </Button>
                )}
              </div>
              {comment.deleted ? (
                <p className="mt-1 mb-0 text-sm text-muted-foreground">This comment was removed.</p>
              ) : (
                <p className="mt-1 mb-0 whitespace-pre-wrap break-words">{comment.body}</p>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      )}

      {canPost ? (
        <form onSubmit={post} className="space-y-3 border-t pt-5">
          <Field
            label={visibility === 'internal' ? 'Add an organiser note' : 'Join the discussion'}
            htmlFor={`sense-comment-${visibility}`}
            hint={visibility === 'internal' ? 'Only reviewers for this branch can see organiser notes.' : 'Comments are public. Do not include personal or sensitive details about other people.'}
          >
            <Textarea
              id={`sense-comment-${visibility}`}
              name="body"
              rows={3}
              maxLength={2000}
              value={body}
              disabled={busy}
              onChange={(event) => setBody(event.target.value)}
              placeholder={visibility === 'internal' ? 'Record what the team decided or what to check next.' : 'Add your perspective or ask a question.'}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="sm" disabled={busy}>{busy ? 'Posting…' : 'Post comment'}</Button>
            <span role="status" aria-live="polite" className="text-sm text-muted-foreground">{status}</span>
          </div>
        </form>
      ) : signInHref ? (
        <div className="border-t pt-5">
          <Button href={signInHref} size="sm">{signInLabel}</Button>
        </div>
      ) : null}

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
