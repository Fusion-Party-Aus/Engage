import { initAnalytics, trackEngage, resultBucket } from '../lib/analytics.ts';

if (initAnalytics()) {
  // The server confirms the session before counting a redirect as a completed sign-in.
  const arrival = new URL(location.href);
  const signinMethod = arrival.searchParams.get('analytics_signin');
  if (signinMethod === 'email' || signinMethod === 'google') {
    if (document.body.dataset.analyticsSignedIn === 'yes') {
      trackEngage('signin_result', { method: signinMethod, outcome: 'success' });
    }
    arrival.searchParams.delete('analytics_signin');
    history.replaceState(history.state, '', arrival.href);
  }
  // Delegation covers React islands and dynamically inserted content.
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const link = target?.closest<HTMLAnchorElement>('a[href]');
    if (!link || link.getAttribute('aria-disabled') === 'true' || link.hasAttribute('download')) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
    trackEngage('navigation_clicked', {
      area: link.closest('.site-header') ? 'header' : link.closest('.site-footer') ? 'footer' : link.closest('aside') ? 'sidebar' : 'content',
      destination: url.href, section: url.hash.slice(1),
      view: url.searchParams.get('view') === 'account' ? 'account' : url.searchParams.get('view') === 'activity' ? 'activity' : url.searchParams.get('history') === '1' ? 'history' : 'default',
      stage: url.searchParams.get('stage') ?? 'all',
      intent: url.searchParams.get('intent') ?? 'none',
    });
  });
  const forms: Record<string, string> = {
    'new-proposal-form': 'proposal', 'comment-form': 'deliberation',
    'amendment-form': 'amendment', 'email-signin-form': 'email_signin',
  };
  const started = new WeakSet<HTMLFormElement>();
  document.addEventListener('focusin', (event) => {
    const form = event.target instanceof Element ? event.target.closest('form') : null;
    if (form && forms[form.id] && !started.has(form)) {
      started.add(form);
      trackEngage('form_started', { form: forms[form.id]! });
    }
  });
  const filters: Record<string, string> = {
    'proposal-stage-select': 'stage', 'proposal-space': 'topic', 'proposal-branch': 'branch',
    'proposal-sort': 'sort', 'policy-jurisdiction': 'jurisdiction', 'policy-branch': 'branch',
  };
  document.addEventListener('change', (event) => {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement) || !filters[select.id]) return;
    const filter = filters[select.id]!;
    const value = !select.value || select.value === 'all' ? 'all' : ['stage', 'sort'].includes(filter) ? select.value : 'selected';
    trackEngage('filter_changed', { filter, value });
  }, true);
  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const collection = form.id === 'proposals-filter-form' ? 'proposals' : form.classList.contains('policy-filters') ? 'policies' : null;
    if (collection) trackEngage('search_submitted', { collection, has_query: String(new FormData(form).get('q') ?? '').trim() ? 'yes' : 'no' });
  }, true);

  function observePage() {
    const listing = document.querySelector<HTMLElement>('[data-analytics-results]');
    if (listing) trackEngage('listing_viewed', {
      collection: listing.dataset.analyticsCollection!, results: resultBucket(Number(listing.dataset.analyticsResults)),
      has_query: new URLSearchParams(location.search).get('q')?.trim() ? 'yes' : 'no',
    });
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || entry.intersectionRatio < 0.1 || document.visibilityState !== 'visible') continue;
        trackEngage('section_viewed', { section: entry.target.id });
        observer.unobserve(entry.target);
      }
    }, { threshold: 0.1 });
    document.querySelectorAll('#proposal-brief, #outcomes-heading, #details-heading, #amendments-heading, #deliberation, #revision-history-heading, #provenance-heading, #proposal-vote, #access-matrix, #passkeys').forEach((element) => observer.observe(element));
    document.addEventListener('astro:before-swap', () => observer.disconnect(), { once: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observePage, { once: true });
  else observePage();
  document.addEventListener('astro:after-swap', observePage);
}

