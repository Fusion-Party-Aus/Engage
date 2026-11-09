import { init, track, type PlausibleRequestPayload } from '@plausible-analytics/tracker';

export const ANALYTICS_HOST = 'engage.fusionparty.org.au';
const ORIGIN = `https://${ANALYTICS_HOST}`;
let initialized = false;
const actions = ['proposal', 'deliberation', 'amendment', 'ballot', 'amendment_ballot', 'endorsement'];
const methods = ['email', 'google', 'passkey', 'passkey_auto', 'passkey_autofill'];
const stages = ['all', 'propose', 'deliberate', 'decide', 'implement'];
// This allowlist is the analytics boundary: never pass identities, free text or choices.
const schema: Record<string, Record<string, readonly string[] | null>> = {
  navigation_clicked: { area: ['header', 'footer', 'sidebar', 'content'], destination: null, section: null, view: ['default', 'account', 'activity', 'history', 'notifications'], stage: stages, intent: ['none', 'vote', 'deliberate', 'propose'] },
  listing_viewed: { collection: ['proposals', 'policies'], results: ['0', '1-5', '6-20', '21+'], has_query: ['yes', 'no'] },
  search_submitted: { collection: ['proposals', 'policies'], has_query: ['yes', 'no'] },
  filter_changed: { filter: ['stage', 'topic', 'branch', 'sort', 'jurisdiction'], value: ['all', 'selected', 'propose', 'deliberate', 'decide', 'implement', 'priority', 'recent', 'ballots', 'contributions'] },
  form_started: { form: ['proposal', 'deliberation', 'amendment', 'email_signin'] },
  contribution_attempted: { action: actions },
  contribution_result: { action: actions, outcome: ['success', 'pending_verification', 'failed'] },
  signin_attempted: { method: methods },
  signin_result: { method: methods, outcome: ['success', 'link_sent', 'failed', 'name_required'] },
  passkey_enrollment: { mode: ['manual', 'automatic'], outcome: ['attempted', 'success', 'failed'] },
  onboarding_action: { action: ['dismiss', 'dismiss_passkey', 'explore'] },
  section_viewed: { section: null },
  share_copied: {},
  my_engage_viewed: {},
  verification_cta_clicked: {},
  digest_cta_clicked: {},
};
const sections = new Set(['proposal-brief', 'outcomes-heading', 'details-heading', 'amendments-heading', 'deliberation', 'revision-history-heading', 'provenance-heading', 'proposal-vote', 'access-matrix', 'passkeys']);

export function analyticsPath(raw: string): string {
  try {
    const url = new URL(raw, ORIGIN);
    if (url.origin !== ORIGIN) return '/external/';
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (/^\/(?:proposals|policies)\/[^/]+$/.test(path)) return `${path}/`;
    if (/^\/(?:proposals|policies|member|branches|changelog|how-it-works|privacy|terms)$/.test(path)) return `${path}/`;
    if (/^\/admin(?:\/|$)/.test(path)) return '/admin/';
    return path === '/' ? '/' : '/other/';
  } catch { return '/other/'; }
}

export function sanitizePayload(payload: PlausibleRequestPayload): PlausibleRequestPayload | null {
  try {
    if (new URL(payload.u, ORIGIN).pathname.startsWith('/api/')) return null;
    let referrer: string | null = null;
    if (payload.r) {
      const ref = new URL(payload.r);
      referrer = ref.origin === ORIGIN ? `${ORIGIN}${analyticsPath(ref.href)}` : ref.origin;
    }
    return { ...payload, u: `${ORIGIN}${analyticsPath(payload.u)}`, r: referrer };
  } catch { return null; }
}

export function initAnalytics(): boolean {
  if (typeof window === 'undefined' || window.location.hostname !== ANALYTICS_HOST) return false;
  if (!initialized) {
    init({
      domain: ANALYTICS_HOST, endpoint: 'https://analytics.fusionparty.org.au/api/event', transformRequest: sanitizePayload,
      customProperties: () => {
        const props: Record<string, string> = {};
        const stage = document.querySelector<HTMLElement>('[data-analytics-stage]')?.dataset.analyticsStage;
        if (stage && stages.includes(stage)) props.proposal_stage = stage;
        if (window.location.pathname === '/member/') {
          const view = new URL(window.location.href).searchParams.get('view');
          props.member_view = view === 'account' || view === 'activity' || view === 'notifications' ? view : 'overview';
        }
        return props;
      },
    });
    initialized = true;
  }
  return true;
}

export function trackEngage(event: string, properties: Record<string, string> = {}): void {
  try {
    if (!Object.hasOwn(schema, event) || !initAnalytics()) return;
    const allowed = schema[event]!;
    const props: Record<string, string> = {};
    for (const [key, value] of Object.entries(properties)) {
      if (!Object.hasOwn(allowed, key)) continue;
      if (key === 'destination') props[key] = analyticsPath(value);
      else if (key === 'section') props[key] = sections.has(value) ? value : 'other';
      else if (allowed[key]?.includes(value)) props[key] = value;
    }
    track(event, { props, interactive: !['section_viewed', 'listing_viewed'].includes(event) });
  } catch {
    // Tracking must never interrupt navigation, authentication or governance actions.
  }
}

export function resultBucket(count: number): string {
  return count === 0 ? '0' : count <= 5 ? '1-5' : count <= 20 ? '6-20' : '21+';
}
