import { useEffect, useState, type ReactNode, type SubmitEvent } from 'react';
import { createAuthClient } from 'better-auth/client';
import { passkeyClient } from '@better-auth/passkey/client';
import { getAuthenticatorName, type Passkey } from '@better-auth/passkey';
import { Fingerprint, KeyRound, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldSeparator, FieldTitle } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { StatusIndicator } from '@/components/indicator';
import { SettingsSection } from '@/components/settings-section';
import { SettingField } from '@/components/settings-field';

type MembershipStatus = 'pending' | 'verified' | 'suspended';
type MemberRole = 'member' | 'moderator' | 'administrator';

export interface MemberSettingsProps {
  name: string;
  email: string;
  role: MemberRole;
  status: MembershipStatus;
  canParticipate: boolean;
  branches: { id: string; name: string; status?: 'member' | 'follower' }[];
  stats: { votes: number; contributions: number; ideas: number };
}

const authClient = createAuthClient({
  plugins: [passkeyClient()],
});

const statusCopy: Record<MembershipStatus, { label: string; description: string; color: 'emerald' | 'amber' | 'rose' }> = {
  verified: {
    label: 'Verified member',
    description: 'You can comment and suggest ideas. Voting depends on each ballot’s eligibility rules.',
    color: 'emerald',
  },
  pending: {
    label: 'Verification pending',
    description: 'You can read and explore while an administrator confirms your party membership.',
    color: 'amber',
  },
  suspended: {
    label: 'Participation suspended',
    description: 'Contact a party administrator about your membership before taking part.',
    color: 'rose',
  },
};

const roleLabel: Record<MemberRole, string> = {
  member: 'Member',
  moderator: 'Moderator',
  administrator: 'Administrator',
};

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

function InfoRow({ label, description, children }: { label: string; description: string; children: ReactNode }) {
  return (
    <Field className="px-(--card-spacing) @md/field-group:items-center" orientation="responsive">
      <FieldContent>
        <FieldTitle>{label}</FieldTitle>
        <FieldDescription className="text-xs">{description}</FieldDescription>
      </FieldContent>
      <FieldContent className="items-start @md/field-group:items-end">{children}</FieldContent>
    </Field>
  );
}

function MemberPreview({ name, status, branches, stats }: Pick<MemberSettingsProps, 'name' | 'status' | 'branches' | 'stats'>) {
  const copy = statusCopy[status];
  const branchLabel = branches.length
    ? branches.map((branch) => `${branch.name}${branch.status === 'member' ? ' (member)' : branch.status === 'follower' ? ' (follower)' : ''}`).join(' · ')
    : 'Fusion National only';

  return (
    <Card className="h-full gap-0 shadow-none">
      <CardHeader className="px-5 pt-5">
        <Badge variant="secondary">Member record</Badge>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col items-start justify-center px-(--card-spacing) py-8">
        <Avatar className="size-20">
          <AvatarFallback className="font-heading text-xl">{initials(name) || 'FM'}</AvatarFallback>
        </Avatar>
        <p className="mt-4 font-heading text-xl font-medium text-balance">{name}</p>
        <p className="mt-1 text-sm text-pretty text-muted-foreground">{branchLabel}</p>
        <div className="mt-3 flex items-center gap-1.5 text-xs">
          <StatusIndicator color={copy.color} pulse={false} />
          <span>{copy.label}</span>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">{copy.description}</p>
      </CardContent>
      <CardFooter className="grid w-full grid-cols-3 divide-x border-t px-0 py-4">
        {[
          { label: 'Votes', value: stats.votes },
          { label: 'Contributions', value: stats.contributions },
          { label: 'Ideas', value: stats.ideas },
        ].map((stat) => (
          <div className="flex flex-col gap-1 ps-5" key={stat.label}>
            <p className="text-[10px] font-mono tracking-wide text-muted-foreground uppercase">{stat.label}</p>
            <p className="text-sm font-semibold tabular-nums">{stat.value}</p>
          </div>
        ))}
      </CardFooter>
    </Card>
  );
}

