import { useState, type ReactNode, type SubmitEvent } from 'react';
import { createAuthClient } from 'better-auth/client';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card';
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
  branches: { id: string; name: string }[];
  stats: { votes: number; contributions: number; ideas: number };
}

const authClient = createAuthClient();

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
    ? branches.map((branch) => branch.name).join(' · ')
    : 'No branch membership on record';

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
          <InfoRow description="Proposals from these branches appear in your overview." label="Branch memberships">
            {branches.length ? (
              <ul className="flex flex-col gap-1 text-sm">
                {branches.map((branch) => (
                  <li key={branch.id}>{branch.name}</li>
                ))}
              </ul>
            ) : (
              <span className="text-sm text-muted-foreground">None on record</span>
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

export default function MemberSettings(props: MemberSettingsProps) {
  const [name, setName] = useState(props.name);

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="grid w-full gap-4 lg:grid-cols-2 xl:grid-cols-[.8fr_1.2fr]">
        <MemberPreview branches={props.branches} name={name} stats={props.stats} status={props.status} />
        <ProfileSection email={props.email} name={name} onSaved={setName} />
      </div>
      <div className="grid w-full gap-4 xl:grid-cols-2">
        <AccessSection branches={props.branches} canParticipate={props.canParticipate} role={props.role} />
        <SessionsSection />
      </div>
    </div>
  );
}
