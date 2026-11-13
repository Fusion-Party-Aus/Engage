import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ExternalLink,
  Eye,
  GripVertical,
  History,
  MapPin,
  Plus,
  Server,
  Share2,
  SlidersHorizontal,
  Trash2,
  Undo2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import {
  ConfirmDialog,
  SaveBar,
  SectionCard,
  relativeDate,
  useUnsavedGuard,
  type ConfirmPrompt,
  type ConfirmRequest,
  type Feedback,
} from '@/components/admin-kit';
import { PLATFORM_LABELS, SOCIAL_PLATFORMS, isPublicHttpUrl, isSiteLink } from '@/lib/url-validation';
import { cn } from '@/lib/utils';

interface Social { label: string; href: string; platform?: string }
interface StateSite { code: string; name: string; websiteHref: string; facebookHref?: string; branchId?: string }
export interface Config {
  allowPublicIndexing: boolean;
  publicPulsePollEnabled: boolean;
  primaryCtaLabel: string;
  primaryCtaHref: string;
  showPrimaryCtaInHeader: boolean;
  defaultOgImage: string;
  socialLinks: Social[];
  stateSites: StateSite[];
  repoUrl: string;
  updatedAt?: string;
  updatedByName?: string;
}
export interface ConfigEvent {
  eventId: string;
  section: string;
  summary: string;
  actorName: string;
  changedFields: string[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  createdAt: string;
}

type SectionKey = 'visibility' | 'features' | 'social' | 'directory' | 'operations' | 'history';
const SECTIONS: Array<{ key: SectionKey; label: string; hint: string; icon: typeof Eye }> = [
  { key: 'visibility', label: 'Public visibility', hint: 'Search indexing, sharing previews and navigation', icon: Eye },
  { key: 'features', label: 'Features', hint: 'Enable and configure public features', icon: SlidersHorizontal },
  { key: 'social', label: 'Social channels', hint: 'Manage national social links', icon: Share2 },
  { key: 'directory', label: 'Branch directory', hint: 'Manage state and territory website links', icon: MapPin },
  { key: 'operations', label: 'Operations', hint: 'Public transparency and maintainer information', icon: Server },
  { key: 'history', label: 'Change history', hint: 'Review configuration changes and restore values', icon: History },
];

const FIELD_LABELS: Record<string, string> = {
  allowPublicIndexing: 'Search engine indexing',
  defaultOgImage: 'Sharing preview image',
  primaryCtaLabel: 'Header button label',
  primaryCtaHref: 'Header button link',
  showPrimaryCtaInHeader: 'Header button shown',
  publicPulsePollEnabled: 'Public sentiment poll trial',
  socialLinks: 'Social channels',
  stateSites: 'Branch directory',
};

type SaveResult = { ok: true } | { ok: false; error: string; fieldErrors: Record<string, string> };

let uid = 0;
const nextId = () => `row-${++uid}`;

function FieldRow({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('grid min-w-0 gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-sm font-semibold">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} role="alert" className="text-sm font-medium [color:var(--horizon-danger-ink)]">
          {error}
        </p>
      ) : hint ? (
        <p id={`${htmlFor}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function ToggleRow({
  id,
  label,
  description,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label id={`${id}-label`} htmlFor={id} className="text-sm font-semibold">
          {label}
        </label>
        <p className="mt-0.5 max-w-[60ch] text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} aria-labelledby={`${id}-label`} />
    </div>
  );
}

/* ---------- shared save hook ---------- */
function useDraftSection<T>(
  initial: T,
  save: (draft: T) => Promise<SaveResult>,
  confirmBefore?: (draft: T) => ConfirmPrompt | null,
  ask?: (r: ConfirmRequest) => void,
) {
  const [draft, setDraft] = useState<T>(initial);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const baseline = useRef(JSON.stringify(initial));
  const dirty = JSON.stringify(draft) !== baseline.current;

  const run = async () => {
    setSaving(true);
    setFeedback({ tone: 'info', text: 'Saving…' });
    const result = await save(draft);
    setSaving(false);
    if (result.ok) {
      baseline.current = JSON.stringify(draft);
      setErrors({});
      setFeedback({ tone: 'success', text: 'Saved. The public site will update within 30 seconds.' });
    } else {
      setErrors(result.fieldErrors);
      setFeedback({ tone: 'error', text: result.error });
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    setFeedback(null);
    const confirm = confirmBefore?.(draft) ?? null;
    if (confirm && ask) ask({ ...confirm, onConfirm: run });
    else void run();
  };
  const discard = () => {
    setDraft(JSON.parse(baseline.current));
    setErrors({});
    setFeedback(null);
    setAttempted(false);
  };
  return { draft, setDraft, saving, feedback, setFeedback, errors, attempted, dirty, submit, discard };
}

/* ---------- Public visibility ---------- */
function VisibilitySection({ config, save, onDirty, ask }: SectionProps) {
  const s = useDraftSection(
    {
      allowPublicIndexing: config.allowPublicIndexing,
      defaultOgImage: config.defaultOgImage,
      showPrimaryCtaInHeader: config.showPrimaryCtaInHeader,
      primaryCtaLabel: config.primaryCtaLabel,
      primaryCtaHref: config.primaryCtaHref,
    },
    (d) => save('visibility', d),
    (d) =>
      d.allowPublicIndexing !== config.allowPublicIndexing
        ? {
            title: d.allowPublicIndexing ? 'Let search engines list Engage?' : 'Hide Engage from search engines?',
            description: d.allowPublicIndexing
              ? 'Published policy and public proposals can start appearing in Google and Bing results.'
              : 'Engage pages will ask search engines not to list them. Pages already listed can take weeks to disappear.',
            confirmLabel: d.allowPublicIndexing ? 'Allow indexing' : 'Hide from search',
          }
        : null,
    ask,
  );
  useEffect(() => onDirty(s.dirty), [s.dirty]);
  const { draft, setDraft, errors, attempted } = s;
  const localErr = (key: string, bad: boolean, msg: string) => errors[key] ?? (attempted && bad ? msg : undefined);
  return (
    <SectionCard id="visibility" title="Public visibility" description="Control how Engage appears in search results, when links are shared, and in the site header.">
      <form onSubmit={s.submit} noValidate>
        <div className="grid gap-6 p-5 xl:grid-cols-[minmax(0,1fr)_17rem]">
          <div className="grid max-w-[40rem] gap-6">
            <ToggleRow
              id="allowPublicIndexing"
              label="Appear in search engines"
              description="When on, Google and Bing may list published policy and public proposals. Turn off while testing or before launch."
              checked={draft.allowPublicIndexing}
              onChange={(v) => setDraft({ ...draft, allowPublicIndexing: v })}
            />
            <FieldRow
              label="Sharing preview image"
              htmlFor="defaultOgImage"
              hint="Shown when someone shares an Engage link on social media or in a chat. Use a path like /engage-og-card.png or a full https:// address."
              error={localErr('defaultOgImage', !isSiteLink(draft.defaultOgImage), 'Enter an image path (starting with /) or a full https:// address.')}
            >
              <Input id="defaultOgImage" value={draft.defaultOgImage} aria-invalid={Boolean(errors.defaultOgImage)} onChange={(e) => setDraft({ ...draft, defaultOgImage: e.target.value })} />
            </FieldRow>
            <hr />
            <ToggleRow
              id="showPrimaryCtaInHeader"
              label="Show a call-to-action button in the header"
              description="A highlighted button at the start of the main menu, such as “Suggest an idea”."
              checked={draft.showPrimaryCtaInHeader}
              onChange={(v) => setDraft({ ...draft, showPrimaryCtaInHeader: v })}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <FieldRow label="Button label" htmlFor="primaryCtaLabel" error={localErr('primaryCtaLabel', !draft.primaryCtaLabel.trim(), 'Enter a label.')} hint="Up to 48 characters.">
                <Input id="primaryCtaLabel" maxLength={48} value={draft.primaryCtaLabel} aria-invalid={Boolean(errors.primaryCtaLabel)} onChange={(e) => setDraft({ ...draft, primaryCtaLabel: e.target.value })} />
              </FieldRow>
              <FieldRow label="Where the button goes" htmlFor="primaryCtaHref" error={localErr('primaryCtaHref', !isSiteLink(draft.primaryCtaHref), 'Enter a page on this site (starting with /) or a full https:// address.')} hint="For example /proposals/new/">
                <Input id="primaryCtaHref" value={draft.primaryCtaHref} aria-invalid={Boolean(errors.primaryCtaHref)} onChange={(e) => setDraft({ ...draft, primaryCtaHref: e.target.value })} />
              </FieldRow>
            </div>
          </div>
          <aside aria-label="Preview" className="grid content-start gap-3">
            <p className="text-xs font-semibold text-muted-foreground">Preview</p>
            <div className="overflow-hidden rounded-lg border">
              {isSiteLink(draft.defaultOgImage) ? (
                <img src={draft.defaultOgImage} alt="Sharing preview" className="aspect-[1200/630] w-full bg-muted object-cover" />
              ) : (
                <div className="grid aspect-[1200/630] place-items-center bg-muted text-xs text-muted-foreground">No valid image</div>
              )}
              <p className="border-t px-3 py-2 text-xs text-muted-foreground">How a shared link looks</p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="mb-2 text-xs text-muted-foreground">Header</p>
              {draft.showPrimaryCtaInHeader ? (
                <span className="inline-flex rounded-full border bg-[var(--horizon-lavender-soft)] px-3 py-1 text-sm font-semibold">{draft.primaryCtaLabel || 'Button label'}</span>
              ) : (
                <span className="text-xs text-muted-foreground">No button shown</span>
              )}
            </div>
          </aside>
        </div>
        <SaveBar dirty={s.dirty} saving={s.saving} feedback={s.feedback} onDiscard={s.discard} />
      </form>
    </SectionCard>
  );
}

/* ---------- Features ---------- */
function FeaturesSection({ config, save, onDirty, ask }: SectionProps) {
  const s = useDraftSection(
    { publicPulsePollEnabled: config.publicPulsePollEnabled },
    (d) => save('features', d),
    undefined,
    ask,
  );
  useEffect(() => onDirty(s.dirty), [s.dirty]);
  return (
    <SectionCard id="features" title="Features" description="Turn optional public features on or off without a new release.">
      <form onSubmit={s.submit} noValidate>
        <div className="p-5">
          <div className="max-w-[40rem]">
            <ToggleRow
              id="publicPulsePollEnabled"
              label="Public sentiment poll (trial)"
              description="Shows a clearly labelled, non-binding Agree / Disagree indicator for the public next to proposals. It never counts as a member vote, and member ballots are unchanged."
              checked={s.draft.publicPulsePollEnabled}
              onChange={(v) => s.setDraft({ publicPulsePollEnabled: v })}
            />
          </div>
        </div>
        <SaveBar dirty={s.dirty} saving={s.saving} feedback={s.feedback} onDiscard={s.discard} />
      </form>
    </SectionCard>
  );
}

/* ---------- reorderable list helper ---------- */
function useReorder<T>(items: Array<T & { _id: string }>, setItems: (next: Array<T & { _id: string }>) => void) {
  const dragFrom = useRef<number | null>(null);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length || from === to) return;
    const next = [...items];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    setItems(next);
  };
  return {
    move,
    dragProps: (index: number) => ({
      draggable: true,
      onDragStart: () => (dragFrom.current = index),
      onDragOver: (e: React.DragEvent) => e.preventDefault(),
      onDrop: () => {
        if (dragFrom.current !== null) move(dragFrom.current, index);
        dragFrom.current = null;
      },
    }),
  };
}

/* ---------- Social channels ---------- */
function SocialSection({ config, save, onDirty, ask }: SectionProps) {
  const initial = useMemo(() => config.socialLinks.map((l) => ({ ...l, platform: l.platform ?? 'website', _id: nextId() })), []);
  const s = useDraftSection(
    { rows: initial },
    (d) => save('social', { socialLinks: d.rows.map(({ _id, ...r }) => r) }),
    undefined,
    ask,
  );
  useEffect(() => onDirty(s.dirty), [s.dirty]);
  const rows = s.draft.rows;
  const setRows = (next: typeof rows) => s.setDraft({ rows: next });
  const { move, dragProps } = useReorder(rows, setRows);
  const update = (i: number, patch: Partial<Social>) => setRows(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const err = (i: number, key: string, bad: boolean, msg: string) => s.errors[`socialLinks.${i}.${key}`] ?? (s.attempted && bad ? msg : undefined);
  return (
    <SectionCard id="social" title="Social channels" description="National channels shown in the site footer, in this order. Drag a row by its handle, or use the arrow buttons.">
      <form onSubmit={s.submit} noValidate>
        <div className="grid gap-6 p-5 xl:grid-cols-[minmax(0,1fr)_16rem]">
          <div className="grid content-start gap-3">
            {rows.length === 0 && <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No channels yet. The footer will show Fusion’s default channels until you add one.</p>}
            <ol className="grid gap-3">
              {rows.map((row, i) => (
                <li key={row._id} {...dragProps(i)} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
                  <GripVertical aria-hidden className="mt-2 hidden size-4 cursor-grab text-muted-foreground sm:block" />
                  <div className="grid min-w-0 gap-3 md:grid-cols-[10rem_minmax(0,1fr)]">
                    <FieldRow label="Platform" htmlFor={`social-platform-${row._id}`}>
                      <NativeSelect id={`social-platform-${row._id}`} value={row.platform} onChange={(e) => update(i, { platform: e.target.value })}>
                        {SOCIAL_PLATFORMS.map((p) => (
                          <option key={p} value={p}>{PLATFORM_LABELS[p]}</option>
                        ))}
                      </NativeSelect>
                    </FieldRow>
                    <FieldRow label="Display name" htmlFor={`social-label-${row._id}`} error={err(i, 'label', !row.label.trim(), 'Enter a name for this channel.')}>
                      <Input id={`social-label-${row._id}`} maxLength={80} value={row.label} aria-invalid={Boolean(err(i, 'label', !row.label.trim(), ''))} onChange={(e) => update(i, { label: e.target.value })} />
                    </FieldRow>
                    <FieldRow className="md:col-span-2" label="Web address" htmlFor={`social-href-${row._id}`} error={err(i, 'href', !isPublicHttpUrl(row.href), 'Enter a full web address, like https://www.facebook.com/YourPage.')}>
                      <Input id={`social-href-${row._id}`} inputMode="url" value={row.href} aria-invalid={Boolean(err(i, 'href', !isPublicHttpUrl(row.href), ''))} onChange={(e) => update(i, { href: e.target.value.trim() })} />
                    </FieldRow>
                  </div>
                  <div className="flex gap-1 sm:flex-col">
                    <Button type="button" size="icon" variant="ghost" className="size-8" aria-label={`Move ${row.label || 'channel'} up`} disabled={i === 0} onClick={() => move(i, i - 1)}><ArrowUp /></Button>
                    <Button type="button" size="icon" variant="ghost" className="size-8" aria-label={`Move ${row.label || 'channel'} down`} disabled={i === rows.length - 1} onClick={() => move(i, i + 1)}><ArrowDown /></Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-8"
                      aria-label={`Remove ${row.label || 'channel'}`}
                      onClick={() =>
                        ask({
                          title: `Remove ${row.label || 'this channel'}?`,
                          description: 'It disappears from the footer once you save. You can add it again later or restore it from Change history.',
                          confirmLabel: 'Remove',
                          destructive: true,
                          onConfirm: () => setRows(rows.filter((_, idx) => idx !== i)),
                        })
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </li>
              ))}
            </ol>
            <div>
              <Button type="button" variant="outline" size="sm" disabled={rows.length >= 20} onClick={() => setRows([...rows, { _id: nextId(), label: '', href: 'https://', platform: 'facebook' }])}>
                <Plus /> Add channel
              </Button>
            </div>
          </div>
          <aside aria-label="Footer preview" className="grid content-start gap-2">
            <p className="text-xs font-semibold text-muted-foreground">Footer preview</p>
            <ul className="grid gap-1.5 rounded-lg bg-[#240a59] p-4 text-sm text-[#c5b9dd]">
              {rows.filter((r) => r.label.trim()).map((r) => (
                <li key={r._id} className="flex items-center gap-1.5"><Share2 aria-hidden className="size-3.5" />{r.label} <span className="sr-only">({PLATFORM_LABELS[r.platform ?? 'website']})</span></li>
              ))}
            </ul>
          </aside>
        </div>
        <SaveBar dirty={s.dirty} saving={s.saving} feedback={s.feedback} onDiscard={s.discard} />
      </form>
    </SectionCard>
  );
}

/* ---------- Branch directory ---------- */
function DirectorySection({ config, save, onDirty, ask }: SectionProps) {
  const initial = useMemo(() => config.stateSites.map((r) => ({ ...r, facebookHref: r.facebookHref ?? '', _id: nextId() })), []);
  const s = useDraftSection(
    { rows: initial },
    (d) => save('directory', { stateSites: d.rows.map(({ _id, ...r }) => ({ ...r, facebookHref: r.facebookHref || undefined })) }),
    undefined,
    ask,
  );
  useEffect(() => onDirty(s.dirty), [s.dirty]);
  const rows = s.draft.rows;
  const setRows = (next: typeof rows) => s.setDraft({ rows: next });
  const { move, dragProps } = useReorder(rows, setRows);
  const update = (i: number, patch: Partial<StateSite>) => setRows(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const err = (i: number, key: string, bad: boolean, msg: string) => s.errors[`stateSites.${i}.${key}`] ?? (s.attempted && bad ? msg : undefined);
  return (
    <SectionCard id="directory" title="Branch directory" description="The website and Facebook page for each state and territory, shown in the footer and on the public Branches page.">
      <form onSubmit={s.submit} noValidate>
        <div className="grid gap-3 p-5">
          <ol className="grid gap-3">
            {rows.map((row, i) => (
              <li key={row._id} {...dragProps(i)} className="grid gap-3 rounded-lg border p-3 lg:grid-cols-[auto_14rem_minmax(0,1fr)_auto]">
                <GripVertical aria-hidden className="mt-2 hidden size-4 cursor-grab text-muted-foreground lg:block" />
                <div className="grid content-start gap-3 sm:grid-cols-[6rem_minmax(0,1fr)] lg:grid-cols-1">
                  <FieldRow label="Short name" htmlFor={`dir-code-${row._id}`} error={err(i, 'code', !/^[A-Za-z]{2,10}$/.test(row.code), 'Use 2–10 letters, like VIC.')}>
                    <Input id={`dir-code-${row._id}`} maxLength={10} value={row.code} onChange={(e) => update(i, { code: e.target.value.toUpperCase() })} />
                  </FieldRow>
                  <FieldRow label="Branch name" htmlFor={`dir-name-${row._id}`} error={err(i, 'name', !row.name.trim(), 'Enter a name.')}>
                    <Input id={`dir-name-${row._id}`} maxLength={80} value={row.name} onChange={(e) => update(i, { name: e.target.value })} />
                  </FieldRow>
                </div>
                <div className="grid content-start gap-3">
                  <FieldRow label="Website" htmlFor={`dir-web-${row._id}`} error={err(i, 'websiteHref', !isPublicHttpUrl(row.websiteHref), 'Enter a full web address, like https://vic.example.org.')}>
                    <Input id={`dir-web-${row._id}`} inputMode="url" value={row.websiteHref} onChange={(e) => update(i, { websiteHref: e.target.value.trim() })} />
                  </FieldRow>
                  <FieldRow label="Facebook page (optional)" htmlFor={`dir-fb-${row._id}`} error={err(i, 'facebookHref', Boolean(row.facebookHref) && !isPublicHttpUrl(row.facebookHref), 'Enter a full web address or leave blank.')}>
                    <Input id={`dir-fb-${row._id}`} inputMode="url" value={row.facebookHref} onChange={(e) => update(i, { facebookHref: e.target.value.trim() })} />
                  </FieldRow>
                </div>
                <div className="flex gap-1 lg:flex-col">
                  <Button type="button" size="icon" variant="ghost" className="size-8" aria-label={`Move ${row.name || 'branch'} up`} disabled={i === 0} onClick={() => move(i, i - 1)}><ArrowUp /></Button>
                  <Button type="button" size="icon" variant="ghost" className="size-8" aria-label={`Move ${row.name || 'branch'} down`} disabled={i === rows.length - 1} onClick={() => move(i, i + 1)}><ArrowDown /></Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-8"
                    aria-label={`Remove ${row.name || 'branch'}`}
                    onClick={() =>
                      ask({
                        title: `Remove ${row.name || 'this branch'} from the directory?`,
                        description: 'This only removes its website links from the public directory. The branch and its members are not affected.',
                        confirmLabel: 'Remove from directory',
                        destructive: true,
                        onConfirm: () => setRows(rows.filter((_, idx) => idx !== i)),
                      })
                    }
                  >
                    <Trash2 />
                  </Button>
                </div>
              </li>
            ))}
          </ol>
          <div>
            <Button type="button" variant="outline" size="sm" onClick={() => setRows([...rows, { _id: nextId(), code: '', name: '', websiteHref: 'https://', facebookHref: '' }])}>
              <Plus /> Add branch
            </Button>
          </div>
        </div>
        <SaveBar dirty={s.dirty} saving={s.saving} feedback={s.feedback} onDiscard={s.discard} />
      </form>
    </SectionCard>
  );
}

/* ---------- Operations (read-only) ---------- */
function OperationsSection({ config }: SectionProps) {
  return (
    <SectionCard id="operations" title="Operations" description="Public transparency about how Engage is run. This is maintained alongside the system itself, so it is shown here but not edited here.">
      <div className="grid gap-4 p-5 text-sm">
        <p className="max-w-[65ch]">
          The public <a href="/how-it-works/#operations">How it works</a> page describes backups and maintainer handover. That text is written by the maintainers with the deployment, so it cannot drift from what is actually running.
        </p>
        <dl className="grid max-w-[40rem] gap-3">
          <div className="grid gap-0.5">
            <dt className="text-xs font-semibold text-muted-foreground">Source code</dt>
            <dd><a href={config.repoUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1">{config.repoUrl}<ExternalLink aria-hidden className="size-3.5" /></a></dd>
          </div>
          <div className="grid gap-0.5">
            <dt className="text-xs font-semibold text-muted-foreground">To change this information</dt>
            <dd>Ask the maintainers to update the operations guide in the repository.</dd>
          </div>
        </dl>
      </div>
    </SectionCard>
  );
}

/* ---------- History ---------- */
function formatValue(_key: string, value: unknown): string {
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (Array.isArray(value)) {
    if (!value.length) return 'None';
    return value.map((v: any) => v.label || v.name || v.code).join(', ');
  }
  return String(value ?? 'Not set');
}

function HistorySection({ events, restore, ask }: SectionProps & { events: ConfigEvent[]; restore: (id: string) => Promise<SaveResult> }) {
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  return (
    <SectionCard id="history" title="Change history" description="Every saved change, with who made it and what it replaced. Restoring puts the earlier values back and is recorded as a new change.">
      <div className="p-5">
        <p role="status" aria-live="polite" className={cn('mb-3 text-sm', feedback?.tone === 'error' ? 'font-semibold [color:var(--horizon-danger-ink)]' : '[color:var(--horizon-success-ink)]')}>{feedback?.text}</p>
        {events.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No changes have been saved yet. When you save a section, it will appear here.</p>
        ) : (
          <ol className="grid divide-y rounded-lg border">
            {events.map((e) => (
              <li key={e.eventId} className="grid gap-2 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{e.summary}</p>
                    <p className="text-xs text-muted-foreground">{e.actorName} · <time dateTime={e.createdAt}>{relativeDate(e.createdAt)}</time></p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      ask({
                        title: 'Restore earlier values?',
                        description: `This puts ${e.changedFields.map((f) => FIELD_LABELS[f] ?? f).join(', ').toLowerCase()} back to how it was before “${e.summary}”.`,
                        confirmLabel: 'Restore',
                        onConfirm: async () => {
                          const r = await restore(e.eventId);
                          setFeedback(r.ok ? { tone: 'success', text: 'Restored.' } : { tone: 'error', text: r.error });
                        },
                      })
                    }
                  >
                    <Undo2 /> Restore
                  </Button>
                </div>
                <details className="text-sm">
                  <summary className="cursor-pointer text-xs font-semibold text-muted-foreground">Show what changed</summary>
                  <dl className="mt-2 grid gap-2">
                    {e.changedFields.map((f) => (
                      <div key={f} className="grid gap-0.5 sm:grid-cols-[12rem_minmax(0,1fr)]">
                        <dt className="text-xs font-semibold">{FIELD_LABELS[f] ?? f}</dt>
                        <dd className="min-w-0 text-xs break-words"><span className="text-muted-foreground">Before:</span> {formatValue(f, e.before[f])}<br /><span className="text-muted-foreground">After:</span> {formatValue(f, e.after[f])}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              </li>
            ))}
          </ol>
        )}
      </div>
    </SectionCard>
  );
}

interface SectionProps {
  config: Config;
  save: (section: string, payload: Record<string, unknown>) => Promise<SaveResult>;
  onDirty: (dirty: boolean) => void;
  ask: (request: ConfirmRequest) => void;
}

export default function PlatformSettings({ initialConfig, initialEvents }: { initialConfig: Config; initialEvents: ConfigEvent[] }) {
  const [config, setConfig] = useState(initialConfig);
  const [events, setEvents] = useState(initialEvents);
  const [active, setActive] = useState<SectionKey>(() => {
    const hash = typeof location !== 'undefined' ? (location.hash.slice(1) as SectionKey) : 'visibility';
    return SECTIONS.some((s) => s.key === hash) ? hash : 'visibility';
  });
  useEffect(() => {
    const onHash = () => {
      const hash = location.hash.slice(1) as SectionKey;
      if (SECTIONS.some((s) => s.key === hash)) setActive(hash);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const [dirty, setDirty] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [version, setVersion] = useState(0);
  useUnsavedGuard(dirty);

  const apply = (payload: { config: Config; events: ConfigEvent[] }) => {
    setConfig(payload.config);
    setEvents(payload.events);
  };
  const call = async (method: 'PATCH' | 'POST', body: Record<string, unknown>): Promise<SaveResult> => {
    try {
      const res = await fetch('/api/admin/settings', {
        method,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok)
        return { ok: false, error: data.error || 'Could not save. Please try again.', fieldErrors: data.fieldErrors ?? {} };
      apply(data);
      return { ok: true };
    } catch {
      return { ok: false, error: 'Could not reach the server. Check your connection and try again.', fieldErrors: {} };
    }
  };
  const save: SectionProps['save'] = (section, payload) => call('PATCH', { ...payload, section });
  const restore = async (eventId: string) => {
    const result = await call('POST', { eventId });
    if (result.ok) setVersion((v) => v + 1);
    return result;
  };

  const go = (key: SectionKey) => {
    if (key === active) return;
    const proceed = () => {
      setDirty(false);
      setActive(key);
      history.replaceState(null, '', `#${key}`);
    };
    if (dirty)
      setConfirm({
        title: 'Discard unsaved changes?',
        description: 'You have edits in this section that have not been saved. Leaving now will lose them.',
        confirmLabel: 'Discard and continue',
        destructive: true,
        onConfirm: proceed,
      });
    else proceed();
  };

  const shared = { config, save, onDirty: setDirty, ask: setConfirm };
  const lastChange = config.updatedAt ? `Last changed ${relativeDate(config.updatedAt)}${config.updatedByName ? ` by ${config.updatedByName}` : ''}` : 'No changes saved yet';
  return (
    <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <nav aria-label="Settings sections" className="min-w-0 lg:sticky lg:top-20">
        <ul className="flex min-w-0 gap-1 overflow-x-auto pb-1 lg:grid lg:overflow-visible lg:pb-0">
          {SECTIONS.map(({ key, label, hint, icon: Icon }) => (
            <li key={key} className="shrink-0">
              <Button
                type="button"
                variant="ghost"
                onClick={() => go(key)}
                aria-current={active === key ? 'page' : undefined}
                className={cn(
                  'h-auto w-full items-start justify-start gap-2.5 rounded-lg px-3 py-2 text-left',
                  active === key ? 'bg-[var(--horizon-lavender)] text-[var(--horizon-purple-deep)]' : 'hover:bg-[var(--horizon-lavender-soft)]',
                )}
              >
                <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">{label}</span>
                  <span className="hidden text-xs text-muted-foreground lg:block">{hint}</span>
                </span>
              </Button>
            </li>
          ))}
        </ul>
        <p className="mt-4 hidden px-3 text-xs text-muted-foreground lg:block">{lastChange}</p>
      </nav>
      <div className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center gap-2 lg:hidden"><Badge variant="muted">{lastChange}</Badge></div>
        {active === 'visibility' && <VisibilitySection key={`v${version}`} {...shared} />}
        {active === 'features' && <FeaturesSection key={`f${version}`} {...shared} />}
        {active === 'social' && <SocialSection key={`s${version}`} {...shared} />}
        {active === 'directory' && <DirectorySection key={`d${version}`} {...shared} />}
        {active === 'operations' && <OperationsSection {...shared} />}
        {active === 'history' && <HistorySection {...shared} events={events} restore={restore} />}
      </div>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
