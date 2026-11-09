import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';

export interface Feedback {
  tone: 'success' | 'error' | 'info';
  text: string;
}

/** Polite live region used under every save/confirm action. */
export function StatusLine({ feedback, className }: { feedback: Feedback | null; className?: string }) {
  return (
    <p
      role={feedback?.tone === 'error' ? 'alert' : 'status'}
      aria-live="polite"
      className={cn(
        'min-h-5 text-sm',
        feedback?.tone === 'error' && 'font-semibold [color:var(--horizon-danger-ink)]',
        feedback?.tone === 'success' && 'font-medium [color:var(--horizon-success-ink)]',
        feedback?.tone === 'info' && 'text-muted-foreground',
        className,
      )}
    >
      {feedback?.text ?? ''}
    </p>
  );
}

export interface ConfirmRequest {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
}

export type ConfirmPrompt = Omit<ConfirmRequest, 'onConfirm'>;

/** One accessible confirmation dialog (Radix AlertDialog: focus trapped, Escape cancels). */
export function ConfirmDialog({
  request,
  onClose,
}: {
  request: ConfirmRequest | null;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  useEffect(() => setBusy(false), [request]);
  return (
    <AlertDialog open={Boolean(request)} onOpenChange={(open) => !open && !busy && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{request?.title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>{request?.description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={request?.destructive ? 'destructive' : 'default'}
            disabled={busy}
            onClick={async (event) => {
              event.preventDefault();
              setBusy(true);
              try {
                await request?.onConfirm();
              } finally {
                setBusy(false);
                onClose();
              }
            }}
          >
            {busy ? 'Working…' : request?.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Warn before the tab closes while any area has unsaved edits. */
export function useUnsavedGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
}

export function SaveBar({
  dirty,
  saving,
  feedback,
  onDiscard,
  saveLabel = 'Save changes',
}: {
  dirty: boolean;
  saving: boolean;
  feedback: Feedback | null;
  onDiscard: () => void;
  saveLabel?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-t px-5 py-3">
      <StatusLine feedback={dirty && !feedback ? { tone: 'info', text: 'You have unsaved changes.' } : feedback} className="mr-auto" />
      <Button type="button" variant="ghost" size="sm" disabled={!dirty || saving} onClick={onDiscard}>
        Discard
      </Button>
      <Button type="submit" size="sm" disabled={!dirty || saving}>
        {saving ? 'Saving…' : saveLabel}
      </Button>
    </div>
  );
}

export function SectionCard({
  title,
  description,
  children,
  id,
}: {
  title: string;
  description: string;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="min-w-0 rounded-xl border bg-background">
      <header className="border-b px-5 py-4">
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          {title}
        </h2>
        <p className="mt-1 max-w-[65ch] text-sm text-muted-foreground">{description}</p>
      </header>
      {children}
    </section>
  );
}

export function relativeDate(value: string | Date | undefined): string {
  if (!value) return 'Not recorded';
  return new Date(value).toLocaleString('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Australia/Melbourne',
  });
}