function ProfileSection({ name, email, onSaved }: { name: string; email: string; onSaved: (name: string) => void }) {
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const trimmed = draft.trim();
  const invalid = trimmed.length < 2 || trimmed.length > 100;
  const changed = trimmed !== name;

  async function save(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (invalid || !changed || saving) return;
    setSaving(true);
    setFailed(false);
    setMessage('Saving…');
    try {
      const result = await authClient.updateUser({ name: trimmed });
      if (result.error) {
        setFailed(true);
        setMessage(
          result.error.status === 429
            ? 'Too many attempts. Please wait a minute and try again.'
            : result.error.message || 'Could not save your name.',
        );
      } else {
        onSaved(trimmed);
        setMessage('Your display name has been saved.');
      }
    } catch {
      setFailed(true);
      setMessage('Could not save your name. Please try again shortly.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} noValidate>
      <SettingsSection
        description="How your name appears on ideas, comments and votes you record."
        title="Profile"
      >
        <CardContent className="flex-1 px-0 py-(--card-spacing)">
          <FieldGroup className="gap-5">
            <SettingField
              description="Shown to other members and administrators."
              htmlFor="member-display-name"
              label="Display name"
            >
              <Input
                aria-invalid={invalid && draft.length > 0}
                autoComplete="name"
                id="member-display-name"
                maxLength={100}
                minLength={2}
                onChange={(event) => setDraft(event.target.value)}
                required
                value={draft}
              />
            </SettingField>
            <FieldSeparator />
            <SettingField
              description="Used for sign-in links and member notices. Ask an administrator to change it."
              htmlFor="member-email"
              label="Email address"
            >
              <Input autoComplete="email" className="bg-muted" id="member-email" readOnly type="email" value={email} />
            </SettingField>
          </FieldGroup>
        </CardContent>
        <CardFooter className="justify-end gap-3 border-t px-5 py-3">
          <p
            aria-live="polite"
            className={failed ? 'mr-auto text-sm font-semibold [color:var(--horizon-danger-ink)]' : 'mr-auto text-sm text-muted-foreground'}
            role="status"
          >
            {message}
          </p>
          <Button disabled={!changed || invalid || saving} size="sm" type="submit">
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </CardFooter>
      </SettingsSection>
    </form>
  );
}

function AccessSection({ role, canParticipate, branches }: Pick<MemberSettingsProps, 'role' | 'canParticipate' | 'branches'>) {
  return (
    <SettingsSection description="What your current account can do in Engage." title="Membership access">
      <CardContent className="flex-1 px-0 py-(--card-spacing)">
        <FieldGroup className="gap-5">
          <InfoRow description="Assigned by the party, not editable here." label="Account role">
            <Badge variant={role === 'member' ? 'muted' : 'secondary'}>{roleLabel[role]}</Badge>
          </InfoRow>
          <FieldSeparator />
          <InfoRow description="Eligibility is checked again for each ballot." label="Participation">
            <span className="text-sm">{canParticipate ? 'Comment, suggest and vote' : 'Read and explore only'}</span>
          </InfoRow>
          <FieldSeparator />
          <InfoRow description="Following a branch shows its proposals. Verified membership is decided by the branch." label="Branches you follow">
            {branches.length ? (
              <ul className="flex flex-col gap-1 text-sm">
                {branches.map((branch) => (
                  <li key={branch.id}>
                    {branch.name}{' '}
                    <span className="text-xs text-muted-foreground">
                      {branch.status === 'member' ? 'Member' : 'Follower'}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-sm text-muted-foreground">Fusion National is included for every account</span>
            )}
          </InfoRow>
        </FieldGroup>
      </CardContent>
    </SettingsSection>
  );
}

function SessionsSection() {
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);

  async function signOutOthers() {
    setMessage('');
    setFailed(false);
    try {
      const response = await fetch('/api/auth/revoke-other-sessions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) throw new Error(String(response.status));
      setMessage('Other sessions have been signed out.');
    } catch {
      setFailed(true);
      setMessage('Could not sign out other sessions. Please try again.');
    }
  }

  async function signOut() {
    try {
      await fetch('/api/session', { method: 'DELETE', credentials: 'same-origin' });
    } finally {
      location.href = '/';
    }
  }

  return (
    <SettingsSection description="Manage where your account is signed in." title="Sessions">
      <CardContent className="flex-1 px-0 py-(--card-spacing)">
        <FieldGroup className="gap-5">
          <InfoRow description="End every other signed-in session. This device stays signed in." label="Other devices">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" type="button" variant="outline">
                  Sign out other sessions
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent size="sm">
                <AlertDialogHeader>
                  <AlertDialogTitle>Sign out other sessions?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Every other browser and device will need to sign in again. This session will stay active.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={signOutOthers}>Sign out others</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </InfoRow>
          <FieldSeparator />
          <InfoRow description="End this session and return to the public site." label="This device">
            <Button onClick={signOut} size="sm" type="button" variant="outline">
              Sign out
            </Button>
          </InfoRow>
        </FieldGroup>
      </CardContent>
      {message && (
        <CardFooter className="border-t px-5 py-3">
          <p
            aria-live="polite"
            className={failed ? 'text-sm font-semibold [color:var(--horizon-danger-ink)]' : 'text-sm text-muted-foreground'}
            role="status"
          >
            {message}
          </p>
        </CardFooter>
      )}
    </SettingsSection>
  );
}

function defaultPasskeyLabel(): string {
  if (typeof navigator === 'undefined') return 'My device passkey';
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iPhone / iPad Passkey';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac Passkey';
  if (/Android/i.test(ua)) return 'Android Passkey';
  if (/Windows/i.test(ua)) return 'Windows Hello Passkey';
  if (/Linux/i.test(ua)) return 'Linux Passkey';
  return 'Device Passkey';
}

function PasskeysSection() {
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [loading, setLoading] = useState(true);
  const [supported, setSupported] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [autoPrompt, setAutoPrompt] = useState(true);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);

  async function loadPasskeys() {
    setLoading(true);
    try {
      const response = await fetch('/api/auth/passkey/list-user-passkeys', {
        method: 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        setPasskeys([]);
        return;
      }
      const list = (await response.json()) as Passkey[];
      const items = Array.isArray(list) ? list : [];
      setPasskeys(items);
      try {
        if (items.length > 0) {
          localStorage.setItem('engage_passkey_enrolled', 'true');
        }
      } catch {
        // Ignore storage restrictions
      }
    } catch {
      setPasskeys([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setSupported(typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined');
    setNewLabel(defaultPasskeyLabel());
    try {
      const storedAuto = localStorage.getItem('engage_passkey_autoprompt');
      if (storedAuto === 'false') {
        setAutoPrompt(false);
      }
    } catch {
      // Ignore
    }
    void loadPasskeys();
  }, []);

  function toggleAutoPrompt(enabled: boolean) {
    setAutoPrompt(enabled);
    try {
      localStorage.setItem('engage_passkey_autoprompt', enabled ? 'true' : 'false');
    } catch {
      // Ignore
    }
  }

  async function handleAddPasskey(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (adding || !supported) return;
    setAdding(true);
    setFailed(false);
    setMessage('Complete the prompt on your device to save your passkey…');
    try {
      const label = newLabel.trim() || defaultPasskeyLabel();
      const result = await authClient.passkey.addPasskey({
        name: label,
      });
      if (result.error) {
        const errCode = 'code' in result.error ? result.error.code : undefined;
        setFailed(true);
        if (errCode === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') {
          setMessage('This device already has a passkey registered for your account.');
        } else if (errCode === 'ERROR_CEREMONY_ABORTED' || errCode === 'REGISTRATION_CANCELLED') {
          setMessage('Passkey setup was cancelled. You can try again anytime.');
        } else if (result.error.status === 401 || result.error.status === 403 || errCode === 'SESSION_REQUIRED') {
          setMessage('Sign in with an email link or Google on a live account before registering a passkey.');
        } else {
          setMessage(result.error.message || 'Could not register passkey on this device.');
        }
      } else {
        setMessage('Passkey added. You can now sign in with one tap using this passkey.');
        try {
          localStorage.setItem('engage_passkey_enrolled', 'true');
        } catch {
          // Ignore storage restrictions
        }
        await loadPasskeys();
      }
    } catch {
      setFailed(true);
      setMessage('Could not register passkey. Ensure you are signed in with a live account.');
    } finally {
      setAdding(false);
    }
  }

  async function handleDeletePasskey(id: string, displayLabel: string) {
    setFailed(false);
    setMessage(`Removing "${displayLabel}"…`);
    try {
      const response = await fetch('/api/auth/passkey/delete-passkey', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!response.ok) throw new Error(String(response.status));
      setPasskeys((prev) => prev.filter((item) => item.id !== id));
      setMessage(`Removed passkey "${displayLabel}".`);
    } catch {
      setFailed(true);
      setMessage('Could not remove passkey. Please try again.');
    }
  }

  return (
    <SettingsSection
      description="Sign in with Face ID, Touch ID, Windows Hello, or a hardware security key—no email wait required."
      id="passkeys"
      title="Passkeys & biometric sign-in"
    >
      <CardContent className="flex-1 px-0 py-(--card-spacing)">
        <FieldGroup className="gap-5">
          <div className="px-(--card-spacing)">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-[var(--horizon-lavender-soft)] px-4 py-3">
              <div className="flex items-start gap-3">
                <Fingerprint className="mt-0.5 size-5 shrink-0 text-[var(--horizon-purple)]" aria-hidden="true" />
                <div className="grid gap-0.5">
                  <p className="text-sm font-semibold text-[var(--horizon-purple-deep)]">
                    Phishing-resistant, instant sign-in
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Passkeys stay in your device or password manager (iCloud Keychain, Google Password Manager, 1Password, Bitwarden) and never expose biometrics to Engage.
                  </p>
                </div>
              </div>
              <Badge variant={passkeys.length > 0 ? 'success' : 'secondary'}>
                {passkeys.length > 0 ? `${passkeys.length} registered` : 'Recommended'}
              </Badge>
            </div>
          </div>

          <FieldSeparator />

          <div className="px-(--card-spacing)">
            <p className="mb-2.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Registered passkeys
            </p>
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading your passkeys…</p>
            ) : passkeys.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No passkeys registered yet. Add one below so you can sign in without waiting for an email link.
              </p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {passkeys.map((item) => {
                  const providerName = getAuthenticatorName(item.aaguid);
                  const displayLabel = item.name || providerName || 'Passkey';
                  const createdLabel = item.createdAt
                    ? new Date(item.createdAt).toLocaleDateString('en-AU', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })
                    : null;
                  return (
                    <li className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5" key={item.id}>
                      <div className="flex items-center gap-2.5 min-w-0">
                        <KeyRound className="size-4 shrink-0 text-[var(--horizon-purple)]" aria-hidden="true" />
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate text-sm font-semibold">{displayLabel}</span>
                            {item.backedUp && (
                              <Badge variant="outline" className="text-xs">
                                Synced
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {providerName && item.name && providerName !== item.name ? `${providerName} · ` : ''}
                            {createdLabel ? `Added ${createdLabel}` : 'Active credential'}
                          </p>
                        </div>
                      </div>

                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button size="sm" type="button" variant="ghost" className="text-xs">
                            <Trash2 className="size-3.5" aria-hidden="true" />
                            Remove
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent size="sm">
                          <AlertDialogHeader>
                            <AlertDialogTitle>Remove passkey "{displayLabel}"?</AlertDialogTitle>
                            <AlertDialogDescription>
                              You will no longer be able to sign in with this passkey unless you add it again. Your email link sign-in will still work.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => handleDeletePasskey(item.id, displayLabel)}>
                              Remove passkey
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <FieldSeparator />

          <form className="grid gap-3 px-(--card-spacing)" onSubmit={handleAddPasskey}>
            <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
              <div className="grid gap-1">
                <label className="text-xs font-semibold" htmlFor="new-passkey-label">
                  Passkey label (helps you recognise this device)
                </label>
                <Input
                  disabled={!supported || adding}
                  id="new-passkey-label"
                  maxLength={64}
                  onChange={(event) => setNewLabel(event.target.value)}
                  placeholder="e.g. MacBook Touch ID or 1Password"
                  value={newLabel}
                />
              </div>
              <Button disabled={!supported || adding} size="sm" type="submit">
                <Plus className="size-4" aria-hidden="true" />
                {adding ? 'Waiting for device…' : 'Add a passkey'}
              </Button>
            </div>
            {!supported && (
              <p className="text-xs text-muted-foreground">
                This browser does not support WebAuthn passkeys. Try Safari, Chrome, Edge, or Firefox on a modern device.
              </p>
            )}
          </form>

          {supported && (
            <>
              <FieldSeparator />
              <InfoRow
                description="When enabled, visiting the sign-in screen on this browser automatically opens your passkey prompt."
                label="Automatic passkey prompt"
              >
                <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-semibold text-[var(--horizon-purple-deep)]">
                  <Checkbox
                    checked={autoPrompt}
                    onChange={(event) => toggleAutoPrompt(event.target.checked)}
                  />
                  <span>Auto-prompt on sign-in</span>
                </label>
              </InfoRow>
            </>
          )}
        </FieldGroup>
      </CardContent>
      {message && (
        <CardFooter className="border-t px-5 py-3">
          <p
            aria-live="polite"
            className={
              failed
                ? 'text-sm font-semibold [color:var(--horizon-danger-ink)]'
                : 'flex items-center gap-1.5 text-sm font-medium [color:var(--horizon-success-ink)]'
            }
            role="status"
          >
            {!failed && <ShieldCheck className="size-4 shrink-0" aria-hidden="true" />}
            <span>{message}</span>
          </p>
        </CardFooter>
      )}
    </SettingsSection>
  );
}

export default function MemberSettings(props: MemberSettingsProps) {
  const [name, setName] = useState(props.name);

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="grid w-full gap-4 lg:grid-cols-2 xl:grid-cols-[.8fr_1.2fr]">
        <MemberPreview branches={props.branches} name={name} stats={props.stats} status={props.status} />
        <ProfileSection email={props.email} name={name} onSaved={setName} />
      </div>
      <PasskeysSection />
      <div className="grid w-full gap-4 xl:grid-cols-2">
        <AccessSection branches={props.branches} canParticipate={props.canParticipate} role={props.role} />
        <SessionsSection />
      </div>
    </div>
  );
}
