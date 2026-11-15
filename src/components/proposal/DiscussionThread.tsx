import * as React from 'react';
import {
  AlertCircle,
  ArrowBigDown,
  ArrowBigUp,
  ChevronDown,
  ChevronUp,
  ClipboardCheck,
  History,
  MessageCircle,
  MoreHorizontal,
  PenLine,
  Reply as ReplyIcon,
  ThumbsUp,
  Trash2,
} from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { trackEngage } from '../../lib/analytics.ts';
import {
  MAX_VISUAL_DEPTH,
  buildCommentThread,
  commentUpvotePercent,
  commentVoteTotal,
  countStances,
  type CommentThreadNode,
  type DiscussionComment,
  type DiscussionEvidence,
  type DiscussionFeedback,
  type DiscussionFeedbackEntry,
  type StanceFilter,
  type TopLevelSort,
} from '../../lib/comment-thread.ts';
import type {
  CommentStance,
  ContributionFeedbackStatus,
} from '../../lib/types.ts';
import './discussion-thread.css';

export interface EvidenceOption {
  group: string;
  value: string;
  label: string;
}

interface Props {
  proposalId: string;
  proposalTitle: string;
  proposalSlug: string;
  initialComments: DiscussionComment[];
  isSignedIn: boolean;
  canParticipate: boolean;
  canModerate: boolean;
  canRespondToFeedback: boolean;
  evidenceOptions: EvidenceOption[];
  initialSort?: TopLevelSort;
}

type FeedbackStatus = ContributionFeedbackStatus | 'clear';
type FeedbackAction = ContributionFeedbackStatus | 'cleared';

const STANCE_META: Record<
  CommentStance,
  {
    label: string;
    variant: 'success' | 'muted' | 'warning' | 'info';
    Icon: typeof ThumbsUp;
  }
> = {
  support: { label: 'Support', variant: 'success', Icon: ThumbsUp },
  concern: { label: 'Concern', variant: 'muted', Icon: AlertCircle },
  amendment: { label: 'Wording', variant: 'warning', Icon: PenLine },
  comment: { label: 'Comment', variant: 'info', Icon: MessageCircle },
};

const STANCE_FILTERS: Array<{ value: StanceFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'support', label: 'Support' },
  { value: 'concern', label: 'Concern' },
  { value: 'amendment', label: 'Wording' },
  { value: 'comment', label: 'Comment' },
];

const STANCE_CHOICES: Array<{ value: CommentStance; label: string }> = [
  { value: 'comment', label: 'Comment' },
  { value: 'support', label: 'Support' },
  { value: 'concern', label: 'Concern' },
  { value: 'amendment', label: 'Wording' },
];

const FEEDBACK_LABELS: Record<FeedbackAction, string> = {
  incorporated: 'Incorporated',
  considered: 'Considered',
  deferred: 'Deferred',
  declined: 'Declined',
  cleared: 'Cleared',
};

/** Deterministic date label: identical during SSR and hydration. */
function formatCommentDate(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function commentDateTitle(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.toLocaleDateString('en-AU', {
    dateStyle: 'full',
    timeZone: 'UTC',
  })} (UTC)`;
}

function initialsFor(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || 'M'
  );
}

function stanceMeta(stance: CommentStance) {
  return STANCE_META[stance] ?? STANCE_META.comment;
}

function feedbackVariant(status: ContributionFeedbackStatus) {
  if (status === 'incorporated') return 'success' as const;
  if (status === 'considered') return 'info' as const;
  if (status === 'deferred') return 'warning' as const;
  return 'outline' as const;
}

function asIsoDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value ?? ''));
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function evidenceHref(kind: string, recordId: string, label?: string): string {
  if (kind === 'amendment') return `#amendment-${encodeURIComponent(recordId)}`;
  if (kind === 'revision') return `#revision-${encodeURIComponent(recordId)}`;
  if (kind === 'decision') return '#proposal-vote';
  if (kind === 'policy' && label?.startsWith('Adopted policy:')) {
    return `/policies/${encodeURIComponent(recordId)}/`;
  }
  return '';
}

function resolveEvidenceLabel(
  raw: { kind: string; recordId: string; label?: string },
  options: EvidenceOption[],
): string {
  if (raw.label) return raw.label;
  const option = options.find(
    (item) => item.value === `${raw.kind}:${raw.recordId}`,
  );
  return option?.label ?? 'Supporting evidence';
}

