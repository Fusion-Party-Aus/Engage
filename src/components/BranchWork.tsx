import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ChevronDown, ChevronRight, Plus, Search, ShieldAlert, UserCheck, UserPlus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConfirmDialog, StatusLine, relativeDate, useUnsavedGuard, type ConfirmRequest, type Feedback } from '@/components/admin-kit';
import { SearchPicker, type PickerResult } from '@/components/admin-search-picker';
import { cn } from '@/lib/utils';

export interface Branch { branchId: string; name: string; kind: string; parentBranchId?: string | null; recognised: boolean }
export interface Person {
  memberId: string;
  name: string;
  email: string;
  branchId: string;
  following: boolean;
  verified: boolean;
  branchRole: 'member' | 'administrator';
  assignedAt?: string;
}
export interface Counts { followers: number; members: number; administrators: number }
export interface Referral {
  referralId: string;
  proposalId: string;
  proposalTitle: string;
  sourceBranchId?: string | null;
  targetBranchId: string;
  reason: string;
  status: string;
  referredByName: string;
  referredAt?: string;
}
interface Props {
  branches: Branch[];
  people: Person[];
  counts: Record<string, Counts>;
  activity: Record<string, { proposals: number; openBallots: number }>;
  referrals: Referral[];
  isAdmin: boolean;
  adminBranchIds: string[];
  currentUserName: string;
}

const KIND_LABEL: Record<string, string> = { national: 'National', state: 'State', territory: 'Territory', constituent: 'Local' };
const KIND_HELP: Record<string, string> = {
  national: 'The top of the structure. Has no parent.',
  state: 'Sits under the national branch.',
  territory: 'Sits under the national branch.',
  constituent: 'A local branch within a state or territory.',
};
const allowedParentKinds = (kind: string): string[] =>
  kind === 'national' ? [] : kind === 'constituent' ? ['state', 'territory'] : ['national'];

async function api(method: string, url: string, body?: unknown): Promise<{ ok: boolean; data: any }> {
  try {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { ok: res.ok, data: await res.json().catch(() => ({})) };
  } catch {
    return { ok: false, data: { error: 'Could not reach the server. Check your connection and try again.' } };
  }
}

