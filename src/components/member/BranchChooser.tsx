import { useEffect, useMemo, useState } from 'react';
import { Check, MapPin, Search, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { ConfirmDialog, StatusLine, type ConfirmRequest, type Feedback } from '@/components/admin-kit';

export interface BranchChoice {
  branchId: string;
  name: string;
  kind: string;
  parentBranchId?: string | null;
  parentName?: string | null;
  included: boolean;
  locked: boolean;
  following: boolean;
  verified: boolean;
  branchRole?: 'member' | 'administrator';
  recognised?: boolean;
}

interface Props {
  branches: BranchChoice[];
  mode: 'onboarding' | 'invite' | 'manage';
  memberKey?: string;
  onComplete?: () => void;
}

const KIND_GROUP_LABEL: Record<string, string> = {
  state: 'State and territory branches',
  territory: 'State and territory branches',
  constituent: 'Local branches',
};

const ONBOARDED_KEY = 'engage_branches_onboarded_v1';
const INVITE_DISMISSED_KEY = 'engage_branches_invite_dismissed_v1';
const DRAFT_KEY = 'engage_branches_draft_v1';

function scopedKey(base: string, memberKey?: string) {
  return memberKey ? `${base}:${memberKey}` : base;
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage is an enhancement; the server remains the source of truth.
  }
}

async function postBranchChange(body: Record<string, unknown>) {
  const response = await fetch('/api/member/branches', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as {
    branches?: BranchChoice[];
    error?: string;
    message?: string;
  };
  return { ok: response.ok, data };
}

function BranchStatus({ branch }: { branch: BranchChoice }) {
  if (branch.included) {
    return <span className="text-sm text-[var(--horizon-muted)]">Included for all Engage users</span>;
  }
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {branch.verified ? (
        <Badge variant="success">{branch.branchRole === 'administrator' ? 'Branch administrator' : 'Member'}</Badge>
      ) : (
        <Badge variant="info">Follower</Badge>
      )}
      {branch.following ? (
        <Badge variant="outline">Following</Badge>
      ) : (
        <Badge variant="muted">Not following updates</Badge>
      )}
    </span>
  );
}

