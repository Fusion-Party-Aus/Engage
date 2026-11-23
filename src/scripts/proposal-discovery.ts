import { hydrateBallotDeadlines } from './ballot-deadlines.ts';

const discovery = '[data-proposal-discovery]';
const resultsSelector = '[data-discovery-results]';
const linkSelector = 'a[data-discovery-link]';

function updateListing(root: HTMLElement, incoming: HTMLElement, search: HTMLInputElement) {
  const active = document.activeElement as HTMLElement | null;
  const activeLink = active?.dataset.discoveryLink;
  const focusedResults = active?.closest(resultsSelector);
  const scroll = { left: window.scrollX, top: window.scrollY };

  // Retain the actual input, selects, stage tabs and live region across updates.
  const query = incoming.querySelector<HTMLInputElement>('#proposal-search')!.value;
  if (query !== search.value.trim()) search.value = query;

  for (const select of root.querySelectorAll<HTMLSelectElement>('form select')) {
    const next = incoming.querySelector<HTMLSelectElement>(`#${select.id}`)!;
    const value = next.value;
    if (select.innerHTML !== next.innerHTML) select.replaceChildren(...next.children);
    select.value = value;
  }

  const stage = root.querySelector<HTMLInputElement>('input[name="stage"]')!;
  stage.value = incoming.querySelector<HTMLInputElement>('input[name="stage"]')!.value;
  const form = root.querySelector<HTMLFormElement>('#proposals-filter-form')!;
  form.dataset.analyticsResults = incoming.querySelector<HTMLFormElement>('#proposals-filter-form')!.dataset.analyticsResults;

  for (const element of root.querySelectorAll<HTMLElement>('[data-discovery-text], [data-discovery-region], a[data-discovery-link]:not([data-discovery-link=""])')) {
    if (element.closest(resultsSelector)) continue;
    const attribute = Array.from(element.attributes).find(({ name }) =>
      name === 'data-discovery-text' || name === 'data-discovery-region' || name === 'data-discovery-link',
    )!;
    const next = incoming.querySelector<HTMLElement>(`[${attribute.name}="${attribute.value}"]`);
    if (!next) continue;
    if (element.innerHTML !== next.innerHTML) element.replaceChildren(...next.childNodes);
    for (const name of ['href', 'class', 'aria-current', 'hidden']) {
      const value = next.getAttribute(name);
      if (value === null) element.removeAttribute(name);
      else element.setAttribute(name, value);
    }
  }

  for (const checkbox of form.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    checkbox.checked = checkbox.defaultChecked;
  }

  const results = root.querySelector<HTMLElement>(resultsSelector)!;
  results.replaceChildren(...incoming.querySelector<HTMLElement>(resultsSelector)!.childNodes);
  hydrateBallotDeadlines(results);

  if (active && root.contains(active) && active.hidden) {
    search.focus({ preventScroll: true });
  } else if (active && !active.isConnected) {
    const replacement = active.id
      ? document.getElementById(active.id)
      : activeLink && !focusedResults
        ? root.querySelector<HTMLElement>(`[data-discovery-link="${activeLink}"]`)
        : null;
    (replacement ?? (focusedResults ? results : search)).focus({ preventScroll: true });
  }
  window.scrollTo({ ...scroll, behavior: 'instant' });
}

type Navigation = { url: URL; mode: 'filter' | 'search' | 'restore' };

function resolvedUrl(url: URL, listing: HTMLElement) {
  const params = url.searchParams;
  if (params.has('page') && params.get('page') !== listing.dataset.page) {
    if (listing.dataset.page === '1') params.delete('page');
    else params.set('page', listing.dataset.page!);
  }
  const stage = listing.querySelector<HTMLInputElement>('input[name="stage"]')!.value;
  // Snapshot cookie-derived Voting preferences so history restores the same view.
  if (stage === 'decide' && !params.has('focus') && !params.has('needsVote')) {
    params.set('focus', listing.dataset.focus!);
  }
  return url;
}