function displayEvidence(
  raw: { kind: string; recordId: string; label?: string; href?: string } | undefined,
  options: EvidenceOption[],
): DiscussionEvidence | undefined {
  if (!raw) return undefined;
  const label = resolveEvidenceLabel(raw, options);
  const href = raw.href ?? evidenceHref(raw.kind, raw.recordId, label);
  return { label, ...(href ? { href } : {}) };
}

function displayFeedback(
  raw: Record<string, any> | undefined | null,
  options: EvidenceOption[],
): DiscussionFeedback | undefined {
  if (!raw) return undefined;
  const evidence = raw.evidence
    ? displayEvidence(raw.evidence, options)
    : undefined;
  return {
    status: raw.status as ContributionFeedbackStatus,
    ...(raw.note ? { note: String(raw.note) } : {}),
    updatedByName: String(raw.updatedByName ?? 'Author'),
    updatedAt: asIsoDate(raw.updatedAt),
    ...(raw.evidence
      ? { evidenceRef: `${raw.evidence.kind}:${raw.evidence.recordId}` }
      : {}),
    ...(evidence ? { evidence } : {}),
  };
}

function displayHistory(
  raw: Array<Record<string, any>> | undefined,
  options: EvidenceOption[],
): DiscussionFeedbackEntry[] {
  return (raw ?? []).map((entry) => {
    const evidence = entry.evidence
      ? displayEvidence(entry.evidence, options)
      : undefined;
    return {
      action: entry.action as DiscussionFeedbackEntry['action'],
      ...(entry.note ? { note: String(entry.note) } : {}),
      updatedByName: String(entry.updatedByName ?? 'Author'),
      updatedAt: asIsoDate(entry.updatedAt),
      ...(evidence ? { evidence } : {}),
    };
  });
}

function fromApiComment(
  raw: Record<string, any>,
  options: EvidenceOption[],
): DiscussionComment {
  const stance = STANCE_CHOICES.some((choice) => choice.value === raw.stance)
    ? (raw.stance as CommentStance)
    : 'comment';
  return {
    commentId: String(raw.commentId),
    parentCommentId: raw.parentCommentId ?? null,
    authorName: String(raw.authorName ?? 'Verified Member'),
    stance,
    body: String(raw.body ?? ''),
    createdAt: asIsoDate(raw.createdAt),
    upvoteCount: Number(raw.upvoteCount ?? 0),
    downvoteCount: Number(raw.downvoteCount ?? 0),
    score: Number(
      raw.score ??
        Number(raw.upvoteCount ?? 0) - Number(raw.downvoteCount ?? 0),
    ),
    upvotedByMe: Boolean(raw.upvotedByMe),
    downvotedByMe: Boolean(raw.downvotedByMe),
    isMine: Boolean(raw.isMine),
    deleted: Boolean(raw.deleted),
    ...(raw.feedback
      ? { feedback: displayFeedback(raw.feedback, options) }
      : {}),
    ...(Array.isArray(raw.feedbackHistory) && raw.feedbackHistory.length
      ? { feedbackHistory: displayHistory(raw.feedbackHistory, options) }
      : {}),
  };
}

