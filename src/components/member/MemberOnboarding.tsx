import { useEffect, useState } from 'react';
import { trackEngage } from '../../lib/analytics.ts';
import { createAuthClient } from 'better-auth/client';
import { passkeyClient } from '@better-auth/passkey/client';
import type { Passkey } from '@better-auth/passkey';
import {
  ArrowRight,
  CheckCircle2,
  Circle,
  Compass,
  Fingerprint,
  MessageSquare,
  ShieldCheck,
  Sparkles,
  Vote,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import BranchChooser, { type BranchChoice } from '@/components/member/BranchChooser';

export interface MemberOnboardingProps {
  name: string;
  email: string;
  status: 'pending' | 'verified' | 'suspended';
  canParticipate: boolean;
  branches: { id: string; name: string }[];
  branchChoices?: BranchChoice[];
  followingBranchCount?: number;
  memberKey?: string;
  openBallotsCount: number;
  firstBallotHref?: string;
  firstBallotTitle?: string;
  deliberationsCount: number;
  firstDeliberationHref?: string;
  firstDeliberationTitle?: string;
  totalContributions: number;
  initialPasskeyCount?: number;
  digestEnabled?: boolean;
  digestExistingMember?: boolean;
  digestSuppressed?: boolean;
}

const DISMISS_STORAGE_KEY = 'engage_onboarding_dismissed_v1';
const WALKTHROUGH_STORAGE_KEY = 'engage_onboarding_walkthrough_seen_v1';
const PASSKEY_STORAGE_KEY = 'engage_passkey_enrolled';
const PASSKEY_NUDGE_DISMISSED_KEY = 'engage_passkey_nudge_dismissed_v1';
const PASSKEY_AUTOREG_ATTEMPTED_KEY = 'engage_passkey_autoreg_attempted_v1';
const KNOWN_EMAIL_KEY = 'engage_known_member_email';

const authClient = createAuthClient({
  plugins: [passkeyClient()],
});

function defaultDevicePasskeyName(): string {
  if (typeof navigator === 'undefined') return 'My device passkey';
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iPhone / iPad Passkey';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac Passkey';
  if (/Android/i.test(ua)) return 'Android Passkey';
  if (/Windows/i.test(ua)) return 'Windows Hello Passkey';
  return 'Device Passkey';
}

export default function MemberOnboarding(props: MemberOnboardingProps) {
  const [dismissed, setDismissed] = useState(false);
  const [hasPasskey, setHasPasskey] = useState(Boolean((props.initialPasskeyCount ?? 0) > 0));
  const [passkeySupported, setPasskeySupported] = useState(true);
  const [enrollingPasskey, setEnrollingPasskey] = useState(false);
  const [passkeyFeedback, setPasskeyFeedback] = useState('');
  const [passkeyError, setPasskeyError] = useState(false);
  const [seenWalkthrough, setSeenWalkthrough] = useState(false);
  const [nudgeDismissed, setNudgeDismissed] = useState(false);
  const [branchesDone, setBranchesDone] = useState(Boolean((props.followingBranchCount ?? 0) > 0));

  useEffect(() => {
    let localHasPasskey = Boolean((props.initialPasskeyCount ?? 0) > 0);
    try {
      if (props.email) {
        localStorage.setItem(KNOWN_EMAIL_KEY, props.email);
      }
      if (localStorage.getItem(DISMISS_STORAGE_KEY) === 'true') {
        setDismissed(true);
      }
      if (localStorage.getItem(WALKTHROUGH_STORAGE_KEY) === 'true') {
        setSeenWalkthrough(true);
      }
      if (localStorage.getItem(PASSKEY_STORAGE_KEY) === 'true') {
        localHasPasskey = true;
        setHasPasskey(true);
      }
      if (sessionStorage.getItem(PASSKEY_NUDGE_DISMISSED_KEY) === 'true') {
        setNudgeDismissed(true);
      }
      const branchKey = `engage_branches_onboarded_v1:${props.memberKey || props.email}`;
      if (localStorage.getItem(branchKey) === 'true') {
        setBranchesDone(true);
      }
    } catch {
      // Ignore storage access errors
    }

    const supported =
      typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined';
    setPasskeySupported(supported);

    async function checkAndAutoUpgradePasskey() {
      try {
        const res = await fetch('/api/auth/passkey/list-user-passkeys', {
          method: 'GET',
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        });
        if (!res.ok) return;
        const list = (await res.json()) as Passkey[];
        if (Array.isArray(list) && list.length > 0) {
          setHasPasskey(true);
          try {
            localStorage.setItem(PASSKEY_STORAGE_KEY, 'true');
          } catch {
            // Ignore
          }
          return;
        }

        // WebAuthn Conditional Create (`useAutoRegister: true`)
        // Silently upgrades the member's session to a passkey when supported by the browser/OS
        if (
          supported &&
          !localHasPasskey &&
          sessionStorage.getItem(PASSKEY_AUTOREG_ATTEMPTED_KEY) !== 'true'
        ) {
          sessionStorage.setItem(PASSKEY_AUTOREG_ATTEMPTED_KEY, 'true');
          trackEngage('passkey_enrollment', { mode: 'automatic', outcome: 'attempted' });
          const autoRes = await authClient.passkey.addPasskey({
            name: defaultDevicePasskeyName(),
            useAutoRegister: true,
          });
          trackEngage('passkey_enrollment', { mode: 'automatic', outcome: autoRes && !autoRes.error ? 'success' : 'failed' });
          if (autoRes && !autoRes.error) {
            setHasPasskey(true);
            setPasskeyFeedback('Passkey automatically saved for 1-tap sign-in next time.');
            try {
              localStorage.setItem(PASSKEY_STORAGE_KEY, 'true');
            } catch {
              // Ignore
            }
          }
        }
      } catch {
        // Ignore on local dev sessions without DB backing or unsupported conditional create
      }
    }

    void checkAndAutoUpgradePasskey();
  }, [props.email, props.memberKey, props.initialPasskeyCount]);

  if (props.status === 'suspended' || dismissed) {
    return null;
  }

  const verifiedDone = props.status === 'verified';
  const participatedDone = props.totalContributions > 0 || seenWalkthrough;
  const chosenBranches = (props.branchChoices ?? []).filter(
    (branch) => !branch.included && (branch.following || branch.verified),
  );

  const steps = [
    {
      id: 'account',
      done: true,
      title: 'Signed in to your Engage member profile',
      description: `Connected as ${props.name || props.email} (${props.email}).`,
      time: 'Completed',
    },
    {
      id: 'passkey',
      done: hasPasskey,
      title: hasPasskey
        ? 'Passkey saved for 1-tap biometric sign-in'
        : 'Add a passkey for instant next-visit sign-in',
      description: hasPasskey
        ? 'Your device passkey is ready whenever you return.'
        : 'Use Face ID, Touch ID, Windows Hello, or your password manager instead of waiting for email links.',
      time: '15 sec',
    },
    {
      id: 'verification',
      done: verifiedDone,
      title: verifiedDone
        ? `Fusion membership verified${props.branches.length ? ` · ${props.branches.map((b) => b.name).join(', ')}` : ''}`
        : 'Membership verification in progress',
      description: verifiedDone
        ? 'You can suggest ideas, post deliberation stances, propose amendments, and vote in eligible ballots.'
        : 'An administrator cross-checks your name and email against the Fusion roll. You can explore every public proposal while you wait.',
      time: verifiedDone ? 'Verified' : 'Automatic notice',
    },
    {
      id: 'branches',
      done: branchesDone,
      title: branchesDone
        ? chosenBranches.length
          ? `Connected to ${chosenBranches.map((branch) => branch.name).join(', ')}`
          : 'Branches chosen later'
        : 'Choose your branches',
      description: branchesDone
        ? 'Fusion National is included. You can change which branches you follow at any time in My Engage.'
        : 'Follow state or local branches to discover their proposals. Following does not make you a verified member or change your voting rights.',
      time: '20 sec',
    },
    {
      id: 'first-action',
      done: participatedDone,
      title:
        props.totalContributions > 0
          ? 'First governance contribution recorded'
          : props.canParticipate && props.openBallotsCount > 0
            ? `Cast your first vote (${props.openBallotsCount} open ${props.openBallotsCount === 1 ? 'ballot' : 'ballots'})`
            : props.canParticipate && props.deliberationsCount > 0
              ? `Join an active deliberation (${props.deliberationsCount} open)`
              : 'Explore live proposals & the 60-second walkthrough',
      description:
        props.totalContributions > 0
          ? 'Your votes, deliberation stances, and ideas are tracked in your personal log.'
          : props.canParticipate && props.firstBallotTitle
            ? `Up next: "${props.firstBallotTitle}" — bound to an immutable wording snapshot.`
            : props.canParticipate && props.firstDeliberationTitle
              ? `Up next: "${props.firstDeliberationTitle}" — share Support, a Concern, or a Wording suggestion.`
              : 'See how ideas move from Propose and Deliberate to Decide and the Official Policy Registry.',
      time: '2 min',
    },
  ];

  const completedCount = steps.filter((s) => s.done).length;
  const progressPercent = Math.round((completedCount / steps.length) * 100);

  async function enrollPasskeyNow() {
    if (enrollingPasskey || !passkeySupported) return;
    trackEngage('passkey_enrollment', { mode: 'manual', outcome: 'attempted' });
    setEnrollingPasskey(true);
    setPasskeyError(false);
    setPasskeyFeedback('Confirm on your device to save your passkey…');
    try {
      const result = await authClient.passkey.addPasskey({
        name: defaultDevicePasskeyName(),
      });
      trackEngage('passkey_enrollment', { mode: 'manual', outcome: result.error ? 'failed' : 'success' });
      if (result.error) {
        const errCode = 'code' in result.error ? result.error.code : undefined;
        setPasskeyError(true);
        if (errCode === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') {
          setHasPasskey(true);
          setPasskeyError(false);
          setPasskeyFeedback('This device already has a passkey registered.');
        } else if (errCode === 'ERROR_CEREMONY_ABORTED' || errCode === 'REGISTRATION_CANCELLED') {
          setPasskeyFeedback('Passkey prompt cancelled. You can add one anytime from Account & Access.');
        } else if (result.error.status === 401 || result.error.status === 403 || errCode === 'SESSION_REQUIRED') {
          setPasskeyFeedback('Sign in with an email link or Google on a live account to register a hardware/device passkey.');
        } else {
          setPasskeyFeedback(result.error.message || 'Could not register passkey right now.');
        }
      } else {
        setHasPasskey(true);
        setPasskeyFeedback('Passkey saved! Next time, click "Sign in with a passkey" for instant access.');
        try {
          localStorage.setItem(PASSKEY_STORAGE_KEY, 'true');
        } catch {
          // Ignore
        }
      }
    } catch {
      trackEngage('passkey_enrollment', { mode: 'manual', outcome: 'failed' });
      setPasskeyError(true);
      setPasskeyFeedback('Could not register passkey right now. You can manage passkeys in Account & Access.');
    } finally {
      setEnrollingPasskey(false);
    }
  }

  function handleDismiss() {
    trackEngage('onboarding_action', { action: 'dismiss' });
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_STORAGE_KEY, 'true');
    } catch {
      // Ignore
    }
  }

  function handleDismissNudge() {
    trackEngage('onboarding_action', { action: 'dismiss_passkey' });
    setNudgeDismissed(true);
    try {
      sessionStorage.setItem(PASSKEY_NUDGE_DISMISSED_KEY, 'true');
    } catch {
      // Ignore
    }
  }

  function markWalkthroughVisited() {
    trackEngage('onboarding_action', { action: 'explore' });
    setSeenWalkthrough(true);
    try {
      localStorage.setItem(WALKTHROUGH_STORAGE_KEY, 'true');
    } catch {
      // Ignore
    }
  }

  const primaryActionHref =
    props.canParticipate && props.firstBallotHref
      ? `${props.firstBallotHref}#proposal-vote`
      : props.canParticipate && props.firstDeliberationHref
        ? `${props.firstDeliberationHref}#deliberation`
        : '/proposals/';

  const primaryActionLabel =
    props.canParticipate && props.firstBallotHref
      ? 'Review & vote on your first ballot'
      : props.canParticipate && props.firstDeliberationHref
        ? 'Contribute to an active deliberation'
        : 'Explore live proposals';

  return (
    <section
      aria-labelledby="member-onboarding-heading"
      className="mb-5 overflow-hidden rounded-xl border border-[var(--horizon-line)] bg-white"
    >
      {/* Top Banner Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--horizon-line)] bg-[var(--horizon-lavender-soft)] px-5 py-3.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <Badge variant="info" className="gap-1">
            <Sparkles className="size-3" aria-hidden="true" />
            Getting started
          </Badge>
          <h2
            id="member-onboarding-heading"
            className="m-0 font-heading text-lg font-semibold text-[var(--horizon-purple-deep)]"
          >
            Your path to participating in Engage
          </h2>
          <span className="text-xs font-semibold text-[var(--horizon-muted)] tabular-nums">
            {completedCount} of {steps.length} complete ({progressPercent}%)
          </span>
        </div>

        <div className="flex items-center gap-3">
          <div
            aria-hidden="true"
            className="hidden h-2 w-28 overflow-hidden rounded-full bg-[var(--horizon-line)] sm:block"
          >
            <div
              className="h-full rounded-full bg-[var(--horizon-purple)] transition-all duration-300"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleDismiss}
            className="text-xs text-[var(--horizon-muted)]"
            aria-label="Dismiss getting started guide"
          >
            <span>Dismiss</span>
            <X aria-hidden="true" />
          </Button>
        </div>
      </div>

      <div className="border-b border-[var(--horizon-line)] bg-[var(--horizon-lavender-soft)] px-5 py-4">
        <h3 className="font-heading text-lg font-semibold">Stay on top of ballot deadlines</h3>
        <p className="my-2 text-sm leading-relaxed">Engage can email you a digest of eligible ballots closing within seven days that you haven’t voted on. Each ballot is reminded once, and reminders stop once you’ve voted. Sign-in emails are separate.</p>
        <p className="my-2 text-sm">{props.digestExistingMember
          ? 'Reminders were enabled for existing Engage accounts so you don’t miss the new feature. You can opt out below or unsubscribe in any digest.'
          : 'For new Engage accounts, reminders stay off until you opt in. This is optional and does not affect voting or membership.'}</p>
        {props.digestSuppressed ? <p className="text-sm">Reminder delivery is paused after a bounce or spam complaint. Contact an administrator to resolve delivery.</p> :
          <form method="post" action="/api/email/preferences" className="flex flex-wrap items-center gap-3 py-2">
            <label className="flex items-center gap-2 text-sm"><input type="hidden" name="category" value="engage" /><Checkbox name="digestEnabled" value="true" defaultChecked={props.digestEnabled === true} /> Send me ballot reminder emails</label>
            <Button type="submit" size="sm" variant="outline">Save reminder preference</Button>
          </form>}
        <p className="text-xs text-[var(--horizon-muted)]">My Engage → Notifications has separate settings for essential account notifications, Engage digests, and general communications such as newsletters and campaigns. Every digest has an unsubscribe link. Delivery, bounce and unsubscribe reporting help keep emails reliable.</p>
      </div>

      {/* Post-Sign-In 1-Tap Passkey Upgrade Nudge (Peak-End & Friction Removal) */}
      {!hasPasskey && passkeySupported && !nudgeDismissed && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--horizon-line)] bg-[var(--horizon-lavender)] px-5 py-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <Fingerprint className="size-4 shrink-0 text-[var(--horizon-purple-deep)]" aria-hidden="true" />
            <p className="m-0 text-xs leading-relaxed text-[var(--horizon-purple-deep)]">
              <strong>Skip the email wait next time:</strong> Save a device passkey (Face ID, Touch ID, Windows Hello, or password manager) so Engage can prompt you automatically when you return.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              type="button"
              disabled={enrollingPasskey}
              onClick={enrollPasskeyNow}
              className="text-xs"
            >
              <Fingerprint className="size-3.5" aria-hidden="true" />
              {enrollingPasskey ? 'Waiting for device…' : 'Enable 1-tap passkey'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleDismissNudge}
              className="text-xs text-[var(--horizon-muted)]"
            >
              Not now
            </Button>
          </div>
        </div>
      )}

      {/* Checklist Grid */}
      <div className="grid divide-y border-b border-[var(--horizon-line)] md:grid-cols-2 md:divide-x md:divide-y-0 lg:grid-cols-3 xl:grid-cols-5">
        {steps.map((step) => (
          <div
            key={step.id}
            className={`flex flex-col justify-between gap-3 p-4 ${
              step.done ? 'bg-[var(--horizon-lavender-soft)]' : 'bg-white'
            }`}
          >
            <div className="grid gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-xs font-bold text-[var(--horizon-purple-deep)]">
                  {step.done ? (
                    <CheckCircle2
                      className="size-4 shrink-0 text-[var(--horizon-success-ink)]"
                      aria-hidden="true"
                    />
                  ) : (
                    <Circle
                      className="size-4 shrink-0 text-[var(--horizon-purple)]"
                      aria-hidden="true"
                    />
                  )}
                  {step.done ? 'Done' : 'Next step'}
                </span>
                <span className="rounded bg-[var(--horizon-lavender)] px-1.5 py-0.5 text-xs font-semibold text-[var(--horizon-muted)] tabular-nums">
                  {step.time}
                </span>
              </div>
              <h3 className="m-0 font-sans text-sm font-bold leading-snug text-[var(--horizon-purple-deep)]">
                {step.title}
              </h3>
              <p className="m-0 text-xs leading-relaxed text-[var(--horizon-muted)]">
                {step.description}
              </p>
            </div>

            {step.id === 'passkey' && !step.done && passkeySupported && (
              <div className="pt-1">
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  disabled={enrollingPasskey}
                  onClick={enrollPasskeyNow}
                  className="w-full justify-center text-xs"
                >
                  <Fingerprint className="size-3.5" aria-hidden="true" />
                  {enrollingPasskey ? 'Waiting for device…' : 'Set up passkey now'}
                </Button>
              </div>
            )}

            {step.id === 'passkey' && step.done && (
              <div className="pt-1">
                <a
                  href="/member/?view=account#passkeys"
                  className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--horizon-purple-deep)] hover:underline"
                >
                  Manage passkeys →
                </a>
              </div>
            )}

            {step.id === 'verification' && !step.done && (
              <div className="pt-1">
                <a
                  href="/how-it-works/#access-matrix"
                  onClick={markWalkthroughVisited}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--horizon-purple-deep)] hover:underline"
                >
                  What you can do right now →
                </a>
              </div>
            )}

            {step.id === 'branches' && (
              <div className="pt-1">
                <a
                  href="#onboarding-branches-heading"
                  className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--horizon-purple-deep)] hover:underline"
                >
                  {branchesDone ? 'Review my branches' : 'Choose branches'} <ArrowRight className="size-3.5" aria-hidden="true" />
                </a>
              </div>
            )}

            {step.id === 'first-action' && (
              <div className="pt-1">
                <a
                  href={primaryActionHref}
                  onClick={markWalkthroughVisited}
                  className="inline-flex items-center gap-1 text-xs font-bold text-[var(--horizon-purple-deep)] hover:underline"
                >
                  {primaryActionLabel} <ArrowRight className="size-3.5" aria-hidden="true" />
                </a>
              </div>
            )}
          </div>
        ))}
      </div>

      <BranchChooser
        mode="onboarding"
        memberKey={props.memberKey || props.email}
        branches={props.branchChoices ?? []}
        onComplete={() => setBranchesDone(true)}
      />

      {/* Bottom Action & Feedback Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-white px-5 py-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--horizon-muted)]">
          {passkeyFeedback ? (
            <span
              role="status"
              aria-live="polite"
              className={
                passkeyError
                  ? 'font-semibold text-[var(--horizon-danger-ink)]'
                  : 'inline-flex items-center gap-1.5 font-semibold text-[var(--horizon-success-ink)]'
              }
            >
              {!passkeyError && <ShieldCheck className="size-4 shrink-0" aria-hidden="true" />}
              {passkeyFeedback}
            </span>
          ) : (
            <span>
              <strong>Tip:</strong> Deliberation stances (<em>Support</em>, <em>Concern</em>,{' '}
              <em>Wording suggestion</em>) shape proposals in Stage 2; formal ballots (
              <em>Approve</em>, <em>Abstain</em>, <em>Reject</em>) decide frozen wording in Stage 3.
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            href="/how-it-works/"
            variant="ghost"
            size="sm"
            onClick={markWalkthroughVisited}
            className="text-xs"
          >
            <Compass className="size-3.5" aria-hidden="true" />
            60-second guide
          </Button>
          {props.canParticipate && props.openBallotsCount > 0 ? (
            <Button href={primaryActionHref} size="sm" className="text-xs">
              <Vote className="size-3.5" aria-hidden="true" />
              Vote on open ballot ({props.openBallotsCount})
            </Button>
          ) : props.canParticipate && props.deliberationsCount > 0 ? (
            <Button href={primaryActionHref} size="sm" className="text-xs">
              <MessageSquare className="size-3.5" aria-hidden="true" />
              Join deliberation ({props.deliberationsCount})
            </Button>
          ) : (
            <Button
              href="/proposals/"
              size="sm"
              variant="outline"
              onClick={markWalkthroughVisited}
              className="text-xs"
            >
              Browse live proposals
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