function Field({ label, htmlFor, hint, error, children }: { label: string; htmlFor: string; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-semibold">{label}</label>
      {children}
      {error ? <p role="alert" className="text-sm font-medium [color:var(--horizon-danger-ink)]">{error}</p> : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Metric({ value, label, hint }: { value: number; label: string; hint?: string }) {
  return (
    <div className="grid gap-0.5 rounded-lg border px-4 py-3">
      <strong className="text-2xl font-semibold tabular-nums">{value}</strong>
      <span className="text-sm">{label}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

function StatusBadge({ person }: { person: Person }) {
  if (!person.verified) return <Badge variant="info">Follower</Badge>;
  return <Badge variant="success">{person.branchRole === 'administrator' ? 'Member · administrator' : 'Member'}</Badge>;
}

function accessLabel(person: Person) {
  if (!person.verified) return 'Follower activities';
  return person.branchRole === 'administrator' ? 'Branch governance' : 'Member activities';
}

export default function BranchWork(props: Props) {
  const { isAdmin, adminBranchIds, currentUserName } = props;
  const [branches, setBranches] = useState(props.branches);
  const [people, setPeople] = useState(props.people);
  const [counts, setCounts] = useState(props.counts);
  const [referrals, setReferrals] = useState(props.referrals);
  const [tab, setTab] = useState<'branches' | 'people' | 'access' | 'referrals'>(() => {
    const h = typeof location !== 'undefined' ? location.hash.slice(1) : '';
    return h === 'people' || h === 'access' || h === 'referrals' ? h : 'branches';
  });
  const [selected, setSelected] = useState<string>(
    isAdmin
      ? props.branches.find((b) => b.kind === 'national')?.branchId
        ?? props.branches[0]?.branchId
        ?? ''
      : props.branches.find((b) => props.adminBranchIds.includes(b.branchId))?.branchId
        ?? props.branches[0]?.branchId
        ?? '',
  );
  const [dirty, setDirty] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [creating, setCreating] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  useUnsavedGuard(dirty);

  useEffect(() => {
    const onHash = () => {
      const h = location.hash.slice(1);
      if (h === 'people' || h === 'access' || h === 'referrals' || h === 'branches') setTab(h);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const distinctBranches = useMemo(
    () => Array.from(new Map(branches.map((b) => [b.branchId, b])).values()),
    [branches],
  );
  const byId = useMemo(() => new Map(distinctBranches.map((b) => [b.branchId, b])), [distinctBranches]);
  const name = (id?: string | null) => (id ? byId.get(id)?.name ?? 'Unknown branch' : 'Not recorded');
  const administrable = (id: string) => isAdmin || adminBranchIds.includes(id);
  const mine = distinctBranches.filter((branch) => administrable(branch.branchId));
  const peopleIn = (branchId: string) => people.filter((person) => person.branchId === branchId);
  const countsFor = (branchId: string): Counts => {
    if (counts[branchId]) return counts[branchId];
    const rows = peopleIn(branchId);
    return {
      followers: rows.filter((person) => person.following).length,
      members: rows.filter((person) => person.verified).length,
      administrators: rows.filter((person) => person.verified && person.branchRole === 'administrator').length,
    };
  };

  const goTab = (next: typeof tab) => {
    if (next === tab) return;
    const proceed = () => {
      setDirty(false);
      setTab(next);
      history.replaceState(null, '', `#${next}`);
    };
    if (dirty)
      setConfirm({ title: 'Discard unsaved changes?', description: 'You have branch settings that are not saved yet.', confirmLabel: 'Discard and continue', destructive: true, onConfirm: proceed });
    else proceed();
  };

  const openPeople = (branchId: string) => {
    setSelected(branchId);
    setTab('people');
    history.replaceState(null, '', '#people');
  };
  const openAccess = (branchId: string) => {
    setSelected(branchId);
    setTab('access');
    history.replaceState(null, '', '#access');
  };

  const refreshPeople = async (branchId?: string) => {
    const query = branchId ? `?branchId=${encodeURIComponent(branchId)}` : '';
    const { ok, data } = await api('GET', `/api/admin/branches/memberships${query}`);
    if (ok && Array.isArray(data.people)) setPeople(data.people);
    if (ok && data.counts) setCounts(data.counts);
  };

  const tabs = isAdmin || adminBranchIds.length
    ? [
        { key: 'branches' as const, label: 'Branches' },
        { key: 'people' as const, label: 'People' },
        { key: 'access' as const, label: 'Governance access' },
        { key: 'referrals' as const, label: 'Referrals' },
      ]
    : [{ key: 'branches' as const, label: 'Branches' }];

  if (!distinctBranches.length) {
    return (
      <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
        You have not been given administration of any branch. A national administrator can delegate this.
      </p>
    );
  }

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-[70ch] text-sm text-muted-foreground">
          Followers choose to see a branch’s activity. Verified members are recognised by an authorised administrator.
          Following never grants member-only voting rights.
        </p>
        {isAdmin && (
          <Button variant="outline" onClick={() => setCreating(true)}>
            <Plus /> New branch
          </Button>
        )}
      </div>

      <div role="tablist" aria-label="Branch governance" className="flex flex-wrap gap-5 border-b">
        {tabs.map((t) => (
          <Button
            key={t.key}
            type="button"
            variant="ghost"
            role="tab"
            id={`tab-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls={`panel-${t.key}`}
            tabIndex={tab === t.key ? 0 : -1}
            onClick={() => goTab(t.key)}
            onKeyDown={(e) => {
              const i = tabs.findIndex((x) => x.key === tab);
              if (e.key === 'ArrowRight') goTab(tabs[(i + 1) % tabs.length]!.key);
              if (e.key === 'ArrowLeft') goTab(tabs[(i + tabs.length - 1) % tabs.length]!.key);
            }}
            className={cn(
              '-mb-px h-auto rounded-none border-b-2 px-0.5 py-2.5 text-sm font-semibold',
              tab === t.key ? 'border-[var(--horizon-ink)] text-[var(--horizon-ink)]' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </Button>
        ))}
      </div>

      <StatusLine feedback={feedback} />

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'branches' && (
          <BranchesPanel
            branches={distinctBranches}
            mine={mine}
            setBranches={setBranches}
            byId={byId}
            countsFor={countsFor}
            activity={props.activity}
            selected={selected}
            setSelected={setSelected}
            isAdmin={isAdmin}
            setDirty={setDirty}
            ask={setConfirm}
            openPeople={openPeople}
            openAccess={openAccess}
            feedback={feedback}
            setFeedback={setFeedback}
          />
        )}
        {tab === 'people' && (
          <PeoplePanel
            branches={mine}
            people={people}
            setPeople={setPeople}
            selected={selected}
            setSelected={setSelected}
            countsFor={countsFor}
            name={name}
            isAdmin={isAdmin}
            administrable={administrable}
            refresh={refreshPeople}
            setFeedback={setFeedback}
            ask={setConfirm}
          />
        )}
        {tab === 'access' && (
          <AccessPanel
            branches={mine}
            people={people}
            name={name}
            countsFor={countsFor}
            isAdmin={isAdmin}
            openPeople={openPeople}
          />
        )}
        {tab === 'referrals' && (
          <ReferralsPanel
            branches={distinctBranches}
            referrals={referrals}
            setReferrals={setReferrals}
            isAdmin={isAdmin}
            name={name}
            currentUserName={currentUserName}
          />
        )}
      </div>

      <CreateBranchDialog
        open={creating}
        onOpenChange={setCreating}
        branches={distinctBranches}
        onCreated={(branch) => {
          setBranches((list) => [...list, branch]);
          setSelected(branch.branchId);
          setTab('branches');
          history.replaceState(null, '', '#branches');
        }}
      />
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

/* ---------------- Branches ---------------- */
function BranchesPanel({ branches, mine, setBranches, byId, countsFor, activity, selected, setSelected, isAdmin, setDirty, ask, openPeople, openAccess, feedback, setFeedback }: any) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const childrenOf = useMemo(() => {
    const map = new Map<string, Branch[]>();
    for (const b of branches as Branch[]) {
      const key = b.parentBranchId && byId.has(b.parentBranchId) ? b.parentBranchId : '';
      map.set(key, [...(map.get(key) ?? []), b]);
    }
    return map;
  }, [branches, byId]);

  const renderNode = (b: Branch, depth: number): React.ReactNode => {
    const kids = childrenOf.get(b.branchId) ?? [];
    const open = !collapsed.has(b.branchId);
    const c = countsFor(b.branchId) as Counts;
    return (
      <li key={b.branchId} role="treeitem" aria-expanded={kids.length ? open : undefined} aria-selected={selected === b.branchId}>
        <div className="flex items-center gap-1" style={{ paddingLeft: `${depth * 1.1}rem` }}>
          {kids.length ? (
            <Button type="button" variant="ghost" size="icon" aria-label={`${open ? 'Collapse' : 'Expand'} ${b.name}`} className="size-7" onClick={() => setCollapsed((s: Set<string>) => { const n = new Set(s); open ? n.add(b.branchId) : n.delete(b.branchId); return n; })}>
              {open ? <ChevronDown aria-hidden className="size-4" /> : <ChevronRight aria-hidden className="size-4" />}
            </Button>
          ) : <span className="size-7" />}
          <Button
            type="button"
            variant="ghost"
            onClick={() => setSelected(b.branchId)}
            className={cn('h-auto w-full min-w-0 flex-1 items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left', selected === b.branchId ? 'bg-[var(--horizon-lavender)]' : 'hover:bg-[var(--horizon-lavender-soft)]')}
          >
            <span className="min-w-0">
              <strong className="block truncate text-sm">{b.name}</strong>
              <span className="block text-xs text-muted-foreground">{KIND_LABEL[b.kind] ?? b.kind} · {c.members} verified · {c.followers} following</span>
            </span>
          </Button>
        </div>
        {kids.length > 0 && open && <ul role="group" className="grid gap-0.5">{kids.map((k) => renderNode(k, depth + 1))}</ul>}
      </li>
    );
  };

  const branch = byId.get(selected) as Branch | undefined;
  const c = branch ? countsFor(branch.branchId) as Counts : { followers: 0, members: 0, administrators: 0 };
  const a = branch ? activity[branch.branchId] ?? { proposals: 0, openBallots: 0 } : { proposals: 0, openBallots: 0 };

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <section aria-labelledby="tree-title" className="rounded-xl border bg-background p-3">
        <div className="mb-2 flex items-center justify-between px-2">
          <h2 id="tree-title" className="text-sm font-semibold">Branches you manage</h2>
          <span className="text-xs text-muted-foreground">{(mine as Branch[]).length} available</span>
        </div>
        <ul role="tree" aria-label="Branch hierarchy" className="grid gap-0.5">
          {(childrenOf.get('') ?? []).map((b) => renderNode(b, 0))}
        </ul>
      </section>
      {branch ? (
        <section aria-labelledby="branch-title" className="rounded-xl border bg-background">
          <header className="flex flex-wrap items-start justify-between gap-2 border-b px-5 py-4">
            <div>
              <h2 id="branch-title" className="text-lg font-semibold">{branch.name}</h2>
              <p className="text-sm text-muted-foreground">
                {KIND_LABEL[branch.kind]} branch{branch.parentBranchId ? ` · Part of ${byId.get(branch.parentBranchId)?.name ?? 'a parent branch'}` : ''}
              </p>
            </div>
            {isAdmin ? <Badge variant={branch.recognised ? 'success' : 'outline'}>{branch.recognised ? 'Recognised' : 'Not recognised'}</Badge> : null}
          </header>
          <div className="grid gap-5 p-5">
            <div className="grid gap-3 sm:grid-cols-3">
              <Metric value={c.followers} label="Following this branch" hint="People who chose to see its activity" />
              <Metric value={c.members} label="Verified members" hint="Recognised by an authorised administrator" />
              <Metric value={c.administrators} label="Branch administrators" hint="Delegated governance access" />
            </div>
            <section aria-labelledby="branch-activity-heading" className="rounded-lg border px-4 py-3">
              <h3 id="branch-activity-heading" className="text-sm font-semibold">Governance activity</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {a.proposals === 0
                  ? 'No proposals currently involve this branch.'
                  : `${a.proposals} proposal${a.proposals === 1 ? '' : 's'} involve this branch${a.openBallots ? `, including ${a.openBallots} open ballot${a.openBallots === 1 ? '' : 's'}` : ''}.`}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => openPeople(branch.branchId)}>
                  <UserCheck /> Manage people
                </Button>
                <Button size="sm" variant="outline" onClick={() => openAccess(branch.branchId)}>
                  Governance access
                </Button>
                <Button size="sm" variant="ghost" href={`/proposals/?branch=${encodeURIComponent(branch.branchId)}`}>
                  View proposals
                </Button>
              </div>
            </section>

            {isAdmin ? (
              <BranchSettings
                key={branch.branchId}
                branch={branch}
                branches={branches}
                setBranches={setBranches}
                byId={byId}
                setDirty={setDirty}
                ask={ask}
                feedback={feedback}
                setFeedback={setFeedback}
              />
            ) : (
              <p className="text-xs text-muted-foreground">
                Branch structure and recognition are managed by a national administrator. You manage this branch’s
                participation and governance access.
              </p>
            )}
          </div>
        </section>
      ) : (
        <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">Select a branch to see its participation.</p>
      )}
    </div>
  );
}

function descendantsOf(id: string, branches: Branch[]): Set<string> {
  const out = new Set<string>();
  const walk = (parent: string) => branches.filter((b) => b.parentBranchId === parent).forEach((b) => { if (!out.has(b.branchId)) { out.add(b.branchId); walk(b.branchId); } });
  walk(id);
  return out;
}

function BranchSettings({ branch, branches, setBranches, byId, setDirty, ask, feedback, setFeedback }: any) {
  const [draft, setDraft] = useState({ name: branch.name, kind: branch.kind, parentBranchId: branch.parentBranchId ?? '', recognised: branch.recognised });
  const [saved, setSaved] = useState(draft);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  useEffect(() => setDirty(dirty), [dirty]);
  useEffect(() => () => setDirty(false), []);
  const blocked = descendantsOf(branch.branchId, branches);
  const parentOptions = (branches as Branch[]).filter((b) => b.branchId !== branch.branchId && !blocked.has(b.branchId));
  const parentError =
    draft.kind === 'national' && draft.parentBranchId ? 'A national branch cannot have a parent.' :
    draft.parentBranchId && !allowedParentKinds(draft.kind).includes(byId.get(draft.parentBranchId)?.kind) ? `A ${KIND_LABEL[draft.kind]?.toLowerCase()} branch should sit under ${allowedParentKinds(draft.kind).join(' or ')} branch.` : '';
  const nameError = !draft.name.trim() ? 'Enter a name.' : '';

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (parentError || nameError) return;
    const run = async () => {
      setSaving(true);
      setFeedback({ tone: 'info', text: 'Saving…' });
      const { ok, data } = await api('PATCH', '/api/admin/branches', { branchId: branch.branchId, ...draft, parentBranchId: draft.parentBranchId || undefined });
      setSaving(false);
      if (!ok) return setFeedback({ tone: 'error', text: data.error || 'Could not save this branch.' });
      setSaved(draft);
      setBranches((list: Branch[]) => list.map((b) => (b.branchId === branch.branchId ? { ...b, ...draft, parentBranchId: draft.parentBranchId || null } : b)));
      setFeedback({ tone: 'success', text: 'Branch settings saved.' });
    };
    if (saved.recognised && !draft.recognised)
      ask({ title: `Stop recognising ${branch.name}?`, description: 'It will be hidden from new branch choices and cannot receive new governance activity. Existing followers, verified members and records are kept.', confirmLabel: 'Stop recognising', destructive: true, onConfirm: run });
    else await run();
  };

  return (
    <details className="rounded-lg border px-4 py-3">
      <summary className="cursor-pointer text-sm font-semibold">Organisational settings</summary>
      <p className="mt-1 text-xs text-muted-foreground">Only a national administrator can change branch structure or recognition.</p>
      <form onSubmit={save} noValidate className="mt-3 grid gap-4" aria-label="Branch settings">
        <Field label="Branch name" htmlFor="branch-name" error={nameError}>
          <Input id="branch-name" maxLength={120} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Branch type" htmlFor="branch-kind" hint={KIND_HELP[draft.kind]}>
            <NativeSelect id="branch-kind" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value, parentBranchId: e.target.value === 'national' ? '' : draft.parentBranchId })}>
              {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </NativeSelect>
          </Field>
          <Field label="Part of" htmlFor="branch-parent" error={parentError}>
            <NativeSelect id="branch-parent" disabled={draft.kind === 'national'} value={draft.parentBranchId} onChange={(e) => setDraft({ ...draft, parentBranchId: e.target.value })}>
              <option value="">{draft.kind === 'national' ? 'Top level' : 'No parent'}</option>
              {parentOptions.map((b) => <option key={b.branchId} value={b.branchId}>{b.name}</option>)}
            </NativeSelect>
          </Field>
        </div>
        <div className="flex items-start justify-between gap-4">
          <div>
            <label id="recognised-label" htmlFor="branch-recognised" className="text-sm font-semibold">Recognised branch</label>
            <p className="text-xs text-muted-foreground">Recognised branches appear in member branch choices and can run governance activity.</p>
          </div>
          <Switch id="branch-recognised" aria-labelledby="recognised-label" checked={draft.recognised} onCheckedChange={(v) => setDraft({ ...draft, recognised: v })} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <StatusLine feedback={dirty && !feedback ? { tone: 'info', text: 'You have unsaved changes.' } : feedback} className="mr-auto" />
          <Button type="button" variant="ghost" size="sm" disabled={!dirty || saving} onClick={() => { setDraft(saved); setFeedback(null); }}>Discard</Button>
          <Button type="submit" size="sm" disabled={!dirty || saving || Boolean(parentError || nameError)}>{saving ? 'Saving…' : 'Save branch settings'}</Button>
        </div>
      </form>
    </details>
  );
}

function CreateBranchDialog({ open, onOpenChange, branches, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; branches: Branch[]; onCreated: (b: Branch) => void }) {
  const empty = { name: '', kind: '', parentBranchId: '', recognised: false };
  const [draft, setDraft] = useState(empty);
  const [attempted, setAttempted] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (open) { setDraft(empty); setAttempted(false); setFeedback(null); } }, [open]);
  const kinds = allowedParentKinds(draft.kind);
  const parents = branches.filter((b) => kinds.includes(b.kind));
  const errors = {
    name: !draft.name.trim() ? 'Enter a name for the branch.' : '',
    kind: !draft.kind ? 'Choose what kind of branch this is.' : '',
    parent: draft.kind && draft.kind !== 'national' && !draft.parentBranchId ? `Choose the ${kinds.join(' or ')} branch it belongs to.` : '',
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    if (errors.name || errors.kind || errors.parent) return;
    setSaving(true);
    const { ok, data } = await api('POST', '/api/admin/branches', { name: draft.name, kind: draft.kind, parentBranchId: draft.parentBranchId || undefined, recognised: draft.recognised });
    setSaving(false);
    if (!ok) return setFeedback({ tone: 'error', text: data.error || 'Could not create the branch.' });
    onCreated(data.branch);
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New branch</DialogTitle>
          <DialogDescription>Choose where it sits first; the rest follows from that.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="grid gap-4">
          <Field label="Type" htmlFor="new-kind" error={attempted ? errors.kind : ''} hint={draft.kind ? KIND_HELP[draft.kind] : undefined}>
            <NativeSelect id="new-kind" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value, parentBranchId: '' })}>
              <option value="">Choose a type</option>
              {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </NativeSelect>
          </Field>
          {draft.kind && draft.kind !== 'national' && (
            <Field label="Part of" htmlFor="new-parent" error={attempted ? errors.parent : ''} hint={parents.length ? undefined : `Create a ${kinds.join(' or ')} branch first.`}>
              <NativeSelect id="new-parent" value={draft.parentBranchId} onChange={(e) => setDraft({ ...draft, parentBranchId: e.target.value })}>
                <option value="">Choose a branch</option>
                {parents.map((b) => <option key={b.branchId} value={b.branchId}>{b.name}</option>)}
              </NativeSelect>
            </Field>
          )}
          <Field label="Name" htmlFor="new-name" error={attempted ? errors.name : ''}>
            <Input id="new-name" maxLength={120} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Fusion Tasmania" />
          </Field>
          <div className="flex items-start justify-between gap-4">
            <div>
              <label id="new-recognised-label" htmlFor="new-recognised" className="text-sm font-semibold">Recognise it now</label>
              <p className="text-xs text-muted-foreground">Recognised branches appear in member branch choices. You can change this later.</p>
            </div>
            <Switch id="new-recognised" aria-labelledby="new-recognised-label" checked={draft.recognised} onCheckedChange={(v) => setDraft({ ...draft, recognised: v })} />
          </div>
          <StatusLine feedback={feedback} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Creating…' : 'Create branch'}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- People ---------------- */
function PeoplePanel({
  branches,
  people,
  setPeople,
  selected,
  setSelected,
  countsFor,
  name,
  isAdmin,
  administrable,
  refresh,
  setFeedback,
  ask,
}: any) {
  const [filterText, setFilterText] = useState('');
  const [limit, setLimit] = useState(25);
  const [managing, setManaging] = useState<Person | null>(null);
  const [adding, setAdding] = useState(false);

  const branchId = administrable(selected) ? selected : branches[0]?.branchId ?? '';
  const branch = (branches as Branch[]).find((b) => b.branchId === branchId);
  const rows = (people as Person[])
    .filter((person) => person.branchId === branchId)
    .filter((person) => !filterText || `${person.name} ${person.email}`.toLowerCase().includes(filterText.toLowerCase()))
    .sort((left, right) => Number(right.verified) - Number(left.verified) || left.name.localeCompare(right.name));
  const counts = branch ? countsFor(branchId) as Counts : { followers: 0, members: 0, administrators: 0 };

  const updatePerson = (updated: Person) => {
    setPeople((list: Person[]) => {
      const exists = list.some((p) => p.branchId === updated.branchId && p.memberId === updated.memberId);
      if (!updated.verified && !updated.following) {
        return list.filter((p) => !(p.branchId === updated.branchId && p.memberId === updated.memberId));
      }
      return exists
        ? list.map((p) => (p.branchId === updated.branchId && p.memberId === updated.memberId ? updated : p))
        : [...list, updated];
    });
  };

  const verify = async (person: Person) => {
    setFeedback({ tone: 'info', text: `Verifying ${person.name}…` });
    const { ok, data } = await api('POST', '/api/admin/branches/memberships', {
      branchId: person.branchId,
      memberId: person.memberId,
      branchRole: 'member',
    });
    if (!ok) return setFeedback({ tone: 'error', text: data.error || 'Could not verify this follower.' });
    updatePerson({ ...person, verified: true, branchRole: 'member', assignedAt: new Date().toISOString() });
    await refresh(person.branchId);
    setFeedback({ tone: 'success', text: `${person.name} is now a verified member of ${name(person.branchId)}.` });
  };

  return (
    <div className="grid gap-5">
      <section aria-labelledby="people-heading" className="min-w-0 rounded-xl border bg-background">
        <header className="flex flex-wrap items-end gap-3 border-b p-4">
          <div className="mr-auto">
            <h2 id="people-heading" className="text-base font-semibold">People</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Followers chose to see this branch. Verified members can take part in member-restricted activities.
            </p>
          </div>
          <div className="w-full sm:w-56">
            <NativeSelect size="sm" aria-label="Choose a branch" value={branchId} onChange={(e) => { setSelected(e.target.value); setLimit(25); }}>
              {(branches as Branch[]).map((b) => <option key={b.branchId} value={b.branchId}>{b.name}</option>)}
            </NativeSelect>
          </div>
          <div className="relative w-full sm:w-64">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input aria-label="Search people by name or email" placeholder="Search name or email" className="h-9 pl-8" value={filterText} onChange={(e) => { setFilterText(e.target.value); setLimit(25); }} />
          </div>
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <UserPlus /> Add a person
          </Button>
        </header>

        {branch && (
          <div className="grid gap-2 border-b px-4 py-3 text-xs text-muted-foreground sm:grid-cols-3">
            <span><strong className="text-foreground tabular-nums">{counts.followers}</strong> following</span>
            <span><strong className="text-foreground tabular-nums">{counts.members}</strong> verified members</span>
            <span><strong className="text-foreground tabular-nums">{counts.administrators}</strong> branch administrators</span>
          </div>
        )}

        {rows.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">
            {people.length === 0
              ? 'Nobody follows this branch yet. You can add a verified Engage member when they are ready to participate.'
              : filterText
                ? 'No people match this search.'
                : 'Nobody follows this branch yet. A follower appears here after they choose the branch; you can then verify their membership.'}
          </p>
        ) : (
          <>
            <ul className="divide-y">
              {rows.slice(0, limit).map((person) => (
                <li key={`${person.branchId}-${person.memberId}`} className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1.4fr)_minmax(0,.6fr)_minmax(0,.8fr)_auto] md:items-center">
                  <div className="min-w-0">
                    <strong className="block truncate text-sm">{person.name}</strong>
                    <span className="block truncate text-xs text-muted-foreground">{person.email}</span>
                  </div>
                  <div><StatusBadge person={person} /></div>
                  <span className="text-sm text-muted-foreground">{accessLabel(person)}</span>
                  <div className="flex justify-start md:justify-end">
                    {person.verified ? (
                      <Button size="sm" variant="outline" onClick={() => setManaging(person)}>Manage membership</Button>
                    ) : (
                      <Button size="sm" onClick={() => verify(person)}>Verify membership</Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {rows.length > limit && (
              <div className="border-t p-3 text-center">
                <Button size="sm" variant="outline" onClick={() => setLimit(limit + 50)}>Show more ({rows.length - limit} left)</Button>
              </div>
            )}
          </>
        )}
      </section>

      <ManageMembershipDialog
        person={managing}
        branchName={managing ? name(managing.branchId) : ''}
        isAdmin={isAdmin}
        onClose={() => setManaging(null)}
        onUpdated={(updated) => updatePerson(updated)}
        refresh={refresh}
        setFeedback={setFeedback}
      />

      <AddPersonDialog
        open={adding}
        branch={branch}
        isAdmin={isAdmin}
        onClose={() => setAdding(false)}
        onAdded={(person) => {
          updatePerson(person);
          setAdding(false);
          void refresh(person.branchId);
          setFeedback({ tone: 'success', text: `${person.name} is now a verified member of ${name(person.branchId)}.` });
        }}
        setFeedback={setFeedback}
      />
    </div>
  );
}

function ManageMembershipDialog({
  person,
  branchName,
  isAdmin,
  onClose,
  onUpdated,
  refresh,
  setFeedback,
}: {
  person: Person | null;
  branchName: string;
  isAdmin: boolean;
  onClose: () => void;
  onUpdated: (person: Person) => void;
  refresh: (branchId?: string) => Promise<void>;
  setFeedback: (feedback: Feedback | null) => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setReason(''); setError(''); setBusy(false); }, [person?.memberId, person?.branchId]);

  if (!person) return null;

  const setRole = async (branchRole: 'member' | 'administrator') => {
    setBusy(true);
    setError('');
    const { ok, data } = await api('POST', '/api/admin/branches/memberships', {
      branchId: person.branchId,
      memberId: person.memberId,
      branchRole,
      reason: reason.trim() || undefined,
    });
    setBusy(false);
    if (!ok) return setError(data.error || 'Could not update this membership.');
    onUpdated({ ...person, verified: true, branchRole });
    await refresh(person.branchId);
    setFeedback({ tone: 'success', text: branchRole === 'administrator' ? `${person.name} can now manage ${branchName}.` : `${person.name} now has member access in ${branchName}.` });
    onClose();
  };

  const revoke = async (event: FormEvent) => {
    event.preventDefault();
    if (reason.trim().length < 3) {
      setError('Give a short reason for removing this membership.');
      return;
    }
    setBusy(true);
    setError('');
    const { ok, data } = await api('DELETE', '/api/admin/branches/memberships', {
      branchId: person.branchId,
      memberId: person.memberId,
      reason: reason.trim(),
    });
    setBusy(false);
    if (!ok) return setError(data.error || 'Could not remove this membership.');
    onUpdated({ ...person, verified: false, branchRole: 'member' });
    await refresh(person.branchId);
    setFeedback({ tone: 'success', text: `${person.name} is no longer a verified member of ${branchName}.${person.following ? ' They still follow the branch.' : ''}` });
    onClose();
  };

  return (
    <Dialog open={Boolean(person)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{person.name}</DialogTitle>
          <DialogDescription>{person.email} · {branchName}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5">
          <section className="grid gap-2 rounded-lg border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <strong className="text-sm">Member activities</strong>
                <p className="text-xs text-muted-foreground">Vote in member-restricted ballots for this branch, subject to each ballot’s rules.</p>
              </div>
              <Badge variant="success">Member</Badge>
            </div>
            {isAdmin && (
              <div className="flex flex-wrap gap-2 border-t pt-2">
                {person.branchRole === 'administrator' ? (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => setRole('member')}>Remove administrator access</Button>
                ) : (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => setRole('administrator')}>Make branch administrator</Button>
                )}
                <p className="w-full text-xs text-muted-foreground">Branch administrators manage this branch’s people and local governance. They cannot ratify or publish policy.</p>
              </div>
            )}
          </section>

          <form onSubmit={revoke} className="grid gap-3 rounded-lg border border-[var(--horizon-danger-bg)] p-3">
            <div>
              <strong className="text-sm">Remove verified membership</strong>
              <p className="mt-1 text-xs text-muted-foreground">
                {person.name} will lose member-only rights in {branchName}. Their votes already recorded, their historical ballot
                records and their decision to follow the branch are unchanged.
              </p>
            </div>
            <Field label="Reason for removal" htmlFor="revoke-reason" error={error || undefined} hint="Kept in the audit record and not shown publicly.">
              <Textarea id="revoke-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Membership ended; verified by the branch secretary." />
            </Field>
            <div className="flex justify-end">
              <Button type="submit" variant="destructive" size="sm" disabled={busy}>
                {busy ? 'Removing…' : 'Remove verified membership'}
              </Button>
            </div>
          </form>
          <StatusLine feedback={error ? { tone: 'error', text: error } : null} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AddPersonDialog({
  open,
  branch,
  isAdmin,
  onClose,
  onAdded,
  setFeedback,
}: {
  open: boolean;
  branch?: Branch;
  isAdmin: boolean;
  onClose: () => void;
  onAdded: (person: Person) => void;
  setFeedback: (feedback: Feedback | null) => void;
}) {
  const [person, setPerson] = useState<PickerResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (open) { setPerson(null); setError(''); setSaving(false); } }, [open]);
  if (!branch) return null;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!person) return setError('Choose a verified Engage member.');
    setSaving(true);
    setError('');
    const { ok, data } = await api('POST', '/api/admin/branches/memberships', {
      branchId: branch.branchId,
      memberId: person.id,
      branchRole: 'member',
    });
    setSaving(false);
    if (!ok) return setError(data.error || 'Could not add this member.');
    onAdded({
      memberId: person.id,
      name: person.label,
      email: person.detail || '',
      branchId: branch.branchId,
      following: false,
      verified: true,
      branchRole: 'member',
      assignedAt: new Date().toISOString(),
    });
    setFeedback({ tone: 'success', text: `${person.label} added to ${branch.name}.` });
  };
  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a verified member</DialogTitle>
          <DialogDescription>
            Search people connected to {branch.name}{isAdmin ? '' : ' through the branches you manage'}. Adding a member
            does not create a second membership record or change their following choices.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <div>
            <SearchPicker label="Person" type="member" branchId={branch.branchId} placeholder="Name or email" value={person} onChange={(value) => { setPerson(value); setError(''); }} />
            {error && <p role="alert" className="mt-1 text-sm font-medium [color:var(--horizon-danger-ink)]">{error}</p>}
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving || !person}>{saving ? 'Adding…' : 'Verify as member'}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- Governance access ---------------- */
function AccessPanel({ branches, people, name, countsFor, isAdmin, openPeople }: any) {
  return (
    <div className="grid gap-5">
      <section aria-labelledby="access-heading" className="rounded-xl border bg-background">
        <header className="border-b px-5 py-4">
          <h2 id="access-heading" className="text-base font-semibold">Governance access</h2>
          <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground">
            Branch administrators can verify members and manage local governance within their branch. They cannot
            ratify or publish policy, change another branch, or exceed their delegated authority.
          </p>
        </header>
        {!isAdmin && (
          <p className="flex items-start gap-2 border-b bg-[var(--horizon-lavender-soft)] px-5 py-3 text-sm">
            <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            Only a national administrator can add or remove branch administrators. You can see who holds access here.
          </p>
        )}
        <ul className="divide-y">
          {(branches as Branch[]).map((branch) => {
            const admins = (people as Person[]).filter((person) => person.branchId === branch.branchId && person.verified && person.branchRole === 'administrator');
            const counts = countsFor(branch.branchId) as Counts;
            return (
              <li key={branch.branchId} className="grid gap-2 px-5 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong className="text-sm">{branch.name}</strong>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{counts.administrators} administrator{counts.administrators === 1 ? '' : 's'}</Badge>
                    <Button size="sm" variant="ghost" onClick={() => openPeople(branch.branchId)}>Manage in People</Button>
                  </div>
                </div>
                {admins.length ? (
                  <ul className="grid gap-1 text-sm">
                    {admins.map((person) => <li key={person.memberId}>{person.name} <span className="text-xs text-muted-foreground">{person.email}</span></li>)}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No branch administrator yet. {isAdmin ? 'Choose a verified member from People and make them an administrator.' : 'A national administrator can delegate this.'}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

/* ---------------- Referrals ---------------- */
function ReferralsPanel({ branches, referrals, setReferrals, isAdmin, name, currentUserName }: any) {
  const [direction, setDirection] = useState<'all' | 'incoming' | 'outgoing'>('all');
  const [branchFilter, setBranchFilter] = useState('');
  const [proposal, setProposal] = useState<PickerResult | null>(null);
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [saving, setSaving] = useState(false);
  const recognised = (branches as Branch[]).filter((b) => b.recognised);
  const dirty = Boolean(proposal || target || reason);
  useUnsavedGuard(dirty);

  const shown = (referrals as Referral[]).filter((r) => {
    if (!branchFilter) return true;
    if (direction === 'incoming') return r.targetBranchId === branchFilter;
    if (direction === 'outgoing') return r.sourceBranchId === branchFilter;
    return r.targetBranchId === branchFilter || r.sourceBranchId === branchFilter;
  });
  const errors = { proposal: !proposal ? 'Choose the proposal to refer.' : '', target: !target ? 'Choose the branch to refer it to.' : '', reason: !reason.trim() ? 'Explain why this is being referred.' : '' };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    if (errors.proposal || errors.target || errors.reason) return;
    setSaving(true);
    const { ok, data } = await api('POST', '/api/admin/branches/referrals', { proposalId: proposal!.id, targetBranchId: target, reason: reason.trim() });
    setSaving(false);
    if (!ok) return setFeedback({ tone: 'error', text: data.error || 'Could not refer this proposal.' });
    setReferrals((list: Referral[]) => [{ ...data.referral, proposalTitle: proposal!.label, referredByName: currentUserName }, ...list]);
    setFeedback({ tone: 'success', text: `“${proposal!.label}” referred to ${name(target)}.` });
    setProposal(null); setTarget(''); setReason(''); setAttempted(false);
  };

  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
      <section aria-labelledby="ref-title" className="min-w-0 rounded-xl border bg-background">
        <header className="flex flex-wrap items-end gap-3 border-b p-4">
          <h2 id="ref-title" className="mr-auto text-base font-semibold">Referrals <span className="font-normal text-muted-foreground">({shown.length})</span></h2>
          <div className="w-44"><NativeSelect size="sm" aria-label="Filter by branch" value={branchFilter} onChange={(e) => setBranchFilter(e.target.value)}><option value="">All branches</option>{(branches as Branch[]).map((b) => <option key={b.branchId} value={b.branchId}>{b.name}</option>)}</NativeSelect></div>
          <div className="w-36"><NativeSelect size="sm" aria-label="Direction" disabled={!branchFilter} value={direction} onChange={(e) => setDirection(e.target.value as any)}><option value="all">In and out</option><option value="incoming">Incoming</option><option value="outgoing">Outgoing</option></NativeSelect></div>
        </header>
        {shown.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">
            {referrals.length === 0
              ? isAdmin ? 'No proposals have been referred between branches yet. Use the form to refer the first one.' : 'No proposals have been referred to or from your branches yet.'
              : 'Referrals exist, but none match this branch filter. Choose “All branches” to see them.'}
          </p>
        ) : (
          <ul className="divide-y">
            {shown.map((r) => (
              <li key={r.referralId} className="grid gap-1.5 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong className="text-sm">{r.proposalTitle || 'Proposal details unavailable'}</strong>
                  <Badge variant="info">{r.status === 'referred' ? 'Awaiting review' : r.status}</Badge>
                </div>
                <p className="text-sm">{name(r.sourceBranchId)} <span aria-label="to">→</span> {name(r.targetBranchId)}</p>
                <p className="max-w-[70ch] text-sm text-muted-foreground">{r.reason}</p>
                <p className="text-xs text-muted-foreground">Referred by {r.referredByName || 'an administrator'} · {relativeDate(r.referredAt)}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="refer-title" className="grid content-start gap-4 rounded-xl border bg-background p-5">
        <div>
          <h2 id="refer-title" className="text-base font-semibold">Refer a proposal</h2>
          <p className="text-sm text-muted-foreground">Asks another branch to review it. A referral does not change who has authority or jurisdiction over the proposal.</p>
        </div>
        {!isAdmin ? (
          <p className="flex items-start gap-2 rounded-lg bg-[var(--horizon-lavender-soft)] p-3 text-sm"><ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" />Only a national administrator can refer proposals. You can see referrals involving your branches here.</p>
        ) : (
          <form onSubmit={submit} noValidate className="grid gap-4">
            <div>
              <SearchPicker label="Proposal" type="proposal" placeholder="Title, ID or topic" value={proposal} onChange={setProposal} />
              {attempted && errors.proposal && <p role="alert" className="mt-1 text-sm font-medium [color:var(--horizon-danger-ink)]">{errors.proposal}</p>}
            </div>
            <Field label="Refer to" htmlFor="ref-target" error={attempted ? errors.target : ''}>
              <NativeSelect id="ref-target" value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">Choose a recognised branch</option>
                {recognised.map((b) => <option key={b.branchId} value={b.branchId}>{b.name}</option>)}
              </NativeSelect>
            </Field>
            <Field label="Why is it being referred?" htmlFor="ref-reason" error={attempted ? errors.reason : ''} hint={`${reason.length}/1000`}>
              <Textarea id="ref-reason" rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <StatusLine feedback={feedback} className="mr-auto" />
              <Button type="submit" disabled={saving}>{saving ? 'Referring…' : 'Refer proposal'}</Button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