async function readJson(response: Response): Promise<Record<string, any>> {
  try {
    return (await response.json()) as Record<string, any>;
  } catch {
    return {};
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export default function DiscussionThread({
  proposalId,
  proposalTitle,
  proposalSlug,
  initialComments,
  isSignedIn,
  canParticipate,
  canModerate,
  canRespondToFeedback,
  evidenceOptions,
  initialSort = 'best',
}: Props) {
  const [comments, setComments] =
    React.useState<DiscussionComment[]>(initialComments);
  const [sort, setSort] = React.useState<TopLevelSort>(initialSort);
  const [stance, setStance] = React.useState<StanceFilter>('all');
  const [announcement, setAnnouncement] = React.useState('');
  const [deleteTarget, setDeleteTarget] =
    React.useState<DiscussionComment | null>(null);
  const [deleteError, setDeleteError] = React.useState('');
  const [deleting, setDeleting] = React.useState(false);

  const stanceCounts = React.useMemo(() => countStances(comments), [comments]);
  const tree = React.useMemo(
    () => buildCommentThread(comments, { sort, stance }),
    [comments, sort, stance],
  );

  const signInHref = `/member/?returnTo=${encodeURIComponent(
    `/proposals/${proposalSlug}/#deliberation`,
  )}&intent=deliberate&title=${encodeURIComponent(proposalTitle)}`;

  const createComment = async (input: {
    body: string;
    stance: CommentStance;
    parentCommentId?: string;
  }) => {
    const response = await fetch('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proposalId,
        body: input.body,
        stance: input.stance,
        ...(input.parentCommentId
          ? { parentCommentId: input.parentCommentId }
          : {}),
      }),
    });
    const data = await readJson(response);
    if (!response.ok) {
      throw new Error(String(data.error ?? 'Could not post your contribution.'));
    }
    const created = data.comment;
    if (!created?.commentId) {
      throw new Error('Could not confirm your contribution was saved.');
    }
    const next = fromApiComment(created, evidenceOptions);
    setComments((current) => [...current, next]);
    setAnnouncement(
      input.parentCommentId ? 'Reply posted.' : 'Contribution posted.',
    );
    return next;
  };

  const vote = async (
    commentId: string,
    action: 'upvote' | 'downvote',
  ) => {
    const response = await fetch('/api/comments', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commentId, action }),
    });
    const data = await readJson(response);
    if (!response.ok) {
      throw new Error(String(data.error ?? 'Could not record comment vote.'));
    }
    setComments((current) =>
      current.map((comment) =>
        comment.commentId === commentId
          ? {
              ...comment,
              upvoteCount: Number(
                data.upvoteCount ?? comment.upvoteCount,
              ),
              downvoteCount: Number(
                data.downvoteCount ?? comment.downvoteCount,
              ),
              score: Number(
                data.score ??
                  Number(data.upvoteCount ?? comment.upvoteCount) -
                    Number(data.downvoteCount ?? comment.downvoteCount),
              ),
              upvotedByMe: Boolean(data.hasUpvoted),
              downvotedByMe: Boolean(data.hasDownvoted),
            }
          : comment,
      ),
    );
    const active = data.hasUpvoted || data.hasDownvoted;
    setAnnouncement(
      action === 'upvote'
        ? active
          ? 'Upvote recorded.'
          : 'Upvote removed.'
        : active
          ? 'Downvote recorded.'
          : 'Downvote removed.',
    );
  };

  const saveFeedback = (
    commentId: string,
    result: Record<string, any>,
  ) => {
    setComments((current) =>
      current.map((comment) =>
        comment.commentId === commentId
          ? {
              ...comment,
              feedback: displayFeedback(result.feedback, evidenceOptions),
              feedbackHistory: displayHistory(
                result.feedbackHistory,
                evidenceOptions,
              ),
            }
          : comment,
      ),
    );
    setAnnouncement(result.feedback ? 'Response saved.' : 'Response cleared.');
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const response = await fetch(
        `/api/comments?commentId=${encodeURIComponent(deleteTarget.commentId)}`,
        { method: 'DELETE' },
      );
      const data = await readJson(response);
      if (!response.ok) {
        throw new Error(String(data.error ?? 'Could not delete contribution.'));
      }
      if (data.deleted) {
        const removedIds = new Set<string>(
          Array.isArray(data.prunedIds) && data.prunedIds.length > 0
            ? data.prunedIds.map(String)
            : [deleteTarget.commentId],
        );
        setComments((current) =>
          current.filter((comment) => !removedIds.has(comment.commentId)),
        );
        setAnnouncement('Contribution deleted.');
      } else {
        setComments((current) =>
          current.map((comment) =>
            comment.commentId === deleteTarget.commentId
              ? { ...comment, body: '', deleted: true, feedback: undefined }
              : comment,
          ),
        );
        setAnnouncement(
          'Contribution deleted. Its replies remain in the discussion.',
        );
      }
      setDeleteTarget(null);
      setDeleteError('');
    } catch (error) {
      setDeleteError(errorMessage(error, 'Could not delete contribution.'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="discussion-thread" id="discussion-thread">
      <Composer
        canParticipate={canParticipate}
        isSignedIn={isSignedIn}
        signInHref={signInHref}
        onPost={createComment}
      />

      <div className="discussion-controls">
        <ToggleGroup
          type="single"
          value={stance}
          onValueChange={(next) => next && setStance(next as StanceFilter)}
          variant="outline"
          size="sm"
          className="discussion-stances"
          aria-label="Filter contributions by stance"
        >
          {STANCE_FILTERS.map((filter) => (
            <ToggleGroupItem
              key={filter.value}
              value={filter.value}
              className="discussion-stance"
            >
              {filter.value !== 'all' &&
                React.createElement(stanceMeta(filter.value).Icon, {
                  'aria-hidden': true,
                })}
              {filter.label}
              <span className="tabular discussion-stance__count">
                {stanceCounts[filter.value]}
              </span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        {comments.length > 1 && (
          <NativeSelect
            value={sort}
            onChange={(event) => setSort(event.target.value as TopLevelSort)}
            size="sm"
            wrapperClassName="w-auto"
            className="rounded-full"
            aria-label="Sort top-level contributions"
          >
            <option value="best">Best</option>
            <option value="top">Top score</option>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </NativeSelect>
        )}
      </div>

      {tree.length === 0 ? (
        <p className="discussion-empty">
          {comments.length === 0
            ? 'No contributions yet. Verified members can start the discussion using the form above.'
            : 'No contributions match this filter.'}
        </p>
      ) : (
        <ol className="comment-thread" aria-label="Discussion contributions">
          {tree.map((node) => (
            <CommentItem
              key={node.comment.commentId}
              node={node}
              canParticipate={canParticipate}
              canRespondToFeedback={canRespondToFeedback}
              canDelete={(comment) => comment.isMine || canModerate}
              deleteTargetId={deleteTarget?.commentId ?? null}
              deleting={deleting}
              deleteError={deleteError}
              onConfirmDelete={() => void confirmDelete()}
              onCancelDelete={() => {
                setDeleteTarget(null);
                setDeleteError('');
              }}
              evidenceOptions={evidenceOptions}
              onVote={vote}
              onReply={createComment}
              onFeedbackSaved={saveFeedback}
              onRequestDelete={(comment) => {
                setDeleteError('');
                setDeleteTarget(comment);
              }}
            />
          ))}
        </ol>
      )}

      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>

    </div>
  );
}

function Composer({
  canParticipate,
  isSignedIn,
  signInHref,
  onPost,
}: {
  canParticipate: boolean;
  isSignedIn: boolean;
  signInHref: string;
  onPost: (input: {
    body: string;
    stance: CommentStance;
  }) => Promise<DiscussionComment>;
}) {
  const [body, setBody] = React.useState('');
  const [stance, setStance] = React.useState<CommentStance>('comment');
  const [placeholder, setPlaceholder] = React.useState(
    'What would you like other members to consider?',
  );
  const [posting, setPosting] = React.useState(false);
  const [status, setStatus] = React.useState('');
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  if (!canParticipate) {
    return isSignedIn ? (
      <div className="discussion-notice">
        <div>
          <strong>Check your membership status</strong>
          <p>
            This account cannot post contributions yet. Check your membership
            status in My Engage.
          </p>
        </div>
        <Button href="/member/" variant="outline" size="sm">
          Check status
        </Button>
      </div>
    ) : (
      <div className="discussion-notice">
        <div>
          <strong>Have a perspective on this proposal?</strong>
          <p>Verified members can sign in to comment or vote on contributions.</p>
        </div>
        <Button href={signInHref} size="sm">
          Sign in to participate
        </Button>
      </div>
    );
  }

  const submit = async () => {
    const text = body.trim();
    if (text.length < 5 || posting) return;
    setPosting(true);
    setStatus('Posting…');
    trackEngage('contribution_attempted', { action: 'deliberation' });
    try {
      await onPost({ body: text, stance });
      trackEngage('contribution_result', {
        action: 'deliberation',
        outcome: 'success',
      });
      setBody('');
      setStatus('Contribution posted.');
    } catch (error) {
      trackEngage('contribution_result', {
        action: 'deliberation',
        outcome: 'failed',
      });
      setStatus(
        errorMessage(error, 'Could not post your contribution. Try again.'),
      );
    } finally {
      setPosting(false);
    }
  };

  return (
    <form
      id="comment-form"
      className="discussion-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="discussion-composer__box">
        <label htmlFor="comment-body-input" className="sr-only">
          Join the discussion
        </label>
        <Textarea
          ref={textareaRef}
          id="comment-body-input"
          name="body"
          required
          minLength={5}
          maxLength={4000}
          rows={3}
          value={body}
          placeholder={placeholder}
          aria-describedby="comment-char-count"
          className="discussion-composer__input focus-visible:ring-0"
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div className="discussion-composer__toolbar">
          <ToggleGroup
            type="single"
            value={stance}
            onValueChange={(next) => next && setStance(next as CommentStance)}
            className="discussion-stances"
            aria-label="Contribution stance"
          >
            {STANCE_CHOICES.map((choice) => (
              <ToggleGroupItem
                key={choice.value}
                value={choice.value}
                className="discussion-stance"
              >
                {React.createElement(stanceMeta(choice.value).Icon, {
                  'aria-hidden': true,
                })}
                {choice.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          <div className="discussion-composer__submit">
            <span
              id="comment-char-count"
              className="discussion-composer__count tabular"
            >
              {body.length} / 4000
            </span>
            <span className="sr-only" role="status" aria-live="polite">
              {status}
            </span>
            <Button type="submit" size="sm" disabled={posting || body.trim().length < 5}>
              {posting ? 'Posting…' : 'Post'}
            </Button>
          </div>
        </div>
      </div>

      <div className="discussion-starters" aria-label="Quick stance starters">
        <span className="discussion-starters__hint">Prompts:</span>
        {[
          {
            stance: 'support' as const,
            label: 'I support this because…',
            placeholder:
              'What makes this proposal valuable or effective? Share the evidence or outcomes you support...',
          },
          {
            stance: 'concern' as const,
            label: 'I’m concerned about…',
            placeholder:
              'What unintended consequence, cost, or implementation risk should members consider?',
          },
          {
            stance: 'amendment' as const,
            label: 'I suggest changing…',
            placeholder:
              'Which sentence or commitment should be clarified, and what wording do you suggest?',
          },
          {
            stance: 'comment' as const,
            label: 'Clarifying question…',
            placeholder:
              'Ask a clarifying question or share context for other members...',
          },
        ].map((starter) => (
          <Button
            key={starter.stance}
            type="button"
            variant="outline"
            size="sm"
            className="discussion-starter"
            onClick={() => {
              setStance(starter.stance);
              setPlaceholder(starter.placeholder);
              textareaRef.current?.focus();
            }}
          >
            {starter.label}
          </Button>
        ))}
      </div>
    </form>
  );
}

function CommentItem({
  node,
  parentAuthorName,
  canParticipate,
  canRespondToFeedback,
  canDelete,
  deleteTargetId,
  deleteError,
  deleting,
  onConfirmDelete,
  onCancelDelete,
  evidenceOptions,
  onVote,
  onReply,
  onFeedbackSaved,
  onRequestDelete,
}: {
  node: CommentThreadNode<DiscussionComment>;
  parentAuthorName?: string;
  canParticipate: boolean;
  canRespondToFeedback: boolean;
  canDelete: (comment: DiscussionComment) => boolean;
  deleteTargetId: string | null;
  deleteError: string;
  deleting: boolean;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  evidenceOptions: EvidenceOption[];
  onVote: (
    commentId: string,
    action: 'upvote' | 'downvote',
  ) => Promise<void>;
  onReply: (input: {
    body: string;
    stance: CommentStance;
    parentCommentId?: string;
  }) => Promise<DiscussionComment>;
  onFeedbackSaved: (commentId: string, result: Record<string, any>) => void;
  onRequestDelete: (comment: DiscussionComment) => void;
}) {
  const comment = node.comment;
  const meta = stanceMeta(comment.stance);
  const [replying, setReplying] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [showHistory, setShowHistory] = React.useState(false);
  const [showFeedbackForm, setShowFeedbackForm] = React.useState(false);
  const [voting, setVoting] = React.useState<'upvote' | 'downvote' | null>(
    null,
  );
  const [actionError, setActionError] = React.useState('');
  const hasChildren = node.children.length > 0;
  const childrenId = `replies-${comment.commentId}`;
  const capped = node.depth >= MAX_VISUAL_DEPTH;
  const deeplyNested = node.depth >= MAX_VISUAL_DEPTH + 2;
  const showChildren = hasChildren && !collapsed;
  const canRemove = canDelete(comment);
  const hasHistory = Boolean(
    comment.feedbackHistory && comment.feedbackHistory.length > 0,
  );
  const canRecordFeedback = canRespondToFeedback && !comment.deleted;
  const canDeleteItem = canRemove && !comment.deleted;
  const hasMenuItems = hasHistory || canRecordFeedback || canDeleteItem;

  const handleVote = async (action: 'upvote' | 'downvote') => {
    setVoting(action);
    setActionError('');
    trackEngage('contribution_attempted', { action: 'comment_vote' });
    try {
      await onVote(comment.commentId, action);
      trackEngage('contribution_result', {
        action: 'comment_vote',
        outcome: 'success',
      });
    } catch (error) {
      trackEngage('contribution_result', {
        action: 'comment_vote',
        outcome: 'failed',
      });
      setActionError(errorMessage(error, 'Could not record comment vote.'));
    } finally {
      setVoting(null);
    }
  };

  return (
    <li
      className="comment"
      id={`comment-${comment.commentId}`}
      data-comment-id={comment.commentId}
      data-depth={node.depth}
      data-deep={deeplyNested ? 'true' : 'false'}
    >
      <article
        className="comment__article"
        aria-labelledby={`author-${comment.commentId}`}
      >
        <div className="comment__row">
          <Avatar
            size={node.depth === 0 ? 'default' : 'sm'}
            className="comment__avatar"
          >
            <AvatarFallback>{initialsFor(comment.authorName)}</AvatarFallback>
          </Avatar>

          <div className="comment__main">
            <header className="comment__meta">
              <strong
                className="comment__author"
                id={`author-${comment.commentId}`}
              >
                {comment.authorName}
              </strong>
              <Badge variant={meta.variant}>
                {meta.label}
              </Badge>
              <time
                className="comment__time tabular"
                dateTime={asIsoDate(comment.createdAt)}
                data-local-time="off"
                title={commentDateTitle(comment.createdAt)}
              >
                {formatCommentDate(comment.createdAt)}
              </time>
              {node.depth > 0 && parentAuthorName ? (
                <span className="comment__context">
                  replying to <strong>@{parentAuthorName}</strong>
                </span>
              ) : null}
              {comment.deleted ? (
                <span className="comment__deleted-label">deleted</span>
              ) : null}
            </header>

            <div className="comment__body">
              {comment.deleted ? (
                <p className="comment__deleted">Comment deleted.</p>
              ) : (
                <p>{comment.body}</p>
              )}
            </div>

            {comment.feedback && !comment.deleted && (
              <div className="comment__response">
                <Badge variant={feedbackVariant(comment.feedback.status)}>
                  {FEEDBACK_LABELS[comment.feedback.status]}
                </Badge>
                <div className="comment__response-copy">
                  {comment.feedback.note && <p>{comment.feedback.note}</p>}
                  {comment.feedback.evidence && (
                    <p className="comment__response-evidence">
                      <strong>Evidence:</strong>{' '}
                      {comment.feedback.evidence.href ? (
                        <a href={comment.feedback.evidence.href}>
                          {comment.feedback.evidence.label}
                        </a>
                      ) : (
                        <span>{comment.feedback.evidence.label}</span>
                      )}
                    </p>
                  )}
                  <p className="comment__response-meta">
                    Response by {comment.feedback.updatedByName} ·{' '}
                    {formatCommentDate(comment.feedback.updatedAt)}
                  </p>
                </div>
              </div>
            )}

            {showHistory && comment.feedbackHistory && (
              <ol className="comment__history" aria-label="Response history">
                {comment.feedbackHistory.map((entry, index) => (
                  <li key={`${comment.commentId}-history-${index}`}>
                    <strong>{FEEDBACK_LABELS[entry.action]}</strong>
                    {entry.note ? ` — ${entry.note}` : ''}
                    {entry.evidence ? (
                      <>
                        {' · '}
                        {entry.evidence.href ? (
                          <a href={entry.evidence.href}>
                            {entry.evidence.label}
                          </a>
                        ) : (
                          <span>{entry.evidence.label}</span>
                        )}
                      </>
                    ) : null}
                    {' · '}
                    {entry.updatedByName} ({formatCommentDate(entry.updatedAt)})
                  </li>
                ))}
              </ol>
            )}

            {showFeedbackForm && !comment.deleted && (
              <FeedbackForm
                comment={comment}
                evidenceOptions={evidenceOptions}
                onSaved={(result) => {
                  onFeedbackSaved(comment.commentId, result);
                  setShowFeedbackForm(false);
                }}
                onCancel={() => setShowFeedbackForm(false)}
              />
            )}

            <div className="comment__actions">
              {!comment.deleted && (
                <div
                  className="comment__votes"
                  role="group"
                  aria-label={`Vote on ${comment.authorName}'s comment`}
                  title={
                    canParticipate
                      ? undefined
                      : 'Sign in and verify your membership to vote on contributions.'
                  }
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="comment__vote"
                    data-direction="up"
                    data-active={comment.upvotedByMe ? 'true' : 'false'}
                    aria-pressed={comment.upvotedByMe}
                    aria-label={`Upvote ${comment.authorName}'s comment`}
                    disabled={!canParticipate || voting !== null}
                    onClick={() => void handleVote('upvote')}
                  >
                    <ArrowBigUp aria-hidden="true" />
                  </Button>
                  <span
                    className="comment__score tabular"
                    title={`${commentUpvotePercent(comment)}% upvoted from ${commentVoteTotal(comment)} ${commentVoteTotal(comment) === 1 ? 'vote' : 'votes'}`}
                    aria-label={`Score ${comment.score}; ${commentUpvotePercent(comment)}% upvoted from ${commentVoteTotal(comment)} votes`}
                  >
                    {comment.score}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="comment__vote"
                    data-direction="down"
                    data-active={comment.downvotedByMe ? 'true' : 'false'}
                    aria-pressed={comment.downvotedByMe}
                    aria-label={`Downvote ${comment.authorName}'s comment`}
                    disabled={!canParticipate || voting !== null}
                    onClick={() => void handleVote('downvote')}
                  >
                    <ArrowBigDown aria-hidden="true" />
                  </Button>
                </div>
              )}

              {canParticipate && !comment.deleted && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="comment__action"
                  aria-expanded={replying}
                  onClick={() => {
                    setReplying((current) => !current);
                    setActionError('');
                  }}
                >
                  <ReplyIcon aria-hidden="true" />
                  Reply
                </Button>
              )}

              {hasChildren && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="comment__action"
                  aria-expanded={showChildren}
                  aria-controls={childrenId}
                  onClick={() => setCollapsed((current) => !current)}
                >
                  {showChildren ? (
                    <ChevronUp aria-hidden="true" />
                  ) : (
                    <ChevronDown aria-hidden="true" />
                  )}
                  {node.replyCount} {node.replyCount === 1 ? 'reply' : 'replies'}
                </Button>
              )}

              {hasMenuItems && (
                <Popover open={menuOpen} onOpenChange={setMenuOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="comment__action comment__action--overflow"
                      aria-label={`More actions for ${comment.authorName}'s comment`}
                    >
                      <MoreHorizontal aria-hidden="true" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="comment__menu">
                    <div className="comment__menu-list">
                      {hasHistory && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="comment__menu-item"
                          onClick={() => {
                            setShowHistory((current) => !current);
                            setMenuOpen(false);
                          }}
                        >
                          <History aria-hidden="true" />
                          {showHistory ? 'Hide' : 'Show'} response history (
                          {comment.feedbackHistory!.length})
                        </Button>
                      )}
                      {canRecordFeedback && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="comment__menu-item"
                          onClick={() => {
                            setShowFeedbackForm((current) => !current);
                            setMenuOpen(false);
                          }}
                        >
                          <ClipboardCheck aria-hidden="true" />
                          {comment.feedback ? 'Update response' : 'Record response'}
                        </Button>
                      )}
                      {canDeleteItem && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="comment__menu-item comment__menu-item--danger"
                          onClick={() => {
                            setMenuOpen(false);
                            onRequestDelete(comment);
                          }}
                        >
                          <Trash2 aria-hidden="true" />
                          Delete
                        </Button>
                      )}
                    </div>
                  </PopoverContent>
                </Popover>
              )}
            </div>

            {deleteTargetId === comment.commentId && (
              <div
                className="comment__confirm"
                role="alertdialog"
                aria-label="Confirm deletion"
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.stopPropagation();
                    onCancelDelete();
                  }
                }}
              >
                <p>
                  Delete this contribution?{' '}
                  {hasChildren
                    ? 'Replies will remain under a deleted placeholder.'
                    : 'This cannot be undone.'}
                </p>
                {deleteError && (
                  <p className="comment__error" role="alert">
                    {deleteError}
                  </p>
                )}
                <div className="comment__confirm-actions">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    autoFocus
                    disabled={deleting}
                    onClick={onCancelDelete}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={deleting}
                    onClick={onConfirmDelete}
                  >
                    {deleting ? 'Deleting…' : 'Delete'}
                  </Button>
                </div>
              </div>
            )}

            {actionError && (
              <p className="comment__error" role="alert">
                {actionError}
              </p>
            )}

            {replying && canParticipate && !comment.deleted && (
              <ReplyComposer
                authorName={comment.authorName}
                onCancel={() => setReplying(false)}
                onSubmit={async (input) => {
                  await onReply({
                    ...input,
                    parentCommentId: comment.commentId,
                  });
                  setReplying(false);
                }}
              />
            )}
          </div>
        </div>

        {hasChildren && (
          <ol
            id={childrenId}
            className="comment__children"
            data-capped={capped ? 'true' : 'false'}
            data-deep={deeplyNested ? 'true' : 'false'}
            hidden={!showChildren}
          >
            {node.children.map((child) => (
              <CommentItem
                key={child.comment.commentId}
                node={child}
                parentAuthorName={comment.authorName}
                canParticipate={canParticipate}
                canRespondToFeedback={canRespondToFeedback}
                canDelete={canDelete}
                deleteTargetId={deleteTargetId}
                deleteError={deleteError}
                deleting={deleting}
                onConfirmDelete={onConfirmDelete}
                onCancelDelete={onCancelDelete}
                evidenceOptions={evidenceOptions}
                onVote={onVote}
                onReply={onReply}
                onFeedbackSaved={onFeedbackSaved}
                onRequestDelete={onRequestDelete}
              />
            ))}
          </ol>
        )}
      </article>
    </li>
  );
}

