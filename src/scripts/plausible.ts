import { init } from '@plausible-analytics/tracker';

// Keep staging and local development out of the production analytics site.
if (window.location.hostname === 'engage.fusionparty.org.au') {
  init({
    domain: 'engage.fusionparty.org.au',
    endpoint: 'https://analytics.fusionparty.org.au/api/event',
  });
}
