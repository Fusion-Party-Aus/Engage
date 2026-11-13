import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Play,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  ConfirmDialog,
  StatusLine,
  relativeDate,
  type ConfirmRequest,
  type Feedback,
} from '@/components/admin-kit';
import type {
  BranchParticipationPreview,
  MigrationStatus,
  StandardBranchPreview,
} from '@/lib/migrations';
import type { BallotExpiryMigrationReport } from '@/lib/ballot-expiry-migration';

const STATUS_COPY: Record<
  MigrationStatus['status'],
  { label: string; variant: 'success' | 'warning' | 'muted' | 'info' | 'destructive' }
> = {
  completed: { label: 'Complete', variant: 'success' },
  pending: { label: 'Ready to apply', variant: 'warning' },
  blocked: { label: 'Waiting for branches', variant: 'muted' },
  running: { label: 'Running', variant: 'info' },
  failed: { label: 'Needs attention', variant: 'destructive' },
};

function branchPreview(preview: StandardBranchPreview) {
  if (!preview.missing) {
    return {
      headline: `All ${preview.total} standard branches are present.`,
      detail: 'No branch records need to be added.',
    };
  }
  return {
    headline: `${preview.missing} of ${preview.total} standard branches need to be added.`,
    detail: `Already present: ${preview.existing}. Missing: ${preview.missingNames.join(', ')}.`,
  };
}

function participationPreview(preview: BranchParticipationPreview) {
  const changes =
    preview.annotatedMemberships +
    preview.createdSubscriptions +
    preview.assignedProposals;
  if (!changes) {
    return {
      headline: 'No participation changes are needed.',
      detail: `${preview.preservedMemberships} existing verified membership record${preview.preservedMemberships === 1 ? '' : 's'} remain preserved.`,
    };
  }
  return {
    headline: `${changes} safe, additive change${changes === 1 ? '' : 's'} ready.`,
    detail: [
      `${preview.annotatedMemberships} membership record${preview.annotatedMemberships === 1 ? '' : 's'} to annotate`,
      `${preview.createdSubscriptions} following preference${preview.createdSubscriptions === 1 ? '' : 's'} to add`,
      `${preview.assignedProposals} open proposal${preview.assignedProposals === 1 ? '' : 's'} to assign to National governance`,
    ].join(' · '),
  };
}

function ballotExpiryPreview(preview: BallotExpiryMigrationReport) {
  const { eligible, skipped, conflicting } = preview.counts;
  if (!eligible && !conflicting) {
    return {
      headline: 'All open formal ballots already have a closing date.',
      detail: `${skipped} existing deadline${skipped === 1 ? '' : 's'} preserved.`,
    };
  }
  return {
    headline: `${eligible} open ballot${eligible === 1 ? '' : 's'} ready for ${preview.targetDeadlineLabel}.`,
    detail: [
      `${skipped} with existing deadline preserved`,
      `${conflicting} needing manual review`,
    ].join(' · '),
  };
}