function BranchGroups({
  branches,
  selected,
  onToggle,
  disabled,
  showSearch,
  query,
  setQuery,
  compact,
}: {
  branches: BranchChoice[];
  selected?: Set<string>;
  onToggle?: (branch: BranchChoice) => void;
  disabled?: boolean;
  showSearch?: boolean;
  query?: string;
  setQuery?: (value: string) => void;
  compact?: boolean;
}) {
  const byKind = useMemo(() => {
    const groups = new Map<string, BranchChoice[]>();
    for (const branch of branches) {
      if (branch.included) continue;
      const key = ['state', 'territory'].includes(branch.kind) ? 'state' : branch.kind;
      groups.set(key, [...(groups.get(key) ?? []), branch]);
    }
    return [...groups.entries()].sort(([left], [right]) => {
      const order: Record<string, number> = { state: 0, constituent: 1 };
      return (order[left] ?? 9) - (order[right] ?? 9);
    });
  }, [branches]);

  if (!branches.length) {
    return <p className="text-sm text-[var(--horizon-muted)]">No branches are currently available to choose.</p>;
  }

  return (
    <div className="grid gap-4">
      {showSearch && (
        <label className="relative block">
          <span className="sr-only">Search branches</span>
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--horizon-muted)]" />
          <Input
            value={query ?? ''}
            onChange={(event) => setQuery?.(event.target.value)}
            placeholder="Search branches"
            className="pl-9"
          />
        </label>
      )}
      {byKind.map(([kind, items]) => {
        const visible = items.filter((branch) => {
          const term = (query ?? '').trim().toLowerCase();
          return !term || `${branch.name} ${branch.parentName ?? ''}`.toLowerCase().includes(term);
        });
        if (!visible.length) return null;
        return (
          <fieldset key={kind} className="grid gap-2">
            <legend className="mb-1 text-xs font-bold tracking-wide text-[var(--horizon-muted)] uppercase">
              {KIND_GROUP_LABEL[kind] ?? (kind === 'state' ? 'State and territory branches' : 'Branches')}
            </legend>
            <div className={compact ? 'grid gap-2 sm:grid-cols-2' : 'grid gap-2'}>
              {visible.map((branch) => {
                const checked = selected?.has(branch.branchId) ?? false;
                return (
                  <div
                    key={branch.branchId}
                    className="flex flex-col gap-2 rounded-lg border border-[var(--horizon-line)] px-3.5 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-3"
                  >
                    <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-3">
                      {selected ? (
                        <Checkbox
                          className="mt-0.5"
                          checked={checked}
                          disabled={disabled}
                          onChange={() => onToggle?.(branch)}
                        />
                      ) : (
                        <MapPin aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[var(--horizon-purple)]" />
                      )}
                      <span className="min-w-0">
                        <strong className="block text-sm">{branch.name}</strong>
                        <span className="block text-xs text-[var(--horizon-muted)]">
                          {branch.parentName && branch.kind === 'constituent'
                            ? `Local branch · part of ${branch.parentName}`
                            : branch.parentName
                              ? `Part of ${branch.parentName}`
                              : 'State branch'}
                        </span>
                      </span>
                    </label>
                    {!selected && (
                      <div className="flex shrink-0 flex-col items-start gap-1.5 sm:items-end">
                        <BranchStatus branch={branch} />
                        {onToggle && (
                          <Button
                            type="button"
                            size="sm"
                            variant={branch.following ? 'ghost' : 'outline'}
                            disabled={disabled}
                            onClick={() => onToggle(branch)}
                          >
                            {branch.following ? 'Unfollow' : branch.verified ? 'Follow updates' : 'Follow'}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}

function NationalRow({ branch }: { branch: BranchChoice }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-[var(--horizon-line)] bg-[var(--horizon-lavender-soft)] px-3.5 py-3">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-[var(--horizon-success-bg)] text-[var(--horizon-success-ink)]">
          <Check aria-hidden="true" className="size-3.5" />
        </span>
        <span>
          <strong className="block text-sm">{branch.name}</strong>
          <span className="block text-xs text-[var(--horizon-muted)]">Included for all Engage users · National governance</span>
        </span>
      </div>
      <Badge variant="success">Included</Badge>
    </div>
  );
}

export default function BranchChooser(props: Props) {
  const { mode, memberKey } = props;
  const national = props.branches.find((branch) => branch.included) ?? {
    branchId: '__national__',
    name: 'Fusion National',
    kind: 'national',
    included: true,
    locked: true,
    following: true,
    verified: false,
  };
  const [branches, setBranches] = useState<BranchChoice[]>(props.branches);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(props.branches.filter((branch) => branch.following && !branch.included).map((branch) => branch.branchId)),
  );
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [hidden, setHidden] = useState(false);
  const [ready, setReady] = useState(mode !== 'invite');
  const onboardingKey = scopedKey(ONBOARDED_KEY, memberKey);
  const draftKey = scopedKey(DRAFT_KEY, memberKey);

  useEffect(() => {
    if (mode === 'invite') {
      const dismissed = readStorage(scopedKey(INVITE_DISMISSED_KEY, memberKey)) === 'true';
      // While the getting-started guide is still open it already offers the
      // branch step, so the one-time invitation stays out of the way.
      const onboardingOpen = readStorage('engage_onboarding_dismissed_v1') !== 'true';
      setHidden(dismissed || onboardingOpen);
      setReady(true);
      return;
    }
    if (mode === 'onboarding') {
      const alreadyDone = readStorage(onboardingKey) === 'true';
      const draft = readStorage(draftKey);
      if (!alreadyDone && draft) {
        try {
          const parsed = JSON.parse(draft);
          if (Array.isArray(parsed)) {
            setSelected(new Set(parsed.filter((item): item is string => typeof item === 'string')));
          }
        } catch {
          // Ignore a corrupt draft and keep the server-backed selection.
        }
      }
      setReady(true);
    }
  }, [mode, memberKey, onboardingKey, draftKey]);

  const available = useMemo(() => branches.filter((branch) => !branch.included), [branches]);
  const stateBranches = useMemo(
    () => available.filter((branch) => branch.kind === 'state' || branch.kind === 'territory'),
    [available],
  );
  const invitationBranches = stateBranches.length ? stateBranches : available;
  const connected = useMemo(
    () => branches.filter((branch) => branch.included || branch.following || branch.verified),
    [branches],
  );

  function toggleDraft(branch: BranchChoice) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(branch.branchId)) next.delete(branch.branchId);
      else next.add(branch.branchId);
      writeStorage(draftKey, JSON.stringify([...next]));
      return next;
    });
  }

  async function saveSelection() {
    setSaving(true);
    setFeedback({ tone: 'info', text: 'Saving your branches…' });
    const { ok, data } = await postBranchChange({ branchIds: [...selected] });
    setSaving(false);
    if (!ok) {
      setFeedback({ tone: 'error', text: data.error || 'Could not save your branches right now.' });
      return;
    }
    if (data.branches) setBranches(data.branches);
    writeStorage(onboardingKey, 'true');
    setFeedback({ tone: 'success', text: 'Your branches are saved. You can change them any time in My Engage.' });
    if (mode === 'invite') {
      writeStorage(scopedKey(INVITE_DISMISSED_KEY, memberKey), 'true');
      setHidden(true);
    }
    props.onComplete?.();
  }

  function skipSelection() {
    writeStorage(onboardingKey, 'true');
    if (mode === 'invite') {
      writeStorage(scopedKey(INVITE_DISMISSED_KEY, memberKey), 'true');
      setHidden(true);
    }
    setFeedback({ tone: 'info', text: 'No changes made. You can choose branches any time in My Engage.' });
    props.onComplete?.();
  }

  async function toggleFollowing(branch: BranchChoice, following: boolean) {
    setSaving(true);
    setFeedback({ tone: 'info', text: following ? `Following ${branch.name}…` : `Updating ${branch.name}…` });
    const { ok, data } = await postBranchChange({ branchId: branch.branchId, following });
    setSaving(false);
    if (!ok) {
      setFeedback({ tone: 'error', text: data.error || 'Could not update this branch right now.' });
      return;
    }
    if (data.branches) setBranches(data.branches);
    setFeedback({
      tone: 'success',
      text: following
        ? `You now follow ${branch.name}. Branch administrators decide who is a verified member.`
        : `You no longer follow ${branch.name}.${branch.verified ? ' Your verified membership is unchanged.' : ''}`,
    });
  }

  function requestFollowing(branch: BranchChoice, following: boolean) {
    if (following) {
      void toggleFollowing(branch, true);
      return;
    }
    if (branch.verified || branch.branchRole === 'administrator') {
      setConfirm({
        title: `Stop following ${branch.name}?`,
        description: (
          <p>
            You will stay a verified {branch.name} member. You will just stop seeing its updates in your feed.
            You can follow it again at any time.
          </p>
        ),
        confirmLabel: 'Stop following',
        onConfirm: () => toggleFollowing(branch, false),
      });
      return;
    }
    void toggleFollowing(branch, false);
  }

  if (mode === 'invite') {
    if (!ready || hidden) return null;
    return (
      <section
        aria-labelledby="branch-invite-heading"
        className="mb-5 overflow-hidden rounded-xl border border-[var(--horizon-line)] bg-white"
      >
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--horizon-line)] bg-[var(--horizon-lavender-soft)] px-5 py-4">
          <div>
            <span className="mb-1 inline-flex items-center gap-1.5 text-xs font-bold text-[var(--horizon-purple)]">
              <Sparkles aria-hidden="true" className="size-3.5" /> One-time invitation
            </span>
            <h2 id="branch-invite-heading" className="font-heading text-xl font-semibold text-[var(--horizon-purple-deep)]">
              Add your state branch
            </h2>
            <p className="mt-1 max-w-[65ch] text-sm text-[var(--horizon-muted)]">
              Choose your state or territory so relevant proposals and discussions appear in My Engage.
              You can add local branches any time from My branches. Following does not automatically make you a verified member.
            </p>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={skipSelection}>
            Not now
          </Button>
        </div>
        <div className="grid gap-4 px-5 py-4">
          <NationalRow branch={national} />
          <BranchGroups
            branches={invitationBranches}
            selected={selected}
            onToggle={toggleDraft}
            disabled={saving}
            compact
          />
          {!stateBranches.length && available.length > 0 && (
            <p className="text-xs text-[var(--horizon-muted)]">
              State branches are not listed yet. You can browse every available branch in{' '}
              <a className="font-semibold underline" href="/member/?view=branches">My branches</a>.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <StatusLine feedback={feedback} className="mr-auto" />
            <a className="text-xs font-semibold underline" href="/member/?view=branches">See local branches</a>
            <Button type="button" size="sm" disabled={saving} onClick={saveSelection}>
              {saving ? 'Saving…' : 'Save my state branch'}
            </Button>
          </div>
        </div>
      </section>
    );
  }

  if (mode === 'onboarding') {
    if (!ready) return null;
    return (
      <section aria-labelledby="onboarding-branches-heading" className="border-b border-[var(--horizon-line)] bg-white px-5 py-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <span className="inline-flex items-center gap-1.5 text-xs font-bold text-[var(--horizon-purple)]">
              <MapPin aria-hidden="true" className="size-3.5" /> Optional · 20 seconds
            </span>
            <h3 id="onboarding-branches-heading" className="mt-1 font-heading text-xl font-semibold text-[var(--horizon-purple-deep)]">
              Your branches
            </h3>
            <p className="mt-1 max-w-[65ch] text-sm text-[var(--horizon-muted)]">
              Follow the branches you care about to discover local proposals and participate in discussions.
              Fusion National is included automatically. Following a branch does not make you a verified member
              or change your voting rights.
            </p>
          </div>
        </div>
        <div className="mt-4 grid gap-4">
          <NationalRow branch={national} />
          <BranchGroups
            branches={available}
            selected={selected}
            onToggle={toggleDraft}
            disabled={saving}
          />
          <div className="flex flex-wrap items-center gap-3">
            <StatusLine feedback={feedback} className="mr-auto" />
            <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={skipSelection}>
              Skip for now
            </Button>
            <Button type="button" size="sm" disabled={saving} onClick={saveSelection}>
              {saving ? 'Saving…' : selected.size ? `Save ${selected.size === 1 ? 'branch' : `${selected.size} branches`}` : 'Save branches'}
            </Button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        <section aria-labelledby="my-branches-list-heading" className="min-w-0 rounded-xl border border-[var(--horizon-line)] bg-white">
          <header className="border-b border-[var(--horizon-line)] px-5 py-4">
            <h2 id="my-branches-list-heading" className="font-heading text-xl font-semibold text-[var(--horizon-purple-deep)]">
              Your branches
            </h2>
            <p className="mt-1 text-sm text-[var(--horizon-muted)]">
              Fusion National is included for every Engage user. A verified membership is separate from following.
            </p>
          </header>
          <ul className="divide-y divide-[var(--horizon-line)]">
            {connected.map((branch) => (
              <li key={branch.branchId} className="flex flex-wrap items-start justify-between gap-2 px-5 py-3.5">
                <div className="min-w-0">
                  <strong className="block text-sm">{branch.name}</strong>
                  <span className="block text-xs text-[var(--horizon-muted)]">
                    {branch.parentName && branch.kind === 'constituent' ? `Local branch · part of ${branch.parentName}` : branch.included ? 'National governance' : 'Branch'}
                  </span>
                </div>
                <BranchStatus branch={branch} />
              </li>
            ))}
          </ul>
          {connected.length === 1 && (
            <p className="border-t border-[var(--horizon-line)] px-5 py-3 text-sm text-[var(--horizon-muted)]">
              You haven’t chosen a state, territory or local branch yet. Follow one below to see its proposals and updates.
            </p>
          )}
          <div className="border-t border-[var(--horizon-line)] px-5 py-4">
            <StatusLine feedback={feedback} />
          </div>
        </section>

        <section aria-labelledby="discover-branches-heading" className="min-w-0 rounded-xl border border-[var(--horizon-line)] bg-white">
          <header className="border-b border-[var(--horizon-line)] px-5 py-4">
            <h2 id="discover-branches-heading" className="font-heading text-xl font-semibold text-[var(--horizon-purple-deep)]">
              Discover branches
            </h2>
            <p className="mt-1 text-sm text-[var(--horizon-muted)]">
              Follow or unfollow a branch at any time. Changes take effect immediately.
            </p>
          </header>
          <div className="px-5 py-4">
            <BranchGroups
              branches={available}
              onToggle={(branch) => requestFollowing(branch, !branch.following)}
              disabled={saving}
              showSearch
              query={query}
              setQuery={setQuery}
            />
          </div>
        </section>
      </div>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </>
  );
}