function ReplyComposer({
  authorName,
  onSubmit,
  onCancel,
}: {
  authorName: string;
  onSubmit: (input: { body: string; stance: CommentStance }) => Promise<void>;
  onCancel: () => void;
}) {
  const [body, setBody] = React.useState('');
  const [stance, setStance] = React.useState<CommentStance>('comment');
  const [posting, setPosting] = React.useState(false);
  const [localError, setLocalError] = React.useState('');
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const replyId = React.useId();

  React.useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const submit = async () => {
    const text = body.trim();
    if (text.length < 5 || posting) return;
    setPosting(true);
    setLocalError('');
    try {
      await onSubmit({ body: text, stance });
      setBody('');
    } catch (error) {
      setLocalError(errorMessage(error, 'Could not post your reply.'));
    } finally {
      setPosting(false);
    }
  };

  return (
    <form
      className="reply-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <label htmlFor={replyId} className="reply-composer__label">
        Replying to {authorName}
      </label>
      <Textarea
        ref={textareaRef}
        id={replyId}
        value={body}
        rows={3}
        maxLength={4000}
        minLength={5}
        required
        placeholder="Add your reply…"
        className="reply-composer__input"
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div className="reply-composer__footer">
        <NativeSelect
          value={stance}
          onChange={(event) => setStance(event.target.value as CommentStance)}
          size="sm"
          wrapperClassName="w-auto"
          aria-label="Reply stance"
        >
          {STANCE_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </NativeSelect>
        <span className="reply-composer__count tabular">
          {body.length} / 4000
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={posting || body.trim().length < 5}
        >
          {posting ? 'Replying…' : 'Reply'}
        </Button>
      </div>
      {localError && (
        <p className="comment__error" role="alert">
          {localError}
        </p>
      )}
    </form>
  );
}

function FeedbackForm({
  comment,
  evidenceOptions,
  onSaved,
  onCancel,
}: {
  comment: DiscussionComment;
  evidenceOptions: EvidenceOption[];
  onSaved: (result: Record<string, any>) => void;
  onCancel: () => void;
}) {
  const [status, setStatus] = React.useState<FeedbackStatus>(
    comment.feedback?.status ?? 'considered',
  );
  const [note, setNote] = React.useState(comment.feedback?.note ?? '');
  const [evidenceRef, setEvidenceRef] = React.useState(
    comment.feedback?.evidenceRef ?? '',
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');
  const groups = [...new Set(evidenceOptions.map((option) => option.group))];

  const submit = async () => {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      const response = await fetch('/api/comments', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commentId: comment.commentId,
          status,
          note,
          evidenceRef,
        }),
      });
      const data = await readJson(response);
      if (!response.ok) {
        throw new Error(String(data.error ?? 'Could not save response.'));
      }
      onSaved(data);
    } catch (submitError) {
      setError(errorMessage(submitError, 'Could not save response.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="response-form"
      aria-label={`Response to ${comment.authorName}'s contribution`}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="response-form__row">
        <Field label="Contribution outcome" htmlFor={`feedback-status-${comment.commentId}`}>
          <NativeSelect
            id={`feedback-status-${comment.commentId}`}
            value={status}
            size="sm"
            onChange={(event) => setStatus(event.target.value as FeedbackStatus)}
          >
            <option value="incorporated">Incorporated</option>
            <option value="considered">Considered</option>
            <option value="deferred">Deferred</option>
            <option value="declined">Declined</option>
            {comment.feedback && <option value="clear">Clear response</option>}
          </NativeSelect>
        </Field>
        <Field
          label="Explanation for contributor (optional)"
          htmlFor={`feedback-note-${comment.commentId}`}
        >
          <Input
            id={`feedback-note-${comment.commentId}`}
            type="text"
            maxLength={500}
            value={note}
            placeholder="Short explanation"
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
      </div>

      {evidenceOptions.length > 0 && status !== 'clear' && (
        <Field
          label="Supporting evidence (optional)"
          htmlFor={`feedback-evidence-${comment.commentId}`}
        >
          <NativeSelect
            id={`feedback-evidence-${comment.commentId}`}
            value={evidenceRef}
            size="sm"
            onChange={(event) => setEvidenceRef(event.target.value)}
          >
            <option value="">None</option>
            {groups.map((group) => (
              <optgroup key={group} label={group}>
                {evidenceOptions
                  .filter((option) => option.group === group)
                  .map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
              </optgroup>
            ))}
          </NativeSelect>
        </Field>
      )}

      <div className="response-form__actions">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? 'Saving…' : 'Save response'}
        </Button>
      </div>
      {error && (
        <p className="comment__error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