export default function AdminMigrations({ initial }: { initial: MigrationStatus[] }) {
  const [migrations, setMigrations] = useState(initial);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  useEffect(() => setMigrations(initial), [initial]);

  const pending = useMemo(
    () => migrations.filter((migration) => migration.ready),
    [migrations],
  );

  async function refresh() {
    setBusy('refresh');
    const response = await fetch('/api/admin/migrations', {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    const data = (await response.json().catch(() => ({}))) as {
      migrations?: MigrationStatus[];
      error?: string;
    };
    setBusy(null);
    if (!response.ok) {
      setFeedback({ tone: 'error', text: data.error || 'Could not load migration status.' });
      return;
    }
    if (data.migrations) setMigrations(data.migrations);
    setFeedback({ tone: 'info', text: 'Migration status refreshed.' });
  }

  async function apply(action: 'apply' | 'apply-all', migrationId?: string) {
    setBusy(action === 'apply-all' ? 'all' : migrationId ?? 'apply');
    setFeedback({ tone: 'info', text: 'Running migration. This can take a moment…' });
    const response = await fetch('/api/admin/migrations', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, migrationId }),
    });
    const data = (await response.json().catch(() => ({}))) as {
      migrations?: MigrationStatus[];
      message?: string;
      error?: string;
    };
    setBusy(null);
    if (!response.ok) {
      setFeedback({ tone: 'error', text: data.error || 'The migration could not be completed.' });
      return;
    }
    if (data.migrations) setMigrations(data.migrations);
    setFeedback({
      tone: 'success',
      text: data.message || 'Migration completed. The recorded result is shown below.',
    });
  }

  function confirmApply(migration: MigrationStatus) {
    setConfirm({
      title:
        migration.id === 'standard-branches'
          ? 'Add missing standard branches?'
          : 'Apply the branch participation migration?',
      description: (
        <div className="grid gap-2 text-sm">
          {migration.id === 'standard-branches' ? (
            <p>
              Adds Fusion National, the state and territory branches when they are missing. Existing branches are
              left exactly as they are. This is safe to run more than once.
            </p>
          ) : (
            <p>
              Adds source and verification metadata to existing branch memberships, records a following preference for
              existing verified members, and gives open proposals without a branch context National governance scope.
              Votes, ballot revisions, completed decisions and member records are not deleted or reinterpreted.
            </p>
          )}
          <p className="text-muted-foreground">
            The result is recorded in the administration log. If the operation is interrupted, it can be safely run
            again.
          </p>
        </div>
      ),
      confirmLabel: migration.id === 'standard-branches' ? 'Add missing branches' : 'Apply migration',
      onConfirm: () => apply('apply', migration.id),
    });
  }

  function confirmApplyAll() {
    setConfirm({
      title: 'Run all pending migrations?',
      description: (
        <p>
          Standard branches run first, followed by branch participation. Both operations are additive and restartable.
          Existing votes, ballot wording and member records are preserved.
        </p>
      ),
      confirmLabel: 'Run pending migrations',
      onConfirm: () => apply('apply-all'),
    });
  }

  return (
    <div className="grid gap-5">
      <section className="rounded-xl border bg-background">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
          <div className="max-w-[70ch]">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="gap-1">
                <Database aria-hidden="true" /> Database migrations
              </Badge>
              <span className="text-xs text-muted-foreground">National administrator only</span>
            </div>
            <h1 className="mt-2 font-heading text-2xl font-semibold text-[var(--horizon-purple-deep)]">
              Keep Engage’s data ready
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              These operations add missing structure and preserve existing governance records. They never delete
              ballots, votes or members, and every result is recorded here.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" disabled={Boolean(busy)} onClick={refresh}>
              <RefreshCw /> {busy === 'refresh' ? 'Refreshing…' : 'Refresh status'}
            </Button>
            {pending.length > 0 && (
              <Button type="button" size="sm" disabled={Boolean(busy)} onClick={confirmApplyAll}>
                <Play /> {busy === 'all' ? 'Running…' : 'Run pending migrations'}
              </Button>
            )}
          </div>
        </header>
        {feedback && (
          <div className="px-5 py-3">
            <StatusLine feedback={feedback} />
          </div>
        )}
      </section>

      <div className="grid gap-4">
        {migrations.map((migration, index) => {
          const copy = STATUS_COPY[migration.status];
          const blocked = migration.status === 'blocked';
          const preview = blocked
            ? {
                headline: 'Waiting for the standard branches.',
                detail: 'Participation changes will be previewed once Fusion National and the standard branches exist.',
              }
            : migration.preview.kind === 'branches'
              ? branchPreview(migration.preview.data)
              : migration.preview.kind === 'participation'
                ? participationPreview(migration.preview.data)
                : ballotExpiryPreview(migration.preview.data);
          const running = migration.status === 'running' || busy === migration.id;
          const complete = migration.status === 'completed';
          return (
            <section key={migration.id} aria-labelledby={`migration-${migration.id}`} className="rounded-xl border bg-background">
              <div className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="grid size-7 place-items-center rounded-full bg-[var(--horizon-lavender)] text-xs font-bold tabular-nums text-[var(--horizon-purple-deep)]">
                      {index + 1}
                    </span>
                    <h2 id={`migration-${migration.id}`} className="font-heading text-xl font-semibold text-[var(--horizon-purple-deep)]">
                      {migration.title}
                    </h2>
                    <Badge variant={copy.variant}>{copy.label}</Badge>
                  </div>
                  <p className="mt-2 max-w-[75ch] text-sm text-muted-foreground">{migration.description}</p>

                  <div className="mt-3 grid gap-1 rounded-lg border bg-[var(--horizon-lavender-soft)] px-4 py-3">
                    <p className="flex items-start gap-2 text-sm font-medium">
                      {complete ? (
                        <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[var(--horizon-success-ink)]" />
                      ) : blocked ? (
                        <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[var(--horizon-warn-ink)]" />
                      ) : (
                        <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[var(--horizon-purple)]" />
                      )}
                      {preview.headline}
                    </p>
                    <p className="pl-6 text-xs text-muted-foreground">{preview.detail}</p>
                  </div>

                  {migration.requires?.length ? (
                    <p className="mt-2 text-xs font-medium text-[var(--horizon-warn-ink)]">
                      Complete “Standard branches” first. The National branch must exist before participation facts are
                      interpreted.
                    </p>
                  ) : null}

                  {migration.lastRun?.lastError ? (
                    <div role="alert" className="mt-3 rounded-lg border border-[var(--horizon-danger-bg)] bg-[var(--horizon-danger-bg)] p-3 text-sm text-[var(--horizon-danger-ink)]">
                      <strong className="block">Last attempt did not complete.</strong>
                      <span>{migration.lastRun.lastError}</span>
                    </div>
                  ) : null}

                  {migration.lastRun?.lastCompletedAt ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Last completed {relativeDate(migration.lastRun.lastCompletedAt)}
                      {migration.lastRun.runCount > 1 ? ` · run ${migration.lastRun.runCount}` : ''}
                    </p>
                  ) : migration.lastRun?.lastStartedAt ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Last started {relativeDate(migration.lastRun.lastStartedAt)}
                    </p>
                  ) : null}
                </div>

                <div className="flex flex-wrap gap-2 lg:flex-col lg:items-stretch">
                  <Button
                    type="button"
                    size="sm"
                    disabled={Boolean(busy) || blocked || running || (!migration.ready && !complete)}
                    onClick={() => confirmApply(migration)}
                  >
                    <Play /> {running ? 'Running…' : complete ? 'Run again safely' : 'Apply migration'}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" disabled={Boolean(busy)} onClick={refresh}>
                    <RefreshCw /> Refresh
                  </Button>
                </div>
              </div>
            </section>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        The command line equivalents remain available for automated deployment:{' '}
        <code className="rounded bg-muted px-1.5 py-0.5">npm run branches:migrate</code> and{' '}
        <code className="rounded bg-muted px-1.5 py-0.5">npm run branches:participation-migrate</code>.
      </p>

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