export function enhanceProposalDiscovery(root: HTMLElement) {
  const form = root.querySelector<HTMLFormElement>('#proposals-filter-form')!;
  const search = root.querySelector<HTMLInputElement>('#proposal-search')!;
  const clearSearch = root.querySelector<HTMLAnchorElement>('[data-discovery-link="clear-search"]')!;
  const results = root.querySelector<HTMLElement>(resultsSelector)!;
  const status = root.querySelector<HTMLElement>('[data-discovery-status]')!;
  const error = root.querySelector<HTMLElement>('[data-discovery-error]')!;

  const initialUrl = resolvedUrl(new URL(location.href), root);
  if (initialUrl.href !== location.href) history.replaceState(history.state, '', initialUrl);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeRequest: AbortController | undefined;
  let failed: Navigation | undefined;
  let editing = false;
  let renderedFilters = formUrl().searchParams;

  function cancelPending() {
    clearTimeout(timer);
    activeRequest?.abort();
    activeRequest = undefined;
    failed = undefined;
    error.hidden = true;
    results.removeAttribute('aria-busy');
    status.textContent = '';
  }

  async function navigate({ url, mode }: Navigation) {
    cancelPending();
    const request = new AbortController();
    activeRequest = request;
    results.setAttribute('aria-busy', 'true');
    status.textContent = 'Updating proposals…';
    try {
      const response = await fetch(url, {
        headers: { 'X-Engage-Proposal-List': '1' },
        signal: request.signal,
        redirect: 'error',
      });
      if (!response.ok) throw new Error('Proposal list request failed');
      const html = await response.text();
      if (request.signal.aborted) return;
      const incoming = new DOMParser().parseFromString(html, 'text/html').querySelector<HTMLElement>(discovery);
      if (!incoming) throw new Error('Proposal list missing from response');

      const nextUrl = resolvedUrl(new URL(url), incoming);
      updateListing(root, incoming, search);
      renderedFilters = formUrl().searchParams;
      if (nextUrl.href !== location.href) {
        if (mode === 'restore' || (mode === 'search' && editing)) {
          history.replaceState(history.state, '', nextUrl);
        } else {
          history.pushState(null, '', nextUrl);
        }
      }
      editing = mode === 'search' && document.activeElement === search;
      status.textContent = root.querySelector('[data-discovery-text="range"]')!.textContent;
    } catch {
      if (request.signal.aborted) return;
      failed = { url, mode };
      error.hidden = false;
      status.textContent = 'Couldn’t load proposals.';
    } finally {
      if (activeRequest === request) {
        activeRequest = undefined;
        results.removeAttribute('aria-busy');
      }
    }
  }

  function formUrl() {
    const url = new URL(form.action);
    for (const [key, value] of new FormData(form)) {
      const text = String(value).trim();
      if (text && (text !== 'all' || key === 'q' || key === 'focus') && (key !== 'sort' || text !== 'priority')) {
        url.searchParams.set(key, text);
      }
    }
    return url;
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const url = formUrl();
    void navigate({ url, mode: document.activeElement === search ? 'search' : 'filter' });
  });
  form.addEventListener('change', (event) => {
    if (event.target instanceof Element && event.target.hasAttribute('data-auto-submit')) {
      editing = false;
      form.requestSubmit();
    }
  });
  search.addEventListener('blur', () => { editing = false; });
  search.addEventListener('input', (event) => {
    cancelPending();
    clearSearch.hidden = !search.value.trim();
    if (event instanceof InputEvent && event.isComposing) return;
    // Keep the old results visible while typing and while the server responds.
    timer = setTimeout(() => void navigate({ url: formUrl(), mode: 'search' }), 350);
  });
  root.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('[data-discovery-retry]') && failed) {
      search.focus({ preventScroll: true });
      void navigate(failed);
      return;
    }
    const link = target?.closest<HTMLAnchorElement>(linkSelector);
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (link.getAttribute('aria-disabled') === 'true') return;
    editing = false;
    const url = new URL(link.href);
    if (link.dataset.discoveryLink === 'clear-search') {
      search.value = '';
      search.focus({ preventScroll: true });
      void navigate({ url: formUrl(), mode: 'filter' });
      return;
    }
    const intent = link.dataset.discoveryLink ?? '';
    const overrides = intent.startsWith('stage-') || intent === 'needs-vote'
      ? ['stage', 'focus', 'needsVote']
      : intent.startsWith('sort-') ? ['sort']
      : intent === 'topic' ? ['space']
      : intent === 'page' ? [] : null;

    if (overrides) {
      const pending = formUrl().searchParams;
      for (const key of new Set([...renderedFilters.keys(), ...pending.keys()])) {
        const value = pending.get(key);
        if (overrides.includes(key) || value === renderedFilters.get(key)) continue;
        if (value === null) url.searchParams.delete(key);
        else url.searchParams.set(key, value);
        if (key === 'space') url.searchParams.delete('category');
        url.searchParams.delete('page');
      }
    }
    void navigate({ url, mode: 'filter' });
  });
  window.addEventListener('popstate', () => {
    editing = false;
    void navigate({ url: new URL(location.href), mode: 'restore' });
  });
}
